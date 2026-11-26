import { RvError } from '../core/git.ts';
import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit } from './output.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json']);
  rejectUnknown(p, [...COMMON, 'layer', 'hunk', 'comment']);
  const target = { layer: flagStr(p, 'layer'), hunk: flagStr(p, 'hunk'), comment: flagStr(p, 'comment') };
  if (!target.layer && !target.hunk && !target.comment) throw new RvError('rv navigate needs --layer, --hunk or --comment');
  const e = await session(p);
  const { data } = await call(e, 'POST', '/navigate', target);
  emit(flagBool(p, 'json'), data, () => 'ok');
  return 0;
}
