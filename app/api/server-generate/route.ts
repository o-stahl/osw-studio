import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { verifyWorkspaceAccess } from '@/lib/auth/system-database';
import { taskManager, eventBus } from '@/lib/server-generate/singleton';
import { runServerGeneration } from '@/lib/server-generate/server-orchestrator-runner';
import type { StartGenerationRequest } from '@/lib/server-generate/types';
import { getProvider } from '@/lib/llm/providers/registry';
import type { ProviderId } from '@/lib/llm/providers/types';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: StartGenerationRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.projectId || !body.prompt || !body.model) {
    return NextResponse.json(
      { error: 'Missing required fields: projectId, prompt, model' },
      { status: 400 },
    );
  }
  // Local providers (Ollama, LM Studio, llama.cpp) have no key; everything else needs one.
  const providerId = body.providerConfig?.provider as ProviderId | undefined;
  if (!body.apiKey && (!providerId || getProvider(providerId).apiKeyRequired)) {
    return NextResponse.json(
      { error: `Missing API key for ${providerId ?? 'the provider'}` },
      { status: 400 },
    );
  }

  const sessionId = session.userId;
  const workspaceId = body.workspaceId;

  // The run reads and writes the project's files, so the caller needs editor access to the
  // workspace it names. Without one, only the instance's own principals (admin, desktop) may use
  // the unscoped database.
  if (workspaceId) {
    try {
      verifyWorkspaceAccess(session.userId, workspaceId, 'editor');
    } catch {
      return NextResponse.json({ error: 'Workspace access denied' }, { status: 403 });
    }
  } else if (session.userId !== 'admin' && session.userId !== 'desktop') {
    return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
  }

  await taskManager.initialize();

  let taskId: string;
  try {
    taskId = taskManager.createTask(body.projectId, sessionId, body.apiKey ?? '', workspaceId);
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
  await taskManager.updateTask(task);

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
  }).catch((err: any) => {
    console.error(`Server generation failed for task ${taskId}:`, err?.message ?? 'unknown error');
  });

  return NextResponse.json({ taskId });
}
