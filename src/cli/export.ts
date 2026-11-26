import { writeFileSync } from 'node:fs';
import { RvError } from '../core/git.ts';
import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { printJson } from './output.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json', 'md']);
  rejectUnknown(p, [...COMMON, 'md', 'out']);
  if (!flagBool(p, 'md') && !flagBool(p, 'json')) throw new RvError('usage: rv export --md [--out file]');
  const e = await session(p);
  const { data } = await call<{ markdown: string }>(e, 'GET', '/export');
  const out = flagStr(p, 'out');
  if (out) writeFileSync(out, data.markdown);
  if (flagBool(p, 'json')) printJson(out ? { ...data, out } : data);
  else if (!out) process.stdout.write(data.markdown);
  return 0;
}
