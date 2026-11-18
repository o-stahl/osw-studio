/**
 * Writing a custom property's new value into the stylesheet that declares it.
 *
 * Unlike an element's override, this is an edit of the project's own CSS: a variable is by nature
 * a value for the whole site, and a second copy of it in `/overrides.css` would leave the
 * stylesheet saying something that is not in force. The write is an ordinary one (not silent), so
 * the pages that use the file recompile, and it is recorded for the Inspector's undo.
 */

import { vfs as browserVfs, type VirtualFileSystem } from '@/lib/vfs';
import { asText } from '@/lib/vfs/as-text';
import { isSafeVariableValue, writeVariable, type VariableRef } from './css-variables';
import type { WriteRecorder } from './types';

/** A definition to write to: which file, and which of its rules. */
export type VariableTarget = VariableRef & { file: string };

export interface VariableWrite {
  ok: boolean;
  /**
   * `generating`: the agent is writing, and this would race it. `missing-file`: the stylesheet is
   * gone. `gone`: its rule no longer declares the variable. `unsafe`: the value could not stand in
   * a declaration.
   */
  reason?: 'generating' | 'missing-file' | 'gone' | 'unsafe';
  file: string;
  /** Empty when the value was already what was asked for. */
  filesWritten: string[];
}

export async function applyVariable(
  projectId: string,
  target: VariableTarget,
  value: string,
  opts?: { fs?: VirtualFileSystem; record?: WriteRecorder; isGenerating?: () => boolean },
): Promise<VariableWrite> {
  const vfs = opts?.fs ?? browserVfs;
  const { file } = target;
  if (opts?.isGenerating?.()) return { ok: false, reason: 'generating', file, filesWritten: [] };
  if (!isSafeVariableValue(value)) return { ok: false, reason: 'unsafe', file, filesWritten: [] };
  let before: string;
  try {
    before = asText((await vfs.readFile(projectId, file)).content);
  } catch {
    return { ok: false, reason: 'missing-file', file, filesWritten: [] };
  }
  const after = writeVariable(file, before, target, value);
  if (after === null) return { ok: false, reason: 'gone', file, filesWritten: [] };
  if (after === before) return { ok: true, file, filesWritten: [] };
  await vfs.updateFile(projectId, file, after);
  opts?.record?.({ path: file, before, after, silent: false });
  return { ok: true, file, filesWritten: [file] };
}
