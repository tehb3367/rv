import { flagBool, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit } from './output.ts';

type StatusData = { layers: { id: string; reviewed: number; total: number }[]; pendingAsks: number };

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json']);
  rejectUnknown(p, COMMON);
  const e = await session(p);
  const { data } = await call<StatusData>(e, 'GET', '/status');
  emit(flagBool(p, 'json'), data, () => {
    const rev = data.layers.reduce((a, l) => a + l.reviewed, 0);
    const tot = data.layers.reduce((a, l) => a + l.total, 0);
    return [
      `${rev}/${tot} hunks reviewed, ${data.pendingAsks} pending asks`,
      ...data.layers.map((l) => `  ${l.id}  ${l.reviewed}/${l.total}`),
    ].join('\n');
  });
  return 0;
}
