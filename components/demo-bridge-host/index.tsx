'use client';

import { useEffect } from 'react';

import {
  BRIDGE_CHANNEL,
  isBridgeRequest,
  type BridgeReady,
  type BridgeReply,
  type BridgeRequest,
} from '@/lib/demo-bridge/protocol';
import { readDemoProjectCount, writeDemoProjectCount } from '@/lib/demo-bridge/project-count';

/**
 * The demo's end of the bridge (`lib/demo-bridge/protocol.ts`), on the page a hosted workspace
 * loads in a hidden frame: lists, exports and removes the projects in this browser's demo storage,
 * for the instance origins in `allowedOrigins` and nobody else.
 */
export function DemoBridgeHost({ allowedOrigins }: { allowedOrigins: string[] }) {
  useEffect(() => {
    const allowed = new Set(allowedOrigins);
    const onMessage = async (event: MessageEvent) => {
      // Only the page that framed this one, and only from a listed origin.
      if (event.source !== window.parent || !allowed.has(event.origin) || !isBridgeRequest(event.data)) return;
      const reply = await answer(event.data);
      (event.source as Window | null)?.postMessage(reply, { targetOrigin: event.origin });
    };
    window.addEventListener('message', onMessage);
    if (window.parent !== window) {
      const ready: BridgeReady = { channel: BRIDGE_CHANNEL, ready: true };
      window.parent.postMessage(ready, '*');
    }
    return () => window.removeEventListener('message', onMessage);
  }, [allowedOrigins]);

  return null;
}

async function answer(request: BridgeRequest): Promise<BridgeReply> {
  const reply = { channel: BRIDGE_CHANNEL, id: request.id } as const;
  try {
    const { vfs } = await import('@/lib/vfs');
    await vfs.init();
    if (request.op === 'list') {
      // Newest first, as the projects page lists them.
      const projects = (await vfs.listProjects())
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      const summaries = await Promise.all(projects.map(async (project) => ({
        id: project.id,
        name: project.name,
        updatedAt: new Date(project.updatedAt).toISOString(),
        fileCount: (await vfs.listFiles(project.id)).length,
      })));
      // Safari keeps IndexedDB apart per top-level origin, so this frame may find none of the
      // projects the demo's own pages counted.
      const unreachable = summaries.length === 0 ? readDemoProjectCount() : 0;
      return { ...reply, ok: true, projects: summaries, ...(unreachable > 0 ? { unreachable } : {}) };
    }
    if (request.op === 'export') {
      const { BackupService } = await import('@/lib/vfs/backup-service');
      return { ...reply, ok: true, backup: await BackupService.exportProjects(request.projectIds) };
    }
    const visible = (await vfs.listProjects()).length;
    let deleted = 0;
    for (const projectId of request.projectIds) {
      await vfs.deleteProject(projectId);
      deleted++;
    }
    // The count the demo's pages keep for frames that cannot read its storage follows the removal.
    // A frame that cannot read it (Safari) found nothing to remove and leaves the count alone.
    if (visible > 0) writeDemoProjectCount((await vfs.listProjects()).length);
    return { ...reply, ok: true, deleted };
  } catch (error) {
    return { ...reply, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
