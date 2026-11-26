import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SavedState } from './types.ts';

export function emptyState(): SavedState {
  return { plan: null, reviewed: {}, comments: [], updatedAt: new Date().toISOString() };
}

export function statePath(gitDir: string, key: string): string {
  return join(gitDir, 'rv', `${key}.json`);
}

/** Write a file atomically: write a temp file next to it, then rename over the target. */
export function atomicWrite(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function coerce(raw: unknown): SavedState {
  const s = emptyState();
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as Partial<SavedState>;
  if (r.plan && typeof r.plan === 'object') s.plan = r.plan;
  if (r.reviewed && typeof r.reviewed === 'object') s.reviewed = { ...r.reviewed };
  if (Array.isArray(r.comments)) s.comments = r.comments;
  if (typeof r.updatedAt === 'string') s.updatedAt = r.updatedAt;
  return s;
}

/** Persists the plan, reviewed marks and comments, with debounced atomic writes. */
export class StateStore {
  private state: SavedState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    readonly path: string,
    private readonly debounceMs = 250,
  ) {
    this.state = StateStore.read(path);
  }

  static read(path: string): SavedState {
    try {
      return coerce(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return emptyState();
    }
  }

  get(): SavedState {
    return this.state;
  }

  update(fn: (s: SavedState) => void): void {
    fn(this.state);
    this.state.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    atomicWrite(this.path, JSON.stringify(this.state, null, 2) + '\n');
  }
}
