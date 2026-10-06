/**
 * Project archive: a project as a browsable zip, and the way back in.
 *
 * The import path is three steps that stay separate on purpose — read, analyze, apply. Reading
 * turns a zip or a dropped folder into `ArchiveEntry[]`; analyzing produces a plan and writes
 * nothing; applying carries out a plan the user has approved. Nothing in the middle step touches
 * storage, which is what lets the preview be trusted.
 */
export { exportProjectArchive, type ArchiveExportResult } from './export';
export { readZipArchive, type ReadZipOptions, type ReadZipResult } from './read-zip';
export { folderToArchiveEntries, collectEntryFiles, ensureAncestorDirs } from './read-folder';
export type { FolderEntriesOptions, FolderEntriesResult } from './read-folder';
export { analyzeImport } from './analyze';
export { applyImport, backendResolutionKey, type BackendResolutionKind } from './apply';
export { validateArchivePath, type PathResult } from './paths';
export type {
  ApplyResult,
  ArchiveEntry,
  ArchiveFormat,
  ArchiveIssue,
  BackendConflict,
  FileConflict,
  FileResolution,
  ImportPlan,
  ImportResolutions,
  ImportTarget,
  ProjectManifest,
  SettingChange,
  SettingResolution,
} from './types';
