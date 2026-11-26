import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError, run, runBytes } from './exec.ts';
import type { DiffSource } from './types.ts';

export class RvError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export async function git(args: string[], cwd: string, allowFail = false): Promise<string> {
  try {
    const r = await run(['git', ...args], { cwd, allowFail });
    return r.code === 0 ? r.stdout : '';
  } catch (e) {
    if (e instanceof CommandError) throw new RvError(e.message);
    throw e;
  }
}

async function gitOk(args: string[], cwd: string): Promise<string | null> {
  const r = await run(['git', ...args], { cwd, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function repoRootOf(cwd: string): Promise<string | null> {
  return gitOk(['rev-parse', '--show-toplevel'], cwd);
}

export async function gitDirOf(cwd: string): Promise<string> {
  const d = await gitOk(['rev-parse', '--absolute-git-dir'], cwd);
  if (!d) throw new RvError('not inside a git repository');
  return d;
}

export async function resolveCommit(ref: string, cwd: string): Promise<string> {
  const sha = await gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  if (!sha) throw new RvError(`unknown revision: ${ref}`);
  return sha;
}

export async function mergeBase(a: string, b: string, cwd: string): Promise<string> {
  const mb = await gitOk(['merge-base', a, b], cwd);
  if (!mb) throw new RvError(`no merge base between ${a} and ${b}`);
  return mb;
}

export async function defaultBaseRef(cwd: string): Promise<string> {
  const head = await gitOk(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd);
  if (head && head !== 'origin/HEAD') return head;
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await gitOk(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`], cwd)) return cand;
  }
  throw new RvError('cannot find a default base: set origin/HEAD (git remote set-head origin -a) or pass a range');
}

async function headName(cwd: string): Promise<string> {
  const name = await gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return name && name !== 'HEAD' ? name : 'HEAD';
}

export function stateKey(baseLabel: string, headLabel: string, prNumber?: number): string {
  if (prNumber !== undefined) return `pr-${prNumber}`;
  return `${baseLabel}..${headLabel}`.replace(/\//g, '_');
}

export type LocalOptions = { range?: string; staged?: boolean; worktree?: boolean; paths?: string[] };

export async function resolveLocalSource(cwd: string, opts: LocalOptions): Promise<DiffSource> {
  const repoRoot = await repoRootOf(cwd);
  if (!repoRoot) throw new RvError('not inside a git repository');
  const gitDir = await gitDirOf(repoRoot);
  const range = opts.range;
  let base: string;
  let head: string;
  let baseLabel: string;
  let headLabel: string;
  if (!range) {
    if (opts.staged) {
      baseLabel = 'HEAD';
      base = await resolveCommit('HEAD', repoRoot);
    } else {
      baseLabel = await defaultBaseRef(repoRoot);
      base = await mergeBase(baseLabel, 'HEAD', repoRoot);
    }
    head = await resolveCommit('HEAD', repoRoot);
    headLabel = await headName(repoRoot);
  } else if (range.includes('...')) {
    const [a, b] = range.split('...');
    const aRef = a || 'HEAD';
    const bRef = b || 'HEAD';
    base = await mergeBase(aRef, bRef, repoRoot);
    head = await resolveCommit(bRef, repoRoot);
    baseLabel = aRef;
    headLabel = bRef === 'HEAD' ? await headName(repoRoot) : bRef;
  } else if (range.includes('..')) {
    const [a, b] = range.split('..');
    const aRef = a || 'HEAD';
    const bRef = b || 'HEAD';
    base = await resolveCommit(aRef, repoRoot);
    head = await resolveCommit(bRef, repoRoot);
    baseLabel = aRef;
    headLabel = bRef === 'HEAD' ? await headName(repoRoot) : bRef;
  } else {
    base = await resolveCommit(range, repoRoot);
    head = await resolveCommit('HEAD', repoRoot);
    baseLabel = range;
    headLabel = await headName(repoRoot);
  }
  let headMode: DiffSource['headMode'] = 'commit';
  if (opts.staged) {
    headMode = 'index';
    headLabel = 'INDEX';
  } else if (opts.worktree) {
    headMode = 'worktree';
    headLabel = 'WORKTREE';
  }
  return {
    repoRoot,
    gitDir,
    base,
    head,
    headMode,
    baseLabel,
    headLabel,
    key: stateKey(baseLabel, headLabel),
    paths: opts.paths ?? [],
  };
}

const DIFF_FLAGS = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-relative',
  '-M',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** Produce the unified diff text for a source. */
export async function loadDiffText(src: DiffSource): Promise<string> {
  const pathArgs = ['--', ...src.paths];
  if (src.headMode === 'index') {
    return git([...DIFF_FLAGS, '--cached', src.base, ...pathArgs], src.repoRoot);
  }
  if (src.headMode === 'worktree') {
    let text = await git([...DIFF_FLAGS, src.base, ...pathArgs], src.repoRoot);
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z', ...pathArgs], src.repoRoot))
      .split('\0')
      .filter(Boolean);
    for (const file of untracked) {
      const r = await run(['git', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file], {
        cwd: src.repoRoot,
        allowFail: true,
      });
      text += r.stdout;
    }
    return text;
  }
  return git([...DIFF_FLAGS, src.base, src.head, ...pathArgs], src.repoRoot);
}

/** Read a file's content on one side of the diff. Returns null when missing. */
export async function readBlob(src: DiffSource, side: 'old' | 'new', path: string): Promise<Uint8Array | null> {
  if (side === 'old') return runBytes(['git', 'show', `${src.base}:${path}`], src.repoRoot);
  if (src.headMode === 'worktree') {
    const full = join(src.repoRoot, path);
    return existsSync(full) ? new Uint8Array(readFileSync(full)) : null;
  }
  if (src.headMode === 'index') return runBytes(['git', 'show', `:${path}`], src.repoRoot);
  return runBytes(['git', 'show', `${src.head}:${path}`], src.repoRoot);
}

/** Blob SHAs for paths on one side, used as cache keys. Missing paths are left out. */
export async function blobShas(src: DiffSource, side: 'old' | 'new', paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  if (side === 'new' && src.headMode === 'worktree') {
    const existing = paths.filter((p) => existsSync(join(src.repoRoot, p)));
    if (existing.length === 0) return out;
    const r = await run(['git', 'hash-object', '--stdin-paths'], {
      cwd: src.repoRoot,
      stdin: existing.join('\n') + '\n',
      allowFail: true,
    });
    const shas = r.stdout.trim().split('\n');
    existing.forEach((p, i) => shas[i] && out.set(p, shas[i]!));
    return out;
  }
  const args =
    side === 'new' && src.headMode === 'index'
      ? ['ls-files', '-s', '-z', '--', ...paths]
      : ['ls-tree', '-r', '-z', side === 'old' ? src.base : src.head, '--', ...paths];
  const r = await run(['git', '-c', 'core.quotePath=false', ...args], { cwd: src.repoRoot, allowFail: true });
  for (const entry of r.stdout.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    const sha = side === 'new' && src.headMode === 'index' ? meta[1] : meta[2];
    if (sha) out.set(path, sha);
  }
  return out;
}
