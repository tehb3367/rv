import { basename } from 'node:path';
import { languageFor } from './highlight.ts';
import type { DiffLine, FileStatus, Hunk, Risk } from './types.ts';

/**
 * Plain-language explanations for learning mode: what a diff shows, what kind of file this is, and what
 * the code words on a line mean. Written for people who don't read code yet. No UI imports.
 */

export type Term = { term: string; meaning: string };

type Family = 'js' | 'python' | 'go' | 'rust' | 'shell' | 'css' | 'html' | 'sql' | 'data' | 'other';

const LANGUAGE_BLURBS: Record<string, { name: string; blurb: string; family: Family }> = {
  typescript: { name: 'TypeScript', family: 'js', blurb: 'TypeScript is JavaScript with "types" added: labels that say what kind of value something holds (text, number, list…), so mistakes are caught before the program runs. It is used for websites, servers and tools.' },
  tsx: { name: 'TypeScript + JSX', family: 'js', blurb: 'A TypeScript file that also describes user-interface pieces with HTML-like tags (JSX), usually for a React web app. The <tags> become things on screen.' },
  javascript: { name: 'JavaScript', family: 'js', blurb: 'JavaScript is the language of web pages, and with Node or Bun it also runs servers and tools.' },
  jsx: { name: 'JavaScript + JSX', family: 'js', blurb: 'JavaScript that describes user-interface pieces with HTML-like tags (JSX), usually for a React web app.' },
  python: { name: 'Python', family: 'python', blurb: 'Python is a general-purpose language known for being readable. Indentation (the spaces at the start of a line) decides which lines belong together.' },
  go: { name: 'Go', family: 'go', blurb: 'Go is a language from Google used for servers and command-line tools. It is simple on purpose and compiles into a single program file.' },
  rust: { name: 'Rust', family: 'rust', blurb: 'Rust is a language for fast, low-level programs that checks very strictly that memory is used safely.' },
  shellscript: { name: 'shell script', family: 'shell', blurb: 'A shell script is a list of terminal commands saved in a file so they can be run in one go.' },
  css: { name: 'CSS', family: 'css', blurb: 'CSS describes how a web page looks: colours, sizes, spacing and layout.' },
  html: { name: 'HTML', family: 'html', blurb: 'HTML describes the structure of a web page: headings, paragraphs, buttons, images.' },
  sql: { name: 'SQL', family: 'sql', blurb: 'SQL is the language for asking a database for data, or changing the data in it.' },
  json: { name: 'JSON', family: 'data', blurb: 'JSON is a plain-text format for data: names paired with values, inside { } braces and [ ] lists. Programs read it as settings or data.' },
  yaml: { name: 'YAML', family: 'data', blurb: 'YAML is a plain-text format for settings, where indentation shows what belongs to what.' },
  toml: { name: 'TOML', family: 'data', blurb: 'TOML is a plain-text settings format made of `name = value` lines grouped under [sections].' },
  markdown: { name: 'Markdown', family: 'other', blurb: 'Markdown is formatted text (like this README): # makes headings, * makes lists or emphasis. It is documentation, not code that runs.' },
  docker: { name: 'Dockerfile', family: 'shell', blurb: 'A Dockerfile is a recipe for building a container: a packaged, ready-to-run copy of a program and everything it needs.' },
};

const LOCKFILES = ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'poetry.lock', 'Gemfile.lock'];

export function isLockfile(path: string): boolean {
  return LOCKFILES.includes(basename(path));
}

/** What kind of file this is, in plain words. */
export function explainFileType(path: string): string {
  if (isLockfile(path))
    return `${basename(path)} is a lockfile: an automatically generated list of the exact versions of every outside library the project uses, so everyone installs the same ones. People rarely edit it by hand; it changes when libraries are added or updated.`;
  const lang = languageFor(path);
  const info = lang ? LANGUAGE_BLURBS[lang] : undefined;
  if (info) return `${basename(path)} is a ${info.name} file. ${info.blurb}`;
  if (lang) return `${basename(path)} is a ${lang} file.`;
  return `${basename(path)} is a file rv doesn't recognise the language of, so it is shown as plain text.`;
}

const STATUS: Record<FileStatus, string> = {
  added: 'This file is new: it did not exist before this change.',
  modified: 'This file already existed and some of its lines changed.',
  deleted: 'This file is removed by this change.',
  renamed: 'This file was renamed or moved to a new folder.',
  binary: 'This is a binary file (like an image or a compiled program). Its contents are not text, so the diff can only say that it changed.',
  mode: 'Only this file\'s permissions changed (for example, whether it may be run as a program), not its contents.',
};

export function explainFileStatus(status: FileStatus, oldPath?: string): string {
  if (status === 'renamed' && oldPath) return `This file was renamed or moved: it used to be ${oldPath}.`;
  return STATUS[status];
}

/** "@@ -40,6 +40,9 @@ class Foo" in words. */
export function explainHunkHeader(h: Hunk): string {
  if (h.pseudo) return `This chunk stands for the whole file: ${h.header}.`;
  const ctx = h.header.replace(/^@@[^@]*@@\s*/, '');
  const where = ctx ? ` The text after the second @@ (“${ctx.trim()}”) is the nearest function or section above, to help you find your place.` : '';
  const span = (start: number, n: number, side: string) =>
    n === 0 ? `nothing in the ${side} file` : `${n} line${n === 1 ? '' : 's'} starting at line ${start} of the ${side} file`;
  return `A "hunk" is one chunk of changes. The @@ line is its address: it covers ${span(h.oldStart, h.oldLines, 'old')}, and ${span(h.newStart, h.newLines, 'new')}.${where}`;
}

/** What a diff line's colour and sign mean. */
export function explainLineKind(line: DiffLine): string {
  if (line.kind === 'add') return `Green line with + : added by this change. It is line ${line.newNo} in the new version of the file.`;
  if (line.kind === 'del') return `Red line with - : removed by this change. It was line ${line.oldNo} in the old version.`;
  return `Plain line: unchanged. It is shown only as context, so you can see what surrounds the changes.`;
}

export const RISK_BLURB: Record<Risk, string> = {
  low: 'Low risk: routine or mechanical changes, unlikely to break things.',
  med: 'Medium risk: changes to how the program behaves. Worth reading carefully.',
  high: 'High risk: touches something sensitive (security, saved data, money, things running at the same time, or code other programs depend on). Mistakes here are costly.',
};

// ---------- terms ----------

const JS: Record<string, string> = {
  import: 'brings in code (functions, values) from another file or library so this file can use it.',
  export: 'makes something in this file available for other files to import.',
  from: 'says which file or library an import comes from.',
  const: 'creates a named value that won\'t be replaced later (a constant).',
  let: 'creates a named value (a variable) that can be changed later.',
  var: 'an older way to create a variable; `let` and `const` are preferred today.',
  function: 'defines a function: a named, reusable set of steps. It can take inputs and give back a result.',
  return: 'ends the function and hands back a result to whoever called it.',
  async: 'marks a function that can wait for slow work (like network or disk) without freezing the program.',
  await: 'pauses this function until a slow operation (like a network request) finishes, then continues with its result.',
  if: 'runs the following code only when a condition is true.',
  else: 'the alternative code to run when the `if` condition is false.',
  for: 'a loop: repeats some code for each item or a number of times.',
  while: 'a loop: repeats some code as long as a condition stays true.',
  class: 'a blueprint for making objects that bundle data with the functions that work on it.',
  new: 'creates a fresh object from a class blueprint.',
  this: 'refers to the object the current code belongs to.',
  try: 'starts a block that might fail; if it does, the `catch` block handles the error instead of crashing.',
  catch: 'handles an error thrown inside the matching `try` block.',
  throw: 'raises an error on purpose, stopping normal flow until something catches it.',
  type: 'defines the shape of some data (TypeScript only): which fields it has and what kinds of values they hold.',
  interface: 'describes the shape an object must have (TypeScript only).',
  null: 'a value meaning "nothing here on purpose".',
  undefined: 'a value meaning "nothing has been set here".',
  true: 'the yes/on value of a true-or-false (boolean).',
  false: 'the no/off value of a true-or-false (boolean).',
  string: 'text. In TypeScript, `: string` labels a value as text.',
  number: 'a numeric value. In TypeScript, `: number` labels a value as a number.',
  boolean: 'a true-or-false value.',
  switch: 'picks one of several code paths depending on a value.',
  case: 'one option inside a `switch`.',
  default: 'the fallback option, or (with export) the file\'s main export.',
  typeof: 'asks what kind of value something is.',
  extends: 'builds a new class or type on top of an existing one.',
  React: 'React, a popular library for building user interfaces out of components.',
  useState: 'a React feature that lets a component remember a value between screen updates.',
  useEffect: 'a React feature that runs code after the component appears or changes (like loading data).',
  console: 'the developer console; `console.log` prints a message for debugging.',
  Promise: 'a placeholder for a result that will arrive later (for example from the network).',
};
const PY: Record<string, string> = {
  import: 'brings in code from another module (file or library).',
  from: 'used with import: take specific names from a module.',
  def: 'defines a function: a named, reusable set of steps.',
  return: 'ends the function and hands back a result.',
  class: 'a blueprint for making objects that bundle data with functions (methods).',
  self: 'the current object, inside a class\'s methods.',
  if: 'runs the indented lines below only when a condition is true.',
  elif: '"else if": another condition to check when the previous one was false.',
  else: 'what to do when the conditions above were false.',
  for: 'a loop over each item in a list or other collection.',
  in: 'checks membership, or (in a for loop) walks through each item.',
  while: 'repeats the indented lines as long as a condition holds.',
  try: 'runs code that might fail; `except` handles the failure.',
  except: 'handles an error raised inside the matching `try`.',
  raise: 'raises an error on purpose.',
  with: 'opens something (like a file) and makes sure it is closed again afterwards.',
  None: 'Python\'s "nothing here" value.',
  True: 'the yes value of a true-or-false.',
  False: 'the no value of a true-or-false.',
  lambda: 'a tiny unnamed function written on one line.',
  async: 'marks a function that can wait for slow work without blocking.',
  await: 'waits for slow work to finish, then continues.',
  print: 'shows text in the terminal.',
  json: 'Python\'s module for reading and writing JSON data.',
  pass: 'does nothing; a placeholder where Python requires a line.',
};
const GO: Record<string, string> = {
  package: 'names the package (group of files) this file belongs to; `main` means it is a runnable program.',
  import: 'brings in other packages this file uses.',
  func: 'defines a function: a named, reusable set of steps.',
  return: 'ends the function and hands back results.',
  var: 'declares a variable.',
  const: 'declares a constant value.',
  type: 'defines a new type (a named shape for data).',
  struct: 'a type that groups named fields together, like a record.',
  interface: 'a set of methods a type must have.',
  if: 'runs code only when a condition is true.',
  for: 'Go\'s only loop keyword: repeats code.',
  range: 'walks through each item of a list, map or channel in a for loop.',
  err: 'by convention, an error value; Go functions return errors instead of throwing them.',
  nil: 'Go\'s "nothing here" value.',
  defer: 'runs a call when the surrounding function finishes (often used for clean-up).',
  go: 'starts a function running at the same time as the rest of the program (a goroutine).',
  fmt: 'Go\'s standard package for formatting and printing text.',
  main: 'the function where a Go program starts.',
};
const RUST: Record<string, string> = {
  fn: 'defines a function.',
  let: 'creates a variable (unchangeable unless marked `mut`).',
  mut: 'marks a variable as changeable.',
  pub: 'makes something visible outside its module.',
  struct: 'a type grouping named fields.',
  enum: 'a type that is one of several named variants.',
  impl: 'adds functions (methods) to a type.',
  use: 'brings names from another module into scope.',
  match: 'chooses code to run by comparing a value against patterns.',
  Option: 'a value that is either Some(thing) or None.',
  Result: 'a value that is either Ok(result) or Err(error).',
};
const SYMBOLS: [string, string, Family[]][] = [
  ['=>', 'an arrow function: a short way to write a function (inputs on the left, result on the right).', ['js']],
  ['===', 'checks that two values are exactly equal (same value and same kind).', ['js']],
  ['!==', 'checks that two values are not exactly equal.', ['js']],
  ['?.', 'optional chaining: only continue if the thing on the left exists, otherwise give undefined instead of crashing.', ['js']],
  ['??', 'use the value on the right if the left side is null or undefined.', ['js']],
  ['...', 'spread: unpacks the items of a list or the fields of an object into the surrounding one.', ['js']],
  ['${', 'inside `backticks`, ${…} drops a value into the text (template string).', ['js']],
  [':=', 'declares a new variable and sets it in one step.', ['go']],
  ['->', 'separates a function\'s inputs from the type of result it returns.', ['python', 'rust']],
  ['&&', 'and: true only if both sides are true.', ['js', 'go', 'rust', 'shell']],
  ['||', 'or: true if either side is true.', ['js', 'go', 'rust']],
];

function familyOf(path: string): Family {
  const lang = languageFor(path);
  return (lang && LANGUAGE_BLURBS[lang]?.family) || 'other';
}

function isCommentLine(text: string, fam: Family): boolean {
  const t = text.trim();
  if (!t) return false;
  if (fam === 'python' || fam === 'shell' || fam === 'data') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--');
}

/** Strip string literals so words inside text aren't explained as code. */
function stripStrings(text: string): string {
  return text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => (m.startsWith('`') && m.includes('${') ? '`${}`' : '""'));
}

/** Explanations of the code words and symbols on one line, in order of appearance, without repeats. */
export function explainTerms(text: string, path: string, max = 8): Term[] {
  const fam = familyOf(path);
  const out: Term[] = [];
  if (!text.trim()) return out;
  if (isCommentLine(text, fam)) {
    return [{ term: 'comment', meaning: 'This line is a comment: a note for people reading the code. The computer ignores it.' }];
  }
  const dict = fam === 'js' ? JS : fam === 'python' ? PY : fam === 'go' ? GO : fam === 'rust' ? RUST : null;
  const code = stripStrings(text);
  const seen = new Set<string>();
  const found: { at: number; term: Term }[] = [];
  if (dict) {
    for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const w = m[0];
      if (seen.has(w) || !Object.prototype.hasOwnProperty.call(dict, w)) continue;
      seen.add(w);
      found.push({ at: m.index ?? 0, term: { term: w, meaning: dict[w]! } });
    }
  }
  for (const [sym, meaning, fams] of SYMBOLS) {
    if (!fams.includes(fam)) continue;
    const src = sym === '${' ? text : code;
    const at = src.indexOf(sym);
    if (at >= 0 && !seen.has(sym)) {
      seen.add(sym);
      found.push({ at, term: { term: sym, meaning } });
    }
  }
  if (/["'`]/.test(text) && fam !== 'data' && !seen.has('"text"')) {
    found.push({ at: text.search(/["'`]/), term: { term: '"…"', meaning: 'text in quotes is a string: literal text the program uses as-is.' } });
  }
  if ((fam === 'js' || fam === 'html') && /<\/?[A-Za-z][\w.]*[\s>/]/.test(code)) {
    found.push({ at: code.search(/<\/?[A-Za-z]/), term: { term: '<tag>', meaning: 'an HTML-like tag (JSX): describes a piece of the user interface, like a box, text or button. className sets its CSS style.' } });
  }
  if (fam === 'data' && /"[^"]+"\s*:/.test(text)) {
    found.push({ at: 0, term: { term: '"name": value', meaning: 'a setting or data field: the name in quotes, then its value.' } });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, max).map((f) => f.term);
}

export type Explanation = { title: string; lines: string[] };

/** Everything learning mode says about one diff line. */
export function explainLine(line: DiffLine, hunk: Hunk): Explanation {
  const lines = [explainLineKind(line)];
  for (const t of explainTerms(line.text, hunk.path)) lines.push(`${t.term} — ${t.meaning}`);
  if (lines.length === 1 && line.text.trim()) lines.push('No special code words here: this line mostly names things or passes values along.');
  if (!line.text.trim()) lines.push('This line is blank; blank lines just space the code out for readability.');
  return { title: line.kind === 'add' ? 'added line' : line.kind === 'del' ? 'removed line' : 'unchanged line', lines };
}
