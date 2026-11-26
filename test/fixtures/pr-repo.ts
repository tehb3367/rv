import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, initRepo, sh, tempDir, write } from '../helpers.ts';

/**
 * A clone of an "origin" that has PR #7 at refs/pull/7/head. The clone does not have the
 * PR head commit locally, so `rv pr` must fetch it.
 */
export function makePrRepo(): { clone: string; head: string; prJson: string; binDir: string; log: string } {
  const work = initRepo();
  write(work, 'src/app.ts', Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
  write(work, 'src/old.py', 'def gone():\n    return 1\n');
  commitAll(work, 'base');
  const origin = tempDir('rv-origin-');
  sh(['git', 'init', '-q', '--bare', '-b', 'main', origin], origin);
  sh(['git', 'remote', 'add', 'origin', origin], work);
  sh(['git', 'push', '-q', 'origin', 'main'], work);
  sh(['git', 'checkout', '-q', '-b', 'pr'], work);
  write(work, 'src/app.ts', Array.from({ length: 20 }, (_, i) => (i === 4 ? 'export const v4 = 40;' : `export const v${i} = ${i};`)).join('\n') + '\nexport const extra = true;\n');
  sh(['git', 'rm', '-q', 'src/old.py'], work);
  const head = commitAll(work, 'pr change');
  sh(['git', 'push', '-q', 'origin', 'HEAD:refs/pull/7/head'], work);
  const clone = tempDir('rv-clone-');
  sh(['git', 'clone', '-q', origin, clone], tempDir());
  const meta = tempDir('rv-gh-');
  const prJson = join(meta, 'pr.json');
  writeFileSync(prJson, JSON.stringify({ baseRefName: 'main', headRefOid: head, number: 7, url: 'https://github.com/acme/widgets/pull/7' }));
  const binDir = join(meta, 'bin');
  mkdirSync(binDir);
  sh(['cp', join(import.meta.dir, 'stub-gh'), join(binDir, 'gh')], meta);
  return { clone, head, prJson, binDir, log: join(meta, 'gh.log') };
}
