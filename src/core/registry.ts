import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from './paths.ts';
import { atomicWrite } from './state.ts';

export type RegistryEntry = {
  id: string;
  pid: number;
  port: number;
  token: string;
  repoRoot: string;
  base: string;
  head: string;
  prNumber?: number;
  startedAt: string;
  version: string;
};

export function entryPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

export function writeEntry(e: RegistryEntry): void {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  const p = entryPath(e.id);
  atomicWrite(p, JSON.stringify(e, null, 2) + '\n', 0o600);
  chmodSync(p, 0o600);
}

export function removeEntry(id: string): void {
  try {
    unlinkSync(entryPath(id));
  } catch {
    /* already gone */
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live sessions. Entries whose pid is dead are removed. */
export function listLive(): RegistryEntry[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: RegistryEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    let e: RegistryEntry;
    try {
      e = JSON.parse(readFileSync(p, 'utf8')) as RegistryEntry;
    } catch {
      continue;
    }
    if (!e || typeof e.pid !== 'number' || !pidAlive(e.pid)) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
      continue;
    }
    out.push(e);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function randomId(prefix: string, len = 8): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = prefix;
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
}
