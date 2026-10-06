import type { ProjectRuntime } from '../types';
import type { ArchiveText } from './text';

/** One entry from a zip or a dropped folder, normalized to a project-root-relative path. */
export interface ArchiveEntry {
  /** Always starts with '/'. Already validated by validateArchivePath. */
  path: string;
  read(): Promise<ArrayBuffer>;
  /** Uncompressed size where the source can state it up front. */
  declaredSize?: number;
  /**
   * When the source says the file was last written — a zip's DOS date, a dropped file's
   * lastModified. Absent when the source records none, which is why nothing may branch on it
   * beyond presentation: it is a claim by whoever built the archive, not evidence.
   */
  modifiedAt?: Date;
}

export const ARCHIVE_FORMAT_VERSION = 1;

export interface ProjectManifest {
  formatVersion: number;
  name: string;
  description?: string;
  runtime?: ProjectRuntime;
  entryPoint?: string;
  globalStyles?: string;
  /** The project database's DDL. Carried as a setting because that is where it is stored. */
  databaseSchema?: string;
  /**
   * Only files whose stored shape disagrees with what their extension implies.
   * Everything absent is inferred with isTextExtension, the same rule the app uses.
   */
  encoding?: Record<string, 'text' | 'binary'>;
}

export type ArchiveFormat = 'archive' | 'loose-files' | 'osws-backup' | 'oswt-template';

export type ImportTarget =
  | { kind: 'new-project' }
  | { kind: 'existing-project'; projectId: string };

export type FileResolution = 'keep-mine' | 'replace' | 'keep-both';
export type SettingResolution = 'keep-current' | 'use-archive';

/** Something the archive layer could not carry across, in either direction — export or import. */
export interface ArchiveIssue {
  path?: string;
  code:
    | 'path-rejected'
    | 'path-too-long'
    | 'too-large'
    | 'invalid-json'
    | 'validation-failed'
    /**
     * The archive carries a file the app reads as instructions to the AI, so importing it changes
     * how the agent behaves on this project rather than only what the project contains.
     */
    | 'ai-instructions'
    /** A record's own code file is absent, so there is nothing to import. */
    | 'missing-code'
    /** A record points at another record that isn't there — a schedule's edge function, say. */
    | 'unresolved-reference'
    /** The record was carried across, but a field the format does not support was dropped. */
    | 'unsupported-field'
    /** Imports and is kept, but cannot run until the project reaches a Server Mode instance. */
    | 'server-mode-required';
  /** English, for logs and for code that reads it. */
  message: string;
  /** The same message as a key the UI translates; absent when it is a thrown error's own words. */
  text?: ArchiveText;
}

export interface FileConflict {
  path: string;
  currentSize: number;
  incomingSize: number;
  currentUpdatedAt?: Date;
  /**
   * When the archive says its copy was last written — `ArchiveEntry.modifiedAt`, carried through
   * so the preview can state both sides of the comparison from the plan alone.
   *
   * Absent whenever the source recorded none. Like `modifiedAt` it is a claim by whoever built the
   * archive, so nothing may branch on it beyond presentation.
   */
  incomingUpdatedAt?: Date;
  /** True when the project's copy is newer. Displayed, never used to pre-select. */
  currentIsNewer: boolean;
  /**
   * Path the incoming file takes under 'keep-both'.
   *
   * Absent when no candidate fits the 200-character path limit — the directory plus ' (2)' plus
   * the extension can exceed it on their own, and truncating the extension instead would change
   * the apparent file type. The dialog offers only Keep mine / Replace for such a row.
   */
  keepBothPath?: string;
}

export interface BackendConflict {
  kind: 'edge' | 'server' | 'scheduled';
  name: string;
  /**
   * What the *archive's* copy is, in the same words `backend.added` uses — a method, a cron
   * expression. Carried on a conflict as well as an addition because this is where it decides
   * something: replacing `send-email` is exactly the moment its method matters.
   */
  detail: string;
  /** Set when the archive's copy is switched off; the dialog says so beside `detail`. */
  disabled?: true;
  keepBothName: string;
}

export interface SettingChange {
  key: 'runtime' | 'entryPoint' | 'globalStyles' | 'databaseSchema' | 'name' | 'description';
  from?: string;
  to: string;
}

/**
 * What importing an archive into a target *would* do. Produced without writing anything, so the
 * user approves a change that has not happened yet.
 *
 * **Path spelling, for apply.** `files.unchanged` and `files.conflicts[].path` are spelled the way
 * the *project* spells them; `files.added` the way the archive does. The two differ whenever a
 * name is written NFD in one place and NFC in the other — macOS versus everywhere else — so apply
 * must resolve a plan path back to its `ArchiveEntry` under `path.normalize('NFC')` rather than by
 * string equality. A plain lookup misses the entry for exactly those files, and writing the
 * archive's spelling instead would create a duplicate beside the file it meant to replace.
 *
 * **Backend, for apply.** `backend.added`, `backend.conflicts` and `backend.unchanged` partition
 * every function the archive carries. A record in none of the three is one the *project* has and
 * the archive does not: leave it alone — an import populates, it never reconciles. `secretsAdded`
 * and `secretsMetadataChanged` likewise list only what apply must write; a secret in neither is
 * either identical or absent from the archive, and needs nothing in both cases.
 */
export interface ImportPlan {
  format: ArchiveFormat;
  manifest?: ProjectManifest;
  files: {
    added: string[];
    conflicts: FileConflict[];
    unchanged: string[];
  };
  backend: {
    added: Array<{ kind: BackendConflict['kind']; name: string; detail: string; disabled?: true }>;
    conflicts: BackendConflict[];
    /**
     * Records the project already has, identical in every field an archive carries. Listed rather
     * than dropped so a project's own export reads as "nothing to do" instead of offering to
     * resolve conflicts that do not exist — and so 'keep both', which would duplicate the record,
     * is never offered for one.
     */
    unchanged: Array<{ kind: BackendConflict['kind']; name: string }>;
    secretsAdded: string[];
    secretsMetadataChanged: string[];
  };
  settingChanges: SettingChange[];
  errors: ArchiveIssue[];
  warnings: ArchiveIssue[];
  totals: { entries: number; bytes: number };
}

/**
 * The user's decisions about a plan.
 *
 * `files` is keyed by `FileConflict.path` — the *project's* spelling, exactly as the plan reports
 * it. `backend` is keyed by `backendResolutionKey(kind, name)` rather than by name alone: an edge
 * function and a scheduled function share one name grammar, so 'nightly' is ambiguous on its own.
 * `settings` is keyed by `SettingChange.key`.
 *
 * A key that is absent means no decision was recorded, which apply reads as the conservative one —
 * keep-mine for a file or a record, keep-current for a setting. An unapproved overwrite is the one
 * outcome that cannot be undone by not clicking.
 */
export interface ImportResolutions {
  files: Record<string, FileResolution>;
  backend: Record<string, FileResolution>;
  settings: Record<string, SettingResolution>;
  /**
   * The user has seen `plan.errors` and wants the rest of the import anyway. The dialog owns this
   * gate — apply never writes anything outside the plan, and the analyzer has already left every
   * blocked entry out of it, so there is nothing left for apply to skip.
   */
  skipBlocked: boolean;
}

/**
 * What applying a plan actually did.
 *
 * `failed` is a tally, not an abort: a per-item failure is reported and the import carries on, so
 * one malformed function cannot cost the user the rest of the archive. `checkpointId` is present
 * for an existing project and absent for a new one, which has no prior state to return to.
 */
export interface ApplyResult {
  projectId: string;
  applied: { files: number; backend: number; settings: number };
  failed: Array<{ path: string; message: string; text?: ArchiveText }>;
  checkpointId?: string;
}
