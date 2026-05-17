// lib/server-generate/file-sync-handler.ts
import { vfs } from '@/lib/vfs';

export async function handleFilesChanged(data: { sourceProjectId: string; paths: string[]; taskId: string }): Promise<void> {
  const { paths, taskId } = data;
  if (!paths?.length || !taskId) return;

  const response = await fetch('/api/server-generate/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, paths }),
  });

  if (!response.ok) return;

  const { files } = await response.json();

  for (const file of files) {
    const content = file.binary
      ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)).buffer
      : file.content;

    const exists = await vfs.fileExists(data.sourceProjectId, file.path);
    if (exists) {
      await vfs.updateFile(data.sourceProjectId, file.path, content);
    } else {
      await vfs.createFile(data.sourceProjectId, file.path, content);
    }
  }

  window.dispatchEvent(new Event('filesChanged'));
}
