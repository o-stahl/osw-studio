// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The workspace's deployment picker is optional: it appears only for a project with a
 * database-enabled deployment. A project not yet on the server answers the list with an error, and
 * that shows no picker rather than an error or a spinner that never stops.
 */

import { DeploymentSelector } from '../deployment-selector';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
const onDeploymentChange = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function mount(answer: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(answer));
  await act(async () => {
    root.render(withMessages(
      <DeploymentSelector projectId="p1" selectedDeploymentId={null} onDeploymentChange={onDeploymentChange} workspaceId="ws1" />,
    ));
  });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

describe('DeploymentSelector', () => {
  it.each([
    ['a server error', async () => json({ error: 'Not found' }, 404)],
    ['a network failure', async () => { throw new TypeError('Failed to fetch'); }],
  ])('shows nothing after %s', async (_name, answer) => {
    await mount(answer);
    expect(container.innerHTML).toBe('');
    expect(onDeploymentChange).not.toHaveBeenCalled();
  });

  it('shows nothing when no deployment has a database', async () => {
    await mount(async () => json({ deployments: [{ id: 'd1', name: 'Site', databaseEnabled: false }] }));
    expect(container.innerHTML).toBe('');
    expect(onDeploymentChange).not.toHaveBeenCalled();
  });

  it('selects the only deployment when it has a database', async () => {
    await mount(async () => json({ deployments: [{ id: 'd1', name: 'Site', databaseEnabled: true }] }));
    expect(onDeploymentChange).toHaveBeenCalledWith('d1', 'Site');
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
    expect(container.textContent).not.toContain(en.deployments.loading);
  });
});
