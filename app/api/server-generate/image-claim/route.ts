import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { taskManager } from '@/lib/server-generate/singleton';
import { claimImageRequest } from '@/lib/server-generate/image-requests';

/**
 * A tab asking to be the one that generates a server-delegated image. The request reaches every tab
 * the account has open; without this each generates its own and pays for it, and all but the first
 * answer are discarded.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await taskManager.initialize();

  let taskId: unknown, requestId: unknown;
  try { ({ taskId, requestId } = await request.json()); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof taskId !== 'string' || typeof requestId !== 'string') {
    return NextResponse.json({ error: 'taskId and requestId are required' }, { status: 400 });
  }
  const task = taskManager.getTask(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  if (task.sessionId !== session.userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return NextResponse.json({ granted: claimImageRequest(task, requestId) });
}
