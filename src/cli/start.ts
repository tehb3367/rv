import { createHash } from 'node:crypto';
import { loadConfig, type Config } from '../core/config.ts';
import { RvError, loadDiffText, resolveLocalSource, type LocalOptions } from '../core/git.ts';
import { resolvePrSource } from '../core/github.ts';
import { log } from '../core/paths.ts';
import type { DiffSource } from '../core/types.ts';
import { startServer, type RunningServer, type Submitter } from '../server/server.ts';
import { Session, type Resolver } from '../server/session.ts';
import { flagBool, flagStr, parseArgs, rejectUnknown, type Parsed } from './args.ts';

const BOOLS = ['staged', 'worktree', 'watch', 'transparent', 'headless', 'json'];
const VALUES = ['theme'];

export function localOptionsFrom(p: Parsed): LocalOptions {
  return {
    range: p.positionals[0],
    staged: flagBool(p, 'staged'),
    worktree: flagBool(p, 'worktree'),
    paths: p.rest,
  };
}

export type StartContext = {
  session: Session;
  server: RunningServer;
  config: Config;
  watch: boolean;
  shutdown: (code?: number) => Promise<never>;
};

export type UiRunner = (ctx: StartContext) => Promise<void>;

async function diffHash(src: DiffSource): Promise<string> {
  return createHash('sha1').update(src.base + src.head).update(await loadDiffText(src)).digest('hex');
}

function startWatch(session: Session, resolver: Resolver): () => void {
  let busy = false;
  let last: string | null = null;
  void diffHash(session.src).then((h) => (last = h));
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const src = await resolver();
      const h = await diffHash(src);
      if (last && h !== last) await session.reload();
      last = h;
    } catch (e) {
      log(`watch: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, 1500);
  return () => clearInterval(timer);
}

async function launch(
  src: DiffSource,
  resolver: Resolver,
  p: Parsed,
  makeSubmitter: SubmitterFactory | undefined,
  ui: UiRunner | null,
): Promise<number> {
  const config = loadConfig(src.repoRoot, {
    theme: flagStr(p, 'theme'),
    transparent: p.flags.has('transparent') ? flagBool(p, 'transparent') : undefined,
  });
  const session = await Session.open(src, resolver, { autoSend: config.asks.autoSend });
  const server = startServer(session, { submit: makeSubmitter?.(session) });
  const watch = flagBool(p, 'watch');
  const stopWatch = watch ? startWatch(session, resolver) : () => {};
  session.bus.on((e) => {
    if (e.type === 'reload') {
      // keep the registry entry's range current
      server.entry.base = session.src.base;
      server.entry.head = session.src.headMode === 'commit' ? session.src.head : session.src.headLabel;
    }
  });
  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true;
      stopWatch();
      await server.stop();
      session.flush();
    }
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGHUP', () => void shutdown(0));
  const ctx: StartContext = { session, server, config, watch, shutdown };
  if (!ui || flagBool(p, 'headless')) {
    if (flagBool(p, 'json')) process.stdout.write(JSON.stringify({ id: server.entry.id, port: server.entry.port }) + '\n');
    else process.stderr.write(`rv session ${server.entry.id} on ${server.url} (headless, Ctrl-C to stop)\n`);
    await new Promise(() => {});
  }
  await ui!(ctx);
  return shutdown(0);
}

export async function runDiff(argv: string[], ui: UiRunner | null): Promise<number> {
  const p = parseArgs(argv, BOOLS);
  rejectUnknown(p, [...BOOLS, ...VALUES]);
  if (p.positionals.length > 1) throw new RvError('rv diff takes at most one range; put paths after --');
  if (flagBool(p, 'staged') && flagBool(p, 'worktree')) throw new RvError('--staged and --worktree cannot be combined');
  const cwd = process.cwd();
  const base = localOptionsFrom(p);
  const resolver: Resolver = async (args) => {
    if (!args) return resolveLocalSource(cwd, base);
    const np = parseArgs(args, BOOLS);
    return resolveLocalSource(cwd, localOptionsFrom(np));
  };
  const src = await resolver();
  return launch(src, resolver, p, undefined, ui);
}

export type SubmitterFactory = (session: Session) => Submitter;

export async function runPr(argv: string[], ui: UiRunner | null, makeSubmitter?: SubmitterFactory): Promise<number> {
  const p = parseArgs(argv, BOOLS);
  rejectUnknown(p, [...BOOLS, ...VALUES]);
  const arg = p.positionals[0];
  if (!arg) throw new RvError('usage: rv pr <number or url>');
  if (flagBool(p, 'staged')) throw new RvError('--staged does not apply to rv pr');
  const cwd = process.cwd();
  const resolver: Resolver = async (args) => {
    const np = args ? parseArgs(args, BOOLS) : p;
    return resolvePrSource(np.positionals[0] ?? arg, cwd, np.rest);
  };
  const src = await resolver();
  return launch(src, resolver, p, makeSubmitter, ui);
}
