// Builds single-file rv binaries with `bun build --compile` for macOS arm64, macOS x64 and Linux x64.
// OpenTUI ships its native renderer as per-platform packages; missing ones are fetched with `npm pack`.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const ROOT = join(import.meta.dir, '..');
const OPENTUI = pkg.dependencies['@opentui/core'];

// Every platform package OpenTUI may import; all but the target's are left external.
const NATIVES = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'linux-x64-musl', 'linux-arm64-musl'].map(
  (p) => `core-${p}`,
);

const ALL = [
  { target: 'bun-darwin-arm64', native: 'core-darwin-arm64', out: 'rv-darwin-arm64' },
  { target: 'bun-darwin-x64', native: 'core-darwin-x64', out: 'rv-darwin-x64' },
  { target: 'bun-linux-x64', native: 'core-linux-x64', out: 'rv-linux-x64' },
];

function sh(cmd: string[], cwd = ROOT): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

function ensureNative(name: string): void {
  const dest = join(ROOT, 'node_modules', '@opentui', name);
  if (existsSync(join(dest, 'package.json'))) return;
  const tmp = mkdtempSync(join(tmpdir(), 'rv-native-'));
  console.log(`fetching @opentui/${name}@${OPENTUI}`);
  sh(['npm', 'pack', '--silent', `@opentui/${name}@${OPENTUI}`], tmp);
  const tgz = [...new Bun.Glob('*.tgz').scanSync(tmp)][0];
  if (!tgz) throw new Error(`npm pack produced nothing for ${name}`);
  mkdirSync(dest, { recursive: true });
  sh(['tar', '-xzf', join(tmp, tgz), '-C', dest, '--strip-components=1']);
  rmSync(tmp, { recursive: true, force: true });
}

const only = process.argv.slice(2);
const targets = only.length ? ALL.filter((t) => only.some((o) => t.out.includes(o) || t.target.includes(o))) : ALL;
mkdirSync(join(ROOT, 'dist'), { recursive: true });
for (const t of targets) {
  ensureNative(t.native);
  console.log(`building dist/${t.out} (${t.target})`);
  sh([
    'bun', 'build', '--compile', '--minify',
    `--target=${t.target}`,
    ...NATIVES.filter((n) => n !== t.native).flatMap((n) => ['--external', `@opentui/${n}`]),
    'src/index.ts', 'src/core/highlight-worker.ts',
    '--outfile', join('dist', t.out),
  ]);
}
