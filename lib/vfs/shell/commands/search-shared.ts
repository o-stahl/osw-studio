import type { LineMatches, LineMatchJob, LineMatchOutcome, ShellContext, ShellEnv } from '../types';
import { normalizePath } from '../paths';

/**
 * What `grep` and `rg` have in common: reading flags, finding the files a list of paths names,
 * building the pattern, and turning one text's matches into output lines.
 *
 * Each command keeps its own table of flags and its own defaults (`rg` numbers lines and puts a
 * blank line between files, `grep` does neither). The mechanism is what is shared, so that a rule
 * such as "a flag the command does not have is refused by name" or "every path given is searched"
 * cannot hold for one command and lapse for the other.
 */

/** A file in the project with string content, which is all either command can search. */
export interface SearchableFile {
  path: string;
  content: string;
  /** Asked for by its own path, not found under a folder that was. */
  named: boolean;
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

/** One flag a command takes. */
export interface FlagSpec {
  /** The option it stands for, by its long name. */
  option: string;
  /**
   * `true`: a value follows (`-C 3`, `-C3`, `--context 3`, `--context=3`).
   * `'attached'`: a value is taken only when written onto the flag (`--color=never`).
   */
  value?: boolean | 'attached';
}

/**
 * A command's flags by how they are written: short letters and long names in one table. The key
 * `#` stands for a bare number (`-3`), where the command reads one.
 */
export type FlagTable = Readonly<Record<string, FlagSpec>>;

/** A table from rows of `[long name, short letter, takes a value]`. */
export function flagTable(
  rows: ReadonlyArray<readonly [option: string, short?: string | null, value?: FlagSpec['value']]>,
): FlagTable {
  const table: Record<string, FlagSpec> = {};
  for (const [option, short, value] of rows) {
    const spec: FlagSpec = { option, value };
    table[option] = spec;
    if (short) table[short] = spec;
  }
  return table;
}

export interface GivenFlag {
  option: string;
  value?: string;
  /** As it was written, for a message about it. */
  as: string;
}

export interface ParsedFlags {
  /** In the order given, so a later flag can override an earlier one. */
  given: GivenFlag[];
  positionals: string[];
  /** Flags the table does not have, as written. */
  unknown: string[];
  /** Flags that take a value and came last, with nothing after them. */
  valueless: string[];
}

/**
 * Reads an argument list the way getopt does: clustered short flags (`-in`), a value attached or
 * separate (`-C3`, `-C 3`, `--context=3`, `--context 3`), and `--` ending the flags. Nothing is
 * dropped: a flag the table lacks is returned in `unknown` for the command to refuse.
 */
export function parseFlags(args: readonly string[], table: FlagTable): ParsedFlags {
  const out: ParsedFlags = { given: [], positionals: [], unknown: [], valueless: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      out.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      // The table's own entries only: every object has a `constructor`, and that is not a flag.
      const spec = name.length > 1 && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
      if (!spec) {
        out.unknown.push(`--${name}`);
      } else if (spec.value === true) {
        const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined) out.valueless.push(`--${name}`);
        else out.given.push({ option: spec.option, value, as: `--${name}` });
      } else if (eq !== -1 && spec.value !== 'attached') {
        out.unknown.push(arg);
      } else {
        out.given.push({ option: spec.option, value: eq === -1 ? undefined : arg.slice(eq + 1), as: `--${name}` });
      }
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      if (/^-\d+$/.test(arg)) {
        const number = table['#'];
        if (number) out.given.push({ option: number.option, value: arg.slice(1), as: arg });
        else out.unknown.push(arg);
        continue;
      }
      for (let j = 1; j < arg.length; j++) {
        const spec = table[arg[j]];
        // The rest of the cluster may be that flag's value: reading it as more flags would name
        // letters nobody wrote.
        if (!spec) {
          out.unknown.push(`-${arg[j]}`);
          break;
        }
        if (spec.value === true) {
          const rest = arg.slice(j + 1);
          const value = rest !== '' ? rest : args[++i];
          if (value === undefined) out.valueless.push(`-${arg[j]}`);
          else out.given.push({ option: spec.option, value, as: `-${arg[j]}` });
          break;
        }
        out.given.push({ option: spec.option, as: `-${arg[j]}` });
      }
      continue;
    }
    out.positionals.push(arg);
  }
  return out;
}

/** A flag's value as a count of lines: a whole number, or null for anything else. */
export function asCount(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

// ---------------------------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------------------------

/**
 * A glob as the source of a regular expression over a whole path or name. `*` and `?` stay inside
 * one path segment, `**` crosses them, `{a,b}` is either, and a `[...]` class is a class.
 */
function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] !== '*') {
        out += '[^/]*';
      } else if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      // A `]` first in the class (after the `!` of a negated one) is a member of it, not its end.
      // The engine would read `[]` as an empty class, so it is written escaped.
      const negated = glob[i + 1] === '!';
      const first = negated ? i + 2 : i + 1;
      const end = glob.indexOf(']', first + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        const body = glob.slice(first, end).replace(/\\/g, '\\\\').replace(/^\]/, '\\]');
        out += `[${negated ? '^' : ''}${body}]`;
        i = end;
      }
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        out += `(?:${glob.slice(i + 1, end).split(',').map(globSource).join('|')})`;
        i = end;
      }
    } else {
      out += c.replace(/[.+^$()|\\}\]]/g, '\\$&');
    }
  }
  return out;
}

/** Whether a file's own name matches a glob: `*.css` against `styles.css`, wherever the file is. */
export function nameMatcher(glob: string): (path: string) => boolean {
  const regex = new RegExp(`^${globSource(glob)}$`);
  return path => regex.test(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * Whether a path matches a glob the way a `.gitignore` line does: one without a slash names a file
 * or folder at any depth, one with a slash is read from the root, and a trailing slash names a
 * folder. With `orInside`, a path inside a matching folder matches too, which is how excluding
 * `node_modules` excludes what is in it.
 */
export function pathMatcher(glob: string, orInside = false): (path: string) => boolean {
  const folder = glob.endsWith('/');
  const trimmed = folder ? glob.slice(0, -1) : glob;
  const head = `${trimmed.includes('/') ? '' : '(?:.*/)?'}${globSource(trimmed.replace(/^\//, ''))}`;
  const tail = folder ? '/.*' : orInside ? '(?:/.*)?' : '';
  const regex = new RegExp(`^${head}${tail}$`);
  return path => regex.test(path.replace(/^\//, ''));
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export interface SearchTargets {
  /** The searchable files under the paths, each once, in the order the paths were given. */
  files: SearchableFile[];
  /** Paths, as given, that name nothing in the project. */
  missing: string[];
  /** One path was given and it is a file: the case in which a count stands alone, with no name. */
  single: boolean;
}

/**
 * The files under each of `paths`, any of which may name a folder, a file, or a glob of either.
 *
 * Folders are skipped, and so is anything whose content is not a string: a binary file is stored as
 * an ArrayBuffer or a blob reference, and matching a regex against either finds nothing useful and
 * can print bytes into the transcript. A path that names nothing is reported rather than searched
 * as an empty folder, since "no such path" and "no match" call for different next steps.
 *
 * A glob is expanded here because the shell leaves these commands' arguments alone: their first
 * argument is a pattern, where `*` is not a file name.
 */
export async function searchTargets(env: ShellEnv, paths: readonly string[]): Promise<SearchTargets> {
  const entries = await env.vfs.getAllFilesAndDirectories(env.projectId, { includeTransient: true });
  const found = new Map<string, SearchableFile>();
  const named: string[] = [];
  const missing: string[] = [];

  /** Collects the files at or under `path`; false when the project has nothing there. */
  const collect = (path: string): boolean => {
    const prefix = path === '/' ? '/' : `${path}/`;
    let exists = path === '/';
    for (const entry of entries) {
      if (entry.path !== path && !entry.path.startsWith(prefix)) continue;
      exists = true;
      if (entry.type === 'directory' || typeof entry.content !== 'string') continue;
      const named = entry.path === path;
      const known = found.get(entry.path);
      if (known) known.named ||= named;
      else found.set(entry.path, { path: entry.path, content: entry.content, named });
    }
    return exists;
  };

  for (const given of paths) {
    const normalized = normalizePath(given) || '/';
    const path = normalized.length > 1 ? normalized.replace(/\/+$/, '') || '/' : normalized;
    if (collect(path)) {
      named.push(path);
      continue;
    }
    let hits: string[] = [];
    if (/[*?[]/.test(path)) {
      try {
        const glob = new RegExp(`^${globSource(path)}$`);
        hits = entries.map(entry => entry.path).filter(candidate => glob.test(candidate)).sort();
      } catch {
        hits = [];
      }
    }
    if (hits.length === 0) {
      missing.push(given);
      continue;
    }
    for (const hit of hits) {
      collect(hit);
      named.push(hit);
    }
  }

  const files = [...found.values()];
  return { files, missing, single: named.length === 1 && files.length === 1 && files[0].path === named[0] };
}

// ---------------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** POSIX character classes, which belong inside a bracket expression: `[[:space:]]`, `[^[:alnum:]_]`. */
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  blank: ' \\t',
  digit: '0-9',
  lower: 'a-z',
  punct: '!-\\/:-@\\[-`{-~',
  space: '\\s',
  upper: 'A-Z',
  word: '\\w',
  xdigit: '0-9A-Fa-f',
};

const withPosixClasses = (pattern: string) =>
  pattern.replace(/\[:([a-z]+):\]/g, (whole, name: string) => POSIX_CLASSES[name] ?? whole);

/**
 * GNU's `\<` and `\>`, the start and the end of a word, which the engine would read as the
 * characters `<` and `>`. Inside a bracket expression they stay characters.
 */
function withWordAnchors(pattern: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (!inClass && next === '<') out += '\\b(?=\\w)';
      else if (!inClass && next === '>') out += '\\b(?<=\\w)';
      else out += c + next;
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    out += c;
  }
  return out;
}

/**
 * A basic regular expression (grep without `-E`) as an extended one. In a basic expression the
 * operators `| ( ) { } + ?` are written with a backslash, and without one they are the characters
 * themselves. `strict` applies both halves; without it only the first, so an unescaped operator
 * keeps working as one.
 */
function fromBasicRegex(pattern: string, strict: boolean): string {
  let out = '';
  /** Inside a bracket expression: where its first member stands, else -1. */
  let classFirst = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (classFirst !== -1) {
      // First in the expression, a closing bracket is a member of it. The engine would read `[]`
      // as an empty class, so it is written escaped.
      if (c === ']' && i === classFirst) {
        out += '\\]';
      } else {
        out += c;
        if (c === ']') classFirst = -1;
      }
      continue;
    }
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      out += '|(){}+?'.includes(next) ? next : c + next;
      i++;
    } else if (c === '[') {
      classFirst = pattern[i + 1] === '^' ? i + 2 : i + 1;
      out += c;
    } else if (strict && '|(){}+?'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}

export interface PatternSpec {
  /** Any of these matches: one, or several from repeated `-e`. */
  patterns: readonly string[];
  /** The patterns are text, not expressions (`-F`). */
  fixed?: boolean;
  /** Basic regular expressions, as grep reads a pattern without `-E`. */
  basic?: boolean;
  /** Only where the match stands as a word of its own (`-w`). */
  word?: boolean;
  ignoreCase?: boolean;
}

/**
 * The expression a command searches with. Throws a `SyntaxError` for a pattern that is not one.
 *
 * A leading `(?i)` sets case-insensitivity, as it does in the engines these commands stand in for.
 * A basic pattern that does not compile with its unescaped operators live is read again with them
 * as plain characters, which is what makes `grep 'foo(' file` find the parenthesis.
 */
export function compilePattern(spec: PatternSpec): RegExp {
  let ignoreCase = spec.ignoreCase === true;
  const patterns = spec.patterns.map((pattern) => {
    if (spec.fixed || !pattern.startsWith('(?i)')) return pattern;
    ignoreCase = true;
    return pattern.slice(4);
  });

  const build = (strict: boolean) => {
    const sources = patterns.map((pattern) => {
      if (spec.fixed) return escapeRegExp(pattern);
      return withWordAnchors(withPosixClasses(spec.basic ? fromBasicRegex(pattern, strict) : pattern));
    });
    const joined = sources.length === 1 ? sources[0] : sources.map(source => `(?:${source})`).join('|');
    // A whole word is a match with no word character against either end, as grep and rg read -w:
    // `\b` would ask for a word character at each end, which `--accent` and `.btn` do not have.
    return new RegExp(spec.word ? `(?<!\\w)(?:${joined})(?!\\w)` : joined, ignoreCase ? 'i' : '');
  };

  try {
    return build(false);
  } catch (error) {
    if (!spec.basic || spec.fixed) throw error;
    try {
      return build(true);
    } catch {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

/** How one text's matches become output lines. */
export interface LinePlan {
  regex: RegExp;
  /** The lines that do not match (`-v`). */
  invert?: boolean;
  /** Each match on a line of its own, instead of the line it is in (`-o`). */
  only?: boolean;
  /** Lines of context to print before and after each matching line. */
  before: number;
  after: number;
  /** Stop after this many matching lines (`-m`). */
  max?: number | null;
  lineNumbers: boolean;
}

/**
 * The line numbers to print for a set of matches, in order and without repeats.
 *
 * Overlapping windows merge rather than printing a line twice, which is why this collects into a
 * set before sorting. With no context either side it returns the matched lines themselves.
 */
function contextWindow(
  matched: Iterable<number>,
  totalLines: number,
  before: number,
  after: number,
): number[] {
  const window = new Set<number>();
  for (const line of matched) {
    for (let j = Math.max(0, line - before); j <= Math.min(totalLines - 1, line + after); j++) {
      window.add(j);
    }
  }
  return Array.from(window).sort((a, b) => a - b);
}

/**
 * The lines of one text that a job selects, in order, and with `only` the matches on each. The
 * server's worker (`lib/sandbox/search-worker.ts`) carries its own copy of this, as source.
 */
function findLineMatches(
  lines: readonly string[],
  regex: RegExp,
  job: Pick<LineMatchJob, 'invert' | 'max' | 'only'>,
): LineMatches {
  const selected: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (job.max !== null && selected.length >= job.max) break;
    if (regex.test(lines[i]) !== job.invert) selected.push(i);
  }
  if (!job.only) return { lines: selected };
  const every = new RegExp(regex.source, `${regex.flags}g`);
  return {
    lines: selected,
    // A pattern that can match nothing (`x*`) matches between every two characters; those say nothing.
    parts: selected.map(i => Array.from(lines[i].matchAll(every), match => match[0]).filter(part => part !== '')),
  };
}

/**
 * Each text's matches under a plan: through the context's runner where it has one (a server, where
 * a runaway pattern must not hold the process), else here. `withParts` asks for `-o`'s matches,
 * which a count or a list of files does not read.
 */
export function matchTexts(texts: string[][], plan: LinePlan, withParts: boolean, ctx?: ShellContext): Promise<LineMatchOutcome> {
  const job: LineMatchJob = {
    source: plan.regex.source,
    flags: plan.regex.flags,
    invert: plan.invert === true,
    max: plan.max ?? null,
    only: withParts && plan.only === true && plan.invert !== true,
    texts,
  };
  if (ctx?.matchLines) return ctx.matchLines(job);
  return Promise.resolve({ ok: true, found: texts.map(lines => findLineMatches(lines, plan.regex, job)) });
}

/** What a command answers when its runner stopped a search at the time limit. */
export const tooSlow = (command: string, limitMs: number) =>
  `${command}: the pattern took too long to run and was stopped after ${limitMs / 1000} s. A repeat inside a repeat, such as (=+)+, can take time that doubles with every character of a line.\n\n  Search for the text as it is written with -F, or use a simpler pattern.`;

/**
 * One text's output: its matching lines with their context, or its matches alone, each behind
 * `label` (a file's path) where there is one and its line number where the plan asks for it.
 */
export function printLines(lines: readonly string[], plan: LinePlan, label: string | null, found: LineMatches): string[] {
  const head = (index: number) => `${label === null ? '' : `${label}:`}${plan.lineNumbers ? `${index + 1}:` : ''}`;
  if (plan.only && !plan.invert) {
    const out: string[] = [];
    found.lines.forEach((index, k) => {
      for (const part of found.parts?.[k] ?? []) out.push(head(index) + part);
    });
    return out;
  }
  return contextWindow(found.lines, lines.length, plan.before, plan.after).map(index => head(index) + lines[index]);
}

/**
 * A text as the lines these commands search. A newline ends the line before it rather than starting
 * one, as in grep and rg: `"a\n"` is one line, `"\n"` one empty line, `""` none.
 */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return lines;
}
