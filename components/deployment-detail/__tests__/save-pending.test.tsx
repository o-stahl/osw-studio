// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { DeploymentDetail } from '../index';
import type { Deployment } from '@/lib/vfs/types';

/**
 * A save that opens the swap dialog has not happened yet, so the edits stay marked unsaved until
 * the swap succeeds. They used to read as saved, and a failed swap lost them on Back with no prompt.
 */

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const deployment = {
  id: 'd1', projectId: 'p1', name: 'Site', underConstruction: false,
  headScripts: [], bodyScripts: [], cdnLinks: [],
  analytics: { enabled: false }, seo: {}, compliance: { enabled: false },
  settingsVersion: 1, enabled: true, createdAt: new Date(), updatedAt: new Date(),
} as unknown as Deployment;

async function editAndSave(onSave: () => Promise<boolean | void>) {
  act(() => {
    root.render(withMessages(
      <DeploymentDetail deployment={deployment} projects={[]} isPublishing={false}
        onBack={() => {}} onSave={onSave} onPublish={() => {}} />,
    ));
  });
  const toggle = container.querySelector<HTMLElement>('[role="switch"]');
  expect(toggle).not.toBeNull();
  act(() => toggle!.click());
  expect(container.textContent).toContain('Unsaved changes');
  const save = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Save Changes');
  await act(async () => { save!.click(); });
}

describe('DeploymentDetail save handed to a dialog', () => {
  it('stays unsaved when onSave resolves false', async () => {
    await editAndSave(async () => false);
    expect(container.textContent).toContain('Unsaved changes');
  });

  it('clears unsaved when onSave resolves', async () => {
    await editAndSave(async () => undefined);
    expect(container.textContent).not.toContain('Unsaved changes');
  });
});
