import { RvError, repoRootOf } from '../core/git.ts';
import { listLive, type RegistryEntry } from '../core/registry.ts';
import { VERSION } from '../version.ts';
import { VERSION_HEADER } from '../server/server.ts';

export const EXIT = { ok: 0, error: 1, validation: 2, noSession: 3, auth: 4 } as const;

export async function discover(sessionId?: string, cwd = process.cwd()): Promise<RegistryEntry> {
  const live = listLive();
  if (sessionId) {
    const e = live.find((x) => x.id === sessionId);
    if (!e) throw new RvError(`no live rv session with id ${sessionId}`, EXIT.noSession);
    return e;
  }
  const root = await repoRootOf(cwd);
  const matches = root ? live.filter((e) => e.repoRoot === root) : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const list = matches.map((e) => `  ${e.id}  ${e.base.slice(0, 8)}..${e.head.slice(0, 8)}${e.prNumber ? `  PR #${e.prNumber}` : ''}`);
    throw new RvError(`several rv sessions are live for this repo, pick one with --session <id>:\n${list.join('\n')}`);
  }
  throw new RvError('no live rv session for this repo, start one with rv diff or rv pr', EXIT.noSession);
}

export type CallResult<T> = { status: number; data: T };

export async function call<T = unknown>(
  entry: RegistryEntry,
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<CallResult<T>> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${entry.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${entry.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new RvError('timed out talking to the rv session');
    throw new RvError('the rv session is not responding (did it exit?)', EXIT.noSession);
  }
  if (res.status === 401) throw new RvError('the rv session rejected the token', EXIT.auth);
  const v = res.headers.get(VERSION_HEADER);
  if (v && v !== VERSION) throw new RvError(`version mismatch: this rv is ${VERSION}, the session is ${v}`, EXIT.auth);
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  if (res.status >= 400 && res.status !== 422) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : text;
    throw new RvError(msg);
  }
  return { status: res.status, data: data as T };
}
