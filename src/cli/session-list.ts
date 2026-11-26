import { listLive } from '../core/registry.ts';
import { flagBool, parseArgs, rejectUnknown } from './args.ts';
import { emit } from './output.ts';

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json']);
  const sub = p.positionals[0] ?? 'list';
  if (sub !== 'list') throw new Error(`unknown subcommand: rv session ${sub}`);
  rejectUnknown(p, ['json']);
  const live = listLive().map((e) => ({
    id: e.id,
    repoRoot: e.repoRoot,
    base: e.base,
    head: e.head,
    ...(e.prNumber !== undefined ? { prNumber: e.prNumber } : {}),
  }));
  emit(flagBool(p, 'json'), live, () =>
    live.length
      ? live.map((e) => `${e.id}  ${e.repoRoot}  ${e.base.slice(0, 8)}..${e.head.slice(0, 8)}${e.prNumber ? `  PR #${e.prNumber}` : ''}`).join('\n')
      : 'no live rv sessions',
  );
  return 0;
}
