import { run } from './exec.ts';
import { RvError, gitDirOf, mergeBase, repoRootOf, stateKey } from './git.ts';
import type { DiffSource } from './types.ts';

export const GH_LOGIN_HINT = 'gh is not authenticated. Run `gh auth login` and try again.';

export async function ghAuthOk(cwd: string): Promise<boolean> {
  try {
    const r = await run(['gh', 'auth', 'status'], { cwd, allowFail: true });
    return r.code === 0;
  } catch {
    return false;
  }
}

export type PrInfo = { baseRefName: string; headRefOid: string; number: number; url: string };

export function parsePrArg(arg: string): string {
  const m = /\/pull\/(\d+)/.exec(arg);
  if (m) return arg; // gh accepts full URLs
  if (/^#?\d+$/.test(arg)) return arg.replace(/^#/, '');
  throw new RvError(`not a PR number or URL: ${arg}`);
}

export function repoFromUrl(url: string): string | undefined {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

async function hasCommit(sha: string, cwd: string): Promise<boolean> {
  const r = await run(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd, allowFail: true });
  return r.code === 0;
}

export async function prView(arg: string, cwd: string): Promise<PrInfo> {
  const r = await run(['gh', 'pr', 'view', parsePrArg(arg), '--json', 'baseRefName,headRefOid,number,url'], {
    cwd,
    allowFail: true,
  });
  if (r.code !== 0) throw new RvError(`gh pr view failed: ${r.stderr.trim()}`);
  try {
    return JSON.parse(r.stdout) as PrInfo;
  } catch {
    throw new RvError('gh pr view returned invalid JSON');
  }
}

export async function resolvePrSource(arg: string, cwd: string, paths: string[] = []): Promise<DiffSource> {
  const repoRoot = await repoRootOf(cwd);
  if (!repoRoot) throw new RvError('not inside a git repository');
  if (!(await ghAuthOk(repoRoot))) throw new RvError(GH_LOGIN_HINT);
  const gitDir = await gitDirOf(repoRoot);
  const pr = await prView(arg, repoRoot);
  if (!(await hasCommit(pr.headRefOid, repoRoot))) {
    await run(['git', 'fetch', '--quiet', 'origin', `pull/${pr.number}/head`], { cwd: repoRoot, allowFail: true });
    if (!(await hasCommit(pr.headRefOid, repoRoot))) {
      throw new RvError(`could not fetch PR head ${pr.headRefOid}`);
    }
  }
  const baseRef = `origin/${pr.baseRefName}`;
  const baseOk = await run(['git', 'rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
    cwd: repoRoot,
    allowFail: true,
  });
  if (baseOk.code !== 0) {
    await run(['git', 'fetch', '--quiet', 'origin', `${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`], {
      cwd: repoRoot,
      allowFail: true,
    });
  }
  const base = await mergeBase(baseRef, pr.headRefOid, repoRoot);
  return {
    repoRoot,
    gitDir,
    base,
    head: pr.headRefOid,
    headMode: 'commit',
    baseLabel: pr.baseRefName,
    headLabel: pr.headRefOid.slice(0, 8),
    key: stateKey('', '', pr.number),
    paths,
    prNumber: pr.number,
    prUrl: pr.url,
    prRepo: repoFromUrl(pr.url),
  };
}
