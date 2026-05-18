import { NextRequest } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { eventBus, taskManager } from '@/lib/server-generate/singleton';

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get('osw_session')?.value;
  if (!sessionToken) {
    return new Response('Unauthorized', { status: 401 });
  }

  const session = await verifySession(sessionToken);
  if (!session) {
    return new Response('Invalid session', { status: 401 });
  }

  const sessionId = session.userId;
  const lastEventIdHeader = request.headers.get('Last-Event-ID');
  const lastEventIdParam = request.nextUrl.searchParams.get('lastEventId');
  const lastEventId = parseInt(lastEventIdHeader ?? lastEventIdParam ?? '0', 10) || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Replay buffered events: if lastEventId > 0, replay from that point;
      // if 0 (fresh connection), replay the entire buffer so reattaching clients get full history.
      const tasks = taskManager.getTasksForSession(sessionId);
      for (const task of tasks) {
        if (task.status !== 'running' && task.status !== 'paused') continue;
        const replayed = lastEventId > 0
          ? eventBus.replayFrom(task.taskId, lastEventId)
          : eventBus.getBuffer(task.taskId);
        if (replayed === null) {
          const gapEvent = `id: ${Date.now()}\nevent: sync_gap\ndata: ${JSON.stringify({ sourceProjectId: task.projectId })}\n\n`;
          controller.enqueue(encoder.encode(gapEvent));
        } else {
          for (const event of replayed) {
            const line = `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
            controller.enqueue(encoder.encode(line));
          }
        }
      }

      const listener = (event: { id: number; event: string; data: Record<string, unknown> }) => {
        try {
          const line = `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
          controller.enqueue(encoder.encode(line));
        } catch {
          eventBus.removeListener(sessionId, listener);
        }
      };

      eventBus.addListener(sessionId, listener);

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
          eventBus.removeListener(sessionId, listener);
        }
      }, 30_000);

      request.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        eventBus.removeListener(sessionId, listener);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
