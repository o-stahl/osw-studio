import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { taskManager } from '@/lib/server-generate/singleton';
import { settleImageRequest } from '@/lib/server-generate/image-requests';

/** Receives the result of a browser-delegated image generation and resolves the paused server-side run. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await taskManager.initialize();

  let taskId: string, requestId: unknown, base64: unknown, mimeType: unknown, error: unknown;
  try { ({ taskId, requestId, base64, mimeType, error } = await request.json()); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const task = taskManager.getTask(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  if (task.sessionId !== session.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (typeof requestId === 'string') {
    settleImageRequest(
      task,
      requestId,
      typeof base64 === 'string' && base64 && typeof mimeType === 'string' && mimeType.startsWith('image/')
        ? { base64, mimeType }
        : { error: typeof error === 'string' && error ? error : 'image generation failed' },
    );
  }

  return NextResponse.json({ ok: true });
}
