// A scripted agent that drives rv only through the CLI, the way the skill tells real agents to.
const RV = process.env.RV_CMD ?? 'rv';

async function rv(args: string[], stdin?: string) {
  const p = Bun.spawn([RV, ...args], { stdin: stdin ? Buffer.from(stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err, json: out.trim() ? JSON.parse(out) : null };
}

function fail(msg: string): never {
  console.error(`fake-agent: ${msg}`);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'plan') {
  const review = await rv(['review', '--json', '--patch']);
  if (review.code !== 0) fail(`rv review failed: ${review.err}`);
  type F = { path: string; status: string; hunks: { id: string }[] };
  const files = review.json.files as F[];
  const ids = (pred: (f: F) => boolean) => files.filter(pred).flatMap((f) => f.hunks.map((h) => h.id));
  const ts = ids((f) => /\.tsx?$/.test(f.path) && f.status === 'modified');
  const pyGo = ids((f) => /\.(py|go)$/.test(f.path));
  const mech = ids((f) => !(/\.tsx?$/.test(f.path) && f.status === 'modified') && !/\.(py|go)$/.test(f.path));
  const plan = (drop: boolean) => ({
    version: 1,
    title: 'Cache lookups and polish the UI',
    layers: [
      { id: 'L1', group: 'Core', title: 'Cached API and active rows', why: 'Wraps hot lookups in the cache and marks active rows. Check the cache key per handler.', risk: 'med', hunks: ts },
      { id: 'L2', group: 'Tools', title: 'Report formatting and greeting', why: 'Pretty-printed reports and a friendlier greeting.', risk: 'low', dependsOn: ['L1'], hunks: drop ? pyGo.slice(1) : pyGo },
      { id: 'L3', group: 'Mechanical', title: 'Rename, logo and lockfile', why: 'No logic: a rename, a new logo and the lockfile bump.', risk: 'low', hunks: mech },
    ],
  });
  const bad = await rv(['stack', 'set', '--stdin', '--json'], JSON.stringify(plan(true)));
  if (bad.code !== 2) fail(`expected exit 2 for a plan missing a hunk, got ${bad.code}`);
  const missing = (bad.json.missing as { id: string }[]).map((m) => m.id);
  if (missing.length !== 1 || missing[0] !== pyGo[0]) fail(`expected missing [${pyGo[0]}], got ${JSON.stringify(missing)}`);
  console.log(`rejected plan: missing ${missing[0]}`);
  const good = await rv(['stack', 'set', '--stdin', '--json'], JSON.stringify(plan(false)));
  if (good.code !== 0) fail(`corrected plan rejected: ${good.out}${good.err}`);
  console.log(`plan accepted: ${ts.length + pyGo.length + mech.length} hunks in 3 layers`);
} else if (cmd === 'wait-reply') {
  const w = await rv(['wait', '--timeout', '60', '--json']);
  if (w.code !== 0 || w.json.event !== 'asks') fail(`expected asks, got ${w.out}${w.err}`);
  for (const ask of w.json.asks) {
    console.log(`ask: ${ask.body}`);
    const r = await rv(['reply', '--to', ask.id, '--body', 'Because handler3 is the hot path.', '--json']);
    if (r.code !== 0) fail(`reply failed: ${r.err}`);
  }
} else fail(`unknown command ${cmd}`);
