/**
 * Parsing helpers belonging to individual commands.
 *
 * `sed` needs BRE→ERE conversion and address matching, `ss` its selector and entity boundary
 * detection, `head`/`tail` a shared argument parser. They sit together rather than inside each
 * command file because more than one command reaches for them, and they are pure — no VFS, no
 * context, nothing to mock.
 */

interface HeadTailArgs {
  count: number;
  /** `-c` counts characters; otherwise lines. */
  bytes: boolean;
  /** Every path named, in order. */
  filePaths: string[];
  /** `tail -n +N`: from line (or character) N on, rather than the last N. */
  fromStart: boolean;
}

/**
 * Shared argument parsing for head/tail: `-n N`, `-c N`, the `-N` shorthand, and their
 * attached forms (`-n20`, `-c600`).
 *
 * An unrecognised flag is an error rather than something to skip. Skipping it left the flag's
 * value looking like a filename — `head -c 600` read as "show the first 10 lines of /600" and
 * reported a missing file, which says nothing about the flag that was actually unsupported.
 */
export function parseHeadTailArgs(args: string[], cmd: string): HeadTailArgs | { error: string } {
  let count: number | null = null;
  let bytes = false;
  let fromStart = false;
  const filePaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      filePaths.push(a);
      continue;
    }
    const flag = a === '-n' || a === '-c' ? a : a.slice(0, 2);
    const attached = a === '-n' || a === '-c' ? '' : a.slice(2);

    if (flag === '-n' || flag === '-c') {
      const raw = attached || args[++i];
      const parsed = parseInt(raw ?? '', 10);
      if (!Number.isFinite(parsed)) {
        return { error: `${cmd}: ${flag}: expected a number` };
      }
      count = parsed;
      bytes = flag === '-c';
      fromStart = (raw ?? '').startsWith('+');
      continue;
    }
    if (/^-\d+$/.test(a)) {
      count = parseInt(a.slice(1), 10);
      continue;
    }
    return { error: `${cmd}: unsupported option '${a}' (supported: -n, -c)` };
  }

  return { count: count ?? 10, bytes, filePaths, fromStart };
}

/**
 * Convert sed's Basic Regular Expression (BRE) to JavaScript Extended Regular Expression (ERE).
 * In BRE: ( ) { } + ? | are LITERAL unless preceded by \
 * In ERE/JS: ( ) { } + ? | are SPECIAL unless preceded by \
 * This swap ensures sed patterns like `darken(var(--primary), 10%)` match literally.
 */
function breToEre(pat: string): string {
  let result = '';
  let escaped = false;
  let inCharClass = false;
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (escaped) {
      if (inCharClass) {
        // Inside [...], keep escapes as-is — no BRE-to-ERE swap
        result += '\\' + ch;
      } else {
        // \( in BRE = grouping → ( in ERE
        // \) in BRE = grouping → ) in ERE
        // \{ \} \+ \? \| — same swap
        if ('(){}+?|'.includes(ch)) {
          result += ch; // drop the backslash, keep special meaning
        } else {
          result += '\\' + ch; // keep escape as-is (\n, \d, \/, etc.)
        }
      }
      escaped = false;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    // Track character class boundaries
    if (ch === '[' && !inCharClass) {
      inCharClass = true;
      result += ch;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      result += ch;
      continue;
    }
    // Inside [...], all chars are literal — no BRE-to-ERE transformation
    if (inCharClass) {
      result += ch;
      continue;
    }
    // Unescaped ( ) { } + ? | in BRE are literal → escape for ERE
    if ('(){}+?|'.includes(ch)) {
      result += '\\' + ch;
    } else {
      result += ch;
    }
  }
  if (escaped) result += '\\'; // trailing backslash
  return result;
}

function parseSedExpression(expr: string): { pattern: RegExp; replacement: string } | { error: string } {
  if (!expr.startsWith('s')) return { error: `sed: invalid expression: ${expr}` };

  const delim = expr[1];
  if (!delim || !/[\/|#@]/.test(delim)) {
    return { error: `sed: invalid delimiter in expression: ${expr}` };
  }

  // Split on unescaped delimiter
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (let i = 2; i < expr.length; i++) {
    const ch = expr[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; current += ch; continue; }
    if (ch === delim) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current); // flags part (may be empty)

  if (parts.length < 2) {
    return { error: `sed: incomplete expression: ${expr}\n\nUsage: sed 's/pattern/replacement/[flags]'\n  flags: g (global)` };
  }

  const [patStr, replStr, flagStr] = parts;

  // Detect multiline \n patterns — not supported in VFS sed
  if (patStr.includes('\\n') || replStr.includes('\\n')) {
    return { error: `sed: multiline patterns with \\n are not supported.\n\nFor multiline edits, use ss (supersed):\n  ss /file << 'EOF'\n  text to find\n  =======\n  replacement text\n  EOF` };
  }

  const globalFlag = (flagStr || '').includes('g');

  try {
    // Convert BRE pattern to JavaScript ERE (unescaped parens become literal, etc.)
    const erePattern = breToEre(patStr);
    const pattern = new RegExp(erePattern, globalFlag ? 'g' : '');
    // Unescape the replacement string (remove backslash-delimiter escapes)
    let replacement = replStr.replace(new RegExp('\\\\' + delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), delim);
    // Translate sed backreferences to JS: \1→$1, \2→$2, etc. and &→$&
    // First protect escaped ampersand (\&) and escaped backslash (\\)
    replacement = replacement
      .replace(/\\\\/g, '\x00BSLASH\x00')
      .replace(/\\&/g, '\x00AMP\x00')
      .replace(/&/g, '$$&')
      .replace(/\\([1-9])/g, '$$$1')
      .replace(/\x00AMP\x00/g, '&')
      .replace(/\x00BSLASH\x00/g, '\\');
    return { pattern, replacement };
  } catch (e: any) {
    return { error: `sed: invalid regex "${patStr}": ${e?.message || 'parse error'}` };
  }
}

/** Address type for sed range commands */
type SedAddress = { type: 'line'; line: number } | { type: 'pattern'; pattern: RegExp } | { type: 'last' };

/** Parsed sed command — substitution, delete, change, insert, append, print, or group */
export type SedCommand =
  | { kind: 'substitute'; pattern: RegExp; replacement: string; start?: SedAddress; end?: SedAddress; negate?: boolean }
  | { kind: 'delete'; start: SedAddress; end?: SedAddress; negate?: boolean }
  | { kind: 'change'; start: SedAddress; end?: SedAddress; text: string; negate?: boolean }
  | { kind: 'insert'; start: SedAddress; text: string; negate?: boolean }
  | { kind: 'append'; start: SedAddress; text: string; negate?: boolean }
  | { kind: 'print'; start: SedAddress; end?: SedAddress; negate?: boolean }
  | { kind: 'group'; start: SedAddress; end?: SedAddress; commands: SedCommand[] };

/**
 * Parse a sed address like /pattern/, a line number, or $
 * Returns the address and the remaining string after it.
 */
function parseSedAddress(expr: string): { addr: SedAddress; rest: string } | null {
  if (!expr) return null;

  // Line number
  const lineMatch = expr.match(/^(\d+)(.*)/);
  if (lineMatch) {
    return { addr: { type: 'line', line: parseInt(lineMatch[1], 10) }, rest: lineMatch[2] };
  }

  // $ = last line
  if (expr[0] === '$') {
    return { addr: { type: 'last' }, rest: expr.slice(1) };
  }

  // /pattern/ or \xpatternx (alternate delimiter)
  if (expr[0] === '/' || expr[0] === '\\') {
    const delim = expr[0] === '\\' ? expr[1] : '/';
    const start = expr[0] === '\\' ? 2 : 1;
    let pattern = '';
    let escaped = false;
    let i = start;
    for (; i < expr.length; i++) {
      if (escaped) { pattern += expr[i]; escaped = false; continue; }
      if (expr[i] === '\\') { escaped = true; pattern += '\\'; continue; }
      if (expr[i] === delim) { i++; break; }
      pattern += expr[i];
    }
    try {
      return { addr: { type: 'pattern', pattern: new RegExp(breToEre(pattern)) }, rest: expr.slice(i) };
    } catch {
      return null;
    }
  }

  return null;
}

/** The index just past the closing `delim` of a section starting at `i`, past backslash escapes. */
function skipDelimited(s: string, i: number, delim: string): number {
  for (; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === delim) return i + 1;
  }
  return s.length;
}

function skipAddress(s: string, i: number): number {
  if (/\d/.test(s[i] ?? '')) { while (/\d/.test(s[i] ?? '')) i++; return i; }
  if (s[i] === '$') return i + 1;
  if (s[i] === '/') return skipDelimited(s, i + 1, '/');
  if (s[i] === '\\' && i + 1 < s.length) return skipDelimited(s, i + 2, s[i + 1]);
  return i;
}

/** The end of the command starting at `i`: its addresses, `!`, and the command with its arguments. */
function skipSedCommand(s: string, i: number): number {
  i = skipAddress(s, i);
  if (s[i] === ',') i = skipAddress(s, i + 1);
  while (s[i] === ' ' || s[i] === '\t') i++;
  if (s[i] === '!') i++;
  while (s[i] === ' ' || s[i] === '\t') i++;
  const c = s[i];
  if (c === 's' && i + 1 < s.length) {
    const delim = s[i + 1];
    let j = skipDelimited(s, skipDelimited(s, i + 2, delim), delim);
    while (j < s.length && /[gpiIm0-9]/.test(s[j])) j++;
    return j;
  }
  // a, i and c take the rest of the line as their text, `;` included.
  if (c === 'a' || c === 'i' || c === 'c') {
    const end = s.indexOf('\n', i);
    return end < 0 ? s.length : end;
  }
  if (c === '{') {
    let j = i + 1;
    for (;;) {
      while (j < s.length && /[\s;]/.test(s[j])) j++;
      if (j >= s.length) return s.length;
      if (s[j] === '}') return j + 1;
      const next = skipSedCommand(s, j);
      j = next > j ? next : j + 1;
    }
  }
  return i < s.length ? i + 1 : i;
}

/**
 * A sed script split into its commands, at `;` and newlines between commands. A `;` inside an
 * address, an `s` section, a `{...}` group or `a`/`i`/`c` text belongs to that command.
 */
export function splitSedScript(script: string): string[] {
  const commands: string[] = [];
  let i = 0;
  while (i < script.length) {
    while (i < script.length && /[\s;]/.test(script[i])) i++;
    if (i >= script.length) break;
    const end = skipSedCommand(script, i);
    commands.push(script.slice(i, end > i ? end : script.length).trim());
    i = end > i ? end : script.length;
  }
  return commands;
}

/**
 * Parse a full sed command expression including optional addresses.
 * Supports: /addr1/,/addr2/d  /addr1/,/addr2/c\text  /addr1/,/addr2/p  s/old/new/g
 */
export function parseSedCommand(expr: string): SedCommand | { error: string } {
  // Try substitution first (most common)
  if (expr.startsWith('s') && expr.length > 2 && /[\/|#@]/.test(expr[1])) {
    const parsed = parseSedExpression(expr);
    if ('error' in parsed) return parsed;
    return { kind: 'substitute', ...parsed };
  }

  // Try address-based commands: /pattern/,/pattern/d  or  5,10d  etc.
  const addr1Result = parseSedAddress(expr);
  if (!addr1Result) {
    return { error: `sed: unrecognized command: ${expr}` };
  }

  let addr2: SedAddress | undefined;
  let remaining = addr1Result.rest;

  // Check for ,addr2
  if (remaining.startsWith(',')) {
    const addr2Result = parseSedAddress(remaining.slice(1));
    if (!addr2Result) {
      return { error: `sed: invalid end address in: ${expr}` };
    }
    addr2 = addr2Result.addr;
    remaining = addr2Result.rest;
  }

  // Parse the command character
  remaining = remaining.trim();

  // Check for ! negate modifier
  let negate = false;
  if (remaining.startsWith('!')) {
    negate = true;
    remaining = remaining.slice(1).trim();
  }

  // Check for {...} command group
  if (remaining.startsWith('{')) {
    const closeIdx = remaining.lastIndexOf('}');
    if (closeIdx < 0) return { error: `sed: unmatched { in: ${expr}` };
    const inner = remaining.slice(1, closeIdx).trim();
    const innerParts = splitSedScript(inner);
    const commands: SedCommand[] = [];
    for (const part of innerParts) {
      const parsed = parseSedCommand(part);
      if ('error' in parsed) return parsed;
      commands.push(parsed);
    }
    return { kind: 'group', start: addr1Result.addr, end: addr2, commands };
  }

  const neg = negate ? { negate: true as const } : {};
  if (remaining === 'd') {
    return { kind: 'delete', start: addr1Result.addr, end: addr2, ...neg };
  }
  if (remaining === 'p') {
    return { kind: 'print', start: addr1Result.addr, end: addr2, ...neg };
  }
  if (remaining.startsWith('c\\') || remaining.startsWith('c ')) {
    const text = remaining.slice(2).replace(/\\n/g, '\n');
    return { kind: 'change', start: addr1Result.addr, end: addr2, text, ...neg };
  }
  // i\ — insert text before matched line (single address only)
  if (remaining.startsWith('i\\') || remaining.startsWith('i ')) {
    const text = remaining.slice(2).replace(/\\n/g, '\n');
    return { kind: 'insert', start: addr1Result.addr, text, ...neg };
  }
  // a\ — append text after matched line (single address only)
  if (remaining.startsWith('a\\') || remaining.startsWith('a ')) {
    const text = remaining.slice(2).replace(/\\n/g, '\n');
    return { kind: 'append', start: addr1Result.addr, text, ...neg };
  }
  // Address + substitution: 6s/old/new/ or /pattern/s/old/new/g
  if (remaining.startsWith('s') && remaining.length > 2 && /[\/|#@]/.test(remaining[1])) {
    const parsed = parseSedExpression(remaining);
    if ('error' in parsed) return parsed;
    return { kind: 'substitute', ...parsed, start: addr1Result.addr, end: addr2, ...neg };
  }

  return { error: `sed: unsupported command "${remaining}" in: ${expr}` };
}

/** Check if a sed address matches a given line */
export function addressMatches(addr: SedAddress, lineNum: number, lineContent: string, totalLines: number): boolean {
  switch (addr.type) {
    case 'line': return lineNum === addr.line;
    case 'last': return lineNum === totalLines;
    case 'pattern': return addr.pattern.test(lineContent);
  }
}

// ─── ss (supersed) utilities ───────────────────────────────────────────────

/**
 * Locate selector within content while relaxing leading indentation and trailing whitespace.
 * Tries exact match first, then trimmed variants.
 */
export function ssFindSelectorMatch(content: string, selector: string): { index: number; normalizedSelector: string } | null {
  const variants: string[] = [];
  const seen = new Set<string>();

  const addVariant = (value: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    variants.push(value);
  };

  addVariant(selector);
  addVariant(selector.replace(/^\s+/, ''));
  addVariant(selector.replace(/\s+$/, ''));
  addVariant(selector.replace(/^\s+/, '').replace(/\s+$/, ''));

  for (const variant of variants) {
    const index = content.indexOf(variant);
    if (index !== -1) {
      return { index, normalizedSelector: variant };
    }
  }

  return null;
}

/**
 * Auto-detect whether the selector targets an HTML element (tag-matched)
 * or a bracket-matched entity (function, class, CSS rule, etc.).
 */
export function ssIsHtmlEntity(selector: string): boolean {
  return selector.startsWith('<') && selector.includes('>');
}

/**
 * Detect entity boundaries — dispatch to HTML tag matching or bracket matching.
 */
export function ssDetectEntityBoundary(
  content: string,
  selectorIndex: number,
  selector: string,
  isHtml: boolean
): { start: number; end: number } | null {
  if (selectorIndex < 0 || selectorIndex >= content.length) return null;

  if (isHtml) {
    return ssDetectHtmlElementBoundary(content, selectorIndex, selector);
  }
  return ssDetectBracketBoundary(content, selectorIndex);
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Detect HTML element boundaries by matching opening and closing tags.
 * Handles nested tags of the same name and self-closing elements.
 */
function ssDetectHtmlElementBoundary(
  content: string,
  selectorIndex: number,
  selector: string
): { start: number; end: number } | null {
  const tagMatch = selector.match(/<(\w+)(?:\s|>|\/)/);
  if (!tagMatch) return null;

  const tagName = tagMatch[1];
  const start = selectorIndex;

  // Self-closing: <br/>, <img ... />, or void elements
  if (selector.includes('/>') || VOID_ELEMENTS.has(tagName.toLowerCase())) {
    // Find closing '>' of tag, skipping '>' inside quoted attribute values
    let tagEnd = selectorIndex;
    let inQuote: string | null = null;
    while (tagEnd < content.length) {
      const ch = content[tagEnd];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>') {
        return { start, end: tagEnd + 1 };
      }
      tagEnd++;
    }
    return null;
  }

  // Track depth for nested same-name tags
  // Use quote-aware regex to handle > inside attribute values like <div title="a > b">
  const openRe = new RegExp(`<${tagName}(?:\\s(?:[^>"']*|"[^"]*"|'[^']*')*)?>`, 'gi');
  const closeRe = new RegExp(`</${tagName}>`, 'gi');

  // Collect all open and close positions after selectorIndex
  const events: { pos: number; len: number; type: 'open' | 'close' }[] = [];

  openRe.lastIndex = selectorIndex;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(content)) !== null) {
    // Skip self-closing tags
    if (content[m.index + m[0].length - 2] === '/') continue;
    events.push({ pos: m.index, len: m[0].length, type: 'open' });
  }

  closeRe.lastIndex = selectorIndex;
  while ((m = closeRe.exec(content)) !== null) {
    events.push({ pos: m.index, len: m[0].length, type: 'close' });
  }

  events.sort((a, b) => a.pos - b.pos);

  let depth = 0;
  for (const ev of events) {
    if (ev.type === 'open') {
      depth++;
    } else {
      if (depth > 0) depth--;
      if (depth === 0) {
        return { start, end: ev.pos + ev.len };
      }
    }
  }

  return null;
}

/**
 * Detect bracket-matched entity boundary (functions, classes, CSS rules).
 * Improved: skips braces inside strings, template literals, and comments.
 */
function ssDetectBracketBoundary(
  content: string,
  selectorIndex: number
): { start: number; end: number } | null {
  // Find the opening bracket
  const openPos = content.indexOf('{', selectorIndex);
  if (openPos === -1) return null;

  const start = selectorIndex;
  let depth = 0;
  let i = openPos;

  while (i < content.length) {
    const ch = content[i];

    // Skip single-line comments
    if (ch === '/' && content[i + 1] === '/') {
      const eol = content.indexOf('\n', i);
      i = eol === -1 ? content.length : eol + 1;
      continue;
    }

    // Skip multi-line comments
    if (ch === '/' && content[i + 1] === '*') {
      const endComment = content.indexOf('*/', i + 2);
      i = endComment === -1 ? content.length : endComment + 2;
      continue;
    }

    // Skip double-quoted strings
    if (ch === '"') {
      i++;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    // Skip single-quoted strings
    if (ch === "'") {
      i++;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }

    // Skip template literals
    if (ch === '`') {
      i++;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === '`') { i++; break; }
        // Skip ${...} expressions inside template literals
        if (content[i] === '$' && content[i + 1] === '{') {
          let tDepth = 1;
          i += 2;
          while (i < content.length && tDepth > 0) {
            if (content[i] === '{') tDepth++;
            else if (content[i] === '}') tDepth--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { start, end: i + 1 };
      }
    }
    i++;
  }

  return null;
}

/**
 * Map a normalized (whitespace-collapsed) search string back to the original content.
 * Returns the start/end positions in the original content.
 */
const WS_RE = /\s/;

export function ssMapNormalizedToOriginal(content: string, normalizedSearch: string): { start: number; end: number } | null {
  // Build a mapping from normalized positions to original positions
  // Strategy: walk both the original content and the normalized search simultaneously
  const contentLen = content.length;
  const searchLen = normalizedSearch.length;

  // Try each position in the original content as a potential start
  for (let origStart = 0; origStart < contentLen; origStart++) {
    let oi = origStart;
    let si = 0;
    let matched = true;

    while (si < searchLen && oi < contentLen) {
      // In normalized form, whitespace runs collapse to a single space
      if (normalizedSearch[si] === ' ') {
        // The original must have at least one whitespace character here
        if (!WS_RE.test(content[oi])) { matched = false; break; }
        // Skip all whitespace in original
        while (oi < contentLen && WS_RE.test(content[oi])) oi++;
        si++;
      } else {
        if (content[oi] !== normalizedSearch[si]) { matched = false; break; }
        oi++;
        si++;
      }
    }

    if (!matched) continue;
    if (si === searchLen) {
      return { start: origStart, end: oi };
    }
  }

  return null;
}
