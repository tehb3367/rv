import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, KeyAction } from '../core/config.ts';
import { groupFiles } from '../core/diff.ts';
import { tokensForLine, type FileTokens } from '../core/highlight.ts';
import type { Palette } from '../core/theme.ts';
import type { Comment, Hunk, Layer } from '../core/types.ts';
import { UNSTACKED_ID } from '../core/types.ts';
import { hunkWordDiffs, type Range } from '../core/worddiff.ts';
import type { NavigateTarget, SessionEvent } from '../server/bus.ts';
import type { SubmitRequest, Submitter } from '../server/server.ts';
import type { Session } from '../server/session.ts';
import { buildKeymap, keyString, type RawKey } from './keys.ts';
import { anchorOf, buildRows, type BuiltRows, type Row } from './rows.ts';
import { styleLine, type StyledText } from './render.ts';
import { wrap } from './text.ts';
import {
  RISK_BLURB,
  explainFileStatus,
  explainFileType,
  explainHunkHeader,
  explainLine,
  type Explanation,
} from '../core/glossary.ts';

export const NARROW = 100;
/** Below this the layout goes compact (phones): no pane border, one number column, wrap on. */
export const COMPACT_WIDTH = 60;
export const COMPACT_HEIGHT = 24;
/** Below this nothing useful fits. */
export const MIN_WIDTH = 24;
export const MIN_HEIGHT = 8;
export const SUBMIT_CHOICES: { label: string; event: NonNullable<SubmitRequest['event']> }[] = [
  { label: 'Comment', event: 'COMMENT' },
  { label: 'Approve', event: 'APPROVE' },
  { label: 'Request changes', event: 'REQUEST_CHANGES' },
  { label: 'Draft', event: 'DRAFT' },
];

export type Editor = {
  mode: 'review' | 'ask' | 'edit';
  hunkId: string;
  line?: { side: 'old' | 'new'; number: number };
  commentId?: string;
  text: string;
  pos: number;
};

export type Overlay =
  | { type: 'help'; scroll: number }
  | { type: 'picker'; sel: number }
  | { type: 'confirm'; message: string; onYes: () => void | Promise<void> };

export type ControllerDeps = {
  session: Session;
  config: Config;
  palette: Palette;
  submit?: Submitter;
  /** Write text to the system clipboard (OSC 52). */
  copy: (text: string) => void;
  /** Open $EDITOR with initial text; resolves to the edited text or null when cancelled. */
  runEditor: (initial: string) => Promise<string | null>;
  prioritize: (paths: string[]) => void;
  quit: () => void;
};

export class Controller {
  width = 120;
  height = 40;
  layerIdx = 0;
  cursor = 0;
  scroll = 0;
  focus: 'main' | 'layers' = 'main';
  sideSel = 0;
  sideOverlay = false;
  sideHidden = false;
  /** Set by `w`; until then wrap follows the config, and is on in compact layouts. */
  wrapOverride: boolean | null = null;
  toggled = new Set<string>();
  overlay: Overlay | null = null;
  editor: Editor | null = null;
  flash: { text: string; role: 'muted' | 'riskMed' | 'riskHigh' | 'riskLow' } | null = null;
  tokens = new Map<string, FileTokens>();
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private dataVersion = 0;
  private built: { key: string; value: BuiltRows } | null = null;
  private styled = new Map<string, StyledText>();
  private words = new Map<string, Map<number, Range[]>>();
  private listeners = new Set<() => void>();
  private keymap: Map<string, KeyAction>;
  private unsub: () => void;

  constructor(readonly deps: ControllerDeps) {
    this.keymap = buildKeymap(deps.config.keys);
    this.unsub = deps.session.bus.on((e) => this.onEvent(e));
    this.prioritizeHighlight();
  }

  dispose(): void {
    this.unsub();
  }

  get session(): Session {
    return this.deps.session;
  }

  get palette(): Palette {
    return this.deps.palette;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const l of this.listeners) l();
  }

  // ---------- layout ----------

  get narrow(): boolean {
    return this.width < NARROW;
  }

  get compact(): boolean {
    return this.width < COMPACT_WIDTH || this.height < COMPACT_HEIGHT;
  }

  get tooSmall(): boolean {
    return this.width < MIN_WIDTH || this.height < MIN_HEIGHT;
  }

  get wrap(): boolean {
    return this.wrapOverride ?? (this.deps.config.layout.wrap || this.compact);
  }

  /** Whether the layers pane can sit beside the main pane; otherwise it opens as an overlay. */
  get canDock(): boolean {
    return !this.narrow && !this.compact;
  }

  get sidebarDocked(): boolean {
    return this.canDock && !this.sideHidden;
  }

  get sidebarShown(): boolean {
    return this.sidebarDocked || this.sideOverlay;
  }

  get sideWidth(): number {
    const cfg = this.deps.config.layout.sidebarWidth;
    // As an overlay on a narrow screen the layer list can take the whole width (up to 50 columns).
    if (!this.sidebarDocked) return Math.min(this.width, Math.max(cfg, 50));
    return Math.min(cfg, Math.max(20, this.width - 20));
  }

  /** Inner width of the main pane (inside its border; compact layouts have no border). */
  get paneWidth(): number {
    if (this.compact) return Math.max(10, this.width);
    return Math.max(20, this.width - (this.sidebarDocked ? this.sideWidth : 0) - 2);
  }

  get editorHeight(): number {
    if (!this.editor) return 0;
    const inner = Math.max(4, this.width - 3);
    const lines = (this.editor.text + ' ').split('\n').reduce((n, l) => n + wrap(l, inner).length, 0);
    const max = this.compact ? Math.max(1, Math.min(4, Math.floor(this.height / 4))) : 8;
    return Math.min(max, Math.max(1, lines)) + 2;
  }

  get learning(): boolean {
    return this.session.learning;
  }

  /** Rows of the learning panel, including its border (or title row when compact). */
  get learnHeight(): number {
    if (!this.learning || this.tooSmall) return 0;
    if (this.compact) return this.height >= 16 ? 5 : 3;
    return Math.max(4, Math.min(9, Math.floor(this.height / 4)));
  }

  get bannerHeight(): number {
    return this.session.rec.stale ? 1 : 0;
  }

  /** Inner height of the main pane: header, banner, footer and editor come off; a border or (compact) a title row. */
  get paneHeight(): number {
    const chrome = this.compact ? 1 : 2;
    return Math.max(1, this.height - 1 - this.bannerHeight - 1 - this.editorHeight - this.learnHeight - chrome);
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    if (this.canDock) this.sideOverlay = false;
    this.keepCursorVisible();
    this.notify();
  }

  // ---------- data ----------

  get layers(): Layer[] {
    return this.session.view.layers;
  }

  get layer(): Layer {
    return this.layers[Math.min(this.layerIdx, this.layers.length - 1)]!;
  }

  get rows(): BuiltRows {
    const key = `${this.layerIdx}|${this.layer.id}|${this.paneWidth}|${this.wrap}|${this.compact}|${this.learning}|${this.dataVersion}`;
    if (this.built?.key === key) return this.built.value;
    const s = this.session;
    const value = buildRows({
      layer: this.layer,
      plan: s.view,
      hunks: s.hunkMap,
      reviewed: s.state.reviewed,
      comments: s.state.comments.filter((c) => this.layer.hunks.includes(c.hunkId)),
      toggled: this.toggled,
      width: this.paneWidth,
      wrap: this.wrap,
      compact: this.compact,
      learning: this.learning,
    });
    this.built = { key, value };
    return value;
  }

  private invalidate(): void {
    this.dataVersion++;
    this.built = null;
  }

  currentRow(): Row | undefined {
    return this.rows.rows[this.cursor];
  }

  currentHunkId(): string | undefined {
    const rows = this.rows.rows;
    const r = rows[this.cursor];
    if (r && 'hunkId' in r && r.hunkId) return r.hunkId;
    for (let i = this.cursor + 1; i < rows.length; i++) {
      const x = rows[i]!;
      if ('hunkId' in x && x.hunkId) return x.hunkId;
    }
    return undefined;
  }

  styledFor(hunk: Hunk, idx: number): StyledText {
    const key = `${hunk.id}:${idx}`;
    const hit = this.styled.get(key);
    if (hit) return hit;
    let wd = this.words.get(hunk.id);
    if (!wd) {
      wd = hunkWordDiffs(hunk);
      this.words.set(hunk.id, wd);
    }
    const line = hunk.lines[idx]!;
    const toks = tokensForLine(line, this.tokens.get(hunk.path));
    const st = styleLine(line.text, toks, wd.get(idx), this.palette);
    this.styled.set(key, st);
    return st;
  }

  setTokens(path: string, t: FileTokens): void {
    this.tokens.set(path, t);
    for (const k of [...this.styled.keys()]) {
      const h = this.session.hunkMap.get(k.slice(0, k.indexOf(':')));
      if (h && h.path === path) this.styled.delete(k);
    }
    if (this.layer.hunks.some((id) => this.session.hunkMap.get(id)?.path === path)) this.notify();
  }

  prioritizeHighlight(): void {
    const s = this.session;
    const pathsOf = (l: Layer | undefined) => (l ? l.hunks.map((id) => s.hunkMap.get(id)?.path).filter((p): p is string => !!p) : []);
    const order = [...pathsOf(this.layer), ...pathsOf(this.layers[this.layerIdx + 1])];
    this.deps.prioritize([...new Set(order)]);
  }

  highlightFiles() {
    return groupFiles(this.session.hunks).map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status }));
  }

  // ---------- header / footer data ----------

  get progress() {
    return this.session.progress();
  }

  get draftAskCount(): number {
    return this.session.draftAsks().length;
  }

  unsubmittedReviews(): Comment[] {
    return this.session.state.comments.filter((c) => c.kind === 'review' && !c.postedAt && c.status !== 'resolved');
  }

  layerProgress(l: Layer): { done: number; total: number } {
    const r = this.session.state.reviewed;
    return { done: l.hunks.filter((id) => r[id]).length, total: l.hunks.length };
  }

  // ---------- flash ----------

  say(text: string, role: NonNullable<Controller['flash']>['role'] = 'muted', ms = 3500): void {
    this.flash = { text, role };
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
      this.notify();
    }, ms);
    this.notify();
  }

  // ---------- events from the server ----------

  private onEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'plan': {
        const id = this.layer?.id;
        this.invalidate();
        const idx = this.layers.findIndex((l) => l.id === id);
        this.openLayer(idx >= 0 && id !== UNSTACKED_ID ? idx : 0, false);
        this.say(`agent posted a plan: ${this.session.view.title}`, 'riskLow');
        return;
      }
      case 'comments': {
        this.invalidate();
        this.keepCursorVisible();
        this.notify();
        return;
      }
      case 'reviewed':
        this.invalidate();
        this.notify();
        return;
      case 'navigate':
        this.navigate(e.target);
        return;
      case 'reload':
        this.invalidate();
        this.styled.clear();
        this.words.clear();
        if (this.layerIdx >= this.layers.length) this.layerIdx = 0;
        this.clampCursor();
        this.notify();
        return;
      case 'agent':
        this.notify();
        return;
      case 'learning':
        this.invalidate();
        this.keepCursorVisible();
        this.notify();
        return;
      case 'done':
        return;
    }
  }

  // ---------- navigation ----------

  clampCursor(): void {
    const n = this.rows.rows.length;
    this.cursor = Math.max(0, Math.min(this.cursor, n - 1));
    this.keepCursorVisible();
  }

  keepCursorVisible(): void {
    const h = this.paneHeight;
    const n = this.rows.rows.length;
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + h) this.scroll = this.cursor - h + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, n - h)));
  }

  private firstHunkRow(): number {
    const i = this.rows.rows.findIndex((r) => r.kind === 'hunk' || r.kind === 'collapsed');
    return i < 0 ? 0 : i;
  }

  openLayer(idx: number, toFirstHunk = true): void {
    const n = this.layers.length;
    this.layerIdx = Math.max(0, Math.min(idx, n - 1));
    this.sideSel = this.layerIdx;
    this.cursor = 0;
    this.scroll = 0;
    if (toFirstHunk) this.cursor = 0;
    this.keepCursorVisible();
    this.prioritizeHighlight();
    this.notify();
  }

  rowIndexOfHunk(hunkId: string): number {
    return this.rows.rows.findIndex((r) => (r.kind === 'hunk' || r.kind === 'collapsed') && r.hunkId === hunkId);
  }

  goToHunk(hunkId: string): boolean {
    const li = this.layers.findIndex((l) => l.hunks.includes(hunkId));
    if (li < 0) return false;
    if (li !== this.layerIdx) this.openLayer(li);
    const ri = this.rowIndexOfHunk(hunkId);
    if (ri >= 0) {
      this.cursor = ri;
      // show the hunk header near the top
      this.scroll = Math.max(0, ri - 2);
      this.keepCursorVisible();
    }
    this.notify();
    return true;
  }

  navigate(t: NavigateTarget): void {
    if (t.comment) {
      const c = this.session.state.comments.find((x) => x.id === t.comment);
      if (c && this.goToHunk(c.hunkId)) {
        const ri = this.rows.rows.findIndex((r) => r.kind === 'text' && r.commentId === c.id);
        if (ri >= 0) {
          this.cursor = ri;
          this.keepCursorVisible();
        }
      }
    } else if (t.hunk) this.goToHunk(t.hunk);
    else if (t.layer) {
      const li = this.layers.findIndex((l) => l.id === t.layer);
      if (li >= 0) this.openLayer(li);
    }
    this.say('agent moved the view', 'muted', 2000);
  }

  move(delta: number): void {
    this.cursor += delta;
    this.clampCursor();
    this.notify();
  }

  scrollBy(delta: number): void {
    const n = this.rows.rows.length;
    const h = this.paneHeight;
    this.scroll = Math.max(0, Math.min(this.scroll + delta, Math.max(0, n - h)));
    if (this.cursor < this.scroll) this.cursor = this.scroll;
    if (this.cursor >= this.scroll + h) this.cursor = this.scroll + h - 1;
    this.notify();
  }

  nextHunk(dir: 1 | -1, crossLayers = true): void {
    const rows = this.rows.rows;
    const here = rows[this.cursor];
    const cur = here && 'hunkId' in here ? here.hunkId : undefined;
    for (let i = this.cursor + dir; i >= 0 && i < rows.length; i += dir) {
      const r = rows[i]!;
      if ((r.kind === 'hunk' || r.kind === 'collapsed') && r.hunkId !== cur) {
        this.cursor = i;
        this.keepCursorVisible();
        if (dir === 1) this.scroll = Math.max(this.scroll, Math.min(i - 1, Math.max(0, rows.length - this.paneHeight)));
        this.keepCursorVisible();
        this.notify();
        return;
      }
      if (dir === -1 && (r.kind === 'hunk' || r.kind === 'collapsed') && r.hunkId === cur && i < this.cursor) {
        // first press of p moves to the top of the current hunk
        this.cursor = i;
        this.keepCursorVisible();
        this.notify();
        return;
      }
    }
    if (dir === 1 && crossLayers && this.layerIdx < this.layers.length - 1) {
      this.openLayer(this.layerIdx + 1);
      this.cursor = this.firstHunkRow();
      this.keepCursorVisible();
      this.notify();
    }
  }

  nextUnreviewed(): void {
    const reviewed = this.session.state.reviewed;
    const n = this.layers.length;
    const cur = this.currentHunkId();
    for (let k = 0; k <= n; k++) {
      const li = (this.layerIdx + k) % n;
      const l = this.layers[li]!;
      let start = 0;
      if (k === 0 && cur) {
        const pos = l.hunks.indexOf(cur);
        start = pos >= 0 ? pos + 1 : 0;
      }
      const hunks = k === n ? l.hunks.slice(0, start) : l.hunks.slice(start);
      const found = hunks.find((id) => !reviewed[id]);
      if (found) {
        this.goToHunk(found);
        return;
      }
    }
    this.say('every hunk is reviewed', 'riskLow');
  }

  // ---------- actions ----------

  toggleReviewedHere(): void {
    const id = this.currentHunkId();
    if (!id) return;
    const nowReviewed = this.session.toggleReviewed(id);
    this.invalidate();
    if (nowReviewed) {
      const l = this.layer;
      const pos = l.hunks.indexOf(id);
      const next = l.hunks[pos + 1];
      if (next) {
        this.cursor = this.rowIndexOfHunk(next);
        this.keepCursorVisible();
      } else {
        this.cursor = this.rowIndexOfHunk(id);
        this.keepCursorVisible();
        const done = this.layerProgress(l);
        if (done.done === done.total && this.layerIdx < this.layers.length - 1) this.say('layer complete — ] for the next layer', 'riskLow');
      }
    } else {
      this.cursor = Math.max(0, this.rowIndexOfHunk(id));
      this.keepCursorVisible();
    }
    this.notify();
  }

  toggleLayerReviewed(): void {
    const l = this.layer;
    const all = l.hunks.every((id) => this.session.state.reviewed[id]);
    this.session.setReviewed(l.hunks, !all);
    this.invalidate();
    this.cursor = this.firstHunkRow();
    this.keepCursorVisible();
    this.say(all ? `${l.id} unmarked` : `${l.id} marked reviewed`, 'riskLow');
  }

  toggleExpand(): void {
    const id = this.currentHunkId();
    if (!id) return;
    if (this.toggled.has(id)) this.toggled.delete(id);
    else this.toggled.add(id);
    this.invalidate();
    this.cursor = Math.max(0, this.rowIndexOfHunk(id));
    this.keepCursorVisible();
    this.notify();
  }

  startComment(kind: 'review' | 'ask'): void {
    const row = this.currentRow();
    const hunkId = row && 'hunkId' in row ? row.hunkId : undefined;
    if (!row || !hunkId) {
      this.say('move the cursor onto a hunk line first', 'riskMed');
      return;
    }
    const line = anchorOf(row, this.session.hunkMap);
    this.editor = { mode: kind, hunkId, line, text: '', pos: 0 };
    this.keepCursorVisible();
    this.notify();
  }

  commentHere(): Comment | undefined {
    const row = this.currentRow();
    if (!row || row.kind !== 'text' || !row.commentId) return undefined;
    return this.session.state.comments.find((c) => c.id === row.commentId);
  }

  startEdit(): void {
    const c = this.commentHere();
    if (!c || c.author !== 'human') {
      this.say('put the cursor on one of your comments to edit it', 'riskMed');
      return;
    }
    this.editor = { mode: 'edit', hunkId: c.hunkId, line: c.line, commentId: c.id, text: c.body, pos: c.body.length };
    this.notify();
  }

  deleteHere(): void {
    const c = this.commentHere();
    if (!c || c.author !== 'human' || c.status !== 'draft') {
      this.say('only your draft comments can be deleted', 'riskMed');
      return;
    }
    this.session.deleteComment(c.id);
    this.say('draft deleted');
  }

  resolveHere(): void {
    const c = this.commentHere();
    if (!c) {
      this.say('put the cursor on a comment thread to resolve it', 'riskMed');
      return;
    }
    this.session.resolveThread(c.id);
    this.say('thread resolved', 'riskLow');
  }

  sendAsks(): void {
    const n = this.session.sendAsks();
    if (!n) this.say('no draft asks to send', 'riskMed');
    else this.say(`sent ${n} ask${n === 1 ? '' : 's'} to the agent${this.session.agentWaiting ? '' : ' (no agent is waiting yet)'}`, 'riskLow');
  }

  exportPath(): string {
    return join(this.session.src.gitDir, 'rv', 'export.md');
  }

  exportMarkdown(): void {
    const md = this.session.exportMarkdown();
    const p = this.exportPath();
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, md);
    } catch (e) {
      this.say(`export failed: ${(e as Error).message}`, 'riskHigh');
      return;
    }
    this.deps.copy(md);
    this.say(`exported to clipboard and ${p}`, 'riskLow', 5000);
  }

  openSubmit(): void {
    if (!this.deps.submit || this.session.src.prNumber === undefined) {
      this.say("local ranges can't be submitted to GitHub — press E to export markdown instead", 'riskMed', 5000);
      return;
    }
    this.overlay = { type: 'picker', sel: 0 };
    this.notify();
  }

  private confirmSubmit(choice: (typeof SUBMIT_CHOICES)[number]): void {
    const n = this.unsubmittedReviews().length;
    this.overlay = {
      type: 'confirm',
      message: `Submit ${n} comment${n === 1 ? '' : 's'} to PR #${this.session.src.prNumber} as ${choice.label}? (y/n)`,
      onYes: async () => {
        this.say('submitting…');
        try {
          const r = await this.deps.submit!({ event: choice.event });
          this.say(`submitted: ${r.url}`, 'riskLow', 8000);
        } catch (e) {
          this.say(`submit failed: ${(e as Error).message}`, 'riskHigh', 8000);
        }
      },
    };
    this.notify();
  }

  async reload(): Promise<void> {
    this.say('reloading…');
    try {
      await this.session.reload();
      this.say(this.session.rec.stale ? `reloaded — plan is stale, ${this.session.rec.newHunks.length} new hunks` : 'reloaded', 'riskLow');
    } catch (e) {
      this.say(`reload failed: ${(e as Error).message}`, 'riskHigh');
    }
  }

  requestQuit(): void {
    const asks = this.draftAskCount;
    const reviews = this.unsubmittedReviews().length;
    if (asks || (reviews && this.session.src.prNumber !== undefined)) {
      const parts: string[] = [];
      if (asks) parts.push(`${asks} unsent ask${asks === 1 ? '' : 's'}`);
      if (reviews && this.session.src.prNumber !== undefined) parts.push(`${reviews} unsubmitted review comment${reviews === 1 ? '' : 's'}`);
      this.overlay = { type: 'confirm', message: `You have ${parts.join(' and ')}. Quit anyway? (y/n)`, onYes: () => this.deps.quit() };
      this.notify();
      return;
    }
    this.deps.quit();
  }

  // ---------- learning mode ----------

  toggleLearning(): void {
    this.session.setLearning(!this.learning);
    this.invalidate();
    this.keepCursorVisible();
    this.say(
      this.learning
        ? `learning mode on — the panel explains the cursor line; ${this.deps.config.keys.explain} asks the agent to explain it`
        : 'learning mode off',
      'riskLow',
      5000,
    );
  }

  /** Ask the agent, right away, to explain the cursor line for someone new to code. */
  explainHere(): void {
    const row = this.currentRow();
    const hunkId = row && 'hunkId' in row ? row.hunkId : undefined;
    if (!row || !hunkId) {
      this.say('move the cursor onto a hunk or line first', 'riskMed');
      return;
    }
    const h = this.session.hunkMap.get(hunkId)!;
    const line = anchorOf(row, this.session.hunkMap);
    const code = row.kind === 'line' ? h.lines[row.lineIndex]!.text.trim() : '';
    const body = code
      ? `Explain this line to me like I'm new to code: what it does, why this change might have been made, and any words I should learn.\n\n\`${code}\``
      : `Explain this chunk of ${h.path} to me like I'm new to code: what it does and why it changed.`;
    const waiting = this.session.agentWaiting;
    // Always a beginner question, even when learning mode is off.
    this.session.addHumanComment({ hunkId, line, kind: 'ask', body, send: true, learning: true });
    this.say(waiting ? 'asked the agent to explain this' : 'explain request queued — it reaches the agent when it runs rv wait', 'riskLow');
  }

  /** What the learning panel says about the cursor row. */
  explainCursor(): Explanation {
    const row = this.currentRow();
    const s = this.session;
    const l = this.layer;
    if (!row) return { title: 'learn', lines: ['Nothing here yet.'] };
    if (row.kind === 'line') {
      const h = s.hunkMap.get(row.hunkId)!;
      return explainLine(h.lines[row.lineIndex]!, h);
    }
    if (row.kind === 'hunk') {
      const h = s.hunkMap.get(row.hunkId)!;
      return { title: 'hunk', lines: [explainHunkHeader(h), `Press ${this.deps.config.keys.reviewed} when you've read it to mark it reviewed.`] };
    }
    if (row.kind === 'collapsed') {
      return { title: 'reviewed', lines: [`You marked this chunk reviewed, so it is folded away. Press ${this.deps.config.keys.expand} to open it again.`] };
    }
    if (row.commentId) {
      const c = s.state.comments.find((x) => x.id === row.commentId);
      const what =
        c?.kind === 'ask'
          ? c.status === 'draft'
            ? `a question for the agent that hasn't been sent yet. Press ${this.deps.config.keys.send} to send it.`
            : c.status === 'pending'
              ? 'a question you sent. The agent will answer it here when it next checks in.'
              : 'a question you asked. The agent\'s reply is in the box underneath.'
        : c?.kind === 'reply' ? 'the agent\'s answer to your question.'
        : c?.kind === 'note' ? 'a note the agent left to point out something that isn\'t obvious.'
        : 'a review comment: feedback that goes to GitHub when you submit (P), or into the export (E).';
      return { title: 'comment', lines: [`This box is ${what}`] };
    }
    if (row.key.startsWith('f:') && row.hunkId) {
      const h = s.hunkMap.get(row.hunkId)!;
      return { title: 'file', lines: [explainFileType(h.path), explainFileStatus(h.fileStatus, h.oldPath)] };
    }
    if (row.layerCard) {
      if (l.id === UNSTACKED_ID)
        return {
          title: 'getting started',
          lines: [
            'This is a code review: a careful read of a change before it is accepted. Green + lines were added, red - lines were removed.',
            'No agent has planned this review yet, so every change is listed file by file. An agent can split it into "layers": small steps in a sensible order.',
            `Move with j/k, press ${this.deps.config.keys.explain} on any line to have the agent explain it, and ${this.deps.config.keys.help} for all keys.`,
          ],
        };
      return {
        title: 'layer',
        lines: [
          `A layer is one step of the review: a group of related changes your agent put together, in an order that builds up from the basics.`,
          RISK_BLURB[l.risk],
          `Use ] and [ to move between layers, n to jump to the next chunk.`,
        ],
      };
    }
    return { title: 'learn', lines: ['Move the cursor onto a line to see what it means.'] };
  }

  // ---------- editor ----------

  private async saveEditor(): Promise<void> {
    const ed = this.editor!;
    const body = ed.text.trim();
    this.editor = null;
    if (!body) {
      this.notify();
      return;
    }
    try {
      if (ed.mode === 'edit') this.session.editComment(ed.commentId!, body);
      else {
        const c = this.session.addHumanComment({ hunkId: ed.hunkId, line: ed.line, kind: ed.mode, body });
        if (c.kind === 'ask') this.say(c.status === 'pending' ? 'ask sent to the agent' : `ask saved as a draft — S to send (${this.draftAskCount})`);
      }
    } catch (e) {
      this.say((e as Error).message, 'riskHigh');
    }
    this.notify();
  }

  private async openExternalEditor(): Promise<void> {
    const ed = this.editor!;
    const out = await this.deps.runEditor(ed.text);
    if (out !== null && this.editor === ed) {
      ed.text = out.replace(/\n+$/, '');
      ed.pos = ed.text.length;
    }
    this.notify();
  }

  insertText(s: string): void {
    const ed = this.editor;
    if (!ed) return;
    const clean = s.replace(/\r\n?/g, '\n');
    ed.text = ed.text.slice(0, ed.pos) + clean + ed.text.slice(ed.pos);
    ed.pos += clean.length;
    this.notify();
  }

  private editorKey(k: RawKey): void {
    const ed = this.editor!;
    const key = keyString(k);
    if (key === 'escape') {
      this.editor = null;
      this.notify();
      return;
    }
    if (key === 'return') {
      void this.saveEditor();
      return;
    }
    if (key === 'linefeed' || key === 'ctrl+j') return this.insertText('\n');
    if (key === 'ctrl+e') {
      void this.openExternalEditor();
      return;
    }
    if (key === 'backspace') {
      if (ed.pos > 0) {
        const before = [...ed.text.slice(0, ed.pos)];
        before.pop();
        const b = before.join('');
        ed.text = b + ed.text.slice(ed.pos);
        ed.pos = b.length;
      }
    } else if (key === 'delete') {
      const after = [...ed.text.slice(ed.pos)];
      after.shift();
      ed.text = ed.text.slice(0, ed.pos) + after.join('');
    } else if (key === 'left') ed.pos = Math.max(0, ed.pos - 1);
    else if (key === 'right') ed.pos = Math.min(ed.text.length, ed.pos + 1);
    else if (key === 'home' || key === 'ctrl+a') ed.pos = ed.text.lastIndexOf('\n', ed.pos - 1) + 1;
    else if (key === 'end') {
      const nl = ed.text.indexOf('\n', ed.pos);
      ed.pos = nl < 0 ? ed.text.length : nl;
    } else if (key === 'space') return this.insertText(' ');
    else if (key === 'tab') return this.insertText('  ');
    else if ([...key].length === 1) return this.insertText(key);
    else if (k.sequence && !k.ctrl && !k.meta && [...k.sequence].length === 1 && k.sequence >= ' ') return this.insertText(k.sequence);
    this.notify();
  }

  // ---------- key dispatch ----------

  handleKey(k: RawKey): void {
    if (this.editor) return this.editorKey(k);
    const key = keyString(k);
    if (this.overlay) return this.overlayKey(key);
    if (this.focus === 'layers' && this.sidebarShown) {
      if (key === 'j' || key === 'down') {
        this.sideSel = Math.min(this.layers.length - 1, this.sideSel + 1);
        return this.notify();
      }
      if (key === 'k' || key === 'up') {
        this.sideSel = Math.max(0, this.sideSel - 1);
        return this.notify();
      }
      if (key === 'return') {
        this.openLayer(this.sideSel);
        if (this.sideOverlay) this.sideOverlay = false;
        this.focus = 'main';
        return this.notify();
      }
      if (key === 'escape') {
        this.focus = 'main';
        this.sideOverlay = false;
        return this.notify();
      }
    }
    if (key === 'escape') {
      if (this.sideOverlay) {
        this.sideOverlay = false;
        this.focus = 'main';
        this.notify();
      }
      return;
    }
    const action = this.keymap.get(key);
    if (action) this.run(action);
  }

  private overlayKey(key: string): void {
    const o = this.overlay!;
    if (o.type === 'help') {
      const page = Math.max(1, this.height - 4);
      if (key === 'j' || key === 'down') o.scroll++;
      else if (key === 'k' || key === 'up') o.scroll = Math.max(0, o.scroll - 1);
      else if (key === 'ctrl+d' || key === 'pagedown' || key === 'space') o.scroll += page;
      else if (key === 'ctrl+u' || key === 'pageup') o.scroll = Math.max(0, o.scroll - page);
      else this.overlay = null;
      return this.notify();
    }
    if (o.type === 'picker') {
      if (key === 'escape' || key === 'q') this.overlay = null;
      else if (key === 'j' || key === 'down') o.sel = (o.sel + 1) % SUBMIT_CHOICES.length;
      else if (key === 'k' || key === 'up') o.sel = (o.sel + SUBMIT_CHOICES.length - 1) % SUBMIT_CHOICES.length;
      else if (key === 'return') return this.confirmSubmit(SUBMIT_CHOICES[o.sel]!);
      else {
        const idx = SUBMIT_CHOICES.findIndex((c) => c.label[0]!.toLowerCase() === key.toLowerCase());
        if (idx >= 0) return this.confirmSubmit(SUBMIT_CHOICES[idx]!);
      }
      return this.notify();
    }
    if (o.type === 'confirm') {
      if (key === 'y' || key === 'Y' || key === 'return') {
        this.overlay = null;
        this.notify();
        void o.onYes();
      } else if (key === 'n' || key === 'N' || key === 'escape' || key === 'q') {
        this.overlay = null;
        this.notify();
      }
    }
  }

  run(action: KeyAction): void {
    const half = Math.max(1, Math.floor(this.paneHeight / 2));
    switch (action) {
      case 'down':
        return this.move(1);
      case 'up':
        return this.move(-1);
      case 'halfDown':
        this.scroll += half;
        return this.move(half);
      case 'halfUp':
        this.scroll = Math.max(0, this.scroll - half);
        return this.move(-half);
      case 'top':
        this.cursor = 0;
        return this.move(0);
      case 'bottom':
        this.cursor = this.rows.rows.length - 1;
        return this.move(0);
      case 'nextHunk':
        return this.nextHunk(1);
      case 'prevHunk':
        return this.nextHunk(-1);
      case 'nextLayer':
        if (this.layerIdx < this.layers.length - 1) this.openLayer(this.layerIdx + 1);
        return;
      case 'prevLayer':
        if (this.layerIdx > 0) this.openLayer(this.layerIdx - 1);
        return;
      case 'nextUnreviewed':
        return this.nextUnreviewed();
      case 'focus':
        if (!this.sidebarShown) this.sideOverlay = true;
        this.focus = this.focus === 'main' ? 'layers' : 'main';
        if (this.focus === 'main' && !this.canDock) this.sideOverlay = false;
        this.sideSel = this.layerIdx;
        return this.notify();
      case 'reviewed':
        return this.toggleReviewedHere();
      case 'layerReviewed':
        return this.toggleLayerReviewed();
      case 'expand':
        return this.toggleExpand();
      case 'comment':
        return this.startComment('review');
      case 'ask':
        return this.startComment('ask');
      case 'edit':
        return this.startEdit();
      case 'delete':
        return this.deleteHere();
      case 'resolve':
        return this.resolveHere();
      case 'send':
        return this.sendAsks();
      case 'export':
        return this.exportMarkdown();
      case 'submit':
        return this.openSubmit();
      case 'reload':
        void this.reload();
        return;
      case 'wrap':
        this.wrapOverride = !this.wrap;
        this.clampCursor();
        return this.say(this.wrap ? 'line wrap on' : 'line wrap off');
      case 'sidebar':
        if (!this.canDock) {
          this.sideOverlay = !this.sideOverlay;
          this.focus = this.sideOverlay ? 'layers' : 'main';
        } else {
          this.sideHidden = !this.sideHidden;
          if (this.sideHidden) this.focus = 'main';
        }
        this.sideSel = this.layerIdx;
        this.keepCursorVisible();
        return this.notify();
      case 'help':
        this.overlay = { type: 'help', scroll: 0 };
        return this.notify();
      case 'quit':
        return this.requestQuit();
      case 'learn':
        return this.toggleLearning();
      case 'explain':
        return this.explainHere();
    }
  }

  /** Mouse: wheel over the main pane scrolls it. */
  wheel(target: 'main' | 'layers', dir: 'up' | 'down'): void {
    if (target === 'main') this.scrollBy(dir === 'down' ? 3 : -3);
    else {
      this.sideSel = Math.max(0, Math.min(this.layers.length - 1, this.sideSel + (dir === 'down' ? 1 : -1)));
      this.notify();
    }
  }
}
