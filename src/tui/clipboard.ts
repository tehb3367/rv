/** OSC 52 clipboard escape, wrapped for tmux passthrough when needed. */
export function osc52(text: string, env: Record<string, string | undefined> = process.env): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const seq = `\x1b]52;c;${b64}\x07`;
  if (env.TMUX) return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
  return seq;
}
