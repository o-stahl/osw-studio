import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { taskManager } from '@/lib/server-generate/singleton';

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get('osw_session')?.value;
  if (!sessionToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const session = await verifySession(sessionToken);
  if (!session) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  let taskId: string;
  try { ({ taskId } = await request.json()); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const task = taskManager.getTask(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  if (task.sessionId !== session.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json(
    { error: 'Resume not supported — paused tasks must be restarted' },
    { status: 501 },
  );
}
