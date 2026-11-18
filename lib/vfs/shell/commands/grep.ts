import type { ShellEnv, ShellResult } from '../types';
import { applyRedirectGuarded, truncate } from '../runtime';
import {
  asCount,
  compilePattern,
  flagTable,
  linesOf,
  matchTexts,
  nameMatcher,
  parseFlags,
  printLines,
  searchTargets,
  tooSlow,
  type FlagTable,
  type LinePlan,
} from './search-shared';

const FLAGS: FlagTable = {
  ...flagTable([
    ['line-number', 'n'],
    ['ignore-case', 'i'],
    ['no-ignore-case'],
    ['only-matching', 'o'],
    ['fixed-strings', 'F'],
    ['extended-regexp', 'E'],
    ['perl-regexp', 'P'],
    ['basic-regexp', 'G'],
    ['word-regexp', 'w'],
    ['invert-match', 'v'],
    ['count', 'c'],
    ['files-with-matches', 'l'],
    ['with-filename', 'H'],
    ['no-filename', 'h'],
    ['regexp', 'e', true],
    ['max-count', 'm', true],
    ['after-context', 'A', true],
    ['before-context', 'B', true],
    ['context', 'C', true],
    ['include', null, true],
    ['exclude', null, true],
    ['exclude-dir', null, true],
    ['no-messages', 's'],
    // Taken and without effect: a folder is always searched through, binary content never is, and
    // the output has no colours.
    ['recursive', 'r'],
    ['dereference-recursive', 'R'],
    ['text', 'a'],
    ['binary-files', null, true],
    ['color', null, 'attached'],
    ['colour', null, 'attached'],
  ]),
  I: { option: 'binary-files' },
  // `-3` is three lines of context.
  '#': { option: 'context' },
};

const SUPPORTED = '-n -i -o -F -E -P -w -v -c -l -h -e PATTERN -m NUM -A NUM -B NUM -C NUM --include=GLOB --exclude=GLOB --exclude-dir=GLOB';

const USAGE = `  Usage: grep [FLAGS] PATTERN [PATH ...]

  PATH is a file, a folder or a glob, and several can be given. A folder is searched all the way
  down, with or without -r. Without a path, / is searched.

  Flags:
    -n              Show line numbers
    -i              Ignore case
    -F              The pattern is text, not a regular expression
    -E, -P          Extended, Perl-style expression: | ( ) { } + ? are operators as written.
                    Without either, they are operators with a backslash too: 'a\\|b', 'x\\+'
    -w              Whole words only
    -v              Lines that do not match
    -e PATTERN      A pattern; repeat for several
    -o              Print only the matching part of each line
    -c              Print the number of matching lines instead of the lines
    -l              Print only the paths of files with a match
    -h              No file names
    -m NUM          Stop after NUM matching lines in a file
    -A NUM, -B NUM  NUM lines after, before each match
    -C NUM, -NUM    NUM lines of context before and after each match
    --include=GLOB, --exclude=GLOB   Only, or all but, files whose name matches
    --exclude-dir=GLOB               Skip folders whose name matches

  Examples:
    grep -n 'pattern' /file.txt
    grep -rn 'TODO\\|FIXME' /scripts /index.html
    grep -c -i todo /
    grep -o 'href="[^"]*"' /index.html
    grep -rl --include='*.css' 'var(--accent)' /

  rg is also available, and numbers lines without being asked.`;

const refuse = (message: string): ShellResult => ({ stdout: '', stderr: message, exitCode: 2 });

/** `grep` — search file contents. */
export async function grepCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, stdin, ctx, redirect } = env;

  const parsed = parseFlags(args, FLAGS);
  // A flag this command lacks is refused, never dropped: a dropped flag leaves output of another
  // shape (matching lines where a count was asked for) that reads as an answer. A wrong-shaped
  // result is worse than no result.
  if (parsed.unknown.length > 0) {
    return refuse(`grep: unsupported flag${parsed.unknown.length > 1 ? 's' : ''}: ${parsed.unknown.join(', ')}\n\n  Supported: ${SUPPORTED}\n  Run grep with no pattern for full usage.`);
  }
  if (parsed.valueless.length > 0) return refuse(`grep: ${parsed.valueless[0]} needs a value after it`);

  let mode: 'lines' | 'paths' | 'count' = 'lines';
  let dialect: 'basic' | 'extended' = 'basic';
  let lineNumbers = false;
  /** -H or -h, the last given; without either, names are printed except on one named file's count. */
  let filenames: boolean | null = null;
  let ignoreCase = false;
  let fixed = false;
  let word = false;
  let invert = false;
  let only = false;
  let quiet = false;
  let max: number | null = null;
  let context: number | null = null;
  let before: number | null = null;
  let after: number | null = null;
  const patterns: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  const excludeDir: string[] = [];

  for (const flag of parsed.given) {
    switch (flag.option) {
      case 'line-number': lineNumbers = true; break;
      case 'ignore-case': ignoreCase = true; break;
      case 'no-ignore-case': ignoreCase = false; break;
      case 'only-matching': only = true; break;
      case 'fixed-strings': fixed = true; break;
      // The engine's own syntax serves for both: it is a superset of an extended expression.
      case 'extended-regexp':
      case 'perl-regexp': dialect = 'extended'; break;
      case 'basic-regexp': dialect = 'basic'; break;
      case 'word-regexp': word = true; break;
      case 'invert-match': invert = true; break;
      case 'count': mode = 'count'; break;
      case 'files-with-matches': mode = 'paths'; break;
      case 'with-filename': filenames = true; break;
      case 'no-filename': filenames = false; break;
      case 'no-messages': quiet = true; break;
      case 'regexp': patterns.push(flag.value!); break;
      case 'include': include.push(flag.value!); break;
      case 'exclude': exclude.push(flag.value!); break;
      case 'exclude-dir': excludeDir.push(flag.value!); break;
      case 'max-count':
      case 'after-context':
      case 'before-context':
      case 'context': {
        const count = asCount(flag.value);
        if (count === null) return refuse(`grep: ${flag.as} needs a number after it, not "${flag.value}"`);
        if (flag.option === 'max-count') max = count;
        else if (flag.option === 'after-context') after = count;
        else if (flag.option === 'before-context') before = count;
        else context = count;
        break;
      }
    }
  }

  const positionals = [...parsed.positionals];
  if (patterns.length === 0) {
    const pattern = positionals.shift();
    if (!pattern) return refuse(`grep: missing pattern\n\n${USAGE}`);
    patterns.push(pattern);
  }
  const paths = stdin !== undefined ? positionals.filter(path => path !== '-') : positionals;

  let keep: (path: string) => boolean;
  try {
    const wanted = include.map(nameMatcher);
    const unwanted = exclude.map(nameMatcher);
    const skipped = excludeDir.map(nameMatcher);
    keep = (path) => {
      if (wanted.length > 0 && !wanted.some(matches => matches(path))) return false;
      if (unwanted.some(matches => matches(path))) return false;
      if (skipped.length === 0) return true;
      const folders = path.split('/').slice(1, -1);
      return !folders.some(folder => skipped.some(matches => matches(folder)));
    };
  } catch (error) {
    return refuse(`grep: invalid glob: ${error instanceof Error ? error.message : String(error)}`);
  }

  let plan: LinePlan;
  try {
    const regex = compilePattern({ patterns, fixed, basic: dialect === 'basic', word, ignoreCase });
    plan = { regex, invert, only, before: before ?? context ?? 0, after: after ?? context ?? 0, max, lineNumbers };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(`grep: ${detail}\n\n  To search for the text as it is written, add -F.`);
  }

  const out: string[] = [];
  let missing: string[] = [];

  if (paths.length === 0 && stdin !== undefined) {
    const lines = linesOf(stdin);
    const matched = await matchTexts([lines], plan, mode === 'lines', ctx);
    if (!matched.ok) return refuse(tooSlow('grep', matched.limitMs));
    const found = matched.found[0];
    // One line at a time: a spread of a large file's lines overflows the call stack.
    if (mode === 'lines') for (const line of printLines(lines, plan, null, found)) out.push(line);
    else {
      // -c and -l count or name whole matching lines, whatever -o and the context flags say.
      const count = found.lines.length;
      if (mode === 'count') out.push(String(count));
      else if (count > 0) out.push('(standard input)');
    }
  } else {
    const targets = await searchTargets(env, paths.length > 0 ? paths : ['/']);
    missing = targets.missing;
    const separated = plan.before > 0 || plan.after > 0;
    const files = targets.files.filter(file => keep(file.path));
    const texts = files.map(file => linesOf(file.content));
    const matched = await matchTexts(texts, plan, mode === 'lines', ctx);
    if (!matched.ok) return refuse(tooSlow('grep', matched.limitMs));
    for (let k = 0; k < files.length; k++) {
      const file = files[k];
      const found = matched.found[k];
      if (mode === 'lines') {
        const printed = printLines(texts[k], plan, filenames !== false ? file.path : null, found);
        if (printed.length === 0) continue;
        if (out.length > 0 && separated && !only) out.push('');
        for (const line of printed) out.push(line);
        continue;
      }
      const count = found.lines.length;
      if (mode === 'paths') {
        if (count > 0) out.push(file.path);
      } else if (filenames === false || (targets.single && filenames === null)) {
        // A path naming one file reports a bare count, as grep does, the zero included: without
        // it, `grep -c missing /file` would answer with silence.
        out.push(String(count));
      } else if (count > 0 || targets.single) {
        out.push(`${file.path}:${count}`);
      }
    }
  }

  const stdout = truncate(out.join('\n'));
  // -s leaves the messages out and the exit status as it is.
  const stderr = quiet ? '' : missing.map(path => `grep: ${path}: No such file or directory`).join('\n');
  if (missing.length > 0) {
    if (!redirect) return { stdout, stderr, exitCode: 2 };
    // What the paths that exist gave still goes to the file, as in a shell; the answer is the failure.
    const written = await applyRedirectGuarded(vfs, projectId, stdout, redirect, ctx);
    return written.exitCode !== 0 ? written : { stdout: '', stderr, exitCode: 2 };
  }
  // An output of nothing goes to a redirect too, and empties the file, as in a shell.
  if (redirect) return applyRedirectGuarded(vfs, projectId, stdout, redirect, ctx);
  return { stdout, stderr: '', exitCode: 0 };
}
