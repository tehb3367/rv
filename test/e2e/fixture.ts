// Builds the e2e fixture: an origin with PR #7, a work repo (repo A) and a fresh clone (repo B).
// Dates and identities are fixed so every commit SHA is deterministic.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: bun fixture.ts <dir>');
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: out,
};
function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(['git', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
function write(root: string, rel: string, data: string | Uint8Array) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
}
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';

const origin = join(out, 'origin.git');
const a = join(out, 'repo-a');
const b = join(out, 'repo-b');
mkdirSync(a, { recursive: true });
git(['init', '-q', '--bare', origin], out);
git(['init', '-q'], a);

// ---- base ----
write(a, 'src/api.ts', lines(40, (i) => (i === 0 ? "import { db } from './db';" : `export function handler${i}(id: string) { return db.get('k${i}', id); }`)));
write(a, 'src/view.tsx', lines(40, (i) => (i === 0 ? "import React from 'react';" : `export const Row${i} = () => <div className="row">{'item ${i}'}</div>;`)));
write(a, 'tools/report.py', lines(12, (i) => (i === 0 ? 'import json' : `def report_${i}(x):\n    return json.dumps({"n": ${i}, "x": x})`)));
write(a, 'cmd/main.go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n');
write(a, 'src/legacy_name.ts', "export const legacy = 'unchanged content for a pure rename';\n");
write(a, 'assets/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 2, 3]));
write(a, 'package-lock.json', '{\n  "name": "fixture",\n  "lockfileVersion": 3,\n  "packages": { "": { "version": "1.0.0" } }\n}\n');
git(['add', '-A'], a);
git(['commit', '-q', '-m', 'base'], a);
git(['remote', 'add', 'origin', origin], a);
git(['push', '-q', 'origin', 'main'], a);
git(['remote', 'set-head', 'origin', 'main'], a);

// ---- feature ----
git(['checkout', '-q', '-b', 'feature'], a);
write(a, 'src/api.ts', lines(40, (i) =>
  i === 0 ? "import { db, cache } from './db';"
  : i === 3 ? 'export function handler3(id: string) { return cache.wrap(() => db.get(\'k3\', id)); }'
  : i === 30 ? 'export async function handler30(id: string) { return await db.get(\'k30\', id); }'
  : `export function handler${i}(id: string) { return db.get('k${i}', id); }`));
write(a, 'src/view.tsx', lines(40, (i) =>
  i === 2 ? "export const Row2 = () => <div className=\"row active\">{'item 2'}</div>;"
  : i === 35 ? "export const Row35 = () => <span className=\"row\">{`item ${35}`}</span>;"
  : i === 0 ? "import React from 'react';" : `export const Row${i} = () => <div className="row">{'item ${i}'}</div>;`));
write(a, 'tools/report.py', lines(12, (i) => (i === 0 ? 'import json' : i === 5 ? 'def report_5(x):\n    return json.dumps({"n": 5, "x": x}, indent=2)' : `def report_${i}(x):\n    return json.dumps({"n": ${i}, "x": x})`)));
write(a, 'cmd/main.go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello, rv")\n}\n');
git(['mv', 'src/legacy_name.ts', 'src/modern_name.ts'], a);
write(a, 'assets/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 9, 9, 9]));
write(a, 'package-lock.json', '{\n  "name": "fixture",\n  "lockfileVersion": 3,\n  "packages": { "": { "version": "1.1.0" } }\n}\n');
git(['add', '-A'], a);
git(['commit', '-q', '-m', 'feature'], a);
const head = git(['rev-parse', 'HEAD'], a);
git(['push', '-q', 'origin', 'HEAD:refs/pull/7/head'], a);

// ---- repo B: a fresh clone without the PR head ----
git(['clone', '-q', origin, b], out);
writeFileSync(join(out, 'pr.json'), JSON.stringify({ baseRefName: 'main', headRefOid: head, number: 7, url: 'https://github.com/acme/widgets/pull/7' }));
console.log(JSON.stringify({ a, b, head, prJson: join(out, 'pr.json') }));
