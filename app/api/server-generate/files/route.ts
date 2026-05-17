import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { taskManager } from '@/lib/server-generate/singleton';
import { VirtualFileSystem } from '@/lib/vfs';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

let serverVFS: VirtualFileSystem | null = null;
async function getServerVFS(): Promise<VirtualFileSystem> {
  if (!serverVFS) {
    serverVFS = new VirtualFileSystem(new SQLiteAdapter());
    await serverVFS.init();
  }
  return serverVFS;
}

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get('osw_session')?.value;
  if (!sessionToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  const { taskId, paths } = await request.json();
  if (!taskId || !Array.isArray(paths)) {
    return NextResponse.json({ error: 'Missing taskId or paths' }, { status: 400 });
  }

  const task = taskManager.getTask(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  if (task.sessionId !== session.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const vfs = await getServerVFS();
  const files = [];
  for (const filePath of paths) {
    try {
      const content = await vfs.readFile(task.projectId, filePath);
      const binary = content instanceof ArrayBuffer;
      files.push({
        path: filePath,
        content: binary ? Buffer.from(content).toString('base64') : content,
        binary,
      });
    } catch {
      // File may have been deleted — skip
    }
  }

  return NextResponse.json({ files });
}
