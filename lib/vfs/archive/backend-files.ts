import type {
  BackendFeatures, EdgeFunction, ScheduledFunction, Secret, ServerFunction,
} from '../types';
import {
  validateEdgeFunctionData,
  validateScheduledFunctionData,
  validateSecretData,
  validateServerFunctionData,
} from '../server-context/generators';
import { validateArchivePath } from './paths';
import { said } from './text';
import type { ArchiveIssue } from './types';

/**
 * Backend features as they sit in storage, passed in by the caller so this module stays pure.
 * Every field is optional: a project may have none of them.
 */
export interface BackendSource {
  edgeFunctions?: EdgeFunction[];
  serverFunctions?: ServerFunction[];
  secrets?: Secret[];
  scheduledFunctions?: ScheduledFunction[];
}

/** A file destined for the archive. Backend features are always text. */
export interface ArchiveTextFile {
  path: string;
  content: string;
}

/**
 * The archive's `/.server/` layout, and the defaults a record takes when the archive states none.
 *
 * Exported because the analyzer and apply both have to agree with what is written here: the
 * analyzer's "unchanged means exporting this again produces these bytes" only holds while every
 * module applies the same defaults, and apply reports failures against these same paths.
 */
export const SERVER_PREFIX = '/.server/';
export const EDGE_DIR = '/.server/edge-functions/';
export const SERVER_DIR = '/.server/server-functions/';
export const SECRETS_PATH = '/.server/secrets.json';
export const SCHEDULED_PATH = '/.server/scheduled.json';

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_METHOD = 'ANY';
export const DEFAULT_TIMEZONE = 'UTC';
/** validateSecretData caps names at 64 characters; the other kinds have no length rule. */
const MAX_SECRET_NAME_LENGTH = 64;

/** Two spaces and a trailing newline, so the files read and diff like anything else in the zip. */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Sort object keys at every depth. Every object this module writes has a fixed key order except a
 * schedule's `config`, which is user-supplied: its key order is not part of the schedule's state,
 * so `{z:1,a:2}` and `{a:2,z:1}` have to produce the same bytes — otherwise unchanged state reads
 * as a change to whatever is diffing the archive.
 *
 * Array order *is* state, so arrays keep theirs.
 *
 * Exported so the analyzer can canonicalize a stored config the same way before comparing one:
 * two modules deciding independently what "the same config" means is how a diff starts lying.
 */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortDeep(source[key]);
  return sorted;
}

function byName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * A feature name becomes a filename, so it has to be one usable path segment. A name containing a
 * slash would write outside its folder and come back unreadable — `groupPairs` would have no
 * feature to attach it to.
 *
 * The character rules live in validateArchivePath and are not restated here; a slash is the one
 * thing it cannot catch, because nested segments are legal in every other path.
 */
function usableAsFilename(
  name: string,
  path: string,
  kind: BackendNameKind,
  warnings?: ArchiveIssue[]
): boolean {
  const result = validateArchivePath(path);
  if (!!name && !name.includes('/') && result.ok) return true;
  warnings?.push({
    path,
    code: result.ok ? 'path-rejected' : result.code,
    ...said('unusableName', { kind, name }),
  });
  return false;
}

/**
 * A record whose code is empty writes an empty `.js`, which `validateEdgeFunctionData` and
 * `validateServerFunctionData` both reject on the way back in ('Missing or invalid "code" field').
 * The record is still exported — it is what the project holds — but the round trip would silently
 * lose it, so say so at the point the archive is made rather than at the point it is imported.
 */
function warnIfCodeEmpty(
  name: string,
  code: string | undefined,
  path: string,
  kind: BackendNameKind,
  warnings?: ArchiveIssue[]
): void {
  if (code) return;
  warnings?.push({
    path,
    code: 'missing-code',
    ...said('emptyCode', { kind, name }),
  });
}

/**
 * Backend features → editable source files.
 *
 * Code goes in a real `.js` file so an external editor treats it as JavaScript; everything else
 * about the feature goes in a `.json` sidecar beside it. Secrets and schedules have no code, so
 * they are single list files.
 *
 * Output is sorted by name, sorted within every object, and carries no ids, timestamps or secret
 * values — the same project state must produce byte-identical files every time.
 *
 * `warnings` is an optional collector for what could not be carried across: a name that is not a
 * usable filename, or a schedule whose edge function is gone.
 */
export function backendToArchiveFiles(
  source: BackendSource,
  warnings?: ArchiveIssue[]
): ArchiveTextFile[] {
  const files: ArchiveTextFile[] = [];

  for (const fn of byName(source.edgeFunctions ?? [])) {
    const codePath = `${EDGE_DIR}${fn.name}.js`;
    if (!usableAsFilename(fn.name, codePath, 'edge', warnings)) continue;
    warnIfCodeEmpty(fn.name, fn.code, codePath, 'edge', warnings);
    files.push({ path: codePath, content: fn.code ?? '' });
    files.push({
      path: `${EDGE_DIR}${fn.name}.json`,
      content: json({
        name: fn.name,
        method: fn.method ?? DEFAULT_METHOD,
        description: fn.description || undefined,
        enabled: fn.enabled !== false,
        timeoutMs: fn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    });
  }

  for (const fn of byName(source.serverFunctions ?? [])) {
    const codePath = `${SERVER_DIR}${fn.name}.js`;
    if (!usableAsFilename(fn.name, codePath, 'server', warnings)) continue;
    warnIfCodeEmpty(fn.name, fn.code, codePath, 'server', warnings);
    files.push({ path: codePath, content: fn.code ?? '' });
    files.push({
      path: `${SERVER_DIR}${fn.name}.json`,
      content: json({
        name: fn.name,
        description: fn.description || undefined,
        enabled: fn.enabled !== false,
      }),
    });
  }

  const secrets = byName(source.secrets ?? []);
  if (secrets.length > 0) {
    // Names and descriptions only. A secret's value never leaves the machine it was entered on.
    files.push({
      path: SECRETS_PATH,
      content: json(secrets.map((s) => ({ name: s.name, description: s.description || undefined }))),
    });
  }

  const scheduled = byName(source.scheduledFunctions ?? []);
  if (scheduled.length > 0) {
    // The link is stored by NAME, not id: ids are per-installation, names survive the trip.
    const nameById = new Map((source.edgeFunctions ?? []).map((fn) => [fn.id, fn.name]));
    const entries = [];
    for (const job of scheduled) {
      const functionName = nameById.get(job.functionId);
      if (!functionName) {
        warnings?.push({
          code: 'unresolved-reference',
          ...said('orphanSchedule', { name: job.name }),
        });
        continue;
      }
      entries.push({
        name: job.name,
        functionName,
        description: job.description || undefined,
        cronExpression: job.cronExpression,
        timezone: job.timezone || DEFAULT_TIMEZONE,
        enabled: job.enabled !== false,
        config: sortDeep(job.config ?? {}),
      });
    }
    if (entries.length > 0) files.push({ path: SCHEDULED_PATH, content: json(entries) });
  }

  return files;
}

interface PairGroup {
  name: string;
  code?: string;
  sidecar?: string;
  sidecarPath?: string;
  codePath?: string;
}

/**
 * Editable source files → parsed backend records.
 *
 * Returns records, **not** file writes. `mountProjectBackendContext` returns immediately unless
 * `NEXT_PUBLIC_SERVER_MODE === 'true'` (lib/vfs/index.ts:236), so in Browser mode — the default —
 * writing to `/.server/…` throws. The caller persists these through the storage adapter instead.
 *
 * Bypassing the mount also bypasses its validation, so each composed record goes through the same
 * exported validator the mount would have used. A record that fails is dropped and reported: a
 * half-formed edge function in storage is worse than an absent one the user can see was rejected.
 *
 * A value present in the archive reaches the validator untouched. Only an **absent** key takes a
 * default — defaulting a malformed one hides it, and `"enabled": "false"` arriving as
 * `enabled: true` publishes a route the archive says is off.
 *
 * Prose in `/.server/` is ignored, which is what lets the generated README.md round-trip.
 *
 * `claimedPaths` is every `/.server/` path this recognized as its own, whether it composed a record
 * or reported an issue about it. A caller that routed the whole folder here can subtract it to find
 * the entries nothing accounted for — those are dropped, and the user was told the folder was
 * theirs to edit.
 *
 * **At most one record per (kind, name).** A record's name comes from its sidecar's `name` field
 * when it has one, and the list files are plain JSON arrays, so two records of the same kind can
 * claim one name in a single archive — `a.json` and `b.json` both saying `"name": "send-email"`,
 * or `secrets.json` listing `API_KEY` twice. Nothing downstream can carry that: a name is the only
 * identity an archive has, so the analyzer would classify one entry twice and apply would try to
 * store both, the second failing on the adapter's uniqueness constraint. First wins, and the loser
 * is reported — the same treatment the zip and folder readers give a duplicate path.
 */
export function archiveFilesToBackend(
  entries: Map<string, string>
): { features: BackendFeatures; issues: ArchiveIssue[]; claimedPaths: Set<string> } {
  const issues: ArchiveIssue[] = [];
  const features: BackendFeatures = {};
  const claimedPaths = new Set<string>();
  // One set per kind, not one shared: edge and scheduled names share a grammar, and a project may
  // legitimately hold an edge function and a schedule both called 'nightly'.
  const takenEdge = new Set<string>();
  const takenServer = new Set<string>();
  const takenSecret = new Set<string>();
  const takenScheduled = new Set<string>();

  const edgeGroups = groupPairs(entries, EDGE_DIR, 'edge', issues, claimedPaths);
  const serverGroups = groupPairs(entries, SERVER_DIR, 'server', issues, claimedPaths);

  const edgeFunctions: NonNullable<BackendFeatures['edgeFunctions']> = [];
  for (const group of edgeGroups) {
    const sidecar = readSidecar(group, issues);
    if (sidecar === INVALID) continue;
    if (!requireCode(group, issues)) continue;
    const candidate: Record<string, unknown> = {
      name: fallback(sidecar?.name, group.name),
      method: fallback(sidecar?.method, DEFAULT_METHOD),
      code: group.code,
      enabled: fallback(sidecar?.enabled, true),
      timeoutMs: fallback(sidecar?.timeoutMs, DEFAULT_TIMEOUT_MS),
    };
    if (sidecar?.description !== undefined) candidate.description = sidecar.description;
    if (!accept(validateEdgeFunctionData(candidate), 'edge', candidate, group.codePath, issues)) {
      continue;
    }
    if (!claimName(takenEdge, 'edge', candidate.name, group.codePath, issues)) continue;
    edgeFunctions.push(candidate as unknown as (typeof edgeFunctions)[number]);
  }
  if (edgeFunctions.length > 0) features.edgeFunctions = edgeFunctions;

  const serverFunctions: NonNullable<BackendFeatures['serverFunctions']> = [];
  for (const group of serverGroups) {
    const sidecar = readSidecar(group, issues);
    if (sidecar === INVALID) continue;
    if (!requireCode(group, issues)) continue;
    const candidate: Record<string, unknown> = {
      name: fallback(sidecar?.name, group.name),
      code: group.code,
      enabled: fallback(sidecar?.enabled, true),
    };
    if (sidecar?.description !== undefined) candidate.description = sidecar.description;
    if (!accept(validateServerFunctionData(candidate), 'server', candidate, group.codePath, issues)) {
      continue;
    }
    if (!claimName(takenServer, 'server', candidate.name, group.codePath, issues)) continue;
    serverFunctions.push(candidate as unknown as (typeof serverFunctions)[number]);
  }
  if (serverFunctions.length > 0) features.serverFunctions = serverFunctions;

  const secrets: NonNullable<BackendFeatures['secrets']> = [];
  if (entries.has(SECRETS_PATH)) claimedPaths.add(SECRETS_PATH);
  for (const item of readList(entries, SECRETS_PATH, issues)) {
    if (item.value !== undefined) {
      // Export never writes one, so this archive was hand-edited. Say so rather than dropping in
      // silence something the author clearly meant to hand over.
      issues.push({
        path: SECRETS_PATH,
        code: 'unsupported-field',
        ...said('secretValue', { name: label(item.name) }),
      });
    }
    const candidate: Record<string, unknown> = { name: item.name };
    if (item.description !== undefined) candidate.description = item.description;
    if (!accept(validateSecretData(candidate), 'secret', candidate, SECRETS_PATH, issues)) continue;
    if (!claimName(takenSecret, 'secret', candidate.name, SECRETS_PATH, issues)) continue;
    secrets.push(candidate as unknown as (typeof secrets)[number]);
  }
  if (secrets.length > 0) features.secrets = secrets;

  const scheduledFunctions: NonNullable<BackendFeatures['scheduledFunctions']> = [];
  if (entries.has(SCHEDULED_PATH)) claimedPaths.add(SCHEDULED_PATH);
  for (const item of readList(entries, SCHEDULED_PATH, issues)) {
    // functionName stays a name here. Resolving it to an id needs the target project's edge
    // functions, which this pure module does not have.
    const candidate: Record<string, unknown> = {
      name: item.name,
      functionName: item.functionName,
      cronExpression: item.cronExpression,
      timezone: fallback(item.timezone, DEFAULT_TIMEZONE),
      enabled: fallback(item.enabled, true),
      config: fallback(item.config, {}),
    };
    if (item.description !== undefined) candidate.description = item.description;
    if (!accept(validateScheduledFunctionData(candidate), 'scheduled', candidate, SCHEDULED_PATH, issues)) {
      continue;
    }
    if (!claimName(takenScheduled, 'scheduled', candidate.name, SCHEDULED_PATH, issues)) {
      continue;
    }
    scheduledFunctions.push(candidate as unknown as (typeof scheduledFunctions)[number]);
  }
  if (scheduledFunctions.length > 0) features.scheduledFunctions = scheduledFunctions;

  return { features, issues, claimedPaths };
}

/**
 * Claim a name for one kind, or report it as already spoken for.
 *
 * Called after the validator, so `name` is a string by the time it gets here — but only the
 * *accepted* records compete for a name, which is what makes "first wins" mean the first record
 * that could have been imported rather than the first line in the file.
 */
function claimName(
  taken: Set<string>,
  kind: BackendNameKind,
  name: unknown,
  path: string | undefined,
  issues: ArchiveIssue[]
): boolean {
  const key = String(name);
  if (!taken.has(key)) {
    taken.add(key);
    return true;
  }
  issues.push({
    path,
    code: 'path-rejected',
    ...said('duplicateName', { kind, name: key }),
  });
  return false;
}

const INVALID = Symbol('invalid-sidecar');

/** Default on absence only; a present-but-wrong value goes to the validator untouched. */
function fallback(value: unknown, whenAbsent: unknown): unknown {
  return value === undefined ? whenAbsent : value;
}

function label(name: unknown): string {
  return typeof name === 'string' && name.length > 0 ? name : '(unnamed)';
}

/** Collect `<dir>/<name>.js` and `<dir>/<name>.json` into one group per stem, sorted by name. */
function groupPairs(
  entries: Map<string, string>,
  dir: string,
  kind: BackendNameKind,
  issues: ArchiveIssue[],
  claimedPaths: Set<string>
): PairGroup[] {
  const groups = new Map<string, PairGroup>();
  for (const [path, content] of entries) {
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = rest.slice(dot + 1);
    if (ext !== 'js' && ext !== 'json') continue;
    if (rest.includes('/')) {
      // A name is one path segment, so nothing here can belong to a feature. Report it rather
      // than dropping it: it holds code somebody expected to be imported.
      claimedPaths.add(path);
      issues.push({
        path,
        code: 'path-rejected',
        ...said('nestedBackendFile', { kind, dir, path }),
      });
      continue;
    }
    claimedPaths.add(path);
    const name = rest.slice(0, dot);
    const group = groups.get(name) ?? { name };
    if (ext === 'js') {
      group.code = content;
      group.codePath = path;
    } else {
      group.sidecar = content;
      group.sidecarPath = path;
    }
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function requireCode(group: PairGroup, issues: ArchiveIssue[]): boolean {
  if (group.code !== undefined) return true;
  issues.push({
    path: group.sidecarPath,
    code: 'missing-code',
    ...said('missingCode', { name: group.name }),
  });
  return false;
}

/**
 * An unreadable sidecar drops the whole record rather than falling back to defaults: the sidecar
 * is where `enabled` and `method` live, and guessing them could publish a route the user disabled.
 */
function readSidecar(
  group: PairGroup,
  issues: ArchiveIssue[]
): Record<string, unknown> | undefined | typeof INVALID {
  if (group.sidecar === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(group.sidecar);
  } catch {
    issues.push({
      path: group.sidecarPath,
      code: 'invalid-json',
      ...said('sidecarNotJson', { path: group.sidecarPath ?? '', name: group.name }),
    });
    return INVALID;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push({
      path: group.sidecarPath,
      code: 'invalid-json',
      ...said('sidecarNotObject', { path: group.sidecarPath ?? '', name: group.name }),
    });
    return INVALID;
  }
  return parsed as Record<string, unknown>;
}

function readList(
  entries: Map<string, string>,
  path: string,
  issues: ArchiveIssue[]
): Array<Record<string, unknown>> {
  const text = entries.get(path);
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    issues.push({ path, code: 'invalid-json', ...said('listNotJson', { path }) });
    return [];
  }
  if (!Array.isArray(parsed)) {
    issues.push({ path, code: 'invalid-json', ...said('listNotArray', { path }) });
    return [];
  }
  const items: Array<Record<string, unknown>> = [];
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push({
        path,
        code: 'invalid-json',
        ...said('entryNotObject', { index: index + 1, path }),
      });
      return;
    }
    items.push(item as Record<string, unknown>);
  });
  return items;
}

function accept(
  result: { valid: boolean; errors: string[] },
  kind: BackendNameKind,
  candidate: Record<string, unknown>,
  path: string | undefined,
  issues: ArchiveIssue[]
): boolean {
  if (result.valid) return true;
  issues.push({
    path,
    code: 'validation-failed',
    ...said('invalidRecord', { kind, name: label(candidate.name), detail: result.errors.join('; ') }),
  });
  return false;
}

export type BackendNameKind = 'edge' | 'server' | 'secret' | 'scheduled';

/**
 * Each kind has its own name grammar, so the file convention `name (2)` is illegal for all of
 * them: edge and scheduled names are lowercase-and-hyphens, server functions are JS identifiers,
 * secrets are SCREAMING_SNAKE_CASE.
 *
 * **Mutates `taken`**, adding the name it returns — two calls with the same input would otherwise
 * hand back the same name, and 'keep both' would lose one of the two records it exists to preserve.
 */
export function keepBothBackendName(
  kind: BackendNameKind,
  name: string,
  taken: Set<string>
): string {
  const separator = kind === 'server' ? '' : kind === 'secret' ? '_' : '-';

  const build = (n: number): string => {
    const suffix = `${separator}${n}`;
    // Only secrets have a length rule; trimming the stem keeps the suffix, which carries the meaning.
    const room = kind === 'secret'
      ? MAX_SECRET_NAME_LENGTH - suffix.length
      : Number.POSITIVE_INFINITY;
    return `${room < name.length ? name.slice(0, Math.max(0, room)) : name}${suffix}`;
  };

  let n = 2;
  let candidate = build(n);
  while (taken.has(candidate)) {
    n += 1;
    candidate = build(n);
  }
  taken.add(candidate);
  return candidate;
}
