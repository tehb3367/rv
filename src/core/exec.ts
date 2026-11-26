export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export type RunOptions = { cwd?: string; stdin?: string; allowFail?: boolean; env?: Record<string, string> };

export async function run(cmd: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) {
    throw new CommandError(`${cmd.join(' ')} failed (${code}): ${stderr.trim()}`, code, stderr);
  }
  return { stdout, stderr, code };
}

export async function runBytes(cmd: string[], cwd?: string): Promise<Uint8Array | null> {
  const proc = Bun.spawn(cmd, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  return code === 0 ? new Uint8Array(buf) : null;
}
