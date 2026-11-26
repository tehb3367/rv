import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RvError } from '../core/git.ts';
import { rvHome } from '../core/paths.ts';
import { VERSION } from '../version.ts';
import skillText from '../../skill/SKILL.md' with { type: 'text' };
import { flagBool, parseArgs } from './args.ts';
import { emit } from './output.ts';

/** Extract the bundled SKILL.md to ~/.rv/skill/SKILL.md, refreshing it when the version changes. */
export function extractSkill(): string {
  const dir = join(rvHome(), 'skill');
  const file = join(dir, 'SKILL.md');
  const stamp = join(dir, '.version');
  const current = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (current !== VERSION || !existsSync(file) || readFileSync(file, 'utf8') !== skillText) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, skillText);
    writeFileSync(stamp, VERSION + '\n');
  }
  return file;
}

export async function run(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ['json']);
  if (p.positionals[0] !== 'path') throw new RvError('usage: rv skill path');
  const path = extractSkill();
  emit(flagBool(p, 'json'), { path }, () => path);
  return 0;
}
