// lib/server-generate/file-sync-handler.ts
import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';

const projectSyncState = new Map<string, { pending: Promise<void>; cancelled: boolean }>();

function getState(projectId: string) {
  let s = projectSyncState.get(projectId);
  if (!s) {
    s = { pending: Promise.resolve(), cancelled: false };
    projectSyncState.set(projectId, s);
  }
  return s;
}

export function cancelPendingFileSync(projectId?: string): void {
  if (projectId) {
    const s = projectSyncState.get(projectId);
    if (s) s.cancelled = true;
  } else {
    for (const s of projectSyncState.values()) s.cancelled = true;
  }
}

export async function handleFilesChanged(data: { sourceProjectId: string; paths: string[]; taskId: string }): Promise<void> {
  const state = getState(data.sourceProjectId);
  state.cancelled = false;
  state.pending = state.pending.then(() => doSync(data)).catch((err) => {
    logger.warn('[file-sync] Sync error:', err);
  });
  return state.pending;
}

async function doSync(data: { sourceProjectId: string; paths: string[]; taskId: string }): Promise<void> {
  const state = projectSyncState.get(data.sourceProjectId);
  if (state?.cancelled) return;
  const { paths, taskId } = data;
  if (!paths?.length || !taskId) return;

  const response = await fetch('/api/server-generate/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, paths }),
  });

  if (!response.ok) return;

  const { files, deleted } = await response.json();

  // Write all files silently (no per-file DOM events or save-manager marking)
  for (const file of files) {
    const content = file.binary
      ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)).buffer
      : file.content;

    const exists = await vfs.fileExists(data.sourceProjectId, file.path);
    if (exists) {
      await vfs.updateFile(data.sourceProjectId, file.path, content, { silent: true });
    } else {
      await vfs.createFile(data.sourceProjectId, file.path, content, { silent: true });
    }
  }

  if (deleted?.length) {
    for (const path of deleted) {
      try {
        await vfs.deleteFile(data.sourceProjectId, path, { silent: true });
      } catch {
        // Already deleted on client
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('filesChanged'));
  }
}
