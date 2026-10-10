// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { Deployment, Project } from '@/lib/vfs/types';
import { DeploymentCard } from '../index';

/**
 * A deployment outlives its project. When the server says the project is gone, the card says so in
 * place of the project's name, even if this browser still has a local copy by that id: the server is
 * what publishing builds from.
 */

vi.mock('@/lib/utils/deployment-thumbnail', () => ({ captureDeploymentPage: vi.fn() }));

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const project = { id: 'p1', name: 'Bakery Site' } as Project;

function render(projectMissing: boolean | undefined) {
  const deployment = {
    id: 'd1', projectId: 'p1', name: 'Bakery', settingsVersion: 1, lastPublishedVersion: 1,
    headScripts: [], bodyScripts: [], cdnLinks: [], analytics: { enabled: false }, compliance: { enabled: false }, seo: {},
    projectMissing,
  } as unknown as Deployment;
  act(() => {
    root.render(withMessages(
      <DeploymentCard
        deployment={deployment}
        project={project}
        onViewAnalytics={() => {}}
        onEditProject={() => {}}
        onPublish={() => {}}
        onUnpublish={() => {}}
        onDelete={() => {}}
      />,
    ));
  });
}

describe('DeploymentCard source project line', () => {
  it('says the project is missing instead of naming it', () => {
    render(true);
    expect(container.textContent).toContain(en.deployments.projectMissing);
    expect(container.textContent).not.toContain('Bakery Site');
  });

  it('names the project when it exists', () => {
    render(undefined);
    expect(container.textContent).toContain('Bakery Site');
    expect(container.textContent).not.toContain(en.deployments.projectMissing);
  });
});
