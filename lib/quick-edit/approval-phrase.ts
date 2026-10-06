/**
 * What a gated capability means, said plainly.
 *
 * The permission system labels a gate for a developer (`rm / rmdir (delete)`); a person who asked for
 * a change needs to know what the agent wants to do, not which command does it. Keyed by gate, each
 * to a whole sentence under `quickEdit.wants`; an unlisted gate is worded around its developer label
 * (`wants.other`) so it still says something true.
 */
export type ApprovalPhraseKey =
  | 'deleteFile' | 'moveFile' | 'copyFile' | 'createFolder' | 'createFile' | 'editFile'
  | 'fetchInternet' | 'callSiteFunction' | 'searchWeb' | 'changeData' | 'readData'
  | 'runScript' | 'generateImage' | 'rebuildSite' | 'changeBuild';

const PHRASES: Record<string, ApprovalPhraseKey> = {
  rm: 'deleteFile',
  mv: 'moveFile',
  cp: 'copyFile',
  mkdir: 'createFolder',
  touch: 'createFile',
  'sed:write': 'editFile',
  ss: 'editFile',
  'curl:external': 'fetchInternet',
  'curl:local': 'callSiteFunction',
  search: 'searchWeb',
  'sqlite3:write': 'changeData',
  'sqlite3:read': 'readData',
  python: 'runScript',
  lua: 'runScript',
  'generate-image': 'generateImage',
  build: 'rebuildSite',
  runtime: 'changeBuild',
};

/** The sentence's key for a gate, or undefined when only its developer label is known. */
export function approvalPhrase(gateKey: string): ApprovalPhraseKey | undefined {
  return PHRASES[gateKey];
}
