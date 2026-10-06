// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * The root page in Server Mode: it sends the browser on to the workspace (desktop) or the admin
 * projects page (web), carrying the query, which holds a provider sign-in's return for the
 * workspace page to finish. A failed desktop bootstrap shows the server's own words, else the status.
 */

const replace = vi.fn();
// Stable like Next's own router: the boot effect depends on it.
const router = { replace, push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/studio-app', () => ({ StudioApp: () => <div data-studio /> }));

import Home from '../page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  replace.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.replaceState(null, '', '/?code=abc&state=xyz');
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => { root.render(withMessages(<Home />)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function desktopInit(status: number, body: unknown) {
  vi.stubEnv('NEXT_PUBLIC_DESKTOP', 'true');
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('root page boot in Server Mode', () => {
  it('sends the web server to the admin projects page with the query', async () => {
    vi.stubEnv('NEXT_PUBLIC_DESKTOP', 'false');
    await render();
    expect(replace).toHaveBeenCalledWith('/admin/projects?code=abc&state=xyz');
  });

  it('bootstraps the desktop workspace and opens it with the query', async () => {
    const fetchMock = desktopInit(200, { workspaceId: 'ws1' });
    await render();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/desktop-init', { method: 'POST' });
    expect(replace).toHaveBeenCalledWith('/w/ws1/projects?code=abc&state=xyz');
    expect(document.cookie).toContain('osw_workspace=ws1');
  });

  it('shows the server\'s own error and detail when the bootstrap fails', async () => {
    desktopInit(500, { error: 'Database is locked', detail: 'SQLITE_BUSY at open' });
    await render();
    expect(replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain('OSW Studio could not initialize its workspace.');
    expect(container.textContent).toContain('Database is locked');
    expect(container.textContent).toContain('SQLITE_BUSY at open');
  });

  it('treats an answer without a workspace id as a failure', async () => {
    desktopInit(200, {});
    await render();
    expect(replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Workspace initialization failed (HTTP 200)');
  });

  it('words a failure without a message by its status', async () => {
    desktopInit(503, {});
    await render();
    expect(container.textContent).toContain('Workspace initialization failed (HTTP 503)');
  });

  it('says the request failed when it never reached the server, with the reason as detail', async () => {
    vi.stubEnv('NEXT_PUBLIC_DESKTOP', 'true');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await render();
    expect(container.textContent).toContain('Workspace initialization request failed');
    expect(container.textContent).toContain('Failed to fetch');
  });
});
