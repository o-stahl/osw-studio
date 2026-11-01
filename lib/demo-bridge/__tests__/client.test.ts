// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDemoBridge } from '../client';
import { BRIDGE_CHANNEL } from '../protocol';

/**
 * The workspace's end of the bridge: a hidden frame on the demo's bridge page. Only the demo's
 * origin, from that frame, is heard; replies are matched to their requests.
 */
const DEMO = 'https://demo.example.com';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function frame(): HTMLIFrameElement {
  const el = document.querySelector('iframe');
  if (!el) throw new Error('no frame');
  return el;
}

function fromFrame(data: unknown, origin = DEMO, source: Window | null = frame().contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

async function opened() {
  const pending = openDemoBridge(DEMO, { timeoutMs: 1000 });
  fromFrame({ channel: BRIDGE_CHANNEL, ready: true });
  return pending;
}

describe('openDemoBridge', () => {
  it("loads the demo's bridge page in a hidden frame and opens when it says it is listening", async () => {
    const bridge = await opened();
    expect(frame().src).toBe(`${DEMO}/demo-bridge`);
    expect(frame().style.display).toBe('none');
    bridge.close();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('does not take a ready signal from another origin or another frame', async () => {
    vi.useFakeTimers();
    const pending = openDemoBridge(DEMO, { timeoutMs: 1000 });
    const outcome = pending.then(() => 'opened', () => 'refused');
    fromFrame({ channel: BRIDGE_CHANNEL, ready: true }, 'https://elsewhere.example.com');
    fromFrame({ channel: BRIDGE_CHANNEL, ready: true }, DEMO, window);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await outcome).toBe('refused');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('asks the demo, at its own origin, and takes only the matching reply', async () => {
    const bridge = await opened();
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    const listing = bridge.list();
    const [request, target] = post.mock.calls[0] as [{ id: string; op: string }, string];
    expect(request.op).toBe('list');
    expect(target).toBe(DEMO);

    const projects = [{ id: 'p1', name: 'Site', updatedAt: '2026-10-16T10:00:00.000Z', fileCount: 3 }];
    fromFrame({ channel: BRIDGE_CHANNEL, id: 'someone-else', ok: true, projects: [] });
    fromFrame({ channel: BRIDGE_CHANNEL, id: request.id, ok: true, projects: [] }, 'https://elsewhere.example.com');
    fromFrame({ channel: BRIDGE_CHANNEL, id: request.id, ok: true, projects });
    expect(await listing).toEqual({ projects, unreachable: 0 });
    bridge.close();
  });

  it('asks the demo to export and to remove exactly the projects it names, and passes on what comes back', async () => {
    const bridge = await opened();
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');

    const exporting = bridge.exportProjects(['p1', 'p2']);
    const [exportRequest, target] = post.mock.calls[0] as [{ id: string }, string];
    expect(exportRequest).toMatchObject({ channel: BRIDGE_CHANNEL, op: 'export', projectIds: ['p1', 'p2'] });
    expect(target).toBe(DEMO);
    const backup = new Blob(['zip']);
    fromFrame({ channel: BRIDGE_CHANNEL, id: exportRequest.id, ok: true, backup });
    expect(await exporting).toBe(backup);

    const deleting = bridge.deleteProjects(['p1']);
    const [deleteRequest] = post.mock.calls[1] as [{ id: string }];
    expect(deleteRequest).toMatchObject({ channel: BRIDGE_CHANNEL, op: 'delete', projectIds: ['p1'] });
    fromFrame({ channel: BRIDGE_CHANNEL, id: deleteRequest.id, ok: true, deleted: 1 });
    expect(await deleting).toBe(1);
    bridge.close();
  });

  it('passes on how many projects the demo holds that its frame cannot read, as a whole number or none', async () => {
    const bridge = await opened();
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    const answer = async (unreachable: unknown) => {
      const listing = bridge.list();
      const [request] = post.mock.calls.at(-1) as [{ id: string }];
      fromFrame({ channel: BRIDGE_CHANNEL, id: request.id, ok: true, projects: [], unreachable });
      return (await listing).unreachable;
    };
    expect(await answer(2)).toBe(2);
    expect(await answer(2.7)).toBe(2);
    expect(await answer('3')).toBe(0);
    expect(await answer(-1)).toBe(0);
    bridge.close();
  });

  it('turns an export without a file into an error', async () => {
    const bridge = await opened();
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    const exporting = bridge.exportProjects(['p1']);
    const [request] = post.mock.calls[0] as [{ id: string }];
    fromFrame({ channel: BRIDGE_CHANNEL, id: request.id, ok: true });
    await expect(exporting).rejects.toThrow();
    bridge.close();
  });

  it('turns a reply that says the demo failed into an error carrying its reason', async () => {
    const bridge = await opened();
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    const deleting = bridge.deleteProjects(['p1']);
    const [request] = post.mock.calls[0] as [{ id: string }];
    fromFrame({ channel: BRIDGE_CHANNEL, id: request.id, ok: false, error: 'storage locked' });
    await expect(deleting).rejects.toThrow('storage locked');
    bridge.close();
  });

  it('gives up on a request the demo never answers, and on close', async () => {
    const bridge = await opened();
    vi.useFakeTimers();
    const listing = bridge.list().then(() => 'answered', () => 'gave up');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await listing).toBe('gave up');
    const deleting = bridge.deleteProjects(['p1']).then(() => 'answered', () => 'closed');
    bridge.close();
    expect(await deleting).toBe('closed');
  });

  it('stops listening to the page once it closes', async () => {
    const listen = vi.spyOn(window, 'addEventListener');
    const unlisten = vi.spyOn(window, 'removeEventListener');
    const bridge = await opened();
    const onMessage = listen.mock.calls.find(([type]) => type === 'message')?.[1];
    expect(onMessage).toBeTypeOf('function');
    bridge.close();
    expect(unlisten).toHaveBeenCalledWith('message', onMessage);
  });
});
