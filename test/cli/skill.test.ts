import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from '../helpers.ts';

const RV = resolve(import.meta.dir, '../../src/index.ts');

test('rv skill path extracts SKILL.md with the rv-review frontmatter', () => {
  const home = tempDir();
  const r = Bun.spawnSync(['bun', RV, 'skill', 'path'], { env: { ...process.env, RV_HOME: home } });
  expect(r.exitCode).toBe(0);
  const p = r.stdout.toString().trim();
  expect(p).toBe(join(home, 'skill', 'SKILL.md'));
  const text = readFileSync(p, 'utf8');
  expect(text.startsWith('---\nname: rv-review\ndescription: Use when a live rv session is open for this repo')).toBe(true);
  expect(text).toContain('rv stack set --stdin');
  expect(text).toContain('Never drop real hunks');
  expect(readFileSync(join(home, 'skill', '.version'), 'utf8').trim()).toBe('1.0.0');
});

test('rv --version and help', () => {
  expect(Bun.spawnSync(['bun', RV, '--version']).stdout.toString().trim()).toBe('1.0.0');
  expect(Bun.spawnSync(['bun', RV, 'help']).stdout.toString()).toContain('rv stack set --stdin');
  expect(Bun.spawnSync(['bun', RV, 'bogus']).exitCode).toBe(1);
});
