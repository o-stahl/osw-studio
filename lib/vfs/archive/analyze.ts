import { isTransientPath } from '../index';
import type { VirtualFileSystem } from '../index';
import type {
  BackendFeatures,
  EdgeFunction,
  Project,
  ScheduledFunction,
  ServerFunction,
  VirtualFile,
} from '../types';
import { FILE_SIZE_LIMITS, getFileTypeFromPath, isInjectedGeneratedFile } from '../types';
import {
  DEFAULT_METHOD,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TIMEZONE,
  SERVER_PREFIX,
  archiveFilesToBackend,
  keepBothBackendName,
  sortDeep,
} from './backend-files';
import { parseManifest } from './manifest';
import { keepBothPath, normalizeKey, validateArchivePath } from './paths';
import { ArchiveError, said } from './text';
import type {
  ArchiveEntry,
  ArchiveIssue,
  BackendConflict,
  FileConflict,
  ImportPlan,
  ImportTarget,
  ProjectManifest,
  SettingChange,
} from './types';

/**
 * Generated on export, so importing it would inject a doc into the project and break round-trip
 * idempotence. `/AGENTS.md` is deliberately absent: no root doc is generated, so a project's own
 * copy is ordinary content and imports like any other file.
 *
 * The manifest's own path joins this set at runtime, but only once a file at it has been read and
 * found to actually be a manifest — see `findManifest`.
 */
const SERVER_README = '/.server/README.md';

/**
 * The file the app feeds to the model as project instructions: `buildSystemPrompt` reads it and
 * appends its contents to the system prompt as domain instructions
 * (lib/llm/system-prompt.ts). An archive is untrusted third-party input, so an incoming copy is
 * not ordinary content — it changes what the agent does, and it replaces the project's own.
 */
const AI_INSTRUCTIONS_PATH = '/.PROMPT.md';

/**
 * Preferred first: export only falls back to the alternate name when the project owns
 * `/project.json`, and in that case `/project.json` is the project's own file.
 */
const MANIFEST_PATHS = ['/osw-project.json', '/project.json'] as const;

/**
 * A DOS date has 2-second resolution, so a file exported and re-read can appear up to two seconds
 * older than the record it came from. Without this slack every round-trip conflict would claim the
 * project's copy is newer.
 */
const TIMESTAMP_SLACK_MS = 2000;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * What importing this archive into this target *would* do.
 *
 * **Writes nothing.** Not a file, not a directory, not a backend record, not a setting. Everything
 * downstream — the preview dialog, the user's approval, apply — rests on that: a plan the user
 * approves must describe a change that has not happened yet. Every call here is a read
 * (`getProject`, `getAllFilesAndDirectories`, the adapter's `list*`), and the archive itself is
 * only ever `read()`.
 *
 * The second property it must hold is idempotence against its own export: analyzing a freshly
 * exported archive back against its own project puts every file in `unchanged`, with nothing
 * added, no conflicts, no setting changes and no errors. If that breaks, re-importing your own
 * archive rewrites your project for no reason.
 *
 * `readerIssues` are whatever the zip or folder reader had to refuse; they are the caller's to
 * pass on because the reader ran before this did.
 */
export async function analyzeImport(
  vfs: VirtualFileSystem,
  entries: ArchiveEntry[],
  target: ImportTarget,
  readerIssues: ArchiveIssue[] = []
): Promise<ImportPlan> {
  const errors: ArchiveIssue[] = [];
  const warnings: ArchiveIssue[] = [];
  const plan: ImportPlan = {
    format: 'loose-files',
    files: { added: [], conflicts: [], unchanged: [] },
    backend: {
      added: [],
      conflicts: [],
      unchanged: [],
      secretsAdded: [],
      secretsMetadataChanged: [],
    },
    settingChanges: [],
    errors,
    warnings,
    totals: { entries: 0, bytes: 0 },
  };

  // 0. The reader's refusals, folded in before anything can return. They are the only account of
  //    what the archive held and this layer never saw — a zip whose entries were all refused but
  //    one arrives here looking like a one-file archive, and the wrong-format verdict below is
  //    drawn from exactly that truncated list. Reporting the refusals is what lets the user tell
  //    "this is the wrong kind of file" from "most of this file could not be read".
  for (const issue of readerIssues) {
    (isWarning(issue) ? warnings : errors).push(issue);
  }

  // 1. Wrong formats leave early. Both are single-entry zips read by their own importers, and
  //    nothing here could do anything useful with the one file they hold.
  const wrongFormat = detectWrongFormat(entries);
  if (wrongFormat) {
    plan.format = wrongFormat.format;
    errors.push({ path: wrongFormat.path, code: 'validation-failed', ...said(wrongFormat.key) });
    return plan;
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  // 2. The manifest — identified by content, not by filename. Nothing reserves `/project.json`
  //    inside a project, so a dropped folder may carry an unrelated one, and a project that owns
  //    the path has to get it back on a round-trip.
  const found = await findManifest(byPath);
  if (found) {
    plan.format = 'archive';
    try {
      plan.manifest = parseManifest(found.text, found.path.slice(1));
    } catch (error) {
      // It says it is a manifest, so this is a real failure — most usefully a format version this
      // build cannot read. Degrade to loose files rather than abandoning the import: the files are
      // still importable without the settings.
      plan.format = 'loose-files';
      errors.push({
        path: found.path,
        code: 'invalid-json',
        message: error instanceof Error ? error.message : String(error),
        text: error instanceof ArchiveError ? error.text : undefined,
      });
    }
  }

  // 3. Split. Only the reserved paths are dropped from the incoming side — deliberately *not*
  //    generated build output, even though the current side has to filter it. The bundler's map is
  //    a session artifact, filled when a preview compiles, so filtering the archive against it
  //    would mean an incoming `bundle.js` imports or vanishes depending on whether the user
  //    happened to open the preview first. A file in the archive is content.
  const reserved = new Set([SERVER_README, ...(found ? [found.path] : [])]);
  const siteEntries: ArchiveEntry[] = [];
  const serverEntries: ArchiveEntry[] = [];
  for (const entry of entries) {
    // Reserved paths are the manifest and the generated `.server/README.md`: written by an export,
    // never imported, and absent from every tally. Counting them here would put a number in the
    // header that the tallies underneath can never add up to — the archive says six, the plan
    // accounts for five, and the difference is a file the user is not being shown.
    if (reserved.has(entry.path)) continue;
    plan.totals.entries += 1;
    if (entry.path.startsWith(SERVER_PREFIX)) {
      serverEntries.push(entry);
      continue;
    }
    // Every other transient namespace is refused rather than written. The test is
    // `isTransientPath`, the same predicate readFile screens with, so the two can never drift:
    // a path the VFS treats as in-memory but the adapter was made to hold is unreadable
    // afterwards — readFile short-circuits on the prefix, finds nothing mounted and throws for a
    // file the explorer still lists — and it survives into every later export. `/.server/` is the
    // one exception because the archive format defines it, and its unrecognized entries are
    // reported the same way a few steps below.
    if (isTransientPath(entry.path)) {
      warnings.push({
        path: entry.path,
        code: 'path-rejected',
        ...said('managedFolder', { path: entry.path }),
      });
      continue;
    }
    siteEntries.push(entry);
  }

  // A file the app reads as instructions to the model is not ordinary content, and it arrives in
  // `files.added` looking like one row among many. Say what it is before the user approves a count.
  const aiInstructions = siteEntries.find(
    (entry) => normalizeKey(entry.path) === AI_INSTRUCTIONS_PATH
  );
  if (aiInstructions) {
    warnings.push({
      path: aiInstructions.path,
      code: 'ai-instructions',
      ...said('aiInstructions', { path: AI_INSTRUCTIONS_PATH }),
    });
  }

  const project =
    target.kind === 'existing-project' ? await vfs.getProject(target.projectId) : undefined;
  const current = project ? await readCurrentFiles(vfs, project.id) : new Map<string, VirtualFile>();

  // Every path 'keep both' must avoid: what the project holds, and what this archive brings.
  const taken = new Set<string>([
    ...[...current.values()].map((file) => file.path),
    ...siteEntries.map((entry) => entry.path),
  ]);
  const classified = new Set<string>();

  for (const entry of siteEntries) {
    // 4. The per-file limit belongs here, not at apply time: createFile throws on an oversized
    //    file (index.ts:985), and by then the user has already approved a preview that promised
    //    it would work.
    const limit = FILE_SIZE_LIMITS[getFileTypeFromPath(entry.path)];
    if (entry.declaredSize !== undefined && entry.declaredSize > limit) {
      errors.push(tooLarge(entry.path, entry.declaredSize, limit));
      continue;
    }

    const key = normalizeKey(entry.path);
    const existing = current.get(key);
    // Only read when there is something to compare against, or when the size is unknown and the
    // bytes are the only way to learn it.
    const bytes =
      existing !== undefined || entry.declaredSize === undefined
        ? new Uint8Array(await entry.read())
        : undefined;
    const size = entry.declaredSize ?? bytes!.byteLength;
    plan.totals.bytes += size;
    if (size > limit) {
      errors.push(tooLarge(entry.path, size, limit));
      continue;
    }

    // Two entries can differ as strings and still name one file — '/café.txt' written NFD and NFC.
    // Storage would hold two; the machine that made the archive held one. Report the second rather
    // than letting it shadow the first's classification.
    if (classified.has(key)) {
      errors.push({
        path: entry.path,
        code: 'path-rejected',
        ...said('duplicateInArchive'),
      });
      continue;
    }
    classified.add(key);

    if (!existing) {
      plan.files.added.push(entry.path);
      continue;
    }

    // Paths that already exist are reported the way the *project* spells them, so apply updates
    // the file that is there instead of creating a second one in the archive's normalization.
    const currentBytes = toBytes(existing.content);
    if (sameBytes(currentBytes, bytes!)) {
      plan.files.unchanged.push(existing.path);
      continue;
    }
    plan.files.conflicts.push(
      buildConflict(existing, currentBytes.byteLength, bytes!.byteLength, entry.modifiedAt, taken)
    );
  }

  // 5. Settings. A new project has nothing to diff against — the manifest simply becomes the
  //    project's settings at creation time.
  if (project && plan.manifest) {
    plan.settingChanges = diffSettings(project, plan.manifest);
  }

  // 6. Backend features. Parsed here, written by nobody: `archiveFilesToBackend` returns records.
  const serverFiles = new Map<string, string>();
  for (const entry of serverEntries) {
    const bytes = await entry.read();
    plan.totals.bytes += entry.declaredSize ?? bytes.byteLength;
    serverFiles.set(entry.path, decoder.decode(bytes));
  }
  const { features, issues, claimedPaths } = archiveFilesToBackend(serverFiles);
  for (const issue of issues) {
    (isWarning(issue) ? warnings : errors).push(issue);
  }
  // Nothing routes a `/.server/` entry back into `plan.files`, so an entry the parser did not
  // recognize is dropped — and the generated README tells the user the files there are theirs to
  // edit. Name them rather than letting them disappear between the preview and the import.
  for (const entry of serverEntries) {
    if (claimedPaths.has(entry.path)) continue;
    warnings.push({
      path: entry.path,
      code: 'path-rejected',
      ...said('notBackendLayout', { path: entry.path }),
    });
  }
  await classifyBackend(vfs, project, features, plan);

  // 7. Browser mode. A warning rather than an error: the records live in IndexedDB in both modes,
  //    so they import and travel with the project — they just have nothing to run them yet.
  if (hasBackendFeatures(features) && process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    warnings.push({ code: 'server-mode-required', ...said('browserModeBackend') });
  }

  return plan;
}

/**
 * Codes that describe something carried across with a field dropped, rather than something left
 * out. `plan.errors` gates the confirm button, so putting one of these there would block an import
 * over a record that imported fine.
 */
const WARNING_CODES = new Set<ArchiveIssue['code']>(['unsupported-field', 'server-mode-required']);

function isWarning(issue: ArchiveIssue): boolean {
  return WARNING_CODES.has(issue.code);
}

/**
 * The archive's manifest, if it has one.
 *
 * A file is the manifest because of what is in it, not where it sits: `/project.json` is an
 * ordinary path that a project may own, and export moves its own manifest aside precisely so it
 * can. Reserving the path unconditionally would mean a project's `project.json` could never
 * round-trip, and that any folder carrying an unrelated one would raise an error the user has to
 * dismiss before importing.
 *
 * A file claiming `formatVersion` and `name` is ours even when `parseManifest` then rejects it —
 * an archive from a newer build says exactly that, and silently importing it as content would
 * apply a format this build cannot read.
 */
async function findManifest(
  byPath: Map<string, ArchiveEntry>
): Promise<{ path: string; text: string } | undefined> {
  for (const path of MANIFEST_PATHS) {
    const entry = byPath.get(path);
    if (!entry) continue;
    const bytes = await entry.read();
    // Deliberately uncharged. The manifest this returns is reserved and excluded from the totals,
    // and a candidate that turns out not to be a manifest falls through to the site loop, which
    // charges it there — counting it here too would bill the same file twice.
    const text = decoder.decode(bytes);
    if (claimsToBeAManifest(text)) return { path, text };
  }
  return undefined;
}

function claimsToBeAManifest(text: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const data = raw as Partial<ProjectManifest>;
  return typeof data.formatVersion === 'number' && typeof data.name === 'string';
}

/**
 * `.osws` and `.oswt` are zips holding exactly one file, which their own importers read whole
 * (`backup-service.ts:95`, `template-service.ts:138`). The single-entry test matters: a site folder
 * may perfectly well contain a `backup.json` of its own, and misreading that as a full backup would
 * leave the user unable to import their own project.
 */
function detectWrongFormat(
  entries: ArchiveEntry[]
): { format: 'osws-backup' | 'oswt-template'; path: string; key: 'isBackup' | 'isTemplate' } | undefined {
  if (entries.length !== 1) return undefined;
  if (entries[0].path === '/backup.json') {
    return {
      format: 'osws-backup',
      path: '/backup.json',
      key: 'isBackup',
    };
  }
  if (entries[0].path === '/template.json') {
    return {
      format: 'oswt-template',
      path: '/template.json',
      key: 'isTemplate',
    };
  }
  return undefined;
}

/**
 * The project's real files, keyed for normalization-insensitive matching.
 *
 * `getAllFilesAndDirectories` injects the bundler's generated files into its own results whatever
 * it was asked for (index.ts:1270), and those records are not in storage. Left in, an incoming
 * `bundle.js` would conflict with a file that does not exist, and apply would then `updateFile`
 * something there is nothing to update. `isInjectedGeneratedFile` screens the record rather than
 * the path, so a project that owns `/bundle.js` keeps its own file in the comparison.
 */
async function readCurrentFiles(
  vfs: VirtualFileSystem,
  projectId: string
): Promise<Map<string, VirtualFile>> {
  const items = await vfs.getAllFilesAndDirectories(projectId);
  // A type predicate, not a bare filter: the element type is a union and the narrowed half is the
  // only one with content to compare.
  const isFile = (item: (typeof items)[number]): item is VirtualFile => item.type !== 'directory';
  const map = new Map<string, VirtualFile>();
  for (const file of items) {
    if (!isFile(file) || isInjectedGeneratedFile(file)) continue;
    map.set(normalizeKey(file.path), file);
  }
  return map;
}

function buildConflict(
  existing: VirtualFile,
  currentSize: number,
  incomingSize: number,
  incomingModifiedAt: Date | undefined,
  taken: Set<string>
): FileConflict {
  const currentUpdatedAt = toDate(existing.updatedAt);
  const conflict: FileConflict = {
    path: existing.path,
    currentSize,
    incomingSize,
    currentUpdatedAt,
    incomingUpdatedAt: incomingModifiedAt,
    currentIsNewer:
      currentUpdatedAt !== undefined &&
      incomingModifiedAt !== undefined &&
      currentUpdatedAt.getTime() > incomingModifiedAt.getTime() + TIMESTAMP_SLACK_MS,
  };
  // keepBothPath mutates `taken`, and can still overflow the 200-character limit when the
  // directory and extension alone are near it. Offer the option only when it would actually work.
  const candidate = keepBothPath(existing.path, taken);
  if (validateArchivePath(candidate).ok) conflict.keepBothPath = candidate;
  return conflict;
}

function diffSettings(project: Project, manifest: ProjectManifest): SettingChange[] {
  const changes: SettingChange[] = [];
  const add = (key: SettingChange['key'], from: string | undefined, to: string | undefined) => {
    // An absent manifest field states nothing, so it changes nothing.
    if (to === undefined || from === to) return;
    changes.push({ key, from, to });
  };

  add('name', project.name, manifest.name);
  // buildManifest writes `description || undefined`, so an empty description round-trips as absent.
  add('description', project.description || undefined, manifest.description);
  add('runtime', project.settings?.runtime, manifest.runtime);
  add('entryPoint', project.settings?.previewEntryPoint, manifest.entryPoint);
  add('globalStyles', project.settings?.globalStyles, manifest.globalStyles);
  add('databaseSchema', project.settings?.databaseSchema, manifest.databaseSchema);
  return changes;
}

/**
 * Sort the parsed records into added / conflicting / unchanged against the project's own.
 *
 * Matched by name — that is the identity an archive can carry, since ids are per-installation —
 * but a matched pair is only a *conflict* once its contents differ. A name-only diff would list a
 * project's own export straight back at it as a screenful of conflicts, and 'keep both' on one of
 * those false conflicts duplicates the record: the option a user picks to be safe would be the one
 * that damages the project.
 */
async function classifyBackend(
  vfs: VirtualFileSystem,
  project: Project | undefined,
  features: BackendFeatures,
  plan: ImportPlan
): Promise<void> {
  const adapter = vfs.getStorageAdapter();
  const [edge, server, secrets, scheduled] = project
    ? await Promise.all([
        adapter.listEdgeFunctions ? adapter.listEdgeFunctions(project.id) : [],
        adapter.listServerFunctions ? adapter.listServerFunctions(project.id) : [],
        adapter.listSecrets ? adapter.listSecrets(project.id) : [],
        adapter.listScheduledFunctions ? adapter.listScheduledFunctions(project.id) : [],
      ])
    : [[] as EdgeFunction[], [], [], []];

  const existingEdge = new Map(edge.map((fn) => [fn.name, fn]));
  const existingServer = new Map(server.map((fn) => [fn.name, fn]));
  const existingScheduled = new Map(scheduled.map((job) => [job.name, job]));
  const existingSecrets = new Map(secrets.map((secret) => [secret.name, secret]));
  // A schedule stores its link by id and the archive stores it by name, so the two are only
  // comparable through the project's own edge functions.
  const edgeNameById = new Map(edge.map((fn) => [fn.id, fn.name]));

  /**
   * The names a 'keep both' rename has to avoid: the project's own, plus every name this archive
   * brings. Both halves are needed. Without the project's, the rename lands on the record it
   * exists to preserve; without the archive's, an archive carrying `send-email` *and*
   * `send-email-2` against a project holding `send-email` renames the first onto the second, and
   * apply then creates two records with one name — the adapter refuses the second with a
   * constraint error the user sees verbatim.
   *
   * `keepBothBackendName` mutates the set it is given, which is also what keeps two renames in one
   * import from colliding with each other.
   */
  const reserved = (existing: Map<string, unknown>, incoming: Array<{ name: string }>) =>
    new Set<string>([...existing.keys(), ...incoming.map((item) => item.name)]);
  const reservedEdge = reserved(existingEdge, features.edgeFunctions ?? []);
  const reservedServer = reserved(existingServer, features.serverFunctions ?? []);
  const reservedScheduled = reserved(existingScheduled, features.scheduledFunctions ?? []);

  /**
   * `existing` is the project's names and is never added to: whether a record is a conflict or an
   * addition is a fact about the *project*, and a set that grew as the archive was walked would
   * report the archive's own second record of a name as a conflict with a project that has no
   * backend features at all — a row saying "replacing a function cannot be undone" about nothing,
   * and a `(kind, name)` in both `added` and `conflicts` at once.
   *
   * Two archive records of one name can no longer reach here — `archiveFilesToBackend` drops the
   * second — and this is the other half of that: neither module may treat the archive as a source
   * of names the project holds.
   */
  const sort = (
    kind: BackendConflict['kind'],
    existing: Set<string>,
    reservedNames: Set<string>,
    name: string,
    detail: string,
    identical: boolean,
    disabled = false
  ) => {
    if (existing.has(name)) {
      if (identical) {
        plan.backend.unchanged.push({ kind, name });
        return;
      }
      plan.backend.conflicts.push({
        kind,
        name,
        detail,
        ...(disabled ? { disabled: true as const } : {}),
        keepBothName: keepBothBackendName(kind, name, reservedNames),
      });
      return;
    }
    plan.backend.added.push({ kind, name, detail, ...(disabled ? { disabled: true as const } : {}) });
  };

  const projectEdge = new Set(existingEdge.keys());
  const projectServer = new Set(existingServer.keys());
  const projectScheduled = new Set(existingScheduled.keys());

  for (const fn of features.edgeFunctions ?? []) {
    sort('edge', projectEdge, reservedEdge, fn.name, fn.method, sameEdge(existingEdge.get(fn.name), fn), fn.enabled === false);
  }
  for (const fn of features.serverFunctions ?? []) {
    // No method or schedule to show, so `detail` is empty and the dialog names it a helper.
    sort(
      'server',
      projectServer,
      reservedServer,
      fn.name,
      '',
      sameServer(existingServer.get(fn.name), fn),
      fn.enabled === false
    );
  }
  for (const job of features.scheduledFunctions ?? []) {
    const detail = `${job.cronExpression} · ${job.functionName}`;
    const identical = sameScheduled(existingScheduled.get(job.name), job, edgeNameById);
    sort('scheduled', projectScheduled, reservedScheduled, job.name, detail, identical);
  }
  for (const secret of features.secrets ?? []) {
    // Values are never in an archive and never touched by an import, so only the name and its
    // description are ever at stake. An identical description needs no write, so it goes in
    // neither list — the same "nothing to do" the unchanged bucket carries for functions.
    const existing = existingSecrets.get(secret.name);
    if (!existing) plan.backend.secretsAdded.push(secret.name);
    else if (blank(existing.description) !== blank(secret.description)) {
      plan.backend.secretsMetadataChanged.push(secret.name);
    }
  }
}

/**
 * Whether a stored record and an archived one hold the same thing.
 *
 * Only the fields the archive actually carries are compared — an id, a timestamp or a schedule's
 * last-run status differ on every round-trip and mean nothing here. Each stored field is put
 * through the same normalization `backendToArchiveFiles` applies on the way out, so "unchanged"
 * means precisely "exporting this again would produce these bytes".
 */
function sameEdge(
  existing: EdgeFunction | undefined,
  incoming: NonNullable<BackendFeatures['edgeFunctions']>[number]
): boolean {
  if (!existing) return false;
  return (
    (existing.code ?? '') === incoming.code &&
    (existing.method ?? DEFAULT_METHOD) === incoming.method &&
    (existing.enabled !== false) === (incoming.enabled !== false) &&
    (existing.timeoutMs ?? DEFAULT_TIMEOUT_MS) === (incoming.timeoutMs ?? DEFAULT_TIMEOUT_MS) &&
    blank(existing.description) === blank(incoming.description)
  );
}

function sameServer(
  existing: ServerFunction | undefined,
  incoming: NonNullable<BackendFeatures['serverFunctions']>[number]
): boolean {
  if (!existing) return false;
  return (
    (existing.code ?? '') === incoming.code &&
    (existing.enabled !== false) === (incoming.enabled !== false) &&
    blank(existing.description) === blank(incoming.description)
  );
}

function sameScheduled(
  existing: ScheduledFunction | undefined,
  incoming: NonNullable<BackendFeatures['scheduledFunctions']>[number],
  edgeNameById: Map<string, string>
): boolean {
  if (!existing) return false;
  // An unresolvable link is not "the same link": the export path drops such a schedule entirely
  // (backend-files.ts:157), so there is nothing it could be identical to.
  const existingFunctionName = edgeNameById.get(existing.functionId);
  return (
    existingFunctionName !== undefined &&
    existingFunctionName === incoming.functionName &&
    existing.cronExpression === incoming.cronExpression &&
    (existing.timezone || DEFAULT_TIMEZONE) === (incoming.timezone || DEFAULT_TIMEZONE) &&
    (existing.enabled !== false) === (incoming.enabled !== false) &&
    canonical(existing.config ?? {}) === canonical(incoming.config ?? {}) &&
    blank(existing.description) === blank(incoming.description)
  );
}

/** An empty description and an absent one are the same state; export writes both as absent. */
function blank(value: string | undefined): string {
  return value || '';
}

/** Key order is not part of a config's state, so it must not be part of the comparison either. */
function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function hasBackendFeatures(features: BackendFeatures): boolean {
  return (
    (features.edgeFunctions?.length ?? 0) > 0 ||
    (features.serverFunctions?.length ?? 0) > 0 ||
    (features.secrets?.length ?? 0) > 0 ||
    (features.scheduledFunctions?.length ?? 0) > 0
  );
}

function tooLarge(path: string, size: number, limit: number): ArchiveIssue {
  return {
    path,
    code: 'too-large',
    ...said('fileTooLarge', { path, size: Math.round(size / 1024 / 1024), limit: Math.round(limit / 1024 / 1024) }),
  };
}

/**
 * Stored content is a string or an ArrayBuffer depending on how the file was created — the agent
 * writes strings, an upload writes bytes — so both sides have to become bytes before they can be
 * compared, or the same file reads as a difference.
 */
function toBytes(content: VirtualFile['content']): Uint8Array {
  const raw: unknown = content;
  if (typeof raw === 'string') return encoder.encode(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return new Uint8Array(raw as ArrayBuffer);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** File records are not hydrated out of IndexedDB, so a timestamp can arrive as a string. */
function toDate(value: Date | string | number | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
