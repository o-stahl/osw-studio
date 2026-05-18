import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { taskManager, eventBus } from '@/lib/server-generate/singleton';
import { runServerGeneration } from '@/lib/server-generate/server-orchestrator-runner';
import type { StartGenerationRequest } from '@/lib/server-generate/types';

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get('osw_session')?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await verifySession(sessionToken);
  if (!session) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  let body: StartGenerationRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.projectId || !body.prompt || !body.model || !body.apiKey) {
    return NextResponse.json(
      { error: 'Missing required fields: projectId, prompt, model, apiKey' },
      { status: 400 },
    );
  }

  const sessionId = session.userId;
  const workspaceId = body.workspaceId;

  let taskId: string;
  try {
    taskId = taskManager.createTask(body.projectId, sessionId, body.apiKey, workspaceId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('limit')) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    throw error;
  }

  const task = taskManager.getTask(taskId)!;
  task.prompt = body.prompt;
  task.model = body.model;
  task.projectName = body.projectName;

  const port = process.env.PORT || '3000';
  const apiBaseUrl = `http://localhost:${port}`;

  // Run generation in background — don't await
  runServerGeneration(taskId, body, {
    taskManager,
    eventBus,
    createVFS: async (_projectId) => {
      const { VirtualFileSystem } = await import('@/lib/vfs');
      const { getWorkspaceAdapter, getSQLiteAdapter } = await import('@/lib/vfs/adapters/server');
      const adapter = workspaceId ? getWorkspaceAdapter(workspaceId) : getSQLiteAdapter();
      const serverVFS = new VirtualFileSystem(adapter);
      await serverVFS.init();
      return serverVFS;
    },
    apiBaseUrl,
  }).catch((err) => {
    console.error(`Server generation failed for task ${taskId}:`, err);
  });

  return NextResponse.json({ taskId });
}
