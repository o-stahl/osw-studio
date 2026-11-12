// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { Deployment } from '@/lib/vfs/types';
import { DeploymentDetail } from '../index';

/**
 * Edits in an open deployment's detail view stay until they are saved or the view is left. The view
 * mirrors the deployment in local state, and the deployments page hands it a new copy of the
 * deployment whenever anything about it changes: a publish replaces it with one that has the new
 * published version and timestamps and the same saved settings.
 */

let container: HTMLElement;
let root: Root;

const deployment = {
  id: 'd1', projectId: 'p1', name: 'Bakery', settingsVersion: 2, lastPublishedVersion: 1,
  publishedAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01'),
  underConstruction: false, customDomain: undefined, databaseEnabled: false,
  headScripts: [], bodyScripts: [], cdnLinks: [],
  analytics: { enabled: false, provider: 'builtin', privacyMode: true },
  seo: { title: 'Fresh bread' },
  compliance: { enabled: false, mode: 'opt-in', blockAnalytics: true },
} as unknown as Deployment;

function render(next: Deployment) {
  act(() => {
    root.render(withMessages(
      <DeploymentDetail
        deployment={next}
        projects={[]}
        isPublishing={false}
        initialSection="seo"
        onBack={() => {}}
        onSave={async () => true}
        onPublish={() => {}}
      />,
    ));
  });
}

const title = () => container.querySelector<HTMLInputElement>('#seo-title')!;
const unsaved = () => container.textContent!.includes(en.deploymentDetail.unsavedChanges);

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render(deployment);
  type(title(), 'Fresh bread daily');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DeploymentDetail unsaved edits', () => {
  it('keeps them through a publish, which changes the published version and not the saved settings', () => {
    expect(unsaved()).toBe(true);

    render({ ...deployment, lastPublishedVersion: 2, publishedAt: new Date('2026-02-01'), updatedAt: new Date('2026-02-01') });

    expect(title().value).toBe('Fresh bread daily');
    expect(unsaved()).toBe(true);
  });

  it('takes the saved settings when they change, over the edit in progress', () => {
    render({ ...deployment, seo: { title: 'Fresh bread, baked daily' }, settingsVersion: 3 });

    expect(title().value).toBe('Fresh bread, baked daily');
    expect(unsaved()).toBe(false);
  });

  it('starts from the other deployment when another one is shown', () => {
    render({ ...deployment, id: 'd2', seo: { title: 'Cakes' } });

    expect(title().value).toBe('Cakes');
    expect(unsaved()).toBe(false);
  });
});
