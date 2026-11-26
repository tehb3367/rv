import { flagBool, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit } from './output.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json']);
  rejectUnknown(p, COMMON);
  const e = await session(p);
  const { data } = await call<{ ok: boolean; hunks: number; stale: boolean }>(e, 'POST', '/reload', p.hasRest ? { args: p.rest } : {});
  emit(flagBool(p, 'json'), data, () => `reloaded: ${data.hunks} hunks${data.stale ? ', plan is stale' : ''}`);
  return 0;
}
