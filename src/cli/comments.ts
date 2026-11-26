import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit } from './output.ts';
import type { Comment } from '../core/types.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json', 'pending']);
  rejectUnknown(p, [...COMMON, 'kind', 'pending']);
  const q = new URLSearchParams();
  const kind = flagStr(p, 'kind');
  if (kind) q.set('kind', kind);
  if (flagBool(p, 'pending')) q.set('pending', '1');
  const e = await session(p);
  const { data } = await call<Comment[]>(e, 'GET', `/comments?${q}`);
  emit(flagBool(p, 'json'), data, () =>
    data.length
      ? data
          .map((c) => `${c.id}  ${c.kind}/${c.status}  ${c.author}  ${c.hunkId}${c.line ? ` ${c.line.side}:${c.line.number}` : ''}\n  ${c.body.replace(/\n/g, '\n  ')}`)
          .join('\n')
      : 'no comments',
  );
  return 0;
}
