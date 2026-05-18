import { VirtualFileSystem } from './index';
import { drainCompileErrors, formatCompileErrors } from '@/lib/preview/compile-errors';

/**
 * Minimal context passed from the orchestrator into the shell executor so
 * commands can emit progress events (e.g. `ask`, `brief`, `spec`) without
 * depending on browser globals. Defined here to avoid a circular import
 * with lib/llm; callers pass a compatible subset of ToolExecutionContext.
 */
export interface ShellContext {
  onProgress?: (event: string, data?: any) => void;
}

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Optional reason flag the orchestrator can act on. Currently used by `ask`
   * to signal "awaiting_user" so the loop pauses for a chip selection.
   */
  exitReason?: string;
};

const TRUNCATE_CHARS = 100000;

function truncate(out: string): string {
  if (out.length > TRUNCATE_CHARS) {
    return out.slice(0, TRUNCATE_CHARS) + "\n… [truncated]";
  }
  return out;
}

function normalizePath(p?: string): string | undefined {
  if (!p) return p;
  if (p.startsWith('/workspace')) {
    const rest = p.slice('/workspace'.length);
    p = rest.length ? rest : '/';
  }
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

async function ensureDirectory(vfs: VirtualFileSystem, projectId: string, path: string) {
  if (path === '/' || !path) return;
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    cur = '/' + parts.slice(0, i + 1).join('/');
    try {
      // relies on createDirectory being idempotent
      await vfs.createDirectory(projectId, cur);
    } catch {
      // ignore
    }
  }
}

/**
 * Strip bash stderr/stdout redirect operators that are no-ops in the virtual shell.
 * LLMs reflexively append patterns like `2>/dev/null`, `&>/dev/null`, `2>&1`, etc.
 * Handles both fused (`2>/dev/null`) and split (`2>` `/dev/null`) token forms.
 */
function stripBashRedirects(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    // Exact fd-duplication: 2>&1
    if (token === '2>&1') continue;
    // Bare redirect operator (2>, 2>>, 1>, 1>>, &>, &>>) — skip it AND the next token (the target path)
    if (/^(?:2|1|&)>>?$/.test(token)) { i++; continue; }
    // Fused redirect+path (2>/dev/null, 1>/tmp/err, &>/dev/null, 2>>/dev/null, etc.)
    if (/^(?:2|1|&)>>?./.test(token)) continue;
    result.push(token);
  }
  return result;
}

/**
 * Extract redirect operator from args: > (overwrite) or >> (append)
 * Returns cleaned args and redirect info
 */
function extractRedirect(args: string[]): { cleanArgs: string[]; redirect?: { file: string; append: boolean } } {
  const appendIdx = args.indexOf('>>');
  const overwriteIdx = args.indexOf('>');

  // Use whichever redirect appears first; prefer >> when at the same position
  let idx: number;
  if (appendIdx !== -1 && overwriteIdx !== -1) {
    idx = appendIdx <= overwriteIdx ? appendIdx : overwriteIdx;
  } else {
    idx = appendIdx !== -1 ? appendIdx : overwriteIdx;
  }
  if (idx === -1) return { cleanArgs: args };

  const append = args[idx] === '>>';
  const file = args[idx + 1];
  if (!file) return { cleanArgs: args }; // No file after redirect — leave as-is

  const cleanArgs = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { cleanArgs, redirect: { file, append } };
}

/**
 * Apply redirect: write stdout to file (> = overwrite, >> = append)
 */
async function applyRedirect(
  vfs: VirtualFileSystem,
  projectId: string,
  content: string,
  redirect: { file: string; append: boolean }
): Promise<ShellResult> {
  const path = normalizePath(redirect.file);
  if (!path) return { stdout: '', stderr: 'redirect: missing file path', exitCode: 2 };

  try {
    const dirPath = path.split('/').slice(0, -1).join('/') || '/';
    if (dirPath !== '/') await ensureDirectory(vfs, projectId, dirPath);

    if (redirect.append) {
      // Append: read existing + append
      let existing = '';
      try {
        const file = await vfs.readFile(projectId, path);
        if (typeof file.content === 'string') existing = file.content;
      } catch { /* file doesn't exist yet */ }
      const newContent = existing ? existing + '\n' + content : content;
      try { await vfs.createFile(projectId, path, newContent); }
      catch { await vfs.updateFile(projectId, path, newContent); }
    } else {
      // Overwrite
      try { await vfs.createFile(projectId, path, content); }
      catch { await vfs.updateFile(projectId, path, content); }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: '', stderr: `redirect: ${path}: ${e?.message || 'cannot write file'}`, exitCode: 1 };
  }
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
    return { error: `sed: multiline patterns with \\n are not supported.\n\nFor multiline edits, use ss (supersed):\n  ss /file << 'EOF'\n  text to find\n  ===\n  replacement text\n  EOF` };
  }

  const globalFlag = (flagStr || '').includes('g');

  try {
    // Convert BRE pattern to JavaScript ERE (unescaped parens become literal, etc.)
    const erePattern = breToEre(patStr);
    const pattern = new RegExp(erePattern, globalFlag ? 'g' : '');
    // Unescape the replacement string (remove backslash-delimiter escapes)
    const replacement = replStr.replace(new RegExp('\\\\' + delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), delim);
    return { pattern, replacement };
  } catch (e: any) {
    return { error: `sed: invalid regex "${patStr}": ${e?.message || 'parse error'}` };
  }
}

/** Address type for sed range commands */
type SedAddress = { type: 'line'; line: number } | { type: 'pattern'; pattern: RegExp } | { type: 'last' };

/** Parsed sed command — substitution, delete, change, insert, append, or print */
type SedCommand =
  | { kind: 'substitute'; pattern: RegExp; replacement: string; start?: SedAddress; end?: SedAddress }
  | { kind: 'delete'; start: SedAddress; end?: SedAddress }
  | { kind: 'change'; start: SedAddress; end?: SedAddress; text: string }
  | { kind: 'insert'; start: SedAddress; text: string }
  | { kind: 'append'; start: SedAddress; text: string }
  | { kind: 'print'; start: SedAddress; end?: SedAddress };

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

/**
 * Parse a full sed command expression including optional addresses.
 * Supports: /addr1/,/addr2/d  /addr1/,/addr2/c\text  /addr1/,/addr2/p  s/old/new/g
 */
function parseSedCommand(expr: string): SedCommand | { error: string } {
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
  if (remaining === 'd') {
    return { kind: 'delete', start: addr1Result.addr, end: addr2 };
  }
  if (remaining === 'p') {
    return { kind: 'print', start: addr1Result.addr, end: addr2 };
  }
  if (remaining.startsWith('c\\') || remaining.startsWith('c ')) {
    const text = remaining.slice(2).replace(/\\n/g, '\n');
    return { kind: 'change', start: addr1Result.addr, end: addr2, text };
  }
  // i\ — insert text before matched line (single address only)
  if (remaining.startsWith('i\\') || remaining.startsWith('i ')) {
    const text = remaining.slice(2).replace(/\\n/g, '\n');
    return { kind: 'insert', start: addr1Result.addr, text };
  }
  // a\ — append text after matched line (single address only)
  if (remaining.startsWith('a\\') || remaining.startsWith('a ')) {
    const text = remaining.slice(2).replace(/\\n/g, '\n');
    return { kind: 'append', start: addr1Result.addr, text };
  }
  // Address + substitution: 6s/old/new/ or /pattern/s/old/new/g
  if (remaining.startsWith('s') && remaining.length > 2 && /[\/|#@]/.test(remaining[1])) {
    const parsed = parseSedExpression(remaining);
    if ('error' in parsed) return parsed;
    return { kind: 'substitute', ...parsed, start: addr1Result.addr, end: addr2 };
  }

  return { error: `sed: unsupported command "${remaining}" in: ${expr}` };
}

/** Check if a sed address matches a given line */
function addressMatches(addr: SedAddress, lineNum: number, lineContent: string, totalLines: number): boolean {
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
function ssFindSelectorMatch(content: string, selector: string): { index: number; normalizedSelector: string } | null {
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
function ssIsHtmlEntity(selector: string): boolean {
  return selector.startsWith('<') && selector.includes('>');
}

/**
 * Detect entity boundaries — dispatch to HTML tag matching or bracket matching.
 */
function ssDetectEntityBoundary(
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

function ssMapNormalizedToOriginal(content: string, normalizedSearch: string): { start: number; end: number } | null {
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

async function vfsShellExecute(
  vfs: VirtualFileSystem,
  projectId: string,
  cmd: string[],
  stdin?: string,
  ctx?: ShellContext
): Promise<ShellResult> {
  // Validate inputs
  if (!projectId || typeof projectId !== 'string') {
    return { stdout: '', stderr: 'Invalid project ID provided', exitCode: 2 };
  }

  if (!cmd || cmd.length === 0) {
    return { stdout: '', stderr: 'No command provided', exitCode: 2 };
  }

  const cleanCmd = stripBashRedirects(
    cmd.filter(arg => arg !== undefined && arg !== null && arg !== '')
  );
  if (cleanCmd.length === 0) {
    return { stdout: '', stderr: 'No valid command arguments provided', exitCode: 2 };
  }

  // Handle ; separator - execute all sequentially regardless of exit codes
  if (cleanCmd.some(arg => arg === ';')) {
    const commands: string[][] = [];
    let currentCmd: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === ';') {
        if (currentCmd.length > 0) {
          commands.push(currentCmd);
          currentCmd = [];
        }
      } else {
        currentCmd.push(arg);
      }
    }
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
    }

    // Execute all commands sequentially regardless of exit codes
    const allStdout: string[] = [];
    const allStderr: string[] = [];
    let lastExitCode = 0;
    let lastExitReason: string | undefined;

    for (const singleCmd of commands) {
      const result = await vfsShellExecuteSingle(vfs, projectId, singleCmd, undefined, ctx);
      if (result.stdout) allStdout.push(result.stdout);
      if (result.stderr) allStderr.push(result.stderr);
      lastExitCode = result.exitCode;
      lastExitReason = result.exitReason;
    }

    return {
      stdout: allStdout.join('\n'),
      stderr: allStderr.join('\n'),
      exitCode: lastExitCode,
      exitReason: lastExitReason
    };
  }

  // Handle && command chaining - execute sequentially, stop on first failure
  if (cleanCmd.some(arg => arg === '&&')) {
    const commands: string[][] = [];
    let currentCmd: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === '&&') {
        if (currentCmd.length > 0) {
          commands.push(currentCmd);
          currentCmd = [];
        }
      } else {
        currentCmd.push(arg);
      }
    }
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
    }

    // Execute commands sequentially
    const allStdout: string[] = [];
    const allStderr: string[] = [];
    let lastExitReason: string | undefined;

    for (const singleCmd of commands) {
      const result = await vfsShellExecuteSingle(vfs, projectId, singleCmd, undefined, ctx);
      if (result.stdout) allStdout.push(result.stdout);
      if (result.stderr) allStderr.push(result.stderr);
      lastExitReason = result.exitReason;

      // Stop on first failure (that's && semantics)
      if (result.exitCode !== 0) {
        return {
          stdout: allStdout.join('\n'),
          stderr: allStderr.join('\n'),
          exitCode: result.exitCode,
          exitReason: result.exitReason
        };
      }
    }

    return {
      stdout: allStdout.join('\n'),
      stderr: allStderr.join('\n'),
      exitCode: 0,
      exitReason: lastExitReason
    };
  }

  // Handle || fallback - execute sequentially, skip remaining on first success
  if (cleanCmd.some(arg => arg === '||')) {
    const commands: string[][] = [];
    let currentCmd: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === '||') {
        if (currentCmd.length > 0) {
          commands.push(currentCmd);
          currentCmd = [];
        }
      } else {
        currentCmd.push(arg);
      }
    }
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
    }

    // Execute commands sequentially, stop on first success
    let lastResult: ShellResult = { stdout: '', stderr: '', exitCode: 1 };
    for (const singleCmd of commands) {
      lastResult = await vfsShellExecuteSingle(vfs, projectId, singleCmd, undefined, ctx);
      if (lastResult.exitCode === 0) {
        return lastResult;
      }
    }

    return lastResult;
  }

  // Handle pipe chains: cmd1 | cmd2 | cmd3
  if (cleanCmd.some(arg => arg === '|')) {
    const segments: string[][] = [];
    let currentSeg: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === '|') {
        if (currentSeg.length > 0) {
          segments.push(currentSeg);
          currentSeg = [];
        }
      } else {
        currentSeg.push(arg);
      }
    }
    if (currentSeg.length > 0) segments.push(currentSeg);

    if (segments.length < 2) {
      return vfsShellExecuteSingle(vfs, projectId, cleanCmd, undefined, ctx);
    }

    // Execute pipe chain left-to-right, passing stdout as stdin
    let pipeStdin: string | undefined = stdin;
    for (let i = 0; i < segments.length; i++) {
      const result = await vfsShellExecuteSingle(vfs, projectId, segments[i], pipeStdin, ctx);
      if (result.exitCode !== 0) return result;
      pipeStdin = result.stdout;
    }

    return { stdout: pipeStdin || '', stderr: '', exitCode: 0 };
  }

  return vfsShellExecuteSingle(vfs, projectId, cleanCmd, stdin, ctx);
}

/**
 * Expand glob patterns (*, ?) in arguments against the VFS file listing.
 * Converts e.g. `/scripts/*.js` into ['/scripts/main.js', '/scripts/app.js'].
 * Only expands args that contain glob characters and aren't flags.
 * If a pattern matches nothing, the original arg is kept (bash default).
 */
async function expandGlobs(
  vfs: VirtualFileSystem,
  projectId: string,
  args: string[]
): Promise<string[]> {
  // Quick check: any args need expansion?
  if (!args.some(a => a && !a.startsWith('-') && (a.includes('*') || a.includes('?')))) {
    return args;
  }

  // Get all file paths once
  const allEntries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
  const allPaths = allEntries.map((e: any) => e.path as string);

  const expanded: string[] = [];
  for (const arg of args) {
    if (!arg || arg.startsWith('-') || (!arg.includes('*') && !arg.includes('?'))) {
      expanded.push(arg);
      continue;
    }

    // Normalize path (adds / prefix if missing)
    const normalized = normalizePath(arg) || arg;

    // Convert glob to regex: escape regex chars, then replace * and ?
    const regexStr = normalized
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');

    const regex = new RegExp(`^${regexStr}$`);
    const matches = allPaths.filter(p => regex.test(p)).sort();

    if (matches.length > 0) {
      expanded.push(...matches);
    } else {
      expanded.push(arg); // No matches — keep original
    }
  }

  return expanded;
}

// Commands where file-path arguments should be glob-expanded.
// Excludes: rg, grep, sed (pattern args), find (-name takes its own glob),
// echo (text content), curl (URLs), status (special).
const GLOB_EXPAND_COMMANDS = new Set([
  'wc', 'ls', 'cat', 'rm', 'cp', 'mv', 'touch',
]);

async function vfsShellExecuteSingle(
  vfs: VirtualFileSystem,
  projectId: string,
  cleanCmd: string[],
  stdin?: string,
  ctx?: ShellContext
): Promise<ShellResult> {
  // Extract redirect operators (> or >>) before processing the command
  const { cleanArgs: argsAfterRedirect, redirect } = extractRedirect(cleanCmd.slice(1));
  const program = cleanCmd[0];
  const args = GLOB_EXPAND_COMMANDS.has(program)
    ? await expandGlobs(vfs, projectId, argsAfterRedirect)
    : argsAfterRedirect;

  try {
    switch (program) {
      case 'ls': {
        // Support flags: -R (recursive), -l/-la/-lh (long format with size & date).
        const lsFlags = new Set<string>();
        const lsPaths: string[] = [];
        for (const a of args) {
          if (a && a.startsWith('-')) lsFlags.add(a);
          else if (a) lsPaths.push(a);
        }
        const recursive = lsFlags.has('-R') || lsFlags.has('-r');
        const longFormat = lsFlags.has('-l') || lsFlags.has('-la') || lsFlags.has('-al') || lsFlags.has('-lh') || lsFlags.has('-lha') || lsFlags.has('-lah');
        const humanReadable = lsFlags.has('-lh') || lsFlags.has('-lha') || lsFlags.has('-lah') || lsFlags.has('-h');

        const formatFileSize = (bytes: number): string => {
          if (!humanReadable) return String(bytes).padStart(8);
          if (bytes < 1024) return `${bytes}B`.padStart(8);
          if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`.padStart(8);
          return `${(bytes / (1024 * 1024)).toFixed(1)}M`.padStart(8);
        };

        const formatFileLong = (f: { path: string; size?: number; updatedAt?: Date }) => {
          const size = formatFileSize(f.size || 0);
          const date = f.updatedAt ? new Date(f.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '                ';
          return `${size}  ${date}  ${f.path}`;
        };

        // Multiple paths: each could be a file or directory
        if (lsPaths.length > 1) {
          const lines: string[] = [];
          for (let pi = 0; pi < lsPaths.length; pi++) {
            const np = normalizePath(lsPaths[pi]);
            if (!np) continue;
            // Try as file first
            try {
              const file = await vfs.readFile(projectId, np);
              lines.push(longFormat ? formatFileLong(file) : file.path);
              continue;
            } catch { /* not a file — try as directory */ }
            // Try as directory
            const dirFiles = await vfs.listDirectory(projectId, np, { includeTransient: true });
            if (dirFiles.length > 0) {
              if (pi > 0) lines.push(''); // blank line between directory sections
              lines.push(`${np}:`);
              const sorted = dirFiles.sort((a, b) => a.path.localeCompare(b.path));
              for (const f of sorted) {
                lines.push(longFormat ? formatFileLong(f) : f.path);
              }
            } else {
              lines.push(`ls: ${np}: No such file or directory`);
            }
          }
          const lsOutput = lines.join('\n');
          const lsResult: ShellResult = { stdout: truncate(lsOutput), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirect(vfs, projectId, lsResult.stdout, redirect);
          return lsResult;
        }

        // Single path: directory listing
        const lsPath = normalizePath(lsPaths[0]) || '/';
        let lsOutput: string;
        if (!recursive) {
          const files = await vfs.listDirectory(projectId, lsPath, { includeTransient: true });
          const sorted = files.sort((a, b) => a.path.localeCompare(b.path));
          lsOutput = longFormat
            ? sorted.map(f => formatFileLong(f)).join('\n')
            : sorted.map(f => f.path).join('\n');
        } else {
          const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
          const prefix = lsPath === '/' ? '/' : (lsPath.endsWith('/') ? lsPath : lsPath + '/');
          const filtered = entries
            .filter((e: any) => e.path === lsPath || e.path.startsWith(prefix))
            .sort((a: any, b: any) => a.path.localeCompare(b.path));
          lsOutput = longFormat
            ? filtered.map((e: any) => formatFileLong(e)).join('\n')
            : filtered.map((e: any) => e.path).join('\n');
        }
        const lsResult: ShellResult = { stdout: truncate(lsOutput), stderr: '', exitCode: 0 };
        if (redirect) return applyRedirect(vfs, projectId, lsResult.stdout, redirect);
        return lsResult;
      }
      case 'tree': {
        // tree [path] [-L depth]
        let maxDepth = Infinity;
        let targetPath = '/';

        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-L' && args[i + 1]) {
            maxDepth = parseInt(args[++i]) || Infinity;
          } else if (!a.startsWith('-')) {
            targetPath = a;
          }
        }

        const basePath = normalizePath(targetPath) || '/';
        const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
        const prefix = basePath === '/' ? '' : basePath;

        // Build a set of all paths including implied directories
        const allPaths = new Set<string>();
        const dirPaths = new Set<string>();

        for (const entry of entries) {
          const entryPath = entry.path;
          // Only include entries under the target path
          if (basePath !== '/' && !entryPath.startsWith(basePath + '/') && entryPath !== basePath) {
            continue;
          }

          allPaths.add(entryPath);
          const isDir = 'type' in entry && entry.type === 'directory';
          if (isDir) dirPaths.add(entryPath);

          // Add implied parent directories (for transient files like /.skills/foo.md)
          const parts = entryPath.split('/').filter(Boolean);
          let currentPath = '';
          for (let i = 0; i < parts.length - 1; i++) {
            currentPath += '/' + parts[i];
            if (!allPaths.has(currentPath)) {
              allPaths.add(currentPath);
              dirPaths.add(currentPath);
            }
          }
        }

        // Convert to sorted array, filtering by base path and depth
        const sortedPaths = Array.from(allPaths)
          .filter(p => {
            if (basePath === '/') return p !== '/';
            return p.startsWith(basePath + '/') || p === basePath;
          })
          .sort();

        // Build tree output with proper indentation
        interface TreeNode {
          name: string;
          path: string;
          isDir: boolean;
          children: TreeNode[];
        }

        // Build tree structure
        const root: TreeNode = { name: basePath === '/' ? '.' : basePath.split('/').pop() || '.', path: basePath, isDir: true, children: [] };
        const nodeMap = new Map<string, TreeNode>();
        nodeMap.set(basePath === '/' ? '' : basePath, root);

        for (const p of sortedPaths) {
          if (p === basePath) continue;
          const relativePath = basePath === '/' ? p : p.slice(basePath.length);
          const parts = relativePath.split('/').filter(Boolean);
          const depth = parts.length;
          if (depth > maxDepth) continue;

          const name = parts[parts.length - 1];
          const parentPath = basePath === '/'
            ? '/' + parts.slice(0, -1).join('/')
            : basePath + '/' + parts.slice(0, -1).join('/');
          const normalizedParent = parentPath === '/' ? '' : parentPath.replace(/\/$/, '');

          const node: TreeNode = {
            name,
            path: p,
            isDir: dirPaths.has(p),
            children: []
          };

          const parent = nodeMap.get(normalizedParent) || root;
          parent.children.push(node);
          nodeMap.set(p, node);
        }

        // Render tree with proper characters
        const lines: string[] = [basePath];

        function renderNode(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): void {
          if (!isRoot) {
            const connector = isLast ? '└── ' : '├── ';
            const suffix = node.isDir ? '/' : '';
            lines.push(prefix + connector + node.name + suffix);
          }

          const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
          node.children.sort((a, b) => {
            // Directories first, then alphabetical
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          for (let i = 0; i < node.children.length; i++) {
            renderNode(node.children[i], childPrefix, i === node.children.length - 1, false);
          }
        }

        renderNode(root, '', true, true);

        const treeResult: ShellResult = { stdout: truncate(lines.join('\n')), stderr: '', exitCode: 0 };
        if (redirect) return applyRedirect(vfs, projectId, treeResult.stdout, redirect);
        return treeResult;
      }
      case 'cat': {
        // Support up to 5 files at once
        const MAX_FILES = 5;
        const filePaths = args.filter(a => a && !a.startsWith('-')).map(p => normalizePath(p));

        // If no file args but stdin is available, pass through stdin
        if (filePaths.length === 0 && stdin !== undefined) {
          const result: ShellResult = { stdout: truncate(stdin), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirect(vfs, projectId, result.stdout, redirect);
          return result;
        }

        if (filePaths.length === 0) {
          return { stdout: '', stderr: 'cat: missing file path', exitCode: 2 };
        }

        if (filePaths.length > MAX_FILES) {
          return {
            stdout: '',
            stderr: `cat: too many files. You requested ${filePaths.length} files, but cat supports a maximum of ${MAX_FILES} files at a time. Please split into multiple cat calls.`,
            exitCode: 2
          };
        }

        const outputs: string[] = [];
        let hadError = false;
        let errorMessages: string[] = [];

        for (const path of filePaths) {
          if (!path) {
            errorMessages.push('cat: invalid path');
            hadError = true;
            continue;
          }

          if (path.startsWith('/-')) {
            errorMessages.push(`cat: invalid path "${path}" (looks like an option)`);
            hadError = true;
            continue;
          }

          try {
            const file = await vfs.readFile(projectId, path);
            if (typeof file.content !== 'string') {
              errorMessages.push(`cat: ${path}: binary or non-text file`);
              hadError = true;
            } else {
              // For multiple files, add a header
              if (filePaths.length > 1) {
                outputs.push(`=== ${path} ===\n${file.content}`);
              } else {
                outputs.push(file.content);
              }
            }
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            errorMessages.push(`cat: ${path}: ${errMsg}`);
            hadError = true;
          }
        }

        const stdout = outputs.join('\n\n');
        const stderr = errorMessages.join('\n');

        const catResult: ShellResult = { stdout: truncate(stdout), stderr, exitCode: hadError ? 1 : 0 };
        if (redirect && !hadError) return applyRedirect(vfs, projectId, catResult.stdout, redirect);
        return catResult;
      }
      case 'head': {
        // head [-n lines | -lines] <file>  (or stdin via pipe)
        let numLines = 10;
        let filePath = '';

        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-n' && args[i + 1]) {
            numLines = parseInt(args[++i]) || 10;
          } else if (/^-\d+$/.test(a)) {
            // Shorthand: head -20 (same as head -n 20)
            numLines = parseInt(a.slice(1)) || 10;
          } else if (!a.startsWith('-')) {
            filePath = a;
          }
        }

        // Use stdin if no file path and stdin is available
        if (!filePath && stdin !== undefined) {
          const lines = stdin.split(/\r?\n/);
          const output = lines.slice(0, numLines).join('\n');
          const result: ShellResult = { stdout: truncate(output), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirect(vfs, projectId, result.stdout, redirect);
          return result;
        }

        const path = normalizePath(filePath);
        if (!path) return { stdout: '', stderr: 'head: missing file path', exitCode: 2 };

        try {
          const file = await vfs.readFile(projectId, path);
          if (typeof file.content !== 'string') {
            return { stdout: '', stderr: `head: ${path}: binary file`, exitCode: 1 };
          }

          const lines = file.content.split(/\r?\n/);
          const output = lines.slice(0, numLines).join('\n');
          const result: ShellResult = { stdout: truncate(output), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirect(vfs, projectId, result.stdout, redirect);
          return result;
        } catch (e: any) {
          return { stdout: '', stderr: `head: ${path}: ${e?.message || 'file not found'}`, exitCode: 1 };
        }
      }
      case 'tail': {
        // tail [-n lines | -lines] <file>  (or stdin via pipe)
        let numLines = 10;
        let filePath = '';

        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-n' && args[i + 1]) {
            numLines = parseInt(args[++i]) || 10;
          } else if (/^-\d+$/.test(a)) {
            // Shorthand: tail -20 (same as tail -n 20)
            numLines = parseInt(a.slice(1)) || 10;
          } else if (!a.startsWith('-')) {
            filePath = a;
          }
        }

        // Use stdin if no file path and stdin is available
        if (!filePath && stdin !== undefined) {
          const lines = stdin.split(/\r?\n/);
          const output = lines.slice(-numLines).join('\n');
          const result: ShellResult = { stdout: truncate(output), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirect(vfs, projectId, result.stdout, redirect);
          return result;
        }

        const path = normalizePath(filePath);
        if (!path) return { stdout: '', stderr: 'tail: missing file path', exitCode: 2 };

        try {
          const file = await vfs.readFile(projectId, path);
          if (typeof file.content !== 'string') {
            return { stdout: '', stderr: `tail: ${path}: binary file`, exitCode: 1 };
          }

          const lines = file.content.split(/\r?\n/);
          const output = lines.slice(-numLines).join('\n');
          const result: ShellResult = { stdout: truncate(output), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirect(vfs, projectId, result.stdout, redirect);
          return result;
        } catch (e: any) {
          return { stdout: '', stderr: `tail: ${path}: ${e?.message || 'file not found'}`, exitCode: 1 };
        }
      }
      case 'grep': {
        // Supported: grep [-n] [-i] [-F] [-A num] [-B num] [-C num] pattern path  (always recursive)
        const flags: Record<string, any> = { n: false, i: false, F: false, C: 0, A: 0, B: 0 };
        const fargs: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
            const flagStr = a.slice(1);
            for (let j = 0; j < flagStr.length; j++) {
              const ch = flagStr[j];
              if (ch === 'n') flags.n = true;
              else if (ch === 'i') flags.i = true;
              else if (ch === 'F') flags.F = true;
              else if (ch === 'C') { flags.C = parseInt(args[++i]) || 2; break; }
              else if (ch === 'A') { flags.A = parseInt(args[++i]) || 2; break; }
              else if (ch === 'B') { flags.B = parseInt(args[++i]) || 2; break; }
            }
          } else {
            fargs.push(a);
          }
        }
        const pattern = fargs[0];
        const path = normalizePath(fargs[1]) || '/';
        if (!pattern) {
          return {
            stdout: '',
            stderr: `grep: missing pattern

Usage: grep [FLAGS] PATTERN [PATH]

Supported flags:
  -n      Show line numbers
  -i      Case insensitive search
  -F      Treat pattern as literal string (not regex)
  -A NUM  Show NUM lines after each match
  -B NUM  Show NUM lines before each match
  -C NUM  Show NUM lines of context (before and after)

Examples:
  {"cmd": ["grep", "searchterm", "/path"]}
  {"cmd": ["grep", "-n", "pattern", "/file.txt"]}
  {"cmd": ["grep", "-i", "TODO", "/"]}
  {"cmd": ["grep", "-F", "exact.string", "/src"]}
  {"cmd": ["grep", "-A", "3", "pattern", "/file.txt"]}
  {"cmd": ["grep", "-C", "5", "function", "/src"]}

Note: grep always searches recursively. rg (ripgrep) is also available.`,
            exitCode: 2
          };
        }

        // Create regex - escape special chars if -F flag is used
        let regex: RegExp;
        if (flags.F) {
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          regex = new RegExp(escaped, flags.i ? 'i' : '');
        } else {
          regex = new RegExp(pattern, flags.i ? 'i' : '');
        }

        const outLines: string[] = [];
        const hasContext = flags.C > 0 || flags.A > 0 || flags.B > 0;

        // If no file path provided and stdin is available, search stdin
        if (!fargs[1] && stdin !== undefined) {
          const stdinLines = stdin.split(/\r?\n/);
          if (hasContext) {
            const matchedStdinLines = new Set<number>();
            for (let i = 0; i < stdinLines.length; i++) {
              if (regex.test(stdinLines[i])) matchedStdinLines.add(i);
            }
            if (matchedStdinLines.size > 0) {
              const contextStdinLines = new Set<number>();
              const beforeCtx = flags.C || flags.B;
              const afterCtx = flags.C || flags.A;
              for (const ln of matchedStdinLines) {
                for (let j = Math.max(0, ln - beforeCtx); j <= Math.min(stdinLines.length - 1, ln + afterCtx); j++) {
                  contextStdinLines.add(j);
                }
              }
              for (const ln of Array.from(contextStdinLines).sort((a, b) => a - b)) {
                outLines.push(flags.n ? `${ln + 1}:${stdinLines[ln]}` : stdinLines[ln]);
              }
            }
          } else {
            for (let i = 0; i < stdinLines.length; i++) {
              if (regex.test(stdinLines[i])) {
                outLines.push(flags.n ? `${i + 1}:${stdinLines[i]}` : stdinLines[i]);
              }
            }
          }
        } else {
          const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
          const dirPrefix = path === '/' ? '/' : (path.endsWith('/') ? path : path + '/');
          for (const e of entries) {
            if ('type' in e && e.type === 'directory') continue;
            const file = e as any;
            if (!file.path.startsWith(dirPrefix) && file.path !== path) continue;
            if (typeof file.content !== 'string') continue;
            const lines = file.content.split(/\r?\n/);

            if (hasContext) {
              const matchedLines = new Set<number>();
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) matchedLines.add(i);
              }
              if (matchedLines.size === 0) continue;

              const contextLines = new Set<number>();
              const beforeContext = flags.C || flags.B;
              const afterContext = flags.C || flags.A;
              for (const lineNum of matchedLines) {
                for (let j = Math.max(0, lineNum - beforeContext); j <= Math.min(lines.length - 1, lineNum + afterContext); j++) {
                  contextLines.add(j);
                }
              }

              const sortedLines = Array.from(contextLines).sort((a, b) => a - b);
              if (outLines.length > 0) outLines.push(''); // separator between files
              for (const lineNum of sortedLines) {
                outLines.push(`${file.path}${flags.n ? ':' + (lineNum + 1) : ''}:${lines[lineNum]}`);
              }
            } else {
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  outLines.push(`${file.path}${flags.n ? ':' + (i + 1) : ''}:${lines[i]}`);
                }
              }
            }
          }
        }

        const output = outLines.join('\n');
        if (outLines.length === 0) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        const grepResult: ShellResult = { stdout: truncate(output), stderr: '', exitCode: 0 };
        if (redirect) return applyRedirect(vfs, projectId, grepResult.stdout, redirect);
        return grepResult;
      }
      case 'rg': {
        // ripgrep with context flags: rg [-n] [-i] [-C num] [-A num] [-B num] pattern [path]
        // Also supports combined flags like -nC, -ni, etc.
        const flags: Record<string, any> = { n: true, i: false, C: 0, A: 0, B: 0 };
        const fargs: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
            // Handle combined flags like -nC, -ni, -iC, etc.
            const flagStr = a.slice(1);
            for (let j = 0; j < flagStr.length; j++) {
              const ch = flagStr[j];
              if (ch === 'n') flags.n = true;
              else if (ch === 'i') flags.i = true;
              else if (ch === 'C') { flags.C = parseInt(args[++i]) || 2; break; }
              else if (ch === 'A') { flags.A = parseInt(args[++i]) || 2; break; }
              else if (ch === 'B') { flags.B = parseInt(args[++i]) || 2; break; }
            }
          } else {
            fargs.push(a);
          }
        }
        const pattern = fargs[0];
        const path = normalizePath(fargs[1]) || '/';
        if (!pattern) {
          return {
            stdout: '',
            stderr: `rg: missing pattern

Usage: rg [FLAGS] PATTERN [PATH]

Supported flags:
  -C NUM  Show NUM lines of context (before and after)
  -A NUM  Show NUM lines after each match
  -B NUM  Show NUM lines before each match
  -i      Case insensitive search
  -n      Show line numbers (enabled by default)

Examples:
  {"cmd": ["rg", "searchterm", "/"]}
  {"cmd": ["rg", "-C", "3", "pattern", "/"]}
  {"cmd": ["rg", "-A", "5", "-B", "2", "function", "/src"]}
  {"cmd": ["rg", "-i", "todo", "/"]}

Tip: Use -C for balanced context. PATH defaults to / if omitted.`,
            exitCode: 2
          };
        }

        const regex = new RegExp(pattern, flags.i ? 'i' : '');
        const outLines: string[] = [];

        // If no file path provided and stdin is available, search stdin
        if (!fargs[1] && stdin !== undefined) {
          const stdinLines = stdin.split(/\r?\n/);
          const matchedStdinLines = new Set<number>();
          for (let i = 0; i < stdinLines.length; i++) {
            if (regex.test(stdinLines[i])) matchedStdinLines.add(i);
          }
          if (matchedStdinLines.size > 0) {
            const contextStdinLines = new Set<number>();
            const beforeCtx = flags.C || flags.B;
            const afterCtx = flags.C || flags.A;
            for (const ln of matchedStdinLines) {
              for (let j = Math.max(0, ln - beforeCtx); j <= Math.min(stdinLines.length - 1, ln + afterCtx); j++) {
                contextStdinLines.add(j);
              }
            }
            for (const ln of Array.from(contextStdinLines).sort((a, b) => a - b)) {
              const lineNumStr = flags.n ? `${ln + 1}:` : '';
              outLines.push(`${lineNumStr}${stdinLines[ln]}`);
            }
          }
        } else {
          const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
          const dirPrefix = path === '/' ? '/' : (path.endsWith('/') ? path : path + '/');

          for (const e of entries) {
            if ('type' in e && e.type === 'directory') continue;
            const file = e as any;
            if (!file.path.startsWith(dirPrefix) && file.path !== path) continue;
            if (typeof file.content !== 'string') continue;

            const lines = file.content.split(/\r?\n/);
            const matchedLines = new Set<number>();

            // Find all matches
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matchedLines.add(i);
              }
            }

            if (matchedLines.size === 0) continue;

            // Add context lines
            const contextLines = new Set<number>();
            const beforeContext = flags.C || flags.B;
            const afterContext = flags.C || flags.A;

            for (const lineNum of matchedLines) {
              for (let j = Math.max(0, lineNum - beforeContext); j <= Math.min(lines.length - 1, lineNum + afterContext); j++) {
                contextLines.add(j);
              }
            }

            // Output with line numbers
            const sortedLines = Array.from(contextLines).sort((a, b) => a - b);
            if (outLines.length > 0) outLines.push(''); // Separator between files

            for (const lineNum of sortedLines) {
              const lineNumStr = flags.n ? `${lineNum + 1}:` : '';
              outLines.push(`${file.path}:${lineNumStr}${lines[lineNum]}`);
            }
          }
        }

        if (outLines.length === 0) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        const rgResult: ShellResult = { stdout: truncate(outLines.join('\n')), stderr: '', exitCode: 0 };
        if (redirect) return applyRedirect(vfs, projectId, rgResult.stdout, redirect);
        return rgResult;
      }
      case 'find': {
        // Supported: find <path> [-type f|d] [-name <pattern>] [-maxdepth <depth>]
        let rootArg: string | undefined;
        let pattern: string | undefined;
        let typeFilter: 'f' | 'd' | undefined;
        let maxDepth = Infinity;

        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (!a) continue;
          if (a === '-name') { pattern = args[i + 1]; i++; continue; }
          if (a === '-type') {
            const typeVal = args[i + 1];
            if (typeVal === 'f' || typeVal === 'd') {
              typeFilter = typeVal;
            }
            i++;
            continue;
          }
          if (a === '-maxdepth') { maxDepth = parseInt(args[i + 1]) || 0; i++; continue; }
          if (!a.startsWith('-') && !rootArg) rootArg = a;
        }

        const root = normalizePath(rootArg) || '/';
        const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
        const prefix = root === '/' ? '/' : (root.endsWith('/') ? root : root + '/');
        const toGlob = (s: string) => new RegExp('^' + s.replace(/[.+^${}()|\[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        const regex = pattern ? toGlob(pattern) : null;

        // Count depth relative to root: /root/a = depth 1, /root/a/b = depth 2
        const rootDepth = root === '/' ? 0 : root.split('/').filter(Boolean).length;

        const res = entries
          .filter((e: any) => e.path === root || e.path.startsWith(prefix))
          .filter((e: any) => {
            // Filter by maxdepth
            const entryDepth = e.path === '/' ? 0 : e.path.split('/').filter(Boolean).length;
            if (entryDepth - rootDepth > maxDepth) return false;
            // Filter by type if specified
            if (typeFilter === 'f') {
              return !('type' in e) || e.type !== 'directory';
            }
            if (typeFilter === 'd') {
              return 'type' in e && e.type === 'directory';
            }
            return true; // No type filter, include all
          })
          .map((e: any) => e.path)
          .filter(p => (regex ? regex.test(p.split('/').pop() || p) : true))
          .sort();

        const findResult: ShellResult = { stdout: truncate(res.join('\n')), stderr: '', exitCode: 0 };
        if (redirect) return applyRedirect(vfs, projectId, findResult.stdout, redirect);
        return findResult;
      }
      case 'mkdir': {
        // Support: mkdir [-p] <path1> <path2> ... (multiple paths like real bash)
        const hasP = args.includes('-p');
        const paths = args.filter(a => a && a !== '-p').map(p => normalizePath(p));

        if (paths.length === 0) {
          return { stdout: '', stderr: 'mkdir: missing operand', exitCode: 2 };
        }

        let hadError = false;
        const errors: string[] = [];

        for (const path of paths) {
          if (!path) continue;

          // Block mkdir under /.server/ - these are transient/auto-generated
          if (path.startsWith('/.server/')) {
            errors.push(`mkdir: cannot create '${path}': server context directories are auto-generated`);
            hadError = true;
            continue;
          }

          try {
            if (hasP) {
              await ensureDirectory(vfs, projectId, path);
            } else {
              await vfs.createDirectory(projectId, path);
            }
          } catch (e: any) {
            hadError = true;
            errors.push(`mkdir: cannot create directory '${path}': ${e?.message || 'unknown error'}`);
          }
        }

        return {
          stdout: '',
          stderr: errors.join('\n'),
          exitCode: hadError ? 1 : 0
        };
      }
      case 'touch': {
        // touch <file1> <file2> ... - create empty files or update timestamp (multiple files like real bash)
        const paths = args.filter(a => a && !a.startsWith('-')).map(p => normalizePath(p));

        if (paths.length === 0) {
          return { stdout: '', stderr: 'touch: missing file operand', exitCode: 2 };
        }

        let hadError = false;
        const errors: string[] = [];

        for (const path of paths) {
          if (!path) continue;

          try {
            // Check if file exists
            await vfs.readFile(projectId, path);
            // File exists, just continue (we don't update timestamps)
          } catch {
            // File doesn't exist, create it with empty content
            try {
              await vfs.createFile(projectId, path, '');
            } catch (e: any) {
              hadError = true;
              errors.push(`touch: cannot touch '${path}': ${e?.message || 'cannot create file'}`);
            }
          }
        }

        return {
          stdout: '',
          stderr: errors.join('\n'),
          exitCode: hadError ? 1 : 0
        };
      }
      case 'rm': {
        // Enhanced rm command: rm [-rfv] <file/dir...>
        // Parse flags including combined flags like -rf, -rfv
        let recursive = false;
        let force = false;
        let verbose = false;
        const targets: string[] = [];

        for (const arg of args) {
          if (arg && arg.startsWith('-')) {
            // Handle combined flags like -rf, -rfv
            if (arg.includes('r') || arg.includes('R')) recursive = true;
            if (arg.includes('f')) force = true;
            if (arg.includes('v')) verbose = true;
          } else if (arg) {
            targets.push(arg);
          }
        }

        if (targets.length === 0) return { stdout: '', stderr: 'rm: missing operand', exitCode: 2 };

        let hadError = false;
        const verboseOutput: string[] = [];
        const errorMessages: string[] = [];

        for (const target of targets) {
          const path = normalizePath(target);
          if (!path) {
            if (!force) hadError = true;
            continue;
          }

          // Handle server context files (/.server/)
          if (path.startsWith('/.server/')) {
            try {
              await vfs.deleteServerContextFile(path);
              if (verbose) verboseOutput.push(`removed '${path}'`);
            } catch (e: any) {
              if (!force) {
                hadError = true;
                const msg = `rm: cannot remove '${path}': ${e?.message || 'unknown error'}`;
                errorMessages.push(msg);
                if (verbose) verboseOutput.push(msg);
              }
            }
            continue;
          }

          try {
            // Try to delete as file first
            await vfs.deleteFile(projectId, path);
            if (verbose) verboseOutput.push(`removed '${path}'`);
          } catch {
            // If not a file, try as directory
            if (recursive) {
              try {
                await vfs.deleteDirectory(projectId, path);
                if (verbose) verboseOutput.push(`removed directory '${path}'`);
              } catch {
                if (!force) {
                  hadError = true;
                  const msg = `rm: cannot remove '${path}': No such file or directory`;
                  errorMessages.push(msg);
                  if (verbose) verboseOutput.push(msg);
                }
              }
            } else {
              if (!force) {
                hadError = true;
                const msg = `rm: cannot remove '${path}': Is a directory (use -r to remove directories)`;
                errorMessages.push(msg);
                if (verbose) verboseOutput.push(msg);
              }
            }
          }
        }

        const stdout = verbose ? verboseOutput.join('\n') : '';
        const stderr = hadError ? errorMessages.join('\n') : '';
        return { stdout: truncate(stdout), stderr, exitCode: hadError ? 1 : 0 };
      }
      case 'mv': {
        const [rold, rnew] = args;
        const oldPath = normalizePath(rold);
        const newPath = normalizePath(rnew);
        if (!oldPath || !newPath) return { stdout: '', stderr: 'mv: missing operands', exitCode: 2 };
        // Try file move
        try {
          await vfs.renameFile(projectId, oldPath, newPath);
          return { stdout: '', stderr: '', exitCode: 0 };
        } catch {
          // Try directory move
          await vfs.renameDirectory(projectId, oldPath, newPath);
          return { stdout: '', stderr: '', exitCode: 0 };
        }
      }
      case 'cp': {
        // Support: cp <src> <dst> | cp -r <srcDir> <dstDir>
        const recursive = args.includes('-r');
        const filtered = args.filter(a => a !== '-r');
        let [src, dst] = filtered;
        src = normalizePath(src) as string;
        dst = normalizePath(dst) as string;
        if (!src || !dst) return { stdout: '', stderr: 'cp: missing operands', exitCode: 2 };
        // Attempt file copy
        try {
          const file = await vfs.readFile(projectId, src);
          try {
            await vfs.createFile(projectId, dst, file.content as any);
          } catch {
            await vfs.updateFile(projectId, dst, file.content as any);
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        } catch {
          if (!recursive) {
            return { stdout: '', stderr: 'cp: -r required for directories', exitCode: 1 };
          }
          // Directory copy: copy all files under src prefix
          const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
          const srcPrefix = src.endsWith('/') ? src : src + '/';
          for (const e2 of entries) {
            if ('type' in e2 && e2.type === 'directory') continue;
            const file = e2 as any;
            if (file.path === src || file.path.startsWith(srcPrefix)) {
              const rel = file.path.slice(src.length);
              const target = (dst.endsWith('/') ? dst.slice(0, -1) : dst) + rel;
              await ensureDirectory(vfs, projectId, target.split('/').slice(0, -1).join('/'));
              try {
                await vfs.createFile(projectId, target, file.content as any);
              } catch {
                await vfs.updateFile(projectId, target, file.content as any);
              }
            }
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
      }
      case 'echo': {
        // echo [-n] [-e] text — redirect handled generically by extractRedirect/applyRedirect
        let suppressNewline = false;
        let interpretEscapes = false;
        let startIdx = 0;

        // Consume leading flag args (bash behavior: only leading args that are purely valid flag chars)
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a.startsWith('-') && a.length > 1 && /^-[ne]+$/.test(a)) {
            for (const ch of a.slice(1)) {
              if (ch === 'n') suppressNewline = true;
              else if (ch === 'e') interpretEscapes = true;
            }
            startIdx = i + 1;
          } else {
            break;
          }
        }

        let output = args.slice(startIdx).join(' ');

        if (interpretEscapes) {
          output = output
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\\\/g, '\\');
        }

        // suppressNewline: our shell doesn't auto-append newlines so it's effectively a no-op,
        // but the flag is consumed so it doesn't appear in output.

        if (redirect) return applyRedirect(vfs, projectId, output, redirect);
        return { stdout: truncate(output), stderr: '', exitCode: 0 };
      }
      case 'sed': {
        // sed [-i] [-n] [-e expr]... 'expr' [file]
        // Supports: substitution, range delete, range change, range print
        let inPlace = false;
        let suppressOutput = false;
        const expressions: string[] = [];
        let filePath = '';

        // Parse arguments
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          // -i (GNU), -i '' (BSD/macOS), -i.bak (backup extension) — all mean in-place
          // Guard against combined flags like -in or -ie — only match -i alone or -i with non-alpha suffix (.bak)
          if (a === '-i' || (a.startsWith('-i') && a.length > 2 && !/^-i[a-z]$/i.test(a))) { inPlace = true; continue; }
          if (a === '-n') { suppressOutput = true; continue; }
          if (a === '-e' && args[i + 1]) { expressions.push(args[++i]); continue; }
          // Substitution expression (s/old/new/g)
          if (a.startsWith('s') && a.length > 2 && /[\/|#@]/.test(a[1])) {
            expressions.push(a);
            continue;
          }
          // Address-based expression (/pattern/d, 5,10d, $d, /p1/,/p2/c\text, etc.)
          // Must distinguish from file paths like /styles/style.css:
          //   Address: /re/d, /re/p, /re/n         (command letter at end of token)
          //            /re/c\text, /re/a\text, /re/i\text  (command letter + backslash)
          //            /re/,/re2/...                (range — comma right after the first addr)
          //   Path:    /dir/file.ext               (second slash followed by arbitrary text)
          // The previous heuristic `/^\/[^/]*\/[,dpcians]/` misclassified any path whose
          // basename began with d/p/c/i/a/n/s (e.g. /src/index.ts → command `i`).
          if (
            /^\d+[,dpcians]/.test(a) ||
            /^[\\$]/.test(a) ||
            /^\/[^/]*\/(?:[dpn]$|[cai]\\|,)/.test(a)
          ) {
            expressions.push(a);
            continue;
          }
          if (!a.startsWith('-') && a) filePath = a;
        }

        if (expressions.length === 0) {
          return {
            stdout: '',
            stderr: `sed: missing expression

Usage: sed [-i] [-n] [-e expr] 'expr' [file]

Commands:
  s/pattern/replacement/[g]       Substitute (BRE: parens are literal)
  /pattern1/,/pattern2/d          Delete lines in range
  /pattern1/,/pattern2/c\\text     Replace range with text
  /pattern/i\\text                 Insert text before matching line
  /pattern/a\\text                 Append text after matching line
  -n '/pattern/p'                 Print matching lines only

Examples:
  sed -i 's/old/new/g' /file.txt
  sed -i '/<nav>/,/<\\/nav>/d' /file.txt
  sed -i '/<nav>/,/<\\/nav>/c\\<nav>new</nav>' /file.txt
  sed -i '/<\\/body>/i\\<footer>My footer</footer>' /file.txt
  sed -n '/<script>/,/<\\/script>/p' /file.txt`,
            exitCode: 2
          };
        }

        // Parse all expressions using the unified parser
        const parsedCmds: SedCommand[] = [];
        for (const expr of expressions) {
          const parsed = parseSedCommand(expr);
          if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 };
          parsedCmds.push(parsed);
        }

        // Get input content
        let inputContent: string;
        const sedPath = normalizePath(filePath);

        if (sedPath) {
          try {
            const file = await vfs.readFile(projectId, sedPath);
            if (typeof file.content !== 'string') {
              return { stdout: '', stderr: `sed: ${sedPath}: binary file`, exitCode: 1 };
            }
            inputContent = file.content;
          } catch (e: any) {
            return { stdout: '', stderr: `sed: ${sedPath}: ${e?.message || 'file not found'}`, exitCode: 1 };
          }
        } else if (stdin !== undefined) {
          inputContent = stdin;
        } else {
          return { stdout: '', stderr: 'sed: no input file or stdin', exitCode: 2 };
        }

        // Apply all commands
        const lines = inputContent.split(/\r?\n/);
        const totalLines = lines.length;
        const outputLines: string[] = [];

        // Track range state per command (for multi-line ranges)
        const inRange = new Array(parsedCmds.length).fill(false);

        for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
          let line = lines[lineIdx];
          const lineNum = lineIdx + 1; // 1-based
          let deleted = false;
          let printed = false;
          const appendAfter: string[] = [];

          for (let ci = 0; ci < parsedCmds.length; ci++) {
            const cmd = parsedCmds[ci];

            if (cmd.kind === 'substitute') {
              // If address-constrained (e.g., 6s/old/new/), only apply on matching lines
              if (cmd.start) {
                if (cmd.end) {
                  // Range-addressed substitution: /start/,/end/s/old/new/
                  if (!inRange[ci] && addressMatches(cmd.start, lineNum, line, totalLines)) {
                    inRange[ci] = true;
                  }
                  if (inRange[ci]) {
                    // Check end-address against original line before substitution
                    const endMatch = addressMatches(cmd.end, lineNum, line, totalLines);
                    line = line.replace(cmd.pattern, cmd.replacement);
                    if (endMatch) {
                      inRange[ci] = false;
                    }
                  }
                } else {
                  // Single-addressed substitution: 6s/old/new/
                  if (addressMatches(cmd.start, lineNum, line, totalLines)) {
                    line = line.replace(cmd.pattern, cmd.replacement);
                  }
                }
              } else {
                line = line.replace(cmd.pattern, cmd.replacement);
              }
              continue;
            }

            // Address-based commands: delete, change, insert, append, print
            const startMatch = addressMatches(cmd.start, lineNum, line, totalLines);

            // Insert/append are single-address only, handled before range logic
            if (cmd.kind === 'insert' && startMatch) {
              outputLines.push(cmd.text); // insert text before the current line
              continue;
            }
            if (cmd.kind === 'append' && startMatch) {
              appendAfter.push(cmd.text); // queue text to add after the current line
              continue;
            }

            if ('end' in cmd && cmd.end) {
              // Range: /start/,/end/cmd
              if (!inRange[ci]) {
                if (startMatch) inRange[ci] = true;
              }

              if (inRange[ci]) {
                const endMatch = addressMatches(cmd.end, lineNum, line, totalLines);

                if (cmd.kind === 'delete') {
                  deleted = true;
                } else if (cmd.kind === 'print') {
                  printed = true;
                } else if (cmd.kind === 'change') {
                  deleted = true; // suppress original lines
                }

                if (endMatch) {
                  // End of range — emit change text if applicable
                  if (cmd.kind === 'change') {
                    outputLines.push(cmd.text);
                  }
                  inRange[ci] = false;
                }
              }
            } else {
              // Single address: /pattern/cmd or 5cmd
              if (startMatch) {
                if (cmd.kind === 'delete') {
                  deleted = true;
                } else if (cmd.kind === 'print') {
                  printed = true;
                } else if (cmd.kind === 'change') {
                  deleted = true;
                  outputLines.push(cmd.text);
                }
              }
            }
          }

          if (!deleted) {
            if (suppressOutput) {
              // -n mode: only output explicitly printed lines
              if (printed) outputLines.push(line);
            } else {
              outputLines.push(line);
            }
          }
          // Flush append-after-line text (from 'a' command)
          for (const text of appendAfter) {
            outputLines.push(text);
          }
        }

        const outputContent = outputLines.join('\n');

        if (inPlace) {
          if (!sedPath) {
            return { stdout: '', stderr: 'sed: -i requires a file argument (cannot edit stdin in-place)', exitCode: 2 };
          }
          try {
            await vfs.updateFile(projectId, sedPath, outputContent);
            return { stdout: '', stderr: '', exitCode: 0 };
          } catch (e: any) {
            return { stdout: '', stderr: `sed: ${sedPath}: ${e?.message || 'cannot write file'}`, exitCode: 1 };
          }
        }

        // Output to stdout (redirect handled generically)
        if (redirect) return applyRedirect(vfs, projectId, outputContent, redirect);
        return { stdout: truncate(outputContent), stderr: '', exitCode: 0 };
      }
      case 'wc': {
        // wc [-l] [-w] [-c] [file ...]  (or stdin via pipe)
        // Default (no flags): show lines, words, chars
        // Multiple files: per-file counts + total line
        const wcFlags = { l: false, w: false, c: false };
        const wcFilePaths: string[] = [];
        let wcAnyFlag = false;

        for (const a of args) {
          if (a && a.startsWith('-')) {
            for (const ch of a.slice(1)) {
              if (ch === 'l') { wcFlags.l = true; wcAnyFlag = true; }
              else if (ch === 'w') { wcFlags.w = true; wcAnyFlag = true; }
              else if (ch === 'c') { wcFlags.c = true; wcAnyFlag = true; }
            }
          } else if (a) {
            wcFilePaths.push(a);
          }
        }

        if (!wcAnyFlag) { wcFlags.l = true; wcFlags.w = true; wcFlags.c = true; }

        const wcCount = (content: string) => ({
          l: content === '' ? 0 : (content.match(/\r?\n/g) || []).length,
          w: content.trim() === '' ? 0 : content.trim().split(/\s+/).length,
          c: content.length,
        });

        const wcFormatLine = (counts: { l: number; w: number; c: number }, label?: string) => {
          const parts: string[] = [];
          if (wcFlags.l) parts.push(String(counts.l));
          if (wcFlags.w) parts.push(String(counts.w));
          if (wcFlags.c) parts.push(String(counts.c));
          if (label) parts.push(label);
          return parts.join(' ');
        };

        // Stdin-only (no file args)
        if (wcFilePaths.length === 0) {
          if (stdin === undefined) {
            return { stdout: '', stderr: 'wc: no input file or stdin', exitCode: 2 };
          }
          const wcOutput = wcFormatLine(wcCount(stdin));
          if (redirect) return applyRedirect(vfs, projectId, wcOutput, redirect);
          return { stdout: truncate(wcOutput), stderr: '', exitCode: 0 };
        }

        // File args (one or many)
        const wcLines: string[] = [];
        const wcTotals = { l: 0, w: 0, c: 0 };

        for (const fp of wcFilePaths) {
          const wcPath = normalizePath(fp);
          if (!wcPath) continue;
          try {
            const file = await vfs.readFile(projectId, wcPath);
            if (typeof file.content !== 'string') {
              wcLines.push(`wc: ${wcPath}: binary file`);
              continue;
            }
            const counts = wcCount(file.content);
            wcTotals.l += counts.l;
            wcTotals.w += counts.w;
            wcTotals.c += counts.c;
            wcLines.push(wcFormatLine(counts, wcPath));
          } catch (e: any) {
            wcLines.push(`wc: ${wcPath}: ${e?.message || 'file not found'}`);
          }
        }

        // Total line when multiple files
        if (wcFilePaths.length > 1) {
          wcLines.push(wcFormatLine(wcTotals, 'total'));
        }

        const wcOutput = wcLines.join('\n');
        if (redirect) return applyRedirect(vfs, projectId, wcOutput, redirect);
        return { stdout: truncate(wcOutput), stderr: '', exitCode: 0 };
      }
      case 'sort': {
        // sort [-r] [-n] [-u] [file]  (or stdin via pipe)
        const sortFlags = { r: false, n: false, u: false };
        let filePath = '';

        for (const a of args) {
          if (a && a.startsWith('-') && /^-[rnu]+$/.test(a)) {
            for (const ch of a.slice(1)) {
              if (ch === 'r') sortFlags.r = true;
              else if (ch === 'n') sortFlags.n = true;
              else if (ch === 'u') sortFlags.u = true;
            }
          } else if (a) {
            filePath = a;
          }
        }

        let inputContent: string;
        const sortPath = normalizePath(filePath);

        if (sortPath) {
          try {
            const file = await vfs.readFile(projectId, sortPath);
            if (typeof file.content !== 'string') {
              return { stdout: '', stderr: `sort: ${sortPath}: binary file`, exitCode: 1 };
            }
            inputContent = file.content;
          } catch (e: any) {
            return { stdout: '', stderr: `sort: ${sortPath}: ${e?.message || 'file not found'}`, exitCode: 1 };
          }
        } else if (stdin !== undefined) {
          inputContent = stdin;
        } else {
          return { stdout: '', stderr: 'sort: no input file or stdin', exitCode: 2 };
        }

        let lines = inputContent.split(/\r?\n/);
        if (sortFlags.n) {
          lines.sort((a, b) => {
            const na = parseFloat(a) || 0;
            const nb = parseFloat(b) || 0;
            return na - nb;
          });
        } else {
          lines.sort();
        }
        if (sortFlags.r) lines.reverse();
        if (sortFlags.u) lines = lines.filter((line, i, arr) => i === 0 || line !== arr[i - 1]);

        const sortOutput = lines.join('\n');
        if (redirect) return applyRedirect(vfs, projectId, sortOutput, redirect);
        return { stdout: truncate(sortOutput), stderr: '', exitCode: 0 };
      }
      case 'uniq': {
        // uniq [-c] [file]  (or stdin via pipe)
        let countPrefix = false;
        let filePath = '';

        for (const a of args) {
          if (a === '-c') countPrefix = true;
          else if (a && !a.startsWith('-')) filePath = a;
        }

        let inputContent: string;
        const uniqPath = normalizePath(filePath);

        if (uniqPath) {
          try {
            const file = await vfs.readFile(projectId, uniqPath);
            if (typeof file.content !== 'string') {
              return { stdout: '', stderr: `uniq: ${uniqPath}: binary file`, exitCode: 1 };
            }
            inputContent = file.content;
          } catch (e: any) {
            return { stdout: '', stderr: `uniq: ${uniqPath}: ${e?.message || 'file not found'}`, exitCode: 1 };
          }
        } else if (stdin !== undefined) {
          inputContent = stdin;
        } else {
          return { stdout: '', stderr: 'uniq: no input file or stdin', exitCode: 2 };
        }

        const lines = inputContent.split(/\r?\n/);
        const resultLines: string[] = [];
        let i = 0;
        while (i < lines.length) {
          let count = 1;
          while (i + count < lines.length && lines[i + count] === lines[i]) count++;
          resultLines.push(countPrefix ? `${String(count).padStart(7)} ${lines[i]}` : lines[i]);
          i += count;
        }

        const uniqOutput = resultLines.join('\n');
        if (redirect) return applyRedirect(vfs, projectId, uniqOutput, redirect);
        return { stdout: truncate(uniqOutput), stderr: '', exitCode: 0 };
      }
      case 'tr': {
        // tr [-d] SET1 [SET2]  (operates on stdin)
        let deleteMode = false;
        const trArgs: string[] = [];

        for (const a of args) {
          if (a === '-d') deleteMode = true;
          else trArgs.push(a);
        }

        if (stdin === undefined) {
          return { stdout: '', stderr: 'tr: no stdin (use with pipe, e.g. cat file | tr ...)', exitCode: 2 };
        }

        const set1 = trArgs[0] || '';
        const set2 = trArgs[1] || '';

        if (!set1) {
          return { stdout: '', stderr: 'tr: missing SET1\n\nUsage: tr [-d] SET1 [SET2]\n  tr \'a-z\' \'A-Z\'  — translate lowercase to uppercase\n  tr -d \'chars\'    — delete characters', exitCode: 2 };
        }

        // Expand ranges like a-z, A-Z, 0-9
        const expandRange = (s: string): string => {
          let result = '';
          for (let i = 0; i < s.length; i++) {
            if (i + 2 < s.length && s[i + 1] === '-') {
              const start = s.charCodeAt(i);
              const end = s.charCodeAt(i + 2);
              for (let c = start; c <= end; c++) result += String.fromCharCode(c);
              i += 2;
            } else {
              result += s[i];
            }
          }
          return result;
        };

        const expandedSet1 = expandRange(set1);

        if (deleteMode) {
          const deleteChars = new Set(expandedSet1.split(''));
          const trOutput = stdin.split('').filter(ch => !deleteChars.has(ch)).join('');
          if (redirect) return applyRedirect(vfs, projectId, trOutput, redirect);
          return { stdout: truncate(trOutput), stderr: '', exitCode: 0 };
        }

        const expandedSet2 = expandRange(set2);
        const charMap = new Map<string, string>();
        for (let i = 0; i < expandedSet1.length; i++) {
          charMap.set(expandedSet1[i], expandedSet2[Math.min(i, expandedSet2.length - 1)] || '');
        }

        const trOutput = stdin.split('').map(ch => charMap.get(ch) ?? ch).join('');
        if (redirect) return applyRedirect(vfs, projectId, trOutput, redirect);
        return { stdout: truncate(trOutput), stderr: '', exitCode: 0 };
      }
      case 'curl': {
        // curl localhost/path — fetch compiled HTML from preview engine
        // Flags: -s/--silent, -I/--head, -o FILE/--output FILE, -X METHOD, -H header, -d body
        const curlFlags = { silent: false, head: false, outputFile: '', method: '', headers: [] as string[], body: '' };
        let curlUrl = '';

        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-s' || a === '--silent') { curlFlags.silent = true; continue; }
          if (a === '-I' || a === '--head') { curlFlags.head = true; continue; }
          if ((a === '-o' || a === '--output') && args[i + 1]) { curlFlags.outputFile = args[++i]; continue; }
          if ((a === '-X' || a === '--request') && args[i + 1]) { curlFlags.method = args[++i]; continue; }
          if ((a === '-H' || a === '--header') && args[i + 1]) { curlFlags.headers.push(args[++i]); continue; }
          if ((a === '-d' || a === '--data' || a === '--data-raw') && args[i + 1]) { curlFlags.body = args[++i]; continue; }
          if (!a.startsWith('-') && a) curlUrl = a;
        }

        // Assume http:// when no protocol is specified
        if (curlUrl && !curlUrl.includes('://')) {
          curlUrl = 'http://' + curlUrl;
        }

        if (!curlUrl) {
          return {
            stdout: '',
            stderr: `curl: no URL specified

Usage: curl [OPTIONS] URL

Options:
  -s, --silent     Suppress progress output
  -I, --head       Show response headers only
  -o, --output FILE  Write output to FILE

Examples:
  curl localhost/                    — compiled index.html
  curl localhost/about               — compiled about page
  curl -I localhost/                 — response headers only
  curl -s localhost/ | grep '<title>'  — pipe to grep
  curl localhost/ > /output.html     — redirect to file

Only localhost URLs are supported (fetches compiled HTML from preview engine).`,
            exitCode: 2
          };
        }

        // Validate localhost-only
        const urlLower = curlUrl.toLowerCase();
        const isLocalhost =
          urlLower.startsWith('http://localhost') ||
          urlLower.startsWith('https://localhost') ||
          urlLower.startsWith('http://127.0.0.1') ||
          urlLower.startsWith('https://127.0.0.1');

        if (!isLocalhost) {
          return {
            stdout: '',
            stderr: `curl: external URLs are not supported: ${curlUrl}\n\nOnly localhost URLs are supported. curl fetches compiled HTML from the preview engine.\n\nExamples:\n  curl localhost/\n  curl localhost/about`,
            exitCode: 1
          };
        }

        // Extract path from URL
        let urlPath = '/';
        try {
          const parsed = new URL(curlUrl);
          urlPath = parsed.pathname || '/';
        } catch {
          // Fallback: extract path manually
          const pathMatch = curlUrl.match(/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/i);
          urlPath = pathMatch?.[1] || '/';
        }

        // Resolve path to VFS file path
        // / → /index.html
        // /about → /about.html
        // /about.html → /about.html
        // /products/ → /products/index.html
        let resolvedPath = urlPath;
        if (resolvedPath === '/') {
          resolvedPath = '/index.html';
        } else if (resolvedPath.endsWith('/')) {
          resolvedPath = resolvedPath + 'index.html';
        } else if (!resolvedPath.includes('.')) {
          resolvedPath = resolvedPath + '.html';
        }

        try {
          // Dynamic import VirtualServer to avoid adding to cli-shell's initial bundle
          const { VirtualServer } = await import('@/lib/preview/virtual-server');
          const project = await vfs.getProject(projectId);
          const server = new VirtualServer(vfs, projectId, { runtime: project?.settings?.runtime });
          const compiled = await server.getCompiledFile(resolvedPath);

          if (!compiled) {
            return {
              stdout: '',
              stderr: `curl: 404 Not Found — ${resolvedPath}\n\nThe file does not exist in the project. Check the path and try again.\n\nResolved: ${urlPath} → ${resolvedPath}`,
              exitCode: 1
            };
          }

          let content = typeof compiled.content === 'string' ? compiled.content : '';

          // Strip VFS Asset Interceptor script (only relevant for browser preview, noise for LLM)
          const interceptorRegex = /<script>\s*\/\/ VFS Asset Interceptor[\s\S]*?<\/script>\s*/;
          content = content.replace(interceptorRegex, '');

          if (curlFlags.head) {
            // Headers only
            const headers = [
              'HTTP/1.1 200 OK',
              `Content-Type: ${compiled.mimeType || 'text/html'}`,
              `Content-Length: ${new TextEncoder().encode(content).length}`,
              ''
            ].join('\n');
            const headResult: ShellResult = { stdout: headers, stderr: '', exitCode: 0 };
            if (redirect) return applyRedirect(vfs, projectId, headResult.stdout, redirect);
            return headResult;
          }

          if (curlFlags.outputFile) {
            // Write to file
            const outPath = normalizePath(curlFlags.outputFile);
            if (!outPath) return { stdout: '', stderr: 'curl: -o: missing file path', exitCode: 2 };
            const dirPath = outPath.split('/').slice(0, -1).join('/') || '/';
            if (dirPath !== '/') await ensureDirectory(vfs, projectId, dirPath);
            try { await vfs.createFile(projectId, outPath, content); }
            catch { await vfs.updateFile(projectId, outPath, content); }
            const msg = curlFlags.silent ? '' : `  % Total    Received\n  100  ${content.length}    ${content.length}\n\nSaved to ${outPath}`;
            return { stdout: msg, stderr: '', exitCode: 0 };
          }

          // Default: return compiled HTML
          const curlResult: ShellResult = { stdout: truncate(content), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirect(vfs, projectId, curlResult.stdout, redirect);
          return curlResult;
        } catch (e: any) {
          // Compilation errors from Handlebars are still useful for the LLM
          return { stdout: '', stderr: `curl: error compiling ${resolvedPath}: ${e?.message || 'unknown error'}`, exitCode: 1 };
        }
      }
      case 'sqlite3': {
        // This case is reached when sqlite3 is called without a deploymentId context
        // When deploymentId is available, tool-registry.ts routes the call to the server API
        return {
          stdout: '',
          stderr: `sqlite3: requires Server Mode with a published deployment

The sqlite3 command requires:
1. Server Mode (not Browser Mode)
2. A deployment to be selected and published

If you are in Server Mode with a published deployment, this error indicates the deployment context is not set.
Please ensure the deployment is selected in the workspace before using sqlite3.

Alternative: Use edge functions for database access via db.query() and db.run()`,
          exitCode: 1
        };
      }
      case 'build': {
        // Build command — triggers its own compilation for reliable results.
        // Previously piggybacked on the preview's debounced compile, causing race
        // conditions when the AI writes multiple files before calling build.
        try {
          const { VirtualServer } = await import('@/lib/preview/virtual-server');
          const buildProject = await vfs.getProject(projectId);
          const server = new VirtualServer(vfs, projectId, { runtime: buildProject?.settings?.runtime });
          await server.compileProject();
          server.cleanupBlobUrls();

          const compileErrors = drainCompileErrors();
          if (compileErrors.length === 0) {
            return { stdout: 'Build successful — 0 errors', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: formatCompileErrors(compileErrors), exitCode: 1 };
        } catch (err: any) {
          return { stdout: '', stderr: `Build failed: ${err.message}`, exitCode: 1 };
        }
      }
      case 'runtime': {
        // Runtime command — change the project's runtime
        // Usage: runtime static|handlebars|react|preact|svelte|vue|python|lua
        const VALID_RUNTIMES = ['static', 'handlebars', 'react', 'preact', 'svelte', 'vue', 'python', 'lua'];
        const requested = args[0]?.toLowerCase();
        if (!requested || !VALID_RUNTIMES.includes(requested)) {
          return {
            stdout: '',
            stderr: `Usage: runtime <name>\nValid runtimes: ${VALID_RUNTIMES.join(', ')}`,
            exitCode: 1
          };
        }
        try {
          const proj = await vfs.getProject(projectId);
          if (!proj) {
            return { stdout: '', stderr: 'Project not found', exitCode: 1 };
          }
          const currentRuntime = proj.settings?.runtime || 'static';
          if (currentRuntime === requested) {
            return { stdout: `Runtime already set to ${requested}`, stderr: '', exitCode: 0 };
          }
          const runtime = requested as import('@/lib/vfs/types').ProjectRuntime;
          proj.settings = { ...proj.settings, runtime };
          await vfs.updateProject(proj);

          // Update .PROMPT.md to match the new runtime's domain prompt
          const { getDomainPrompt, isDefaultDomainPrompt } = await import('@/lib/llm/prompts');
          const newPrompt = getDomainPrompt(runtime);
          try {
            const existing = await vfs.readFile(projectId, '/.PROMPT.md');
            if (isDefaultDomainPrompt(typeof existing.content === 'string' ? existing.content : '')) {
              await vfs.updateFile(projectId, '/.PROMPT.md', newPrompt);
            }
            // If custom, leave it alone — the AI is managing .PROMPT.md
          } catch {
            // .PROMPT.md doesn't exist — create it
            await vfs.createFile(projectId, '/.PROMPT.md', newPrompt);
          }

          // Notify workspace so preview picks up the new runtime immediately
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('runtimeChanged', { detail: { runtime } }));
          }

          return { stdout: `Runtime changed to ${requested}`, stderr: '', exitCode: 0 };
        } catch (err: any) {
          return { stdout: '', stderr: `Failed to change runtime: ${err.message}`, exitCode: 1 };
        }
      }
      case 'status': {
        // Status pseudo-command
        // Usage: status --task "..." --done "..." --remaining "..." --complete
        const flags: Record<string, string> = {};
        let currentFlag: string | null = null;
        const tokens: string[] = [];
        let isComplete = false;
        let isIncomplete = false;
        for (const arg of args) {
          if (arg === '--complete') {
            if (currentFlag && tokens.length > 0) {
              flags[currentFlag] = tokens.join(' ');
              tokens.length = 0;
            }
            currentFlag = null;
            isComplete = true;
          } else if (arg === '--incomplete') {
            if (currentFlag && tokens.length > 0) {
              flags[currentFlag] = tokens.join(' ');
              tokens.length = 0;
            }
            currentFlag = null;
            isIncomplete = true;
          } else if (arg === '--task' || arg === '--done' || arg === '--remaining') {
            if (currentFlag && tokens.length > 0) {
              flags[currentFlag] = tokens.join(' ');
              tokens.length = 0;
            }
            currentFlag = arg.slice(2); // strip '--'
          } else if (currentFlag) {
            tokens.push(arg);
          }
        }
        if (currentFlag && tokens.length > 0) {
          flags[currentFlag] = tokens.join(' ');
        }

        if (!flags.task || !flags.done) {
          return {
            stdout: '',
            stderr: 'Usage: status --task "what was asked" --done "what I accomplished" --remaining "what\'s left or none" --complete',
            exitCode: 1
          };
        }
        const remaining = flags.remaining || 'none';
        // --complete wins over --incomplete if both present; neither = incomplete
        const complete = isComplete && !isIncomplete;
        return {
          stdout: `Task: ${flags.task}\nDone: ${flags.done}\nRemaining: ${remaining}\nComplete: ${complete ? 'yes' : 'no'}`,
          stderr: '',
          exitCode: 0
        };
      }
      case 'ask': {
        // ask [--prompt "Question"] "Option A" "Option B" "Option C"
        // Presents tappable chip options to the user. The orchestrator detects
        // exitReason='awaiting_user' and pauses the loop until the user picks.
        let askPrompt: string | undefined;
        const options: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '--prompt' && args[i + 1] !== undefined) {
            askPrompt = args[++i];
          } else if (a) {
            options.push(a);
          }
        }
        if (options.length < 2) {
          return {
            stdout: '',
            stderr: 'Usage: ask [--prompt "Question"] "Option A" "Option B" ["Option C" ...]\nNeed at least two options.',
            exitCode: 1
          };
        }
        ctx?.onProgress?.('ask', { prompt: askPrompt, options });
        return {
          stdout: `Awaiting user selection. Options presented: ${options.map(o => `"${o}"`).join(', ')}`,
          stderr: '',
          exitCode: 0,
          exitReason: 'awaiting_user'
        };
      }
      case 'brief': {
        // brief --merge << 'EOF' { ...JSON... } EOF
        // Merges a JSON object into the project brief. The body comes via stdin.
        const mode = args[0];
        if (mode !== '--merge') {
          return {
            stdout: '',
            stderr: 'Usage: brief --merge << \'EOF\'\n{ ...JSON... }\nEOF',
            exitCode: 1
          };
        }
        if (!stdin || !stdin.trim()) {
          return {
            stdout: '',
            stderr: 'brief --merge: expected JSON body via heredoc (<< \'EOF\' ... EOF).',
            exitCode: 1
          };
        }
        let parsed: any;
        try {
          parsed = JSON.parse(stdin.trim());
        } catch (err: any) {
          return {
            stdout: '',
            stderr: `brief --merge: invalid JSON — ${err.message}`,
            exitCode: 1
          };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return {
            stdout: '',
            stderr: 'brief --merge: body must be a JSON object.',
            exitCode: 1
          };
        }
        ctx?.onProgress?.('brief_update', { brief: parsed });
        const fields = Object.keys(parsed);
        return {
          stdout: fields.length > 0 ? `Brief updated: ${fields.join(', ')}` : 'Brief unchanged.',
          stderr: '',
          exitCode: 0
        };
      }
      case 'spec': {
        // spec --append "Section heading" << 'EOF'
        // prose content
        // EOF
        const mode = args[0];
        if (mode !== '--append') {
          return {
            stdout: '',
            stderr: 'Usage: spec --append "Section heading" << \'EOF\'\nprose\nEOF',
            exitCode: 1
          };
        }
        const section = args[1];
        if (!section || typeof section !== 'string' || !section.trim()) {
          return {
            stdout: '',
            stderr: 'spec --append: section heading required as second argument.',
            exitCode: 1
          };
        }
        if (!stdin || !stdin.trim()) {
          return {
            stdout: '',
            stderr: 'spec --append: expected prose body via heredoc (<< \'EOF\' ... EOF).',
            exitCode: 1
          };
        }
        ctx?.onProgress?.('spec_update', {
          section: section.trim(),
          content: stdin.trim()
        });
        return {
          stdout: `Spec updated: ${section.trim()}`,
          stderr: '',
          exitCode: 0
        };
      }
      case 'propose-create': {
        // propose-create — signals project is ready to create (user confirms via button).
        // The accumulated brief is held client-side; this command just flips the
        // "ready" flag. The orchestrator detects this and ends the setup loop.
        ctx?.onProgress?.('project_ready', {});
        return {
          stdout: 'Project ready to create. The user can review the brief and click "Create now" to confirm.',
          stderr: '',
          exitCode: 0,
          exitReason: 'setup_propose_create'
        };
      }
      case 'ss': {
        // ss (supersed) — smart file editing with multiple modes
        // Syntax: ss [flags] /path/to/file << 'EOF'\nsearch\n===\nreplacement\nEOF
        // Modes: (none) literal, --entity, --fuzzy, --regex

        // Parse flags (long form preferred: --entity, --fuzzy, --regex)
        let ssMode: 'literal' | 'entity' | 'fuzzy' | 'regex' = 'literal';
        let ssFilePath = '';
        for (const a of args) {
          if (a === '--entity' || a === '-e') ssMode = 'entity';
          else if (a === '--fuzzy' || a === '-f') ssMode = 'fuzzy';
          else if (a === '--regex' || a === '-r') ssMode = 'regex';
          else if (a && !a.startsWith('-')) ssFilePath = a;
        }

        const ssPath = normalizePath(ssFilePath);
        if (!ssPath) return { stdout: '', stderr: 'ss: missing file path', exitCode: 2 };

        if (stdin === undefined || stdin === '') {
          return { stdout: '', stderr: 'ss: missing heredoc input (use ss /file << \'EOF\')', exitCode: 2 };
        }

        // Split on \n===\n separator
        const sepIdx = stdin.indexOf('\n===\n');
        if (sepIdx === -1) {
          return { stdout: '', stderr: 'ss: missing === separator between search and replacement\n\nUsage: ss /file << \'EOF\'\nsearch content\n===\nreplacement content\nEOF', exitCode: 2 };
        }

        const ssSearch = stdin.substring(0, sepIdx);
        const ssReplace = stdin.substring(sepIdx + 5); // skip \n===\n

        // Read target file
        let ssContent: string;
        try {
          const file = await vfs.readFile(projectId, ssPath);
          if (typeof file.content !== 'string') {
            return { stdout: '', stderr: `ss: ${ssPath}: binary file`, exitCode: 1 };
          }
          ssContent = file.content;
        } catch (e: any) {
          return { stdout: '', stderr: `ss: ${ssPath}: ${e?.message || 'file not found'}`, exitCode: 1 };
        }

        let ssResult: string;

        switch (ssMode) {
          case 'literal': {
            const idx = ssContent.indexOf(ssSearch);
            if (idx === -1) {
              const preview = ssSearch.length > 200 ? ssSearch.substring(0, 200) + '...' : ssSearch;
              return { stdout: '', stderr: `ss: search text not found in ${ssPath}\n\nSearched for:\n${preview}`, exitCode: 1 };
            }
            ssResult = ssContent.substring(0, idx) + ssReplace + ssContent.substring(idx + ssSearch.length);
            break;
          }
          case 'entity': {
            const selectorMatch = ssFindSelectorMatch(ssContent, ssSearch);
            if (!selectorMatch) {
              const preview = ssSearch.length > 200 ? ssSearch.substring(0, 200) + '...' : ssSearch;
              return { stdout: '', stderr: `ss --entity: selector not found in ${ssPath}\n\nSearched for:\n${preview}`, exitCode: 1 };
            }
            const isHtml = ssIsHtmlEntity(selectorMatch.normalizedSelector);
            const boundary = ssDetectEntityBoundary(ssContent, selectorMatch.index, selectorMatch.normalizedSelector, isHtml);
            if (!boundary) {
              return { stdout: '', stderr: `ss --entity: could not detect entity boundary for selector in ${ssPath}`, exitCode: 1 };
            }
            ssResult = ssContent.substring(0, boundary.start) + ssReplace + ssContent.substring(boundary.end);
            break;
          }
          case 'fuzzy': {
            const normalizeForFuzzy = (s: string) => s.split('\n').map(l => l.trim()).filter(l => l.length > 0).join(' ').replace(/\s+/g, ' ');
            const normalizedSearch = normalizeForFuzzy(ssSearch);
            const origRange = ssMapNormalizedToOriginal(ssContent, normalizedSearch);
            if (!origRange) {
              const preview = ssSearch.length > 200 ? ssSearch.substring(0, 200) + '...' : ssSearch;
              return { stdout: '', stderr: `ss -f: search text not found (even with whitespace normalization) in ${ssPath}\n\nSearched for:\n${preview}`, exitCode: 1 };
            }
            ssResult = ssContent.substring(0, origRange.start) + ssReplace + ssContent.substring(origRange.end);
            break;
          }
          case 'regex': {
            let re: RegExp;
            try {
              re = new RegExp(ssSearch, 's'); // dotall mode
            } catch (e: any) {
              return { stdout: '', stderr: `ss -r: invalid regex: ${e?.message || 'parse error'}`, exitCode: 2 };
            }
            const m = re.exec(ssContent);
            if (!m) {
              const preview = ssSearch.length > 200 ? ssSearch.substring(0, 200) + '...' : ssSearch;
              return { stdout: '', stderr: `ss -r: regex did not match in ${ssPath}\n\nPattern:\n${preview}`, exitCode: 1 };
            }
            // Expand $0, $1, $2, ... backreferences in replacement (single-pass to avoid $1 clobbering $10)
            // Use $$ to produce a literal $ (e.g. "$$10" → "$10")
            const expandedReplace = ssReplace
              .replace(/\$\$/g, '\x00DOLLAR\x00')
              .replace(/\$(\d+)/g, (_, idx) => m[Number(idx)] || '')
              .replace(/\x00DOLLAR\x00/g, '$');
            ssResult = ssContent.substring(0, m.index) + expandedReplace + ssContent.substring(m.index + m[0].length);
            break;
          }
        }

        // Write result
        try {
          await vfs.updateFile(projectId, ssPath, ssResult);
          return { stdout: '', stderr: '', exitCode: 0 };
        } catch (e: any) {
          return { stdout: '', stderr: `ss: ${ssPath}: ${e?.message || 'cannot write file'}`, exitCode: 1 };
        }
      }
      case 'sleep': {
        // No-op — LLMs reflexively use sleep between commands.
        // Parse the duration to avoid "command not found" errors but don't actually wait.
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      default: {
        const bashHint = program === 'bash' ? `
Don't use "bash" as a command - call the shell tool directly with your command.
Wrong: {"cmd": ["bash", "-c", "ls -la"]}
Right: {"cmd": ["ls", "-la"]}
` : '';

        return {
          stdout: '',
          stderr: `${program}: command not found${bashHint}

Supported commands: ls, tree, cat, head, tail, rg, grep, find, mkdir, touch, rm, mv, cp, echo, sed, ss, wc, sort, uniq, tr, curl, sleep, sqlite3, build, status
Operators: | (pipe), > (redirect), >> (append), && (chain), || (fallback), ; (sequence)

Correct shell tool usage:
  {"cmd": ["ls", "/"]}                        - List files
  {"cmd": ["ls", "-R", "/"]}                  - List files recursively
  {"cmd": ["tree", "/", "-L", "2"]}           - Show directory tree (max depth 2)
  {"cmd": ["cat", "/file.txt"]}               - Read entire file
  {"cmd": ["head", "-n", "20", "/file.txt"]}  - Read first 20 lines
  {"cmd": ["tail", "-n", "20", "/file.txt"]}  - Read last 20 lines
  {"cmd": ["rg", "-C", "3", "pattern", "/"]}  - Search with 3 lines context (recommended)
  {"cmd": ["rg", "-A", "2", "-B", "1", "pattern"]} - Search with custom context
  {"cmd": ["grep", "-n", "pattern", "/file.txt"]} - Search with line numbers
  {"cmd": ["grep", "-F", "literal", "/file.txt"]} - Search literal string
  {"cmd": ["find", "/", "-name", "*.js"]}     - Find files by name
  {"cmd": ["mkdir", "-p", "/path/to/dir"]}    - Create directory (with parents)
  {"cmd": ["touch", "/file.txt"]}             - Create empty file
  {"cmd": ["rm", "-rf", "/dirname"]}          - Delete directory recursively
  {"cmd": ["mv", "/old.txt", "/new.txt"]}     - Move/rename files
  {"cmd": ["cp", "-r", "/src", "/dest"]}      - Copy files/directories
  {"cmd": ["echo", "Hello World"]}            - Output text
  {"cmd": ["echo", "content", ">", "/file.txt"]} - Write text to file
  {"cmd": ["sed", "s/old/new/g", "/file.txt"]}  - Text substitution (stdout)
  {"cmd": ["sed", "-i", "s/old/new/g", "/file.txt"]} - In-place edit
  {"cmd": ["cat", "/f.txt", "|", "grep", "class", "|", "head", "-n", "5"]} - Pipe chain
  {"cmd": ["grep", "-n", "div", "/f.txt", ">", "/results.txt"]} - Redirect to file
  {"cmd": ["find", "/", "-type", "f", "|", "wc", "-l"]} - Count files
  {"cmd": ["wc", "-l", "/file.txt"]}             - Count lines in file
  {"cmd": ["curl", "localhost/"]}                 - View compiled HTML output
  {"cmd": ["curl", "localhost/about"]}            - View compiled page (path resolution)
  {"cmd": ["curl", "-I", "localhost/"]}           - Response headers only
  {"cmd": ["sqlite3", "SELECT * FROM users"]} - Execute SQL (Server Mode)
  {"cmd": ["sqlite3", "-json", "SELECT * FROM products"]} - SQL output as JSON

Note: Use ss for editing existing files, cat > for new file creation, sed -i for single-line substitutions. Use rg (ripgrep) instead of grep for better context management.
Note: sqlite3 is only available in Server Mode and when a deployment context is selected.`,
          exitCode: 127
        };
      }
    }
  } catch (e: any) {
    return { stdout: '', stderr: e?.message || String(e), exitCode: 1 };
  }
}

// Create a global instance that can be imported
export const vfsShell = {
  execute: async (
    projectId: string,
    cmd: string[],
    stdin?: string,
    ctx?: ShellContext
  ): Promise<{ success: boolean; stdout?: string; stderr?: string; exitReason?: string }> => {
    const { getActiveVFS } = await import('./index');
    const activeVFS = getActiveVFS();
    await activeVFS.init();
    const result = await vfsShellExecute(activeVFS, projectId, cmd, stdin, ctx);
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitReason: result.exitReason
    };
  }
};
