import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { taskManager } from '@/lib/server-generate/singleton';
import { VirtualFileSystem } from '@/lib/vfs';
import { getWorkspaceAdapter, getSQLiteAdapter } from '@/lib/vfs/adapters/server';

async function getVFSForTask(workspaceId?: string): Promise<VirtualFileSystem> {
  const adapter = workspaceId ? getWorkspaceAdapter(workspaceId) : getSQLiteAdapter();
  const vfs = new VirtualFileSystem(adapter);
  await vfs.init();
  return vfs;
}

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get('osw_session')?.value;
  if (!sessionToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  let taskId: string, paths: string[];
  try { ({ taskId, paths } = await request.json()); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!taskId || !Array.isArray(paths)) {
    return NextResponse.json({ error: 'Missing taskId or paths' }, { status: 400 });
  }

  const task = taskManager.getTask(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  if (task.sessionId !== session.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const vfs = await getVFSForTask(task.workspaceId);
  const files = [];
  const deleted = [];
  for (const filePath of paths) {
    try {
      const exists = await vfs.fileExists(task.projectId, filePath);
      if (!exists) {
        deleted.push(filePath);
        continue;
      }
      const file = await vfs.readFile(task.projectId, filePath);
      const binary = file.content instanceof ArrayBuffer;
      files.push({
        path: filePath,
        content: binary ? Buffer.from(file.content as ArrayBuffer).toString('base64') : file.content as string,
        binary,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        deleted.push(filePath);
      }
    }
  }

  return NextResponse.json({ files, deleted });
}
