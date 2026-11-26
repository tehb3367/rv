import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function rvHome(): string {
  return process.env.RV_HOME ?? join(homedir(), '.rv');
}

export function sessionsDir(): string {
  return join(rvHome(), 'sessions');
}

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'rv');
}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'rv');
}

/** Append a line to ~/.rv/rv.log. Never throws. */
export function log(message: string): void {
  try {
    mkdirSync(rvHome(), { recursive: true });
    appendFileSync(join(rvHome(), 'rv.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ignore */
  }
}
