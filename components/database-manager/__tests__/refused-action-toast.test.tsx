// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * A refused toggle, delete or clear in a deployment's Backend section says so. These used to log to
 * the console only, so a 403 or a 404 left the control looking unresponsive.
 */

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

import { LogsViewer } from '../logs-viewer';

let container: HTMLElement;
let root: Root;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const LOG = {
  id: 'l1', functionId: 'f1', functionName: 'hello', method: 'GET', path: '/hello',
  statusCode: 200, durationMs: 5, timestamp: new Date().toISOString(),
};

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toastError.mockClear();
  vi.stubGlobal('confirm', () => true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function clickClear(deleteResponse: Response) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'DELETE' ? deleteResponse : json({ logs: [LOG] })));
  await act(async () => {
    root.render(withMessages(<LogsViewer deploymentId="d1" workspaceId="ws1" />));
  });
  const clear = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Clear');
  expect(clear?.hasAttribute('disabled')).toBe(false);
  await act(async () => { clear!.click(); });
}

describe('LogsViewer clear', () => {
  it("shows the server's reason when clearing is refused", async () => {
    await clickClear(json({ error: 'Forbidden' }, 403));
    expect(toastError).toHaveBeenCalledWith('Forbidden');
  });

  it('falls back to its own message when the server gives none', async () => {
    await clickClear(new Response('', { status: 404 }));
    expect(toastError).toHaveBeenCalledWith('Failed to clear logs');
  });

  it('says nothing when clearing succeeds', async () => {
    await clickClear(json({ success: true }));
    expect(toastError).not.toHaveBeenCalled();
  });
});
