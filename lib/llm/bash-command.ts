/**
 * How a bash tool call's command string becomes what the shell runs: lines and heredocs, the
 * command portion unescaped, tokens with operators and glued redirects split out. Pure, so the
 * executor in `tool-registry.ts` and the write classification in `write-scope.ts` read a command
 * the same way.
 */

/**
 * Unescape HTML entities that models sometimes emit in tool call arguments.
 * Applied only to the command portion of a bash string, never to heredoc bodies.
 */
export function unescapeHtmlEntities(cmd: string): string {
  if (!cmd.includes('&')) return cmd;
  return cmd
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Parse a shell command string into an array of arguments
 */
export function parseBashCommand(cmdStr: string): string[] {
  const args: string[] = [];
  const wasQuoted: boolean[] = [];
  // Offset in each token just past its final closing quote. Everything from there on was typed
  // unquoted, so it is the only part an operator may be split out of.
  const quotedEnds: number[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let escaped = false;
  let argWasQuoted = false;
  let quotedEnd = 0;

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (inQuotes) {
      if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
        quotedEnd = current.length;
      } else if (quoteChar === '"' && char === '\\') {
        // Double quotes: only \" and \\ are escape sequences; other backslashes are literal
        const next = cmdStr[i + 1];
        if (next === '"' || next === '\\') {
          escaped = true;
          continue;
        }
        current += char;
      } else {
        // Single quotes: everything is literal (including backslashes)
        current += char;
      }
    } else {
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
        argWasQuoted = true;
      } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        if (current.length > 0 || argWasQuoted) {
          args.push(current);
          wasQuoted.push(argWasQuoted);
          quotedEnds.push(quotedEnd);
          current = '';
          argWasQuoted = false;
          quotedEnd = 0;
        }
      } else {
        current += char;
      }
    }
  }

  if (current.length > 0 || argWasQuoted) {
    args.push(current);
    wasQuoted.push(argWasQuoted);
    quotedEnds.push(quotedEnd);
  }

  const split = splitOperatorTokens(args, wasQuoted, quotedEnds);

  // Expand brace patterns like {a,b,c}, but not inside quoted arguments (matches bash behavior)
  return expandBraces(split.args, split.wasQuoted);
}

/** `;`, `&&`, `||` and `|`, longest first so `||` is not read as two pipes. */
const OPERATOR_SPLIT_RE = /(\|\||&&|;|\|)/;

/**
 * A glued output redirect: `ls>out.txt`, `cat a>>b`.
 *
 * The operator must be followed by something a filename can start with. That lookahead is what
 * keeps `-->` intact: a trailing `>` with no target is not a redirect, and HTML written without
 * quotes is far more common here than a redirect someone forgot to space out.
 */
const GLUED_REDIRECT_RE = /(>>|>)(?=[\w./~])/;

/** `2>`, `1>>`, `&>`, `2>/dev/null`, `2>&1`: stripBashRedirects matches these whole, so leave them. */
const FD_REDIRECT_RE = /^(?:0|1|2|&)>>?/;

/** Tokens carrying a `<` are treated as content, not redirection: `<p>hi</p>` must survive intact. */
function canSplitRedirect(token: string): boolean {
  return !token.includes('<') && !FD_REDIRECT_RE.test(token) && GLUED_REDIRECT_RE.test(token);
}

/**
 * Separate control operators that were written without surrounding spaces.
 *
 * Everything downstream detects operators by whole-token equality, so `head -c 600; echo` left
 * `600;` as one token and the `;` was never seen: the pipe splitter then swallowed the rest of
 * the line and the last bare word became the command's file argument. Unquoted operators are
 * separators in bash regardless of spacing, so splitting here matches the shell being imitated.
 *
 * Quoted arguments are left alone: `echo "a;b"` is one literal argument, as in bash.
 */
function splitOperatorTokens(
  args: string[],
  wasQuoted: boolean[],
  quotedEnds: number[]
): { args: string[]; wasQuoted: boolean[] } {
  const outArgs: string[] = [];
  const outQuoted: boolean[] = [];
  const isOperator = (s: string) => s === ';' || s === '&&' || s === '||' || s === '|';

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    // Only the run after the last closing quote is eligible. Testing the whole token treated
    // `echo '---'; date` as one quoted argument, so the `;` never became an operator and `date`
    // was swallowed as an argument to echo.
    const qEnd = quotedEnds[i] ?? 0;
    const head = token.slice(0, qEnd);
    const tail = token.slice(qEnd);
    if (!OPERATOR_SPLIT_RE.test(tail) && !canSplitRedirect(tail)) {
      outArgs.push(token);
      outQuoted.push(wasQuoted[i]);
      continue;
    }

    const pieces: string[] = [];
    for (const chained of tail.split(OPERATOR_SPLIT_RE)) {
      if (chained === '') continue;
      const split = canSplitRedirect(chained) ? chained.split(GLUED_REDIRECT_RE) : [chained];
      for (const piece of split) {
        if (piece !== '') pieces.push(piece);
      }
    }

    // The quoted run belongs to whatever came before the first operator: its own argument when
    // the tail opens with one (`'---';`), otherwise glued to the first piece (`'q'x;y` → `qx`).
    if (head) {
      if (pieces.length === 0 || isOperator(pieces[0])) {
        outArgs.push(head);
        outQuoted.push(true);
      } else {
        pieces[0] = head + pieces[0];
      }
    }
    for (const piece of pieces) {
      outArgs.push(piece);
      outQuoted.push(head !== '' && piece.startsWith(head));
    }
  }

  return { args: outArgs, wasQuoted: outQuoted };
}

/**
 * Expand brace patterns in arguments (e.g., "file{1,2,3}.txt" -> ["file1.txt", "file2.txt", "file3.txt"])
 * Skips quoted arguments: bash does not expand braces inside quotes.
 */
function expandBraces(args: string[], wasQuoted?: boolean[]): string[] {
  const expanded: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (wasQuoted?.[i]) {
      expanded.push(arg);
      continue;
    }
    // Check if arg contains brace expansion pattern
    const braceMatch = arg.match(/^(.+)\{([^}]+)\}(.*)$/);

    if (braceMatch) {
      const [, prefix, items, suffix] = braceMatch;
      const itemList = items.split(',').map(item => item.trim());
      for (const item of itemList) {
        expanded.push(prefix + item + suffix);
      }
    } else {
      expanded.push(arg);
    }
  }

  return expanded;
}

/**
 * Check if a string has unbalanced quotes (i.e., we're inside an open quote).
 * Respects escape sequences in double quotes (\" is not a closing quote).
 * In single quotes, backslash is literal (no escaping) per POSIX.
 */
function hasUnbalancedQuotes(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inDouble) { i++; continue; }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

/**
 * Split a newline-separated command string into individual commands,
 * preserving heredoc blocks and multiline quoted strings as part of their parent command.
 * E.g., "mkdir -p dir\ncat > file << 'EOF'\ncontent\nEOF\nls" → 3 commands
 */
export function splitNewlineCommands(cmdStr: string): string[] {
  const lines = cmdStr.split('\n');
  const commands: string[] = [];
  let current = '';
  let heredocDelimiter: string | null = null;

  for (const line of lines) {
    if (heredocDelimiter) {
      // Inside a heredoc: accumulate until we hit the end delimiter
      current += '\n' + line;
      if (line.trim() === heredocDelimiter) {
        // Heredoc closed: the command is complete. Flush it now and reset so the
        // heredoc BODY never feeds the quote-balance heuristic below. Otherwise a body
        // with an odd number of quotes makes hasUnbalancedQuotes(current) true and the
        // NEXT chained heredoc command gets swallowed as a fake quote-continuation
        // (e.g. three chained `cat > f << 'EOF'` blocks collapsing into two).
        heredocDelimiter = null;
        const trimmed = current.trim();
        if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
        current = '';
      }
      continue;
    }

    // Inside an unclosed quote: accumulate until quotes balance
    if (current && hasUnbalancedQuotes(current)) {
      current += '\n' + line;
      continue;
    }

    // Check if this line starts a heredoc
    const heredocStart = line.match(/<<-?\s*['"]?(\w+)['"]?/);
    if (heredocStart) {
      if (current) {
        const trimmed = current.trim();
        if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
        current = '';
      }
      current = line;
      heredocDelimiter = heredocStart[1];
      continue;
    }

    // Regular line: accumulate in current buffer
    // (don't push directly: next iteration's unbalanced quote check needs to see it)
    if (current) {
      const prevTrimmed = current.trim();
      if (prevTrimmed && !prevTrimmed.startsWith('#')) commands.push(prevTrimmed);
    }
    current = line;
  }

  // Flush remaining
  if (current) {
    const trimmed = current.trim();
    if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
  }

  return commands;
}

/**
 * One logical command with its heredoc taken apart, in either order (`cat > f << 'EOF'` or
 * `cat << 'EOF' > f`): `command` is the line around the `<<`, `stdin` the body, and `trailing` any
 * lines after the closing delimiter (`EOF\npython file.py`). When the delimiter never came (a
 * truncated stream), the body is everything after the first line.
 */
export function splitHeredoc(cmdString: string): { command: string; stdin?: string; trailing?: string } {
  const match = cmdString.match(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]*?)\n\1(?:[ \t]*\n([\s\S]+))?\s*$/);
  if (match) {
    const before = cmdString.slice(0, match.index ?? 0).trim();
    const afterDelimiter = (match[2] || '').trim();
    return {
      command: afterDelimiter ? `${before} ${afterDelimiter}` : before,
      stdin: match[3],
      ...(match[4] ? { trailing: match[4].trim() } : {}),
    };
  }
  const fallback = cmdString.match(/^([^\n]*?)\s*<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]+)$/);
  if (fallback) {
    const before = fallback[1].trim();
    const afterDelimiter = (fallback[3] || '').trim();
    return {
      command: afterDelimiter ? `${before} ${afterDelimiter}` : before,
      stdin: fallback[4].replace(new RegExp('\\n' + fallback[2] + '\\s*$'), ''),
    };
  }
  return { command: cmdString };
}

/**
 * Every simple command a bash call runs, as the tokens the shell is given: the lines the executor
 * splits, each heredoc body left out (it is input, not command line), the command portion
 * unescaped and tokenized, and the tokens cut at `;`, `&&`, `||` and `|`.
 *
 * The lines after a heredoc's delimiter are split as the executor runs them: unescaped, then one
 * command line per line, comment lines skipped. Read through `splitNewlineCommands` instead, a line
 * that leaves a quote open would take the next line in as text, where the executor runs it.
 */
export function commandStages(command: string): string[][] {
  const lines = command.includes('\n') ? splitNewlineCommands(command) : [command];
  return lines.flatMap((line) => {
    const { command: head, trailing } = splitHeredoc(line);
    const stages: string[][] = [[]];
    for (const token of parseBashCommand(unescapeHtmlEntities(head))) {
      if (token === ';' || token === '&&' || token === '||' || token === '|') stages.push([]);
      else stages[stages.length - 1].push(token);
    }
    const after = trailing
      ? unescapeHtmlEntities(trailing).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      : [];
    return [...stages.filter((stage) => stage.length > 0), ...after.flatMap(commandStages)];
  });
}
