import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { taskManager, eventBus } from '@/lib/server-generate/singleton';
import type { ServerTask } from '@/lib/server-generate/types';

const going = (task: ServerTask) => task.status === 'running' || task.status === 'paused' || task.status === 'stopping';

/** Stop one task: ask its runner, or close one that has no runner left to finish it. */
async function stopTask(task: ServerTask): Promise<boolean> {
  // A task with a live loop is asked to stop and completes itself through the runner, as does one
  // whose runner is still setting it up and checks for a stop before its loop starts. One with
  // neither, such as a task reloaded from the durable store after the process restarted, has
  // nothing that will ever complete it, so it is closed here and its clients told so.
  if (!task.orchestrator && !task.runnerActive) {
    eventBus.emit(task.taskId, task.projectId, 'task_complete', { result: 'stopped' }, task.sessionId);
    await taskManager.completeTask(task.taskId, 'cancelled');
    return false;
  }
  task.orchestrator?.stop();
  task.status = 'stopping';
  await taskManager.updateTask(task);
  return true;
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await taskManager.initialize();

  let taskId: string;
  let projectId: string | undefined;
  try { ({ taskId, projectId } = await request.json()); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const task = taskManager.getTask(taskId);
  if (task && task.sessionId !== session.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Any other of this account's tasks still going on the project is stopped too: one left running
  // beside the task the tab knows would otherwise write on with nothing able to reach it.
  const project = projectId ?? task?.projectId;
  const others = project
    ? taskManager.getTasksForSession(session.userId).filter((t) => t.projectId === project && t.taskId !== taskId && going(t))
    : [];
  for (const other of others) await stopTask(other);

  if (!task || !going(task)) {
    return NextResponse.json({ ok: true, alreadyDone: true });
  }
  return NextResponse.json({ ok: true, hadOrchestrator: await stopTask(task) });
}
