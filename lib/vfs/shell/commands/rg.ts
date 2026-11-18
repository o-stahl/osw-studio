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
  pathMatcher,
  printLines,
  searchTargets,
  tooSlow,
  type LinePlan,
} from './search-shared';

const FLAGS = flagTable([
  ['line-number', 'n'],
  ['no-line-number', 'N'],
  ['ignore-case', 'i'],
  ['case-sensitive', 's'],
  ['smart-case', 'S'],
  ['fixed-strings', 'F'],
  ['word-regexp', 'w'],
  ['invert-match', 'v'],
  ['only-matching', 'o'],
  ['files-with-matches', 'l'],
  ['count', 'c'],
  ['files'],
  ['with-filename', 'H'],
  ['no-filename', 'I'],
  ['regexp', 'e', true],
  ['glob', 'g', true],
  ['type', 't', true],
  ['type-not', 'T', true],
  ['max-count', 'm', true],
  ['after-context', 'A', true],
  ['before-context', 'B', true],
  ['context', 'C', true],
  ['no-messages'],
  // Taken and without effect: the project has no ignore files, hidden folders are searched like any
  // other, binary content is never searched, and the output has no colours or headings to turn off.
  ['hidden', '.'],
  ['no-ignore'],
  ['unrestricted', 'u'],
  ['text', 'a'],
  ['pcre2', 'P'],
  ['follow', 'L'],
  ['no-heading'],
  ['no-config'],
  ['color', null, true],
  ['threads', 'j', true],
]);

/** File types by name, as ripgrep defines the ones a web project holds. */
const TYPES: Readonly<Record<string, readonly string[]>> = {
  css: ['*.css', '*.scss'],
  csv: ['*.csv'],
  hbs: ['*.hbs'],
  html: ['*.ejs', '*.htm', '*.html'],
  js: ['*.cjs', '*.js', '*.jsx', '*.mjs', '*.vue'],
  json: ['*.json'],
  less: ['*.less'],
  lua: ['*.lua'],
  markdown: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  md: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  sass: ['*.sass', '*.scss'],
  sql: ['*.psql', '*.sql'],
  svelte: ['*.svelte'],
  svg: ['*.svg'],
  toml: ['*.toml'],
  ts: ['*.cts', '*.mts', '*.ts', '*.tsx'],
  txt: ['*.txt'],
  typescript: ['*.cts', '*.mts', '*.ts', '*.tsx'],
  vue: ['*.vue'],
  xml: ['*.dtd', '*.xhtml', '*.xml', '*.xsd', '*.xsl', '*.xslt'],
  yaml: ['*.yaml', '*.yml'],
};

const USAGE = `  Usage: rg [FLAGS] PATTERN [PATH ...]
         rg --files [PATH ...]

  PATH is a file, a folder or a glob, and several can be given. Without one, / is searched.

  Flags:
    -i              Ignore case
    -S              Ignore case unless the pattern has a capital letter
    -F              The pattern is text, not a regular expression
    -w              Whole words only
    -v              Lines that do not match
    -e PATTERN      A pattern; repeat for several
    -C NUM          NUM lines of context before and after each match
    -A NUM, -B NUM  NUM lines after, before each match
    -o              Print only the matching part of each line
    -l              Print only the paths of files with a match
    -c              Print the number of matching lines in each file
    -m NUM          Stop after NUM matching lines in a file
    -g GLOB         Only files matching GLOB; -g '!GLOB' leaves them out; repeat for several
    -t TYPE         Only files of a type (${Object.keys(TYPES).join(', ')})
    -T TYPE         All but files of a type
    -N, -I          No line numbers; no file names
    --files         List the files a search would read

  Examples:
    rg -C 3 'pattern' /
    rg -i todo /index.html /scripts
    rg -l 'class="btn' -g '*.html'
    rg -c -t css 'var\\(--accent\\)'`;

const refuse = (message: string): ShellResult => ({ stdout: '', stderr: message, exitCode: 2 });

/** `rg` — search file contents, with line numbers and optional context. */
export async function rgCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, stdin, ctx, redirect } = env;

  const parsed = parseFlags(args, FLAGS);
  if (parsed.unknown.length > 0) {
    return refuse(`rg: unsupported flag${parsed.unknown.length > 1 ? 's' : ''}: ${parsed.unknown.join(', ')}\n\n${USAGE}`);
  }
  if (parsed.valueless.length > 0) return refuse(`rg: ${parsed.valueless[0]} needs a value after it`);

  let mode: 'lines' | 'paths' | 'count' | 'files' = 'lines';
  let casing: 'sensitive' | 'insensitive' | 'smart' = 'sensitive';
  let lineNumbers = true;
  /** -H or -I, the last given; without either, names are printed except on one named file's count. */
  let filenames: boolean | null = null;
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
  const globs: string[] = [];
  const types: string[] = [];
  const typesNot: string[] = [];

  for (const flag of parsed.given) {
    switch (flag.option) {
      case 'line-number': lineNumbers = true; break;
      case 'no-line-number': lineNumbers = false; break;
      case 'ignore-case': casing = 'insensitive'; break;
      case 'case-sensitive': casing = 'sensitive'; break;
      case 'smart-case': casing = 'smart'; break;
      case 'fixed-strings': fixed = true; break;
      case 'word-regexp': word = true; break;
      case 'invert-match': invert = true; break;
      case 'only-matching': only = true; break;
      case 'files-with-matches': mode = 'paths'; break;
      case 'count': mode = 'count'; break;
      case 'files': mode = 'files'; break;
      case 'with-filename': filenames = true; break;
      case 'no-filename': filenames = false; break;
      case 'no-messages': quiet = true; break;
      case 'regexp': patterns.push(flag.value!); break;
      case 'glob': globs.push(flag.value!); break;
      case 'type':
      case 'type-not': {
        if (!TYPES[flag.value!]) {
          return refuse(`rg: unrecognized file type: ${flag.value}\n\n  Types: ${Object.keys(TYPES).join(', ')}\n  For any other, use -g '*.ext'.`);
        }
        (flag.option === 'type' ? types : typesNot).push(flag.value!);
        break;
      }
      case 'max-count':
      case 'after-context':
      case 'before-context':
      case 'context': {
        const count = asCount(flag.value);
        if (count === null) return refuse(`rg: ${flag.as} needs a number after it, not "${flag.value}"`);
        if (flag.option === 'max-count') max = count;
        else if (flag.option === 'after-context') after = count;
        else if (flag.option === 'before-context') before = count;
        else context = count;
        break;
      }
    }
  }

  const positionals = [...parsed.positionals];
  if (mode !== 'files' && patterns.length === 0) {
    const pattern = positionals.shift();
    if (!pattern) return refuse(`rg: missing pattern\n\n${USAGE}`);
    patterns.push(pattern);
  }
  const paths = stdin !== undefined ? positionals.filter(path => path !== '-') : positionals;

  let keep: (path: string) => boolean;
  try {
    const wanted = globs.filter(glob => !glob.startsWith('!')).map(glob => pathMatcher(glob));
    const unwanted = globs.filter(glob => glob.startsWith('!')).map(glob => pathMatcher(glob.slice(1), true));
    const ofType = types.flatMap(type => TYPES[type]).map(nameMatcher);
    const notOfType = typesNot.flatMap(type => TYPES[type]).map(nameMatcher);
    keep = path =>
      (wanted.length === 0 || wanted.some(matches => matches(path))) &&
      !unwanted.some(matches => matches(path)) &&
      (ofType.length === 0 || ofType.some(matches => matches(path))) &&
      !notOfType.some(matches => matches(path));
  } catch (error) {
    return refuse(`rg: invalid glob: ${error instanceof Error ? error.message : String(error)}`);
  }

  let plan: LinePlan | null = null;
  if (mode !== 'files') {
    // A capital inside an escape (`\S`) is not a capital letter of the pattern.
    const capital = patterns.some(pattern => /\p{Lu}/u.test(fixed ? pattern : pattern.replace(/\\./g, '')));
    try {
      const regex = compilePattern({
        patterns,
        fixed,
        word,
        ignoreCase: casing === 'insensitive' || (casing === 'smart' && !capital),
      });
      plan = { regex, invert, only, before: before ?? context ?? 0, after: after ?? context ?? 0, max, lineNumbers };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return refuse(`rg: regex parse error: ${detail}\n\n  To search for the text as it is written, add -F.`);
    }
  }

  const out: string[] = [];
  let missing: string[] = [];

  if (plan && paths.length === 0 && stdin !== undefined) {
    const lines = linesOf(stdin);
    const matched = await matchTexts([lines], plan, mode === 'lines', ctx);
    if (!matched.ok) return refuse(tooSlow('rg', matched.limitMs));
    const found = matched.found[0];
    // One line at a time: a spread of a large file's lines overflows the call stack.
    if (mode === 'lines') for (const line of printLines(lines, plan, null, found)) out.push(line);
    else {
      const count = found.lines.length;
      if (mode === 'count') out.push(String(count));
      else if (count > 0) out.push('<stdin>');
    }
  } else {
    const targets = await searchTargets(env, paths.length > 0 ? paths : ['/']);
    missing = targets.missing;
    // A file asked for by name is read whatever the filters say; they choose among a folder's files.
    const files = targets.files.filter(file => file.named || keep(file.path));
    if (plan && files.length === 0 && targets.files.length > 0) {
      return {
        stdout: '',
        stderr: `rg: no files were searched: none of the ${targets.files.length} there pass the -g/-t filters given.\n\n  rg --files ${paths.join(' ') || '/'} lists them.`,
        exitCode: 1,
      };
    }
    const texts = plan ? files.map(file => linesOf(file.content)) : [];
    const matched = plan ? await matchTexts(texts, plan, mode === 'lines', ctx) : null;
    if (matched && !matched.ok) return refuse(tooSlow('rg', matched.limitMs));
    for (let k = 0; k < files.length; k++) {
      const file = files[k];
      if (!plan || !matched?.ok) {
        out.push(file.path);
        continue;
      }
      const found = matched.found[k];
      if (mode === 'lines') {
        const printed = printLines(texts[k], plan, filenames !== false ? file.path : null, found);
        if (printed.length === 0) continue;
        // A blank line between files, where whole lines are printed.
        if (out.length > 0 && !only) out.push('');
        // One line at a time: a spread of a large file's lines overflows the call stack.
        for (const line of printed) out.push(line);
        continue;
      }
      const count = found.lines.length;
      if (mode === 'paths') {
        if (count > 0) out.push(file.path);
      } else if (filenames === false || (targets.single && filenames === null)) {
        // One file asked about by name answers with its number alone, a zero included: silence
        // would not say whether the file was read.
        out.push(String(count));
      } else if (count > 0 || targets.single) {
        out.push(`${file.path}:${count}`);
      }
    }
  }

  const stdout = truncate(out.join('\n'));
  // --no-messages leaves the messages out and the exit status as it is.
  const stderr = quiet ? '' : missing.map(path => `rg: ${path}: No such file or directory`).join('\n');
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
