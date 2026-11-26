import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit } from './output.ts';

type ReviewData = {
  range: string;
  files: { path: string; status: string; hunks: { id: string; header: string; added: number; removed: number; lines?: string[] }[] }[];
};

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json', 'patch', 'unreviewed']);
  rejectUnknown(p, [...COMMON, 'patch', 'unreviewed', 'layer']);
  const e = await session(p);
  const q = new URLSearchParams();
  if (flagBool(p, 'patch')) q.set('patch', '1');
  if (flagBool(p, 'unreviewed')) q.set('unreviewed', '1');
  const layer = flagStr(p, 'layer');
  if (layer) q.set('layer', layer);
  const { data } = await call<ReviewData>(e, 'GET', `/review?${q}`);
  emit(flagBool(p, 'json'), data, () => {
    const out: string[] = [`range ${data.range}`];
    for (const f of data.files) {
      out.push(`${f.path}  ${f.status}`);
      for (const h of f.hunks) {
        out.push(`  ${h.id}  ${h.header}  +${h.added} -${h.removed}`);
        for (const l of h.lines ?? []) out.push(`    ${l}`);
      }
    }
    return out.join('\n');
  });
  return 0;
}
