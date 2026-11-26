import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tempDir(prefix = 'rv-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function sh(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

export function write(root: string, rel: string, content: string | Uint8Array): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function initRepo(): string {
  const dir = tempDir('rv-repo-');
  sh(['git', 'init', '-q', '-b', 'main'], dir);
  sh(['git', 'config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

export function commitAll(dir: string, msg: string): string {
  sh(['git', 'add', '-A'], dir);
  sh(['git', 'commit', '-q', '-m', msg, '--allow-empty'], dir);
  return sh(['git', 'rev-parse', 'HEAD'], dir).trim();
}
