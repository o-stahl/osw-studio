// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { McpPane } from '../mcp-pane';

/**
 * The MCP pane is rendered on the server and hydrated in the browser. The server has no address of
 * its own to show, so the endpoint has to come out the same on both sides of hydration and take the
 * browser's address afterwards; otherwise React reports a hydration mismatch and renders the pane
 * again from scratch.
 */

let container: HTMLElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ grants: [] }), { status: 200 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('McpPane hydration', () => {
  it('hydrates without a mismatch and then shows the full endpoint', async () => {
    const pane = () => withMessages(<McpPane workspaceId="ws" />);

    vi.stubGlobal('window', undefined);
    const html = renderToString(pane());
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ grants: [] }), { status: 200 })));

    container.innerHTML = html;
    const errors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, pane(), { onRecoverableError: (error) => errors.push(error) });
    });

    expect(errors).toEqual([]);
    expect(container.textContent).toContain(`${window.location.origin}/api/mcp`);
  });
});
