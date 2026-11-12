// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

/**
 * A deployment's Logs section: a failed call opens onto the error it stored, the log level is set
 * from the section and saved at once, and the section says how many calls it keeps.
 */

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

import { LogsViewer } from '../logs-viewer';

const t = createTranslator({ locale: 'en', messages: en, onError: (e) => { throw e; } });
const now = new Date().toISOString();
const FAILED = {
  id: 2, functionId: 'f1', functionName: 'checkout', method: 'POST', path: '/checkout',
  statusCode: 500, durationMs: 12, error: 'TypeError: cart.total is not a function', timestamp: now,
};
const OK = { id: 1, functionId: 'f1', functionName: 'checkout', method: 'GET', path: '/checkout', statusCode: 200, durationMs: 5, timestamp: now };

let container: HTMLElement;
let root: Root;
let requests: Array<{ method: string; body: unknown }>;
let putResponse: () => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toastError.mockClear();
  requests = [];
  putResponse = () => json({ level: 'errors' });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return method === 'PUT' ? putResponse() : json({ logs: [FAILED, OK], level: 'all', cap: 1000 });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(withMessages(<LogsViewer deploymentId="d1" workspaceId="ws1" />));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const levelItem = (level: 'all' | 'errors' | 'off') =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]')).find((el) => el.textContent === t(`backend.logLevel.${level}`))!;

describe('LogsViewer', () => {
  it('opens a failed call onto its error, and only a failed call', async () => {
    const toggles = container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]');
    expect(toggles).toHaveLength(1);
    expect(container.textContent).not.toContain(FAILED.error);

    await act(async () => { toggles[0].click(); });
    expect(toggles[0].getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain(FAILED.error);

    await act(async () => { toggles[0].click(); });
    expect(container.textContent).not.toContain(FAILED.error);
  });

  it('says how many calls it keeps, and saves the level picked', async () => {
    expect(container.textContent).toContain(t('backend.logsKept', { count: 1000 }));
    expect(levelItem('all').getAttribute('data-state')).toBe('on');

    await act(async () => { levelItem('errors').click(); });

    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ level: 'errors' });
    expect(levelItem('errors').getAttribute('data-state')).toBe('on');
  });

  it('puts the level back and says so when the change is refused', async () => {
    putResponse = () => json({ error: 'Forbidden' }, 403);

    await act(async () => { levelItem('off').click(); });

    expect(toastError).toHaveBeenCalledWith('Forbidden');
    expect(levelItem('all').getAttribute('data-state')).toBe('on');
  });

  it('takes no other level while one is being saved', async () => {
    let answer!: (response: Response) => void;
    putResponse = () => new Promise<Response>((resolve) => { answer = resolve; });

    await act(async () => { levelItem('errors').click(); });
    await act(async () => { levelItem('off').click(); });
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(levelItem('errors').getAttribute('data-state')).toBe('on');

    await act(async () => { answer(json({ level: 'errors' })); });
    putResponse = () => json({ level: 'off' });
    await act(async () => { levelItem('off').click(); });
    expect(requests.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ level: 'errors' }, { level: 'off' }]);
    expect(levelItem('off').getAttribute('data-state')).toBe('on');
  });
});
