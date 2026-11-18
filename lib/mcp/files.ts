import { getWorkspaceAdapter } from '@/lib/vfs/adapters/server';

type Adapter = Awaited<ReturnType<typeof getWorkspaceAdapter>>;

export interface WrittenFile {
  path: string;
  type: string;
  mimeType: string;
  size: number;
  created: boolean;
  /** What the write did to the user's hand edits on the page, when it did anything (the write guard). */
  note?: string;
}

/**
 * Writes one file through the VFS, creating or replacing it, and tells the open tab. Shared by
 * `files_write` and the upload URL route so both store bytes the same way and meet the same
 * per-type size limits and storage quota.
 */
export async function writeProjectFile(
  adapter: Adapter,
  notice: { userId: string; clientLabel: string },
  projectId: string,
  path: string,
  body: string | ArrayBuffer,
): Promise<WrittenFile> {
  const { VirtualFileSystem } = await import('@/lib/vfs');
  const projectVfs = new VirtualFileSystem(adapter);
  await projectVfs.init();

  const { beginWriteGuard } = await import('@/lib/direct-edit/write-guard');
  const { isMarkupFile } = await import('@/lib/direct-edit/targets');
  const guard = typeof body === 'string' && isMarkupFile(path) ? await beginWriteGuard(projectVfs, projectId) : null;

  // `createFile` refuses a path that exists, so the existing file decides which call to make.
  const existing = await adapter.getFile(projectId, path);
  const written = existing
    ? await projectVfs.updateFile(projectId, path, body)
    : await projectVfs.createFile(projectId, path, body);
  const note = guard ? await guard.finish() : '';

  const project = await adapter.getProject(projectId);
  const { notifyProjectChanged } = await import('./notify');
  notifyProjectChanged({
    userId: notice.userId, projectId, projectName: project?.name ?? projectId,
    created: false, clientLabel: notice.clientLabel,
  });

  return {
    path: written.path,
    type: written.type,
    mimeType: written.mimeType,
    size: written.size,
    created: !existing,
    ...(note ? { note } : {}),
  };
}
