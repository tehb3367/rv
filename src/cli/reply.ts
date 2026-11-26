import { RvError } from '../core/git.ts';
import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit, readStdin } from './output.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json', 'stdin']);
  rejectUnknown(p, [...COMMON, 'to', 'body', 'stdin']);
  const to = flagStr(p, 'to');
  if (!to) throw new RvError('--to <commentId> is required');
  const body = flagBool(p, 'stdin') ? await readStdin() : flagStr(p, 'body');
  if (!body || !body.trim()) throw new RvError('--body or --stdin is required');
  const e = await session(p);
  const { data } = await call<{ id: string }>(e, 'POST', `/comments/${encodeURIComponent(to)}/reply`, { body });
  emit(flagBool(p, 'json'), data, () => data.id);
  return 0;
}
