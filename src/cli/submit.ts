import { RvError } from '../core/git.ts';
import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit } from './output.ts';

const EVENTS: Record<string, string> = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', draft: 'DRAFT' };

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json', 'include-asks']);
  rejectUnknown(p, [...COMMON, 'event', 'include-asks']);
  const evArg = (flagStr(p, 'event') ?? 'comment').toLowerCase();
  const event = EVENTS[evArg] ?? (Object.values(EVENTS).includes(evArg.toUpperCase()) ? evArg.toUpperCase() : undefined);
  if (!event) throw new RvError('--event must be comment, approve, request-changes or draft');
  const e = await session(p);
  const { data } = await call<{ url: string }>(e, 'POST', '/submit', { event, includeAsks: flagBool(p, 'include-asks') });
  emit(flagBool(p, 'json'), data, () => data.url);
  return 0;
}
