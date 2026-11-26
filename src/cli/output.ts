export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/** Print JSON with --json, otherwise the human-readable text. */
export function emit(json: boolean, data: unknown, human: () => string): void {
  if (json) printJson(data);
  else {
    const s = human();
    process.stdout.write(s.endsWith('\n') || s === '' ? s : s + '\n');
  }
}

export async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}
