import type { EditKind } from './journal';
import type { RecordedWrite } from './types';

/**
 * The open project's Inspector edit history, as the workspace's Undo and Redo keys reach it.
 *
 * Registered by the workspace for the project it has open and cleared when it closes; the keys are
 * handled by the dock, which has no other way to it. See `EditJournal`.
 */
export interface EditHistory {
  /** The project the history belongs to. */
  projectId: string;
  /**
   * Adds a write to the history as one more gesture: the agent's `style` command, which goes through
   * the Styles tab's write path, takes this so its changes undo the same way.
   */
  record(group: string, kind: EditKind, write: RecordedWrite): void;
  /** When the edit Undo would take back was made, or `null` with nothing to undo. */
  undoAt(): number | null;
  /** When the edit Redo would bring back was undone, or `null` with nothing to redo. */
  redoAt(): number | null;
  undo(): void;
  redo(): void;
}

let current: EditHistory | null = null;

export function setEditHistory(history: EditHistory | null): void {
  current = history;
}

export function editHistory(): EditHistory | null {
  return current;
}
