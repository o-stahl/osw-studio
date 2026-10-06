import JSZip from 'jszip';
import type { VirtualFileSystem } from '../index';
import { isInjectedGeneratedFile, type VirtualFile } from '../types';
import { backendToArchiveFiles, type BackendSource } from './backend-files';
import { SERVER_README_MD } from './docs';
import { buildManifest, serializeManifest } from './manifest';
import { keepBothPath } from './paths';
import { said } from './text';
import type { ArchiveIssue } from './types';

/** Where the manifest goes, unless the project already owns that path. */
const MANIFEST_PATH = 'project.json';
/** The fallback, chosen so `import` can accept either name without guessing. */
const ALTERNATE_MANIFEST_PATH = 'osw-project.json';

/**
 * Last resort for an entry's timestamp, used only when neither the file nor the project has a
 * usable one. A zip stores DOS dates, which start at 1980 and cannot represent anything earlier.
 */
const FALLBACK_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1));

export interface ArchiveExportResult {
  blob: Blob;
  /** Anything that could not be carried into the archive. Empty on a clean export. */
  warnings: ArchiveIssue[];
}

/**
 * A project as a browsable zip: real files at real paths, backend features as editable source,
 * and a manifest holding the settings that are not files.
 *
 * Deliberately not `exportProjectAsZip` (index.ts): that one compiles the project for deployment
 * and drops every dot-prefixed path. This one is the round-trip format, so `.PROMPT.md` and its
 * neighbours are part of the payload.
 *
 * The same project state must produce the same bytes, so entries are added in sorted order and
 * nothing interpolates a date, a count or an id.
 */
export async function exportProjectArchive(
  vfs: VirtualFileSystem,
  projectId: string
): Promise<ArchiveExportResult> {
  const warnings: ArchiveIssue[] = [];
  const project = await vfs.getProject(projectId);

  // Without includeTransient the `/.skills/` and `/.server/` mounts stay out — the archive writes
  // its own `/.server/` from storage, and a mounted copy would fight with it.
  const items = await vfs.getAllFilesAndDirectories(projectId);
  const isFile = (item: (typeof items)[number]): item is VirtualFile => item.type !== 'directory';
  // getAllFilesAndDirectories injects generated files regardless of options (index.ts:1270-1278),
  // and build output does not belong in a source archive. Screened by record rather than by path:
  // a project that owns /bundle.js gets its own file back, not the bundler's.
  const files = items
    .filter(isFile)
    .filter((file) => !isInjectedGeneratedFile(file))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Entries generated here have no timestamp of their own, so they take the project's. Anything
  // clock-derived would put the download time into the zip headers and make the container bytes
  // differ between two exports of identical state.
  const generatedDate = zipDate(project.updatedAt);

  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path.slice(1), file.content, { date: zipDate(file.updatedAt, project.updatedAt) });
  }

  const backendFiles = backendToArchiveFiles(await readBackendFeatures(vfs, projectId), warnings);
  for (const file of backendFiles) {
    // Backend features are rendered here rather than stored as files, so they have no mtime of
    // their own either — and their content is derived from project state, so the project's fits.
    zip.file(file.path.slice(1), file.content, { date: generatedDate });
  }
  if (backendFiles.length > 0) {
    // No collision check: createFile rejects any `/.server/` path that is not a .json
    // (index.ts:547), so a project can never hold a real file here.
    zip.file('.server/README.md', SERVER_README_MD, { date: generatedDate });
  }

  // Nothing reserves either manifest name in a project, and JSZip.file() overwrites in silence —
  // and the manifest is written after the file loop, so it would win. Both names have to be
  // checked: a project owning only /project.json is handled by the fallback, but one owning both
  // would lose its /osw-project.json without a word.
  const ownedPaths = new Set(files.map((file) => file.path));
  const manifestPath = pickManifestPath(ownedPaths, warnings);
  // Read through the accessor rather than off the record: a project created before the schema
  // moved onto the project still holds it in localStorage, and buildManifest reading the record
  // directly would download that project without its schema and never migrate it.
  const { getProjectSchema } = await import('../project-schema');
  const databaseSchema = (await getProjectSchema(projectId, vfs)) || undefined;
  const manifestSource = { ...project, settings: { ...project.settings, databaseSchema } };
  zip.file(manifestPath, serializeManifest(buildManifest(manifestSource, files)), {
    date: generatedDate,
  });

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { blob, warnings };
}

/**
 * A name for the manifest that no file in the project already holds.
 *
 * Import looks for the manifest under the two known names only, so the third name is a file the
 * archive can still be imported *from* — its settings simply arrive as content instead of as
 * settings. That is the lesser loss: the alternative is deleting a file the user wrote.
 */
function pickManifestPath(ownedPaths: Set<string>, warnings: ArchiveIssue[]): string {
  for (const candidate of [MANIFEST_PATH, ALTERNATE_MANIFEST_PATH]) {
    if (!ownedPaths.has(`/${candidate}`)) return candidate;
  }
  // A copy: keepBothPath mutates the set it is given, and this one is the project's file list.
  const fallback = keepBothPath(`/${ALTERNATE_MANIFEST_PATH}`, new Set(ownedPaths)).slice(1);
  warnings.push({
    path: `/${fallback}`,
    code: 'path-rejected',
    ...said('manifestRelocated', { manifest: MANIFEST_PATH, alternate: ALTERNATE_MANIFEST_PATH, fallback }),
  });
  return fallback;
}

/**
 * First usable timestamp among the candidates, falling back to a fixed constant.
 *
 * Every `zip.file` call has to pass one: JSZip defaults to `new Date()`, so an `undefined` slipping
 * through would put the download time into that entry's header and quietly cost the format its
 * determinism. A record restored from IndexedDB can carry a missing or serialized date, hence the
 * coercion rather than a bare instanceof.
 */
function zipDate(...candidates: Array<Date | string | number | undefined>): Date {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const date = candidate instanceof Date ? candidate : new Date(candidate);
    // A DOS date cannot go below 1980, and a pre-1980 value writes a nonsense header rather than
    // failing, so it is treated as unusable alongside NaN.
    if (!Number.isNaN(date.getTime()) && date.getTime() >= FALLBACK_ENTRY_DATE.getTime()) return date;
  }
  return FALLBACK_ENTRY_DATE;
}

/** Every list method is optional on StorageAdapter, so each one is guarded separately. */
async function readBackendFeatures(
  vfs: VirtualFileSystem,
  projectId: string
): Promise<BackendSource> {
  const adapter = vfs.getStorageAdapter();
  const [edgeFunctions, serverFunctions, secrets, scheduledFunctions] = await Promise.all([
    adapter.listEdgeFunctions ? adapter.listEdgeFunctions(projectId) : [],
    adapter.listServerFunctions ? adapter.listServerFunctions(projectId) : [],
    adapter.listSecrets ? adapter.listSecrets(projectId) : [],
    adapter.listScheduledFunctions ? adapter.listScheduledFunctions(projectId) : [],
  ]);
  return { edgeFunctions, serverFunctions, secrets, scheduledFunctions };
}
