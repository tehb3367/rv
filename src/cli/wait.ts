import { flagBool, flagNum, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit } from './output.ts';
import type { Comment } from '../core/types.ts';

type WaitData = { event: 'asks'; asks: Comment[] } | { event: 'done' } | { event: 'timeout' };

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json']);
  rejectUnknown(p, [...COMMON, 'timeout']);
  const timeout = flagNum(p, 'timeout', 600);
  const e = await session(p);
  const { data } = await call<WaitData>(e, 'GET', `/wait?timeout=${timeout}`, undefined, { timeoutMs: (timeout + 30) * 1000 });
  emit(flagBool(p, 'json'), data, () => {
    if (data.event !== 'asks') return data.event;
    return data.asks
      .map((a) => `ask ${a.id} on ${a.hunkId}${a.line ? ` ${a.line.side}:${a.line.number}` : ''}\n  ${a.body.replace(/\n/g, '\n  ')}`)
      .join('\n');
  });
  return 0;
}
