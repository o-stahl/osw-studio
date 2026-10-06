import { vfs } from '@/lib/vfs';
import { checkpointManager } from '@/lib/vfs/checkpoint';

/**
 * The starting-point checkpoint a project gets on its first open, so the user can always roll
 * back. Records it as the project's last save and returns its id.
 *
 * preserveUpdatedAt: this fires on the first open of every project, including one that was just
 * imported and pushed. Bumping updatedAt here is a local write nothing pushes, so it left freshly
 * imported projects stuck on "Local newer" in Server Sync.
 */
export async function createOpenCheckpoint(projectId: string): Promise<string> {
  const cp = await checkpointManager.createCheckpoint(projectId, 'Project opened', { kind: 'auto', label: { key: 'projectOpened' } });
  // Re-read after the checkpoint: a new project's first push finishes meanwhile, and
  // writing the copy read before it would erase the revision it stamped.
  const opened = await vfs.getProject(projectId);
  opened.lastSavedCheckpointId = cp.id;
  opened.lastSavedAt = opened.updatedAt;
  await vfs.updateProject(opened, { preserveUpdatedAt: true });
  return cp.id;
}
