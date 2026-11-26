import { RvError } from '../core/git.ts';
import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit, readStdin } from './output.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json', 'stdin']);
  if (p.positionals[0] !== 'add') throw new RvError('usage: rv note add --hunk <id> --body <md> [--line new:42]');
  rejectUnknown(p, [...COMMON, 'hunk', 'body', 'line', 'stdin']);
  const hunk = flagStr(p, 'hunk');
  if (!hunk) throw new RvError('--hunk is required');
  const body = flagBool(p, 'stdin') ? await readStdin() : flagStr(p, 'body');
  if (!body || !body.trim()) throw new RvError('--body or --stdin is required');
  const e = await session(p);
  const { data } = await call<{ id: string }>(e, 'POST', '/comments', { kind: 'note', hunkId: hunk, body, line: flagStr(p, 'line') });
  emit(flagBool(p, 'json'), data, () => data.id);
  return 0;
}
