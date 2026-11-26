import { groupFiles, hunkBody, hunkStats, parseDiff } from '../core/diff.ts';
import { exportMarkdown } from '../core/export.ts';
import { loadDiffText } from '../core/git.ts';
import { reconcilePlan, validatePlan, type Reconciled, type ValidationResult } from '../core/plan.ts';
import { randomId } from '../core/registry.ts';
import { StateStore, statePath } from '../core/state.ts';
import type { Comment, DiffSource, FileSummary, Hunk, Layer, Plan } from '../core/types.ts';
import { EventBus, type NavigateTarget } from './bus.ts';

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type Resolver = (args?: string[]) => Promise<DiffSource>;

export type WaitResult = { event: 'asks'; asks: Comment[] } | { event: 'done' } | { event: 'timeout' };

type Waiter = { resolve: (r: WaitResult) => void; timer: ReturnType<typeof setTimeout> };

export type LineAnchor = { side: 'old' | 'new'; number: number };

export function parseLineAnchor(s: string): LineAnchor {
  const m = /^(old|new):(\d+)$/.exec(s.trim());
  if (!m) throw new SessionError(`bad line anchor "${s}", expected new:<n> or old:<n>`);
  return { side: m[1] as 'old' | 'new', number: parseInt(m[2]!, 10) };
}

export type SessionOptions = { autoSend?: boolean; debounceMs?: number };

export class Session {
  readonly bus = new EventBus();
  src!: DiffSource;
  hunks: Hunk[] = [];
  hunkMap = new Map<string, Hunk>();
  files: FileSummary[] = [];
  rec!: Reconciled;
  store!: StateStore;
  private waiters = new Set<Waiter>();
  private ended = false;
  autoSend: boolean;

  private constructor(
    private readonly resolver: Resolver,
    private readonly opts: SessionOptions,
  ) {
    this.autoSend = opts.autoSend ?? false;
  }

  static async open(src: DiffSource, resolver: Resolver, opts: SessionOptions = {}): Promise<Session> {
    const s = new Session(resolver, opts);
    await s.load(src);
    return s;
  }

  private async load(src: DiffSource): Promise<void> {
    const text = await loadDiffText(src);
    const hunks = parseDiff(text);
    if (!this.store || this.src.key !== src.key || this.src.gitDir !== src.gitDir) {
      this.store?.flush();
      this.store = new StateStore(statePath(src.gitDir, src.key), this.opts.debounceMs ?? 250);
    }
    this.src = src;
    this.hunks = hunks;
    this.hunkMap = new Map(hunks.map((h) => [h.id, h]));
    this.files = groupFiles(hunks);
    this.rec = reconcilePlan(this.store.get().plan, hunks);
    if (this.rec.stored) {
      const stored = this.rec.stored;
      this.store.update((s) => (s.plan = stored));
    }
  }

  /** Reload the diff, optionally pointing the session at a new range. */
  async reload(args?: string[]): Promise<void> {
    const src = await this.resolver(args && args.length ? args : undefined);
    await this.load(src);
    this.bus.emit({ type: 'reload' });
  }

  get state() {
    return this.store.get();
  }

  get view(): Plan {
    return this.rec.view;
  }

  get agentWaiting(): boolean {
    return this.waiters.size > 0;
  }

  layerOf(hunkId: string): Layer | undefined {
    return this.view.layers.find((l) => l.hunks.includes(hunkId));
  }

  private hunk(id: string): Hunk {
    const h = this.hunkMap.get(id);
    if (!h) throw new SessionError(`unknown hunk ${id}`, 404);
    return h;
  }

  private checkLine(h: Hunk, line?: LineAnchor): void {
    if (!line) return;
    const ok = h.lines.some((l) =>
      line.side === 'new' ? l.kind !== 'del' && l.newNo === line.number : l.kind !== 'add' && l.oldNo === line.number,
    );
    if (!ok) throw new SessionError(`line ${line.side}:${line.number} is not in hunk ${h.id} (${h.header})`);
  }

  // ---------- read ----------

  review(opts: { patch?: boolean; layer?: string; unreviewed?: boolean } = {}) {
    let allowed: Set<string> | null = null;
    if (opts.layer) {
      const layer = this.view.layers.find((l) => l.id === opts.layer);
      if (!layer) throw new SessionError(`unknown layer ${opts.layer}`, 404);
      allowed = new Set(layer.hunks);
    }
    const reviewed = this.state.reviewed;
    const files = this.files
      .map((f) => ({
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        status: f.status,
        hunks: f.hunks
          .filter((h) => (!allowed || allowed.has(h.id)) && (!opts.unreviewed || !reviewed[h.id]))
          .map((h) => {
            const { added, removed } = hunkStats(h);
            return {
              id: h.id,
              header: h.header,
              added,
              removed,
              ...(opts.patch ? { lines: h.lines.length ? hunkBody(h.lines).split('\n') : [] } : {}),
            };
          }),
      }))
      .filter((f) => f.hunks.length > 0);
    return {
      base: this.src.base,
      head: this.src.headMode === 'commit' ? this.src.head : this.src.headLabel,
      range: `${this.src.baseLabel}..${this.src.headLabel}`,
      ...(this.src.prNumber !== undefined ? { prNumber: this.src.prNumber } : {}),
      files,
    };
  }

  stack() {
    return { plan: this.rec.stored, stale: this.rec.stale, newHunks: this.rec.newHunks };
  }

  comments(filter: { kind?: string; pending?: boolean } = {}): Comment[] {
    return this.state.comments.filter(
      (c) => (!filter.kind || c.kind === filter.kind) && (!filter.pending || c.status === 'pending'),
    );
  }

  status() {
    const reviewed = this.state.reviewed;
    return {
      layers: this.view.layers.map((l) => ({
        id: l.id,
        reviewed: l.hunks.filter((id) => reviewed[id]).length,
        total: l.hunks.length,
      })),
      pendingAsks: this.state.comments.filter((c) => c.kind === 'ask' && c.status === 'pending').length,
    };
  }

  progress(): { reviewed: number; total: number } {
    const reviewed = this.state.reviewed;
    return { reviewed: this.hunks.filter((h) => reviewed[h.id]).length, total: this.hunks.length };
  }

  exportMarkdown(): string {
    const plan = this.rec.hasPlan ? this.view : { ...this.view, title: `${this.src.baseLabel}..${this.src.headLabel}` };
    return exportMarkdown(plan, this.hunks, this.state.comments, this.state.reviewed);
  }

  // ---------- plan ----------

  setStack(input: unknown): ValidationResult {
    const r = validatePlan(input, this.hunks);
    if (!r.ok) return r;
    this.store.update((s) => (s.plan = r.plan));
    this.rec = reconcilePlan(r.plan, this.hunks);
    this.bus.emit({ type: 'plan' });
    return r;
  }

  // ---------- reviewed marks ----------

  setReviewed(hunkIds: string[], value: boolean): void {
    const now = new Date().toISOString();
    this.store.update((s) => {
      for (const id of hunkIds) {
        if (value) s.reviewed[id] = s.reviewed[id] ?? now;
        else delete s.reviewed[id];
      }
    });
    this.bus.emit({ type: 'reviewed', hunkIds });
  }

  toggleReviewed(hunkId: string): boolean {
    const now = !this.state.reviewed[hunkId];
    this.setReviewed([hunkId], now);
    return now;
  }

  // ---------- comments ----------

  private push(c: Comment): Comment {
    this.store.update((s) => s.comments.push(c));
    this.bus.emit({ type: 'comments', hunkIds: [c.hunkId] });
    return c;
  }

  addNote(input: { hunkId: string; line?: LineAnchor; body: string }): Comment {
    const h = this.hunk(input.hunkId);
    this.checkLine(h, input.line);
    if (!input.body.trim()) throw new SessionError('note body is empty');
    return this.push({
      id: randomId('c_'),
      hunkId: h.id,
      ...(input.line ? { line: input.line } : {}),
      author: 'agent',
      kind: 'note',
      body: input.body,
      status: 'answered',
      createdAt: new Date().toISOString(),
    });
  }

  addHumanComment(input: { hunkId: string; line?: LineAnchor; kind: 'review' | 'ask'; body: string }): Comment {
    const h = this.hunk(input.hunkId);
    this.checkLine(h, input.line);
    const c = this.push({
      id: randomId('c_'),
      hunkId: h.id,
      ...(input.line ? { line: input.line } : {}),
      author: 'human',
      kind: input.kind,
      body: input.body,
      status: input.kind === 'ask' && this.autoSend ? 'pending' : 'draft',
      createdAt: new Date().toISOString(),
    });
    if (c.status === 'pending') this.wake();
    return c;
  }

  private find(id: string): Comment {
    const c = this.state.comments.find((x) => x.id === id);
    if (!c) throw new SessionError(`unknown comment ${id}`, 404);
    return c;
  }

  editComment(id: string, body: string): void {
    const c = this.find(id);
    if (c.author !== 'human') throw new SessionError('only your own comments can be edited');
    this.store.update(() => (c.body = body));
    this.bus.emit({ type: 'comments', hunkIds: [c.hunkId] });
  }

  deleteComment(id: string): void {
    const c = this.find(id);
    if (c.author !== 'human' || c.status !== 'draft' || c.postedAt) throw new SessionError('only drafts can be deleted');
    this.store.update((s) => (s.comments = s.comments.filter((x) => x.id !== id)));
    this.bus.emit({ type: 'comments', hunkIds: [c.hunkId] });
  }

  resolveThread(id: string): void {
    const c = this.find(id);
    const root = c.parentId ? this.find(c.parentId) : c;
    this.store.update((s) => {
      for (const x of s.comments) if (x.id === root.id || x.parentId === root.id) x.status = 'resolved';
    });
    this.bus.emit({ type: 'comments', hunkIds: [c.hunkId] });
  }

  reply(toId: string, body: string): Comment {
    const ask = this.find(toId);
    if (ask.kind !== 'ask') throw new SessionError(`${toId} is a ${ask.kind}, only asks can be replied to`);
    if (!body.trim()) throw new SessionError('reply body is empty');
    const c: Comment = {
      id: randomId('c_'),
      hunkId: ask.hunkId,
      ...(ask.line ? { line: ask.line } : {}),
      author: 'agent',
      kind: 'reply',
      parentId: ask.id,
      body,
      status: 'answered',
      createdAt: new Date().toISOString(),
    };
    this.store.update((s) => {
      s.comments.push(c);
      if (ask.status !== 'resolved') ask.status = 'answered';
    });
    this.bus.emit({ type: 'comments', hunkIds: [ask.hunkId] });
    return c;
  }

  draftAsks(): Comment[] {
    return this.state.comments.filter((c) => c.kind === 'ask' && c.status === 'draft');
  }

  /** Send every draft ask to the agent. Returns how many were sent. */
  sendAsks(): number {
    const drafts = this.draftAsks();
    if (!drafts.length) return 0;
    this.store.update(() => {
      for (const c of drafts) c.status = 'pending';
    });
    this.bus.emit({ type: 'comments', hunkIds: drafts.map((c) => c.hunkId) });
    this.wake();
    return drafts.length;
  }

  // ---------- agent wait loop ----------

  private undelivered(): Comment[] {
    return this.state.comments.filter((c) => c.kind === 'ask' && c.status === 'pending' && !c.deliveredAt);
  }

  private takeAsks(): Comment[] {
    const asks = this.undelivered();
    const now = new Date().toISOString();
    this.store.update(() => {
      for (const c of asks) c.deliveredAt = now;
    });
    return asks.map((c) => ({ ...c }));
  }

  private wake(): void {
    if (!this.undelivered().length) return;
    const first = this.waiters.values().next().value;
    if (!first) return;
    this.release(first, { event: 'asks', asks: this.takeAsks() });
  }

  private release(w: Waiter, r: WaitResult): void {
    clearTimeout(w.timer);
    this.waiters.delete(w);
    w.resolve(r);
    this.bus.emit({ type: 'agent', waiting: this.agentWaiting });
  }

  /** Block until the human sends asks or ends the review. Each ask is returned once. */
  wait(timeoutSec: number, signal?: AbortSignal): Promise<WaitResult> {
    if (this.ended) return Promise.resolve({ event: 'done' });
    if (this.undelivered().length) return Promise.resolve({ event: 'asks', asks: this.takeAsks() });
    return new Promise((resolve) => {
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => this.release(w, { event: 'timeout' }), Math.max(0, timeoutSec) * 1000),
      };
      this.waiters.add(w);
      // A client that hangs up must not swallow the next asks.
      signal?.addEventListener('abort', () => this.waiters.has(w) && this.release(w, { event: 'timeout' }));
      this.bus.emit({ type: 'agent', waiting: true });
    });
  }

  /** End the review: every waiting agent gets `done`. */
  end(): void {
    this.ended = true;
    for (const w of [...this.waiters]) this.release(w, { event: 'done' });
    this.bus.emit({ type: 'done' });
    this.store.flush();
  }

  // ---------- navigation ----------

  navigate(target: NavigateTarget): void {
    if (target.layer && !this.view.layers.some((l) => l.id === target.layer))
      throw new SessionError(`unknown layer ${target.layer}`, 404);
    if (target.hunk) this.hunk(target.hunk);
    if (target.comment) this.find(target.comment);
    if (!target.layer && !target.hunk && !target.comment) throw new SessionError('navigate needs --layer, --hunk or --comment');
    this.bus.emit({ type: 'navigate', target });
  }

  markPosted(ids: string[], when = new Date().toISOString()): void {
    this.store.update((s) => {
      for (const c of s.comments) if (ids.includes(c.id)) c.postedAt = when;
    });
    this.bus.emit({ type: 'comments', hunkIds: [] });
  }

  flush(): void {
    this.store.flush();
  }
}
