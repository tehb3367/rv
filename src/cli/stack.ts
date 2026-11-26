import { readFileSync } from 'node:fs';
import { RvError } from '../core/git.ts';
import { flagBool, flagStr, parseArgs, rejectUnknown } from './args.ts';
import { EXIT, call } from './client.ts';
import { COMMON, session } from './common.ts';
import { emit, printJson, readStdin } from './output.ts';
import type { Plan } from '../core/types.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json', 'stdin']);
  const sub = p.positionals[0];
  if (sub === 'get') {
    rejectUnknown(p, COMMON);
    const e = await session(p);
    const { data } = await call<{ plan: Plan | null; stale: boolean; newHunks: string[] }>(e, 'GET', '/stack');
    emit(flagBool(p, 'json'), data, () => {
      if (!data.plan) return 'no plan yet (unstacked)';
      const out = [`${data.plan.title}${data.stale ? `  (stale, ${data.newHunks.length} new hunks)` : ''}`];
      for (const l of data.plan.layers) out.push(`  ${l.id}  ${l.risk.padEnd(4)}  ${l.title}  (${l.hunks.length} hunks)`);
      return out.join('\n');
    });
    return 0;
  }
  if (sub === 'set') {
    rejectUnknown(p, [...COMMON, 'stdin', 'file']);
    const file = flagStr(p, 'file');
    if (!file && !flagBool(p, 'stdin')) throw new RvError('rv stack set needs --stdin or --file <plan.json>');
    const text = file ? readFileSync(file, 'utf8') : await readStdin();
    const e = await session(p);
    const { status, data } = await call(e, 'PUT', '/stack', text);
    if (status === 422) {
      printJson(data); // the validation JSON is the useful output for agents either way
      return EXIT.validation;
    }
    emit(flagBool(p, 'json'), data, () => 'plan installed');
    return 0;
  }
  throw new RvError('usage: rv stack get | rv stack set --stdin | --file <plan.json>');
}
