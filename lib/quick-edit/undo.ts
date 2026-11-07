/**
 * Where undo and redo go, over a project's checkpoints.
 *
 * Checkpoints are a list, oldest first. Restoring one does not remove any, so a position has to be
 * remembered separately: the cursor is the checkpoint the project was last restored to, or null
 * when it is at the newest. Undo steps the cursor back, redo steps it forward, and any new
 * checkpoint puts the cursor back at the newest, which is what retires the redo branch.
 */

function position(ids: readonly string[], cursor: string | null): number {
  if (cursor === null) return ids.length - 1;
  const index = ids.indexOf(cursor);
  // A cursor that points at a pruned checkpoint is as good as none.
  return index === -1 ? ids.length - 1 : index;
}

/** The checkpoint undo would restore, or null when there is nothing earlier. */
export function undoTarget(ids: readonly string[], cursor: string | null): string | null {
  const index = position(ids, cursor);
  return index > 0 ? ids[index - 1] : null;
}

/** The checkpoint redo would restore, or null when the project is at the newest. */
export function redoTarget(ids: readonly string[], cursor: string | null): string | null {
  const index = position(ids, cursor);
  return index < ids.length - 1 ? ids[index + 1] : null;
}

/**
 * Where Retry starts a run over: the checkpoint before the one the run finished on, which is where
 * undo would go from it. Null when that checkpoint is gone, or nothing came before it.
 */
export function retryStart(ids: readonly string[], finishedOn: string): string | null {
  return ids.includes(finishedOn) ? undoTarget(ids, finishedOn) : null;
}
