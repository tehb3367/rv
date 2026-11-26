import { RvError } from '../core/git.ts';

export type Parsed = {
  positionals: string[];
  flags: Map<string, string | true>;
  /** Everything after a bare `--`. */
  rest: string[];
  hasRest: boolean;
};

/**
 * Parse argv. `booleans` lists flags that take no value; every other `--flag` takes one
 * (`--flag value` or `--flag=value`).
 */
export function parseArgs(argv: string[], booleans: string[] = []): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let rest: string[] = [];
  let hasRest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      rest = argv.slice(i + 1);
      hasRest = true;
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) flags.set(name, a.slice(eq + 1));
      else if (booleans.includes(name)) flags.set(name, true);
      else {
        const v = argv[i + 1];
        if (v === undefined || (v.startsWith('--') && v !== '--')) throw new RvError(`--${name} needs a value`);
        flags.set(name, v);
        i++;
      }
      continue;
    }
    if (a === '-h') {
      flags.set('help', true);
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags, rest, hasRest };
}

export function flagStr(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(p: Parsed, name: string): boolean {
  return p.flags.has(name) && p.flags.get(name) !== 'false';
}

export function flagNum(p: Parsed, name: string, def: number): number {
  const v = flagStr(p, name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RvError(`--${name} must be a non-negative number`);
  return n;
}

export function rejectUnknown(p: Parsed, allowed: string[]): void {
  for (const k of p.flags.keys()) {
    if (!allowed.includes(k) && k !== 'help') throw new RvError(`unknown flag --${k}`);
  }
}
