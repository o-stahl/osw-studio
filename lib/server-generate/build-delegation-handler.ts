// lib/server-generate/build-delegation-handler.ts
import { vfs } from '@/lib/vfs';
import { handleFilesChanged } from './file-sync-handler';

export async function handleBuildRequested(data: {
  sourceProjectId: string;
  taskId: string;
  fileManifest?: Record<string, number>;
}): Promise<void> {
  const { sourceProjectId, taskId, fileManifest } = data;

  try {
    if (fileManifest) {
      const stalePaths = Object.keys(fileManifest);
      if (stalePaths.length > 0) {
        await handleFilesChanged({ sourceProjectId, paths: stalePaths, taskId });
      }
    }

    const { VirtualServer } = await import('@/lib/preview/virtual-server');
    const { drainCompileErrors } = await import('@/lib/preview/compile-errors');

    const project = await vfs.getProject(sourceProjectId);
    if (!project) {
      await postBuildResult(taskId, false, ['Project not found']);
      return;
    }

    const server = new VirtualServer(vfs, sourceProjectId, { runtime: project.settings?.runtime });
    await server.compileProject();
    server.cleanupBlobUrls();

    const compileErrors = drainCompileErrors();
    const errorMessages = compileErrors.map((e) => `${e.file}: ${e.error}`);
    await postBuildResult(taskId, errorMessages.length === 0, errorMessages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await postBuildResult(taskId, false, [message]);
  }
}

async function postBuildResult(taskId: string, success: boolean, errors?: string[]): Promise<void> {
  await fetch('/api/server-generate/build-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, success, errors }),
  });
}
