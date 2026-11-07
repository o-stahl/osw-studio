import { isSedInPlaceFlag } from '@/lib/vfs/shell-commands';

/**
 * Permission gating: pure classification of a parsed command into a "gate key",
 * and resolution of whether that key needs user approval under the current mode.
 * No I/O - mode and overrides are passed in. Read by the tool-dispatch gate and
 * by the matrix UI.
 */

export type PermissionMode = 'auto' | 'ask' | 'custom';
export type GateDecision = 'ask' | 'allow';

/** The recommended consequential set that 'ask' mode prompts for. */
export const ASK_DEFAULT_KEYS: ReadonlySet<string> = new Set([
  'curl:external',
  'search',
  'generate-image',
  'rm',
]);

/** One row per command in the matrix UI. Dual commands expose two facet keys. */
export interface GateCommand {
  command: string;
  label: string;
  keys: string[]; // gate keys this command can produce
}

// Full command surface (mirrors tool-registry.ts command list). Ordinary commands
// have a single key equal to their name; dual commands split into read/write or
// local/external facets.
export const GATE_COMMANDS: GateCommand[] = [
  { command: 'cat', label: 'cat (read file)', keys: ['cat'] },
  { command: 'head', label: 'head', keys: ['head'] },
  { command: 'tail', label: 'tail', keys: ['tail'] },
  { command: 'ls', label: 'ls', keys: ['ls'] },
  { command: 'tree', label: 'tree', keys: ['tree'] },
  { command: 'grep', label: 'grep', keys: ['grep'] },
  { command: 'rg', label: 'rg (ripgrep)', keys: ['rg'] },
  { command: 'find', label: 'find', keys: ['find'] },
  { command: 'wc', label: 'wc', keys: ['wc'] },
  { command: 'sort', label: 'sort', keys: ['sort'] },
  { command: 'uniq', label: 'uniq', keys: ['uniq'] },
  { command: 'tr', label: 'tr', keys: ['tr'] },
  { command: 'echo', label: 'echo', keys: ['echo'] },
  { command: 'mkdir', label: 'mkdir', keys: ['mkdir'] },
  { command: 'touch', label: 'touch', keys: ['touch'] },
  { command: 'mv', label: 'mv (move)', keys: ['mv'] },
  { command: 'cp', label: 'cp (copy)', keys: ['cp'] },
  { command: 'rm', label: 'rm / rmdir (delete)', keys: ['rm'] },
  { command: 'ss', label: 'ss (search/replace edit)', keys: ['ss'] },
  { command: 'sed', label: 'sed', keys: ['sed:read', 'sed:write'] },
  { command: 'curl', label: 'curl', keys: ['curl:local', 'curl:external'] },
  { command: 'sqlite3', label: 'sqlite3', keys: ['sqlite3:read', 'sqlite3:write'] },
  { command: 'python', label: 'python / python3', keys: ['python'] },
  { command: 'lua', label: 'lua', keys: ['lua'] },
  { command: 'preview', label: 'preview', keys: ['preview'] },
  { command: 'build', label: 'build', keys: ['build'] },
  { command: 'runtime', label: 'runtime', keys: ['runtime'] },
  { command: 'sleep', label: 'sleep', keys: ['sleep'] },
  { command: 'ask', label: 'ask (prompt the user)', keys: ['ask'] },
  { command: 'generate-image', label: 'generate-image', keys: ['generate-image'] },
  { command: 'search', label: 'search (web)', keys: ['search'] },
];

/** Commands that are intentionally never gated, shown as always-allowed in the matrix. */
export const ALWAYS_ALLOWED_NOTES: { command: string; reason: string }[] = [
  { command: 'status', reason: 'the signal the agent uses to finish a run; gating it could stall generation.' },
  { command: 'agent', reason: 'spawning sub-agents is always allowed; the commands a sub-agent runs are gated individually, so control happens there.' },
  { command: 'cd', reason: 'accepted and ignored — the VFS has no working directory, so there is nothing to gate.' },
  { command: 'brief', reason: 'reaches only the setup agent during project intake, and reports back to the user rather than touching the project.' },
  { command: 'spec', reason: 'reaches only the setup agent during project intake, and records the agreed plan rather than touching the project.' },
  { command: 'propose-create', reason: 'reaches only the setup agent, and proposes a project for the user to accept — the creation itself is the user\'s action.' },
];

/** A statement verb that changes data; followed by `(` it is a function, as `replace()` is. */
const WRITE_SQL = /\b(insert|update|delete|create|drop|alter|replace|truncate)\b(?!\s*\()/i;

/**
 * Quoted strings and names, and comments, in one pass from the left, so a quote inside a comment
 * and a comment marker inside a string are each taken for what they are.
 */
const SQL_NOT_WORDS = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

/**
 * Whether a `sqlite3` command line changes a deployment's data rather than reading it, read from the
 * statements' own words: quoted strings and names, and comments, are left out, so a query for
 * `action = 'delete'` stays a query. Each argument is read on its own, since the statement that runs
 * is one argument and a flag-shaped one beside it must not comment it out.
 */
export function sqliteChangesData(args: string[]): boolean {
  if (args[0] !== 'sqlite3') return false;
  return args.slice(1).some((arg) => WRITE_SQL.test(arg.replace(SQL_NOT_WORDS, ' ')));
}

export function extractCurlUrls(args: string[]): string[] {
  // Mirror cli-shell.ts curl flag parsing: every non-flag, non-flag-value token, in order.
  const takesValue = new Set(['-o', '--output', '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw']);
  const urls: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    // Stop at a shell operator: a pipe, redirect, or chain token means the following tokens
    // belong to another command, not curl. Without this, `curl localhost | head` reads "|"
    // and "head" as URLs and misclassifies a local fetch as external ("http://|"). (&&/||/;
    // are already split out upstream, but included here for safety.)
    if (a === '|' || a === '||' || a === '&&' || a === ';' || /^(?:[12&]?>>?|<)$/.test(a)) break;
    if (takesValue.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    urls.push(a);
  }
  return urls;
}

/** Is a single raw URL token external (i.e. not localhost/127.0.0.1)? */
export function isExternalUrl(raw: string): boolean {
  if (!raw) return false;
  const url = (raw.includes('://') ? raw : 'http://' + raw).toLowerCase();
  return !(
    url.startsWith('http://localhost') || url.startsWith('https://localhost') ||
    url.startsWith('http://127.0.0.1') || url.startsWith('https://127.0.0.1')
  );
}

export function isExternalCurl(args: string[]): boolean {
  return extractCurlUrls(args).some(isExternalUrl);
}

/** Classify a parsed command (cmdArray) into the gate key for THIS invocation. */
export function classifyGateKey(args: string[]): string | null {
  const name = args[0];
  if (!name) return null;
  switch (name) {
    case 'rmdir': return 'rm';
    case 'python3': return 'python'; // shares the python capability toggle
    case 'curl': return isExternalCurl(args) ? 'curl:external' : 'curl:local';
    case 'sed': return args.slice(1).some(isSedInPlaceFlag) ? 'sed:write' : 'sed:read';
    case 'sqlite3': return sqliteChangesData(args) ? 'sqlite3:write' : 'sqlite3:read';
    default: {
      const known = GATE_COMMANDS.some(c => c.command === name);
      return known ? name : null;
    }
  }
}

/** Does this gate key require approval under the given mode and overrides? */
export function needsApproval(
  key: string,
  mode: PermissionMode,
  overrides: Record<string, GateDecision>,
): boolean {
  if (mode === 'auto') return false;
  if (mode === 'ask') {
    if (!ASK_DEFAULT_KEYS.has(key)) return false;
    return overrides[key] !== 'allow';
  }
  // custom: matrix is authoritative; unset keys fall back to the ask-set default.
  const fallback: GateDecision = ASK_DEFAULT_KEYS.has(key) ? 'ask' : 'allow';
  return (overrides[key] ?? fallback) === 'ask';
}

export interface ApprovalRequest {
  command: string;   // the full command segment text, for display
  gateKey: string;   // e.g. 'curl:external'
  capabilityLabel: string; // human label, e.g. 'Web access'
}
export type ApprovalOutcome = 'once' | 'always' | 'deny';

export function capabilityLabel(gateKey: string): string {
  if (gateKey === 'search' || gateKey.startsWith('curl:')) return 'Web access';
  if (gateKey === 'generate-image') return 'Image generation';
  if (gateKey === 'rm') return 'File deletion';
  return gateKey;
}
