import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { taskManager } from '@/lib/server-generate/singleton';

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get('osw_session')?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await verifySession(sessionToken);
  if (!session) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const taskId = request.nextUrl.searchParams.get('taskId');

  if (taskId) {
    const task = taskManager.getTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({
      taskId: task.taskId,
      projectId: task.projectId,
      status: task.status,
      startedAt: task.startedAt,
      buildDeferred: task.buildDeferred,
    });
  }

  const tasks = taskManager.getTasksForSession(session.userId).map((t) => ({
    taskId: t.taskId,
    projectId: t.projectId,
    status: t.status,
    startedAt: t.startedAt,
    buildDeferred: t.buildDeferred,
    prompt: t.prompt,
    model: t.model,
    projectName: t.projectName,
  }));

  return NextResponse.json({ tasks });
}
