import type { Project, VirtualFile } from '../types';
import { isTextExtension } from '../types';
import { ArchiveError } from './text';
import { ARCHIVE_FORMAT_VERSION, type ProjectManifest } from './types';

/** Fixed key order — a manifest must serialize byte-identically for the same project state. */
const KEY_ORDER = [
  'formatVersion', 'name', 'description', 'runtime',
  'entryPoint', 'globalStyles', 'databaseSchema', 'encoding',
] as const satisfies readonly (keyof ProjectManifest)[];

/**
 * Adding a field to ProjectManifest without adding it to KEY_ORDER would drop it from every
 * archive while tsc stayed green — silent data loss in the file that defines the format. This
 * makes that a compile error instead: the alias resolves to `never` when a key is unlisted.
 */
type _KeyOrderIsExhaustive =
  Exclude<keyof ProjectManifest, (typeof KEY_ORDER)[number]> extends never ? true : never;
const _keyOrderIsExhaustive: _KeyOrderIsExhaustive = true;
void _keyOrderIsExhaustive;

export function buildManifest(project: Project, files: VirtualFile[]): ProjectManifest {
  const encoding: Record<string, 'text' | 'binary'> = {};
  for (const file of files) {
    // Derive from the content itself. file.type is path-derived (index.ts:982) and does not
    // describe the content: the same config.yaml is a string when the agent writes it and an
    // ArrayBuffer when uploaded through the explorer.
    const actual: 'text' | 'binary' = typeof file.content === 'string' ? 'text' : 'binary';
    const inferred: 'text' | 'binary' = isTextExtension(file.path) ? 'text' : 'binary';
    if (actual !== inferred) encoding[file.path] = actual;
  }

  const manifest: ProjectManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    name: project.name,
    description: project.description || undefined,
    runtime: project.settings?.runtime,
    entryPoint: project.settings?.previewEntryPoint,
    globalStyles: project.settings?.globalStyles,
    databaseSchema: project.settings?.databaseSchema,
    encoding: Object.keys(encoding).length > 0 ? sortKeys(encoding) : undefined,
  };
  return manifest;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

/**
 * Canonical form, whatever the input object looked like: fixed key order, sorted encoding map,
 * unknown keys dropped. Sorting here rather than only in buildManifest means a hand-edited
 * manifest that comes back through parseManifest re-serializes identically too.
 */
export function serializeManifest(manifest: ProjectManifest): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = manifest[key];
    if (value === undefined) continue;
    ordered[key] = key === 'encoding' ? sortKeys(value as Record<string, 'text' | 'binary'>) : value;
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

/**
 * `filename` only shapes the error messages. Export renames the manifest to `osw-project.json`
 * when the project owns `/project.json`, and an error naming the wrong file sends the user
 * looking at a file that is fine.
 */
export function parseManifest(text: string, filename = 'project.json'): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ArchiveError('manifestNotJson', { file: filename });
  }
  const data = raw as Partial<ProjectManifest>;
  if (typeof data?.formatVersion !== 'number' || typeof data?.name !== 'string') {
    throw new ArchiveError('manifestMissingFields', { file: filename });
  }
  if (data.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError('manifestNewer', { version: data.formatVersion });
  }
  return {
    formatVersion: data.formatVersion,
    name: data.name,
    description: data.description,
    runtime: data.runtime,
    entryPoint: data.entryPoint,
    globalStyles: data.globalStyles,
    databaseSchema: data.databaseSchema,
    encoding: data.encoding,
  };
}
