import { hashText } from '@/lib/canvas/hash';
import type { EdgeFunction, ScheduledFunction, Secret, ServerFunction } from './types';

export interface BackendFeatureSet {
  edgeFunctions: EdgeFunction[];
  serverFunctions: ServerFunction[];
  secrets: Secret[];
  scheduledFunctions: ScheduledFunction[];
}

/** What the server was last known to hold: a fingerprint per `kind:name`. */
type BackendBase = Record<string, string>;

type Kind = keyof BackendFeatureSet;
type Item = BackendFeatureSet[Kind][number];

const KINDS: Kind[] = ['edgeFunctions', 'serverFunctions', 'secrets', 'scheduledFunctions'];

const baseKey = (projectId: string) => `osw-backend-synced:${projectId}`;

export function readBackendBase(projectId: string): BackendBase {
  try {
    return JSON.parse(localStorage.getItem(baseKey(projectId)) ?? '{}') as BackendBase;
  } catch {
    return {};
  }
}

export function writeBackendBase(projectId: string, set: BackendFeatureSet): void {
  try {
    localStorage.setItem(baseKey(projectId), JSON.stringify(backendBaseOf(set)));
  } catch {
    // Without a record every unmatched item counts as new, which keeps it rather than deleting it.
  }
}

function edgeNamesOf(set: BackendFeatureSet): Map<string, string> {
  return new Map(set.edgeFunctions.map(fn => [fn.id, fn.name]));
}

/** The item's content, without ids, timestamps, run history or a secret's value. */
function fingerprint(kind: Kind, item: Item, edgeNames: Map<string, string>): string {
  const description = item.description ?? null;
  let content: unknown[];
  if (kind === 'edgeFunctions') {
    const fn = item as EdgeFunction;
    content = [description, fn.code, fn.method, Boolean(fn.enabled), fn.timeoutMs];
  } else if (kind === 'serverFunctions') {
    const fn = item as ServerFunction;
    content = [description, fn.code, Boolean(fn.enabled)];
  } else if (kind === 'secrets') {
    content = [description];
  } else {
    const fn = item as ScheduledFunction;
    content = [description, edgeNames.get(fn.functionId) ?? fn.functionId, fn.cronExpression, fn.timezone, fn.config ?? {}, Boolean(fn.enabled)];
  }
  return hashText(JSON.stringify(content));
}

function backendBaseOf(set: BackendFeatureSet): BackendBase {
  const edgeNames = edgeNamesOf(set);
  const base: BackendBase = {};
  for (const kind of KINDS) {
    for (const item of set[kind]) base[`${kind}:${item.name}`] = fingerprint(kind, item, edgeNames);
  }
  return base;
}

const updatedAt = (item: Item) => new Date(item.updatedAt).getTime() || 0;

/** The version to keep of one name, or null where a side deleted it after both had held it. */
function choose<T extends Item>(local: T | undefined, server: T | undefined, localPrint?: string, serverPrint?: string, base?: string): T | null {
  if (local && server) {
    if (localPrint === serverPrint || base === localPrint) return server;
    if (base === serverPrint) return local;
    return updatedAt(local) > updatedAt(server) ? local : server;
  }
  if (local) return base === localPrint ? null : local;
  if (server) return base === serverPrint ? null : server;
  return null;
}

/**
 * Both sides' backend features brought together, item by name (the server allows one per name).
 *
 * `base` tells a change from a difference: an item only one side has was either just made there,
 * or deleted on the other side, and an item both have was changed by whichever no longer matches.
 */
export function mergeBackendFeatures(
  local: BackendFeatureSet,
  server: BackendFeatureSet,
  base: BackendBase,
): { merged: BackendFeatureSet; needsPush: boolean } {
  const localEdges = edgeNamesOf(local);
  const serverEdges = edgeNamesOf(server);
  const merged: BackendFeatureSet = { edgeFunctions: [], serverFunctions: [], secrets: [], scheduledFunctions: [] };
  let mergedEdges = new Map<string, string>();
  let needsPush = false;

  for (const kind of KINDS) {
    const mine = new Map<string, Item>(local[kind].map(item => [item.name, item]));
    const theirs = new Map<string, Item>(server[kind].map(item => [item.name, item]));
    const kept: Item[] = [];
    for (const name of new Set([...theirs.keys(), ...mine.keys()])) {
      const l = mine.get(name);
      const s = theirs.get(name);
      const lp = l && fingerprint(kind, l, localEdges);
      const sp = s && fingerprint(kind, s, serverEdges);
      let item = choose(l, s, lp, sp, base[`${kind}:${name}`]);
      if (!item) {
        if (s) needsPush = true;
        continue;
      }
      const fromLocal = item === l;
      if (kind === 'secrets') {
        // The server never returns a value, so the browser's stays with the secret.
        const value = (l as Secret | undefined)?.value;
        item = { ...(item as Secret), value, hasValue: Boolean(value) || (item as Secret).hasValue };
        if (value && !(s as Secret | undefined)?.hasValue) needsPush = true;
      }
      if (kind === 'scheduledFunctions') {
        const schedule = item as ScheduledFunction;
        const edgeName = (fromLocal ? localEdges : serverEdges).get(schedule.functionId);
        const functionId = merged.edgeFunctions.find(fn => fn.name === edgeName)?.id;
        if (!functionId) {
          if (s) needsPush = true;
          continue;
        }
        item = { ...schedule, functionId };
      }
      if (!s || fingerprint(kind, item, kind === 'scheduledFunctions' ? mergedEdges : localEdges) !== fingerprint(kind, s, serverEdges)) {
        needsPush = true;
      }
      kept.push(item);
    }
    (merged[kind] as Item[]) = kept;
    if (kind === 'edgeFunctions') mergedEdges = edgeNamesOf(merged);
  }
  return { merged, needsPush };
}

/** Whether the stored copy of an item already is the merged one. */
export function sameBackendItem(kind: Kind, stored: Item, merged: Item, mergedSet: BackendFeatureSet, storedSet: BackendFeatureSet): boolean {
  if (stored.id !== merged.id) return false;
  if (kind === 'secrets' && (stored as Secret).value !== (merged as Secret).value) return false;
  if (kind === 'scheduledFunctions' && (stored as ScheduledFunction).functionId !== (merged as ScheduledFunction).functionId) return false;
  return fingerprint(kind, stored, edgeNamesOf(storedSet)) === fingerprint(kind, merged, edgeNamesOf(mergedSet));
}
