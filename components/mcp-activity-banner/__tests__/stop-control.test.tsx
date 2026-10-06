// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A run started through the connector spends the account's own provider key and edits its files,
 * and this notice is the only place it surfaces. So it is also where the run has to be stoppable:
 * before this the only way to end one was to close the tab.
 */

const stopGeneration = vi.fn();
vi.mock('@/lib/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ stopGeneration }) },
}));
vi.mock('@/lib/api/backend-status', () => ({
  getBackendStatus: () => ({ backendDown: false, authExpired: false }),
  subscribeBackendStatus: () => () => {},
}));

import { markMcpActivity, clearMcpActivity } from '@/lib/api/mcp-activity';
import { McpActivityBanner } from '..';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(withMessages(<McpActivityBanner />)); });
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    b => (b.textContent ?? '').toLowerCase().includes(label) ||
         (b.getAttribute('aria-label') ?? '').toLowerCase().includes(label)
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => { stopGeneration.mockClear(); clearMcpActivity(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('the MCP activity banner', () => {
  it('stops the run it is reporting', () => {
    markMcpActivity({ kind: 'run', projectId: 'p1', projectName: 'Site', clientLabel: 'Claude' });
    mount();

    expect(container.textContent).toContain('Claude');
    const stop = buttonLabelled('stop');
    expect(stop).toBeTruthy();
    act(() => { stop!.click(); });

    expect(stopGeneration).toHaveBeenCalledWith('p1');
  });

  it('offers no stop for an edit, which has already happened', () => {
    markMcpActivity({ kind: 'edit', projectId: 'p1', projectName: 'Site', clientLabel: 'Claude' });
    mount();

    expect(container.textContent).toContain('edited files');
    expect(buttonLabelled('stop')).toBeUndefined();
  });
});

describe('what the MCP activity banner says', () => {
  it('says a run is running, naming the client and project', () => {
    markMcpActivity({ kind: 'run', projectId: 'p1', projectName: 'Site', clientLabel: 'Claude' });
    mount();
    expect(container.textContent).toContain('Claude is running an agent task on Site through the MCP connector.');
  });

  it('names a deployment change by what happened to it', () => {
    markMcpActivity({ kind: 'deploy', projectId: 'd1', projectName: 'Blog', clientLabel: 'Claude', action: 'published' });
    mount();
    expect(container.textContent).toContain('Claude published the deployment Blog through the MCP connector.');
  });

  it('says a deployment without a name, rather than a placeholder', () => {
    markMcpActivity({ kind: 'deploy', projectId: 'd1', projectName: '', clientLabel: 'Claude' });
    mount();
    expect(container.textContent).toContain('Claude changed a deployment through the MCP connector.');
  });

  it('falls back to a generic client and an untitled project', () => {
    markMcpActivity({ kind: 'edit', projectId: 'p1', projectName: '', clientLabel: '' });
    mount();
    expect(container.textContent).toContain('An MCP client edited files in Untitled through the MCP connector.');
  });
});
