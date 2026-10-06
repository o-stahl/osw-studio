import { v4 as uuidv4 } from 'uuid';
import { translator } from '@/lib/i18n/runtime';
import { RUNTIME_CONFIGS } from '../../runtimes/registry';
import type { VirtualFileSystem } from '../index';
import { checkpointManager } from '../checkpoint';
import { saveManager } from '../save-manager';
import type { BackendFeatures, EdgeFunction, Project, ProjectRuntime } from '../types';
import { isTextExtension } from '../types';
import {
  validateEdgeFunctionData,
  validateScheduledFunctionData,
  validateSecretData,
  validateServerFunctionData,
} from '../server-context/generators';
import {
  DEFAULT_METHOD,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TIMEZONE,
  EDGE_DIR,
  SCHEDULED_PATH,
  SECRETS_PATH,
  SERVER_DIR,
  SERVER_PREFIX,
  archiveFilesToBackend,
  type BackendNameKind,
} from './backend-files';
import { normalizeKey } from './paths';
import { ensureAncestorDirs } from './read-folder';
import { ArchiveError, said } from './text';
import type {
  ApplyResult,
  ArchiveEntry,
  BackendConflict,
  FileResolution,
  ImportPlan,
  ImportResolutions,
  ImportTarget,
  ProjectManifest,
  SettingChange,
} from './types';

/** Where a settings failure is reported. The manifest is the archive's file, not the project's. */
const MANIFEST_LABEL = 'project.json';

const decoder = new TextDecoder();

const KNOWN_RUNTIMES = new Set<string>(RUNTIME_CONFIGS.map((config) => config.id));

/** Secrets have no `keepBothName`, so they need a kind of their own to key a resolution by. */
export type BackendResolutionKind = BackendConflict['kind'] | 'secret';

/**
 * The key a backend resolution is recorded under.
 *
 * Name alone will not do: edge functions and scheduled functions share one name grammar
 * (lowercase and hyphens), so a project holding an edge function and a schedule both called
 * 'nightly' would have one key deciding both — and 'keep mine' on the schedule would quietly
 * spare the edge function the replacement the user asked for.
 */
export function backendResolutionKey(kind: BackendResolutionKind, name: string): string {
  return `${kind}:${name}`;
}

/** What apply will do with one record, once the plan and the resolution are combined. */
type BackendAction =
  | { action: 'skip' }
  | { action: 'create'; name: string }
  | { action: 'update'; name: string };

interface FileWrite {
  /** The path the plan reports, which is how the archive entry is found. */
  planPath: string;
  /** Where it lands — the same path, or the keep-both rename. */
  targetPath: string;
  mode: 'create' | 'update';
}

/**
 * Carry out a plan the user has approved.
 *
 * Three properties hold whatever the archive contains:
 *
 * 1. **Nothing outside the plan is written.** Every write comes from `plan.files.added`,
 *    `plan.files.conflicts`, `plan.settingChanges` or the backend buckets. An entry the analyzer
 *    refused is still in `entries` — apply never looks at it. A record the *project* has and the
 *    archive does not is in none of the buckets and is left exactly alone: an import populates,
 *    it never reconciles deletions.
 *
 * 2. **Nothing is deleted, and nothing is deleted-then-created.** A failed re-create after a
 *    delete would lose the original, and no outcome here is worth that trade; 'keep both' writes
 *    a second path rather than moving the first.
 *
 * 3. **One failure does not cost the rest of the import.** Each write is wrapped, the failure is
 *    tallied into `result.failed` with its reason, and the loop continues — matching the folder
 *    drop and `skills/service.ts`, not the abort-on-first-error of `.osws`/`.oswt`. What comes
 *    back is a report against the plan the user approved: what applied, what did not, and why.
 *
 * The one thing that *is* fatal is a failed checkpoint on an existing project (below).
 *
 * **What the checkpoint does and does not cover.** `restoreCheckpoint` restores files and
 * directories, and the backend records and covered settings too
 * (`lib/vfs/checkpoint-backend.ts`), so an import is one undo. The exception is a secret's stored
 * value, which a checkpoint deliberately never holds: replacing a secret is the one write here
 * that cannot be undone. That, plus the fact that an archive carries no old code either, is why
 * nothing replaces a record the user did not explicitly resolve to 'replace', and why 'keep both'
 * writes a second record instead.
 *
 * Backend features are written through the storage adapter and never through the `/.server/`
 * mount: `mountProjectBackendContext` returns immediately unless `NEXT_PUBLIC_SERVER_MODE` is
 * 'true' (index.ts:236), which is the default deployment mode, so a mount-based write throws for
 * most users. Bypassing the mount also bypasses its validation, so every record goes through the
 * same exported validator the mount would have used before it reaches storage.
 */
export async function applyImport(
  vfs: VirtualFileSystem,
  plan: ImportPlan,
  resolutions: ImportResolutions,
  entries: ArchiveEntry[],
  target: ImportTarget,
  onProgress?: (done: number, total: number) => void
): Promise<ApplyResult> {
  const result: ApplyResult = {
    projectId: target.kind === 'existing-project' ? target.projectId : '',
    applied: { files: 0, backend: 0, settings: 0 },
    failed: [],
  };

  let projectId: string;
  if (target.kind === 'existing-project') {
    projectId = target.projectId;
    // Throws on a missing project, which is the right moment for it: nothing has been written.
    const project = await vfs.getProject(projectId);
    // This is the only import in the app that can overwrite a project someone is working in, and
    // the checkpoint is what makes the whole import one undo. A failure here is fatal on purpose:
    // proceeding would leave the user with an overwrite and no way back, which is worse than an
    // import that never started.
    const checkpoint = await checkpointManager.createCheckpoint(
      projectId,
      `Before import: ${plan.manifest?.name ?? project.name}`, // i18n-ignore: stored English; the panel shows `label`
      { kind: 'manual', label: { key: 'beforeImport', values: { name: plan.manifest?.name ?? project.name } } }
    );
    result.checkpointId = checkpoint.id;
  } else {
    projectId = await createProjectFromManifest(vfs, plan.manifest, result);
  }
  result.projectId = projectId;

  const entryByKey = buildEntryIndex(entries);
  const encoding = buildEncodingIndex(plan.manifest);
  const writes = planFileWrites(plan, resolutions, result);
  // Parsed before the first write so the progress total is honest, and so a malformed `/.server/`
  // file is reported as part of the same run rather than after everything else has landed.
  const features = await readBackendFeatures(entries, result);

  const total = writes.length + countBackendWrites(plan, resolutions, features);
  let done = 0;
  const step = () => onProgress?.(++done, total);

  await saveManager.runWithSuppressedDirty(projectId, async () => {
    for (const write of writes) {
      try {
        const entry = entryByKey.get(normalizeKey(write.planPath));
        if (!entry) {
          // Only reachable when the plan and the entries came from different reads.
          throw new Error('The archive no longer holds a file at this path.');
        }
        const content = decodeContent(await entry.read(), write.planPath, encoding);
        // createFile only creates the immediate parent (index.ts:2048), which leaves gaps for
        // anything nested deeper than one directory.
        await ensureAncestorDirs(projectId, write.targetPath, { silent: true });
        if (write.mode === 'create') {
          await vfs.createFile(projectId, write.targetPath, content, { silent: true });
        } else {
          await vfs.updateFile(projectId, write.targetPath, content, { silent: true });
        }
        result.applied.files += 1;
      } catch (error) {
        result.failed.push(failure(write.targetPath, error));
      }
      step();
    }
  });

  if (target.kind === 'existing-project') {
    await applySettingChanges(vfs, projectId, plan, resolutions, result);
  }

  await applyBackend(vfs, projectId, plan, resolutions, features, result, step);

  if (result.applied.files > 0 && typeof window !== 'undefined') {
    // One event for the whole import. The writes above are silent so a large archive does not
    // trigger a reload per file — the same shape as restoreCheckpoint (checkpoint.ts:498).
    window.dispatchEvent(new Event('filesChanged'));
  }

  // Dirty was suppressed so the flag would not flap once per file, but an import into an existing
  // project *is* an unsaved change, and the workspace's "Discard changes" is what takes the user
  // back to their last save. A new project follows importProject and stays clean.
  if (target.kind === 'existing-project' && didWrite(result)) {
    saveManager.markDirty(projectId);
  }

  vfs.scheduleAutoSync(projectId);
  return result;
}

function didWrite(result: ApplyResult): boolean {
  return result.applied.files + result.applied.backend + result.applied.settings > 0;
}

/**
 * A new project takes the manifest wholesale: there is nothing to diff against, which is why
 * `plan.settingChanges` is empty for this target.
 */
async function createProjectFromManifest(
  vfs: VirtualFileSystem,
  manifest: ProjectManifest | undefined,
  result: ApplyResult
): Promise<string> {
  // A folder of loose files carries no manifest and still has to become a project.
  const project = await vfs.createProject(manifest?.name ?? translator()('importDialog.importedProject'), manifest?.description);
  if (!manifest) return project.id;

  let applied = 1; // the name
  if (manifest.description !== undefined) applied += 1;
  const settings = project.settings ?? {};
  if (manifest.runtime !== undefined) {
    if (isKnownRuntime(manifest.runtime)) {
      settings.runtime = manifest.runtime;
      applied += 1;
    } else {
      result.failed.push({ path: MANIFEST_LABEL, ...said('unknownRuntime', { value: manifest.runtime }) });
    }
  }
  if (manifest.entryPoint !== undefined) {
    settings.previewEntryPoint = manifest.entryPoint;
    applied += 1;
  }
  if (manifest.globalStyles !== undefined) {
    settings.globalStyles = manifest.globalStyles;
    applied += 1;
  }
  if (manifest.databaseSchema !== undefined) {
    // Stored only. The DDL is executed against the project database by the Schema tab's
    // auto-apply, which is Server Mode's job and needs the database to exist first.
    settings.databaseSchema = manifest.databaseSchema;
    applied += 1;
  }
  project.settings = settings;
  await vfs.updateProject(project);
  result.applied.settings += applied;
  return project.id;
}

/**
 * Entries keyed for normalization-insensitive lookup.
 *
 * The analyzer spells a matched file the way the *project* does and a new one the way the archive
 * does, and the two differ whenever a name is written NFD in one place and NFC in the other. A
 * plain lookup misses exactly those files; writing the archive's spelling instead would create a
 * duplicate beside the file it meant to replace.
 *
 * First entry wins, matching the analyzer, which classifies the first and reports the rest as a
 * duplicate path.
 */
function buildEntryIndex(entries: ArchiveEntry[]): Map<string, ArchiveEntry> {
  const index = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    const key = normalizeKey(entry.path);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

function buildEncodingIndex(manifest: ProjectManifest | undefined): Map<string, 'text' | 'binary'> {
  const index = new Map<string, 'text' | 'binary'>();
  for (const [path, shape] of Object.entries(manifest?.encoding ?? {})) {
    index.set(normalizeKey(path), shape);
  }
  return index;
}

/**
 * Text or bytes. The manifest lists only the files whose stored shape disagrees with what their
 * extension implies, so everything absent from it is inferred the way the app infers it.
 */
function decodeContent(
  buffer: ArrayBuffer,
  path: string,
  encoding: Map<string, 'text' | 'binary'>
): string | ArrayBuffer {
  const shape = encoding.get(normalizeKey(path)) ?? (isTextExtension(path) ? 'text' : 'binary');
  return shape === 'text' ? decoder.decode(buffer) : buffer;
}

/**
 * The file writes the plan and the resolutions between them authorize — nothing else.
 *
 * A conflict with no recorded resolution is kept, not replaced: a decision the user never made is
 * not consent to overwrite their file.
 */
function planFileWrites(
  plan: ImportPlan,
  resolutions: ImportResolutions,
  result: ApplyResult
): FileWrite[] {
  const writes: FileWrite[] = [];
  for (const path of plan.files.added) {
    writes.push({ planPath: path, targetPath: path, mode: 'create' });
  }
  for (const conflict of plan.files.conflicts) {
    const resolution = fileResolution(resolutions, conflict.path);
    if (resolution === 'keep-mine') continue;
    if (resolution === 'replace') {
      writes.push({ planPath: conflict.path, targetPath: conflict.path, mode: 'update' });
      continue;
    }
    if (!conflict.keepBothPath) {
      // The analyzer omits it when no candidate fits the 200-character limit, and the dialog does
      // not offer the option for such a row. Report it rather than falling back to replace.
      result.failed.push({
        path: conflict.path,
        ...said('keepBothTooLong'),
      });
      continue;
    }
    writes.push({ planPath: conflict.path, targetPath: conflict.keepBothPath, mode: 'create' });
  }
  return writes;
}

function fileResolution(resolutions: ImportResolutions, path: string): FileResolution {
  return resolutions.files[path] ?? resolutions.files[normalizeKey(path)] ?? 'keep-mine';
}

/**
 * The archive's backend records, re-derived from the entries: the plan carries names and a
 * one-line detail, not code, so apply has to parse them again.
 *
 * `archiveFilesToBackend` validates every record it composes and drops the ones that fail. Those
 * are already in `plan.errors`, and they belong in `failed` too — from apply's side they are
 * precisely the part of the approved plan that did not happen.
 *
 * `unsupported-field` is the exception: it means the record *was* composed and only a field the
 * format cannot carry was dropped, so the record goes on to import. Counting it as failed would
 * report a record that applied as one that did not. The analyzer already put it in `plan.warnings`,
 * where the user saw it before approving.
 */
async function readBackendFeatures(
  entries: ArchiveEntry[],
  result: ApplyResult
): Promise<BackendFeatures> {
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.path.startsWith(SERVER_PREFIX)) continue;
    try {
      files.set(entry.path, decoder.decode(await entry.read()));
    } catch (error) {
      result.failed.push(failure(entry.path, error));
    }
  }
  const { features, issues } = archiveFilesToBackend(files);
  for (const issue of issues) {
    if (issue.code === 'unsupported-field') continue;
    result.failed.push({ path: issue.path ?? SERVER_PREFIX, message: issue.message, text: issue.text });
  }
  return features;
}

/** How many backend writes will be attempted, for the progress total. */
function countBackendWrites(
  plan: ImportPlan,
  resolutions: ImportResolutions,
  features: BackendFeatures
): number {
  let count = 0;
  for (const fn of features.edgeFunctions ?? []) {
    if (backendAction(plan, resolutions, 'edge', fn.name).action !== 'skip') count += 1;
  }
  for (const fn of features.serverFunctions ?? []) {
    if (backendAction(plan, resolutions, 'server', fn.name).action !== 'skip') count += 1;
  }
  for (const secret of features.secrets ?? []) {
    if (secretAction(plan, secret.name).action !== 'skip') count += 1;
  }
  for (const job of features.scheduledFunctions ?? []) {
    if (backendAction(plan, resolutions, 'scheduled', job.name).action !== 'skip') count += 1;
  }
  return count;
}

/**
 * What the plan says to do with one function-shaped record.
 *
 * A name in none of `added`, `conflicts` or `unchanged` belongs to the project and not the
 * archive — leave it alone. So does an `unchanged` one, which by definition needs no write.
 */
function backendAction(
  plan: ImportPlan,
  resolutions: ImportResolutions,
  kind: BackendConflict['kind'],
  name: string
): BackendAction {
  if (plan.backend.added.some((item) => item.kind === kind && item.name === name)) {
    return { action: 'create', name };
  }
  const conflict = plan.backend.conflicts.find((item) => item.kind === kind && item.name === name);
  if (!conflict) return { action: 'skip' };
  const resolution = resolutions.backend[backendResolutionKey(kind, name)] ?? 'keep-mine';
  if (resolution === 'keep-mine') return { action: 'skip' };
  if (resolution === 'replace') return { action: 'update', name };
  return { action: 'create', name: conflict.keepBothName };
}

/**
 * A secret is only ever created, never updated.
 *
 * A value is never in an archive, so the only thing that can differ is the description — and the
 * preview says plainly that the project keeps its own. There is no resolution to read: nothing
 * offers the choice, so nothing writes one.
 */
function secretAction(plan: ImportPlan, name: string): BackendAction {
  return plan.backend.secretsAdded.includes(name)
    ? { action: 'create', name }
    : { action: 'skip' };
}

async function applySettingChanges(
  vfs: VirtualFileSystem,
  projectId: string,
  plan: ImportPlan,
  resolutions: ImportResolutions,
  result: ApplyResult
): Promise<void> {
  const wanted = plan.settingChanges.filter(
    (change) => (resolutions.settings[change.key] ?? 'keep-current') === 'use-archive'
  );
  if (wanted.length === 0) return;

  try {
    const project = await vfs.getProject(projectId);
    project.settings = project.settings ?? {};
    let applied = 0;
    for (const change of wanted) {
      if (applySetting(project, change, result)) applied += 1;
    }
    if (applied === 0) return;
    await vfs.updateProject(project);
    result.applied.settings += applied;
  } catch (error) {
    result.failed.push(failure(MANIFEST_LABEL, error));
  }
}

/**
 * A manifest is a hand-editable text file, so its values are input rather than state. A runtime
 * the app does not have would leave the project unable to preview, and a project that cannot
 * preview is hard to get back from even with the import's checkpoint in hand, so it is refused
 * rather than written.
 */
function applySetting(project: Project, change: SettingChange, result: ApplyResult): boolean {
  switch (change.key) {
    case 'name':
      project.name = change.to;
      return true;
    case 'description':
      project.description = change.to;
      return true;
    case 'entryPoint':
      project.settings.previewEntryPoint = change.to;
      return true;
    case 'globalStyles':
      project.settings.globalStyles = change.to;
      return true;
    case 'databaseSchema':
      project.settings.databaseSchema = change.to;
      return true;
    case 'runtime':
      if (!isKnownRuntime(change.to)) {
        result.failed.push({ path: MANIFEST_LABEL, ...said('unknownRuntime', { value: change.to }) });
        return false;
      }
      project.settings.runtime = change.to;
      return true;
  }
}

function isKnownRuntime(value: string): value is ProjectRuntime {
  return KNOWN_RUNTIMES.has(value);
}

/**
 * Backend records, in the one order that works: **edge functions → server functions → secrets →
 * scheduled functions.** A schedule carries `functionName` in the archive and `functionId` in the
 * record, so the edge function it points at has to exist before the name can resolve. A name that
 * still does not resolve is a `failed` entry, not a throw — the rest of the import is not the
 * schedule's to cancel.
 */
async function applyBackend(
  vfs: VirtualFileSystem,
  projectId: string,
  plan: ImportPlan,
  resolutions: ImportResolutions,
  features: BackendFeatures,
  result: ApplyResult,
  step: () => void
): Promise<void> {
  const adapter = vfs.getStorageAdapter();
  const now = new Date();

  /**
   * The archive's name for an edge function → the name it was actually stored under.
   *
   * 'Keep both' stores the archive's `send-email` as `send-email-2` and leaves the project's own
   * `send-email` alone, so a schedule that names `send-email` must not be resolved against the
   * project's map: that map holds both names and would hand back the *project's* function, wiring
   * the imported schedule to code the archive never carried. Recorded for every non-skipped
   * decision, including ones whose write then fails — a rename that did not land must surface as
   * an unresolvable link, not fall back to the record it was renamed to avoid.
   *
   * A skipped ('keep mine') function is deliberately absent: its schedule should link to the
   * project's existing function of that name, which is what the fallback below does.
   */
  const storedEdgeName = new Map<string, string>();

  for (const fn of features.edgeFunctions ?? []) {
    const decision = backendAction(plan, resolutions, 'edge', fn.name);
    if (decision.action === 'skip') continue;
    storedEdgeName.set(fn.name, decision.name);
    try {
      const fields = {
        name: decision.name,
        description: fn.description,
        code: fn.code,
        method: fn.method ?? DEFAULT_METHOD,
        enabled: fn.enabled ?? true,
        timeoutMs: fn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      };
      // The mount would have validated; writing through the adapter means validating here. The
      // 'keep both' rename goes through it too — a renamed record still has to satisfy the name
      // grammar its kind is stored under.
      requireValid(validateEdgeFunctionData(fields), 'edge', decision.name);

      if (decision.action === 'create') {
        const create = required(adapter.createEdgeFunction, 'edge');
        await create.call(adapter, { ...fields, id: uuidv4(), projectId, createdAt: now, updatedAt: now });
      } else {
        const list = required(adapter.listEdgeFunctions, 'edge');
        const existing = pick(await list.call(adapter, projectId), decision.name);
        const update = required(adapter.updateEdgeFunction, 'edge');
        await update.call(adapter, { ...existing, ...fields, updatedAt: now });
      }
      result.applied.backend += 1;
    } catch (error) {
      result.failed.push(failure(`${EDGE_DIR}${fn.name}.js`, error));
    }
    step();
  }

  for (const fn of features.serverFunctions ?? []) {
    const decision = backendAction(plan, resolutions, 'server', fn.name);
    if (decision.action === 'skip') continue;
    try {
      const fields = {
        name: decision.name,
        description: fn.description,
        code: fn.code,
        enabled: fn.enabled ?? true,
      };
      requireValid(validateServerFunctionData(fields), 'server', decision.name);

      if (decision.action === 'create') {
        const create = required(adapter.createServerFunction, 'server');
        await create.call(adapter, { ...fields, id: uuidv4(), projectId, createdAt: now, updatedAt: now });
      } else {
        const list = required(adapter.listServerFunctions, 'server');
        const existing = pick(await list.call(adapter, projectId), decision.name);
        const update = required(adapter.updateServerFunction, 'server');
        await update.call(adapter, { ...existing, ...fields, updatedAt: now });
      }
      result.applied.backend += 1;
    } catch (error) {
      result.failed.push(failure(`${SERVER_DIR}${fn.name}.js`, error));
    }
    step();
  }

  for (const secret of features.secrets ?? []) {
    const decision = secretAction(plan, secret.name);
    if (decision.action === 'skip') continue;
    try {
      requireValid(
        validateSecretData({ name: decision.name, description: secret.description }),
        'secret',
        decision.name
      );

      if (decision.action === 'create') {
        const create = required(adapter.createSecret, 'secret');
        await create.call(adapter, {
          name: decision.name,
          description: secret.description,
          id: uuidv4(),
          projectId,
          // An archive never carries a value, so a new secret is a placeholder to be filled in.
          hasValue: false,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const list = required(adapter.listSecrets, 'secret');
        const existing = pick(await list.call(adapter, projectId), decision.name);
        const update = required(adapter.updateSecret, 'secret');
        // The stored record is spread first and only the description is set: `value` and
        // `hasValue` are never touched, because the archive has nothing to say about them and
        // overwriting them would destroy a credential that exists nowhere else.
        await update.call(adapter, { ...existing, description: secret.description, updatedAt: now });
      }
      result.applied.backend += 1;
    } catch (error) {
      result.failed.push(failure(SECRETS_PATH, error));
    }
    step();
  }

  // Read after the edge functions have been written, so a schedule can point at one this very
  // import created.
  const edgeByName = new Map<string, EdgeFunction>();
  if (adapter.listEdgeFunctions) {
    for (const fn of await adapter.listEdgeFunctions(projectId)) edgeByName.set(fn.name, fn);
  }

  for (const job of features.scheduledFunctions ?? []) {
    const decision = backendAction(plan, resolutions, 'scheduled', job.name);
    if (decision.action === 'skip') continue;
    try {
      const fields = {
        name: decision.name,
        description: job.description,
        cronExpression: job.cronExpression,
        timezone: job.timezone ?? DEFAULT_TIMEZONE,
        enabled: job.enabled ?? true,
        config: job.config ?? {},
      };
      // Validated in the archive's shape, which is the one the validator knows: it checks
      // `functionName`, while the stored record holds the `functionId` resolved just below.
      requireValid(
        validateScheduledFunctionData({ ...fields, functionName: job.functionName }),
        'scheduled',
        decision.name
      );

      const linkedName = storedEdgeName.get(job.functionName) ?? job.functionName;
      const linked = edgeByName.get(linkedName);
      if (!linked) {
        throw new ArchiveError('missingEdgeFunction', { name: decision.name, edge: linkedName });
      }

      if (decision.action === 'create') {
        const create = required(adapter.createScheduledFunction, 'scheduled');
        await create.call(adapter, {
          ...fields,
          id: uuidv4(),
          projectId,
          functionId: linked.id,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const list = required(adapter.listScheduledFunctions, 'scheduled');
        const existing = pick(await list.call(adapter, projectId), decision.name);
        const update = required(adapter.updateScheduledFunction, 'scheduled');
        await update.call(adapter, { ...existing, ...fields, functionId: linked.id, updatedAt: now });
      }
      result.applied.backend += 1;
    } catch (error) {
      result.failed.push(failure(SCHEDULED_PATH, error));
    }
    step();
  }
}

/**
 * Every backend method on StorageAdapter is optional. A missing one is reported rather than
 * skipped: an import that quietly dropped half an archive because the adapter could not store it
 * would look like a clean success.
 */
function required<T>(method: T | undefined, what: BackendNameKind): NonNullable<T> {
  if (!method) throw new ArchiveError('cannotStore', { what });
  return method as NonNullable<T>;
}

/** The record a 'replace' is replacing. Its absence is a failure, never a silent create. */
function pick<T extends { name: string }>(items: T[], name: string): T {
  const found = items.find((item) => item.name === name);
  if (!found) {
    throw new ArchiveError('nothingToReplace', { name });
  }
  return found;
}

function requireValid(
  validation: { valid: boolean; errors: string[] },
  kind: BackendNameKind,
  name: string
): void {
  if (validation.valid) return;
  throw new ArchiveError('invalidRecord', { kind, name, detail: validation.errors.join('; ') });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed write, with the reason in the UI's language when the archive layer raised it. */
function failure(path: string, error: unknown): ApplyResult['failed'][number] {
  return error instanceof ArchiveError ? { path, message: error.message, text: error.text } : { path, message: message(error) };
}
