// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const renderPage = vi.fn();
vi.mock('@/lib/canvas/render-job', () => ({ renderPage: (...args: unknown[]) => renderPage(...args) }));

import { vfs } from '@/lib/vfs';
import { handleRenderRequested, handleSelectionRequested, selectionAnswer } from '../render-delegation-handler';

/**
 * This tab's side of rendering for the server: it claims only a project it has, renders only once
 * the pulls under way have landed, and posts what it rendered; and its answer to a selection
 * question, with the line the selection's source position is on.
 */

globalThis.indexedDB = new IDBFactory();
const calls: { url: string; body: Record<string, unknown> }[] = [];
let granted = true;

beforeEach(() => {
  calls.length = 0;
  granted = true;
  renderPage.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ granted }) };
  }));
});

async function project(): Promise<string> {
  await vfs.init();
  const p = await vfs.createProject('Rendered', 'fixture', `p-render-${Math.random().toString(36).slice(2)}`);
  await vfs.createFile(p.id, '/index.html', '<html>\n<body>\n  <h1>Hi</h1>\n</body>\n</html>', { silent: true });
  return p.id;
}

describe('handleRenderRequested', () => {
  it('claims, waits for the pulls under way, renders and posts the result', async () => {
    const id = await project();
    const order: string[] = [];
    renderPage.mockImplementation(async () => { order.push('render'); return { ok: false, error: 'done' }; });
    // A pull lands later, as a real one does: one that recorded at once would pass unawaited.
    const synced = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); order.push('synced'); };
    await handleRenderRequested({ requestId: 'r1', job: { kind: 'inspect', projectId: id, page: '/', width: 1440 } }, synced);
    expect(calls.map((c) => c.url)).toEqual(['/api/server-generate/render-claim', '/api/server-generate/render-result']);
    expect(order).toEqual(['synced', 'render']);
    expect(calls[1].body).toEqual({ requestId: 'r1', result: { ok: false, error: 'done' } });
  });

  it('leaves a request for a project it does not have to another tab', async () => {
    await handleRenderRequested({ requestId: 'r2', job: { kind: 'inspect', projectId: 'not-here', page: '/', width: 1440 } }, async () => {});
    expect(calls).toEqual([]);
  });

  it('renders nothing when another tab claimed it first', async () => {
    const id = await project();
    granted = false;
    await handleRenderRequested({ requestId: 'r3', job: { kind: 'inspect', projectId: id, page: '/', width: 1440 } }, async () => {});
    expect(renderPage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

describe('the selection this tab reports', () => {
  it('names the project, page, width, position in source and marker', async () => {
    const id = await project();
    const answer = await selectionAnswer(id, {
      domPath: 'body > h1', tagName: 'h1', nodeId: 'n', attributes: { 'data-osw-id': 'h1abc123' }, outerHTML: '<h1>Hi</h1>',
      srcAttr: '/index.html:17', page: '/index.html', viewportWidth: 375, timestamp: 42, surface: 'canvas',
    });
    expect(answer).toMatchObject({ projectId: id, projectName: 'Rendered', surface: 'canvas', page: '/index.html', width: 375, marker: 'h1abc123', selectedAt: 42 });
    // As style and inspect take it: line and column, not the compile's offset.
    expect(answer?.source).toMatch(/^\/index\.html:3:\d+$/);
    expect(answer).not.toHaveProperty('src');
  });

  it('answers nothing for another project, and still answers', async () => {
    await handleSelectionRequested({ requestId: 's1', projectId: 'other' }, () => ({
      projectId: 'mine', focus: { domPath: 'body', tagName: 'body', nodeId: 'n', attributes: {}, outerHTML: '', timestamp: 1 },
    }));
    expect(calls).toEqual([{ url: '/api/server-generate/selection-result', body: { requestId: 's1', selection: null } }]);
  });
});
