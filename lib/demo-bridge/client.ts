import {
  BRIDGE_CHANNEL,
  BRIDGE_PATH,
  isBridgeReady,
  isBridgeReply,
  type BridgeReply,
  type DemoProjectSummary,
} from './protocol';

/** A reply that answers the request; one that does not rejects it (`request`). */
type Answer = Extract<BridgeReply, { ok: true }>;

/** What the demo holds: the projects this frame can read, and how many more it cannot (Safari). */
export interface DemoProjectList {
  projects: DemoProjectSummary[];
  unreachable: number;
}

/** The workspace's end of the bridge (`./protocol.ts`): a hidden frame on the demo's bridge page. */
export interface DemoBridge {
  list(): Promise<DemoProjectList>;
  /** A `.osws` of these projects, for `BackupService.importAllData`. */
  exportProjects(projectIds: string[]): Promise<Blob>;
  /** Removes them from the demo; resolves to how many it was asked to remove. */
  deleteProjects(projectIds: string[]): Promise<number>;
  close(): void;
}

/**
 * Opens the bridge and waits for it to say it is listening. Only messages from `demoOrigin`, and
 * from this frame, count; anything else on the page is ignored.
 */
export function openDemoBridge(demoOrigin: string, { timeoutMs = 20_000 }: { timeoutMs?: number } = {}): Promise<DemoBridge> {
  return new Promise((resolveOpen, rejectOpen) => {
    const frame = document.createElement('iframe');
    frame.src = `${demoOrigin}${BRIDGE_PATH}`;
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;

    const pending = new Map<string, { resolve: (reply: Answer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let opened = false;

    const close = () => {
      window.removeEventListener('message', onMessage);
      frame.remove();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('The demo bridge was closed'));
      }
      pending.clear();
    };

    const request = (body: { op: 'list' } | { op: 'export' | 'delete'; projectIds: string[] }) =>
      new Promise<Answer>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The demo did not answer'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        frame.contentWindow?.postMessage({ channel: BRIDGE_CHANNEL, id, ...body }, demoOrigin);
      });

    const bridge: DemoBridge = {
      async list() {
        const reply = await request({ op: 'list' });
        const unreachable = typeof reply.unreachable === 'number' && reply.unreachable > 0 ? Math.floor(reply.unreachable) : 0;
        return { projects: reply.projects ?? [], unreachable };
      },
      async exportProjects(projectIds) {
        const reply = await request({ op: 'export', projectIds });
        if (!(reply.backup instanceof Blob)) throw new Error('The demo sent no projects');
        return reply.backup;
      },
      async deleteProjects(projectIds) {
        const reply = await request({ op: 'delete', projectIds });
        return reply.deleted ?? 0;
      },
      close,
    };

    function onMessage(event: MessageEvent) {
      if (event.origin !== demoOrigin || event.source !== frame.contentWindow) return;
      if (!opened && isBridgeReady(event.data)) {
        opened = true;
        clearTimeout(openTimer);
        resolveOpen(bridge);
        return;
      }
      if (!isBridgeReply(event.data)) return;
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      clearTimeout(entry.timer);
      if (event.data.ok) entry.resolve(event.data);
      else entry.reject(new Error(event.data.error));
    }

    const openTimer = setTimeout(() => {
      close();
      rejectOpen(new Error('The demo did not load'));
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    document.body.appendChild(frame);
  });
}
