// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

/**
 * A refused toggle, delete or clear in a deployment's Backend section says so. These used to log to
 * the console only, so a 403 or a 404 left the control looking unresponsive.
 */

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

import { LogsViewer } from '../logs-viewer';
import { FunctionsManager } from '../functions-manager';
import { ScheduledFunctionsManager } from '../scheduled-functions-manager';
import { ServerFunctionsManager } from '../server-functions-manager';
import { SecretsManager } from '../secrets-manager';

let container: HTMLElement;
let root: Root;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const now = new Date().toISOString();
const LOG = {
  id: 'l1', functionId: 'f1', functionName: 'hello', method: 'GET', path: '/hello',
  statusCode: 200, durationMs: 5, timestamp: now,
};
const EDGE = {
  id: 'f1', name: 'hello', method: 'GET', code: '', enabled: true, timeoutMs: 5000,
  createdAt: now, updatedAt: now,
};
const SCHEDULE = {
  id: 's1', name: 'nightly', functionId: 'f1', cronExpression: '0 0 * * *', timezone: 'UTC', config: {},
  enabled: true, nextRunAt: now, createdAt: now, updatedAt: now,
};
const HELPER = { id: 'h1', name: 'helper', code: '', enabled: true, createdAt: now, updatedAt: now };
const SECRET = { id: 'k1', name: 'API_KEY', hasValue: true, createdAt: now, updatedAt: now };

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toastError.mockClear();
  vi.stubGlobal('confirm', () => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const buttonNamed = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll<HTMLElement>('button, [role="menuitem"]')).find(b => b.textContent === text);

async function clickClear(deleteResponse: Response) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'DELETE' ? deleteResponse : json({ logs: [LOG] })));
  await act(async () => {
    root.render(withMessages(<LogsViewer deploymentId="d1" workspaceId="ws1" />));
  });
  const clear = buttonNamed(container, en.common.actions.clear);
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
    expect(toastError).toHaveBeenCalledWith(en.backend.clearLogsFailed);
  });

  it('says nothing when clearing succeeds', async () => {
    await clickClear(json({ success: true }));
    expect(toastError).not.toHaveBeenCalled();
  });
});

type Action = 'toggle' | 'delete';
interface Case {
  name: string;
  render: () => React.ReactElement;
  /** The GET responses the manager loads its list from, by URL suffix. */
  lists: Record<string, unknown>;
  /** The method the action is sent with. */
  method: 'PUT' | 'DELETE';
  action: Action;
  fallback: string;
}

const props = { deploymentId: 'd1', workspaceId: 'ws1' };
const edgeList = { '/functions': { functions: [EDGE] } };
const cases: Case[] = [
  { name: 'FunctionsManager', render: () => <FunctionsManager {...props} />, lists: edgeList, method: 'PUT', action: 'toggle', fallback: en.backend.updateFunctionFailed },
  { name: 'FunctionsManager', render: () => <FunctionsManager {...props} />, lists: edgeList, method: 'DELETE', action: 'delete', fallback: en.backend.deleteFunctionFailed },
  { name: 'ScheduledFunctionsManager', render: () => <ScheduledFunctionsManager {...props} />, lists: { '/scheduled-functions': { scheduledFunctions: [SCHEDULE] }, ...edgeList }, method: 'PUT', action: 'toggle', fallback: en.backend.updateScheduleFailed },
  { name: 'ScheduledFunctionsManager', render: () => <ScheduledFunctionsManager {...props} />, lists: { '/scheduled-functions': { scheduledFunctions: [SCHEDULE] }, ...edgeList }, method: 'DELETE', action: 'delete', fallback: en.backend.deleteScheduleFailed },
  { name: 'ServerFunctionsManager', render: () => <ServerFunctionsManager {...props} />, lists: { '/server-functions': { functions: [HELPER] } }, method: 'PUT', action: 'toggle', fallback: en.backend.updateHelperFailed },
  { name: 'ServerFunctionsManager', render: () => <ServerFunctionsManager {...props} />, lists: { '/server-functions': { functions: [HELPER] } }, method: 'DELETE', action: 'delete', fallback: en.backend.deleteHelperFailed },
  { name: 'SecretsManager', render: () => <SecretsManager {...props} />, lists: { '/secrets': { secrets: [SECRET], encryptionConfigured: true } }, method: 'DELETE', action: 'delete', fallback: en.backend.deleteSecretFailed },
];

async function runAction(c: Case, actionResponse: Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === c.method) return actionResponse;
    const suffix = Object.keys(c.lists).find(s => url.endsWith(s));
    return suffix ? json(c.lists[suffix]) : new Response('', { status: 404 });
  }));
  await act(async () => { root.render(withMessages(c.render())); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });

  // The item's actions sit in a dropdown, opened from the keyboard as Radix allows in jsdom.
  const trigger = container.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  const label = c.action === 'toggle' ? en.common.actions.disable : en.common.actions.delete;
  const item = buttonNamed(document.body, label);
  expect(item).toBeDefined();
  await act(async () => { item!.click(); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

describe.each(cases)('$name $action', (c) => {
  it("shows the server's reason when refused", async () => {
    await runAction(c, json({ error: 'Forbidden' }, 403));
    expect(toastError).toHaveBeenCalledWith('Forbidden');
  });

  it('falls back to its own message when the server gives none', async () => {
    await runAction(c, new Response('', { status: 404 }));
    expect(toastError).toHaveBeenCalledWith(c.fallback);
  });

  it('says nothing when the server accepts it', async () => {
    await runAction(c, json({ success: true }));
    expect(toastError).not.toHaveBeenCalled();
  });
});
