// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { deepMerge } from '@/lib/i18n/merge';
import type { Deployment, Project } from '@/lib/vfs/types';
import { DeploymentCard } from '../index';

/**
 * The card's count badges, for the scripts and CDN links a deployment has switched on, read in the
 * app's language and count only what is enabled.
 */

vi.mock('@/lib/utils/deployment-thumbnail', () => ({ captureDeploymentPage: vi.fn() }));

let container: HTMLElement;
let root: Root;

const messages = deepMerge(en, fi);
const t = createTranslator({ locale: 'fi', messages, namespace: 'deployments', onError: (e) => { throw e; } });

const script = (enabled: boolean) => ({ id: String(Math.random()), name: 's', content: '', enabled });

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

describe('DeploymentCard count badges', () => {
  it('count the enabled scripts and CDN links in the app\'s language', () => {
    const deployment = {
      id: 'd1', projectId: 'p1', name: 'Bakery', settingsVersion: 1, lastPublishedVersion: 1,
      headScripts: [script(true), script(false)], bodyScripts: [script(true)],
      cdnLinks: [{ id: 'c1', name: 'x', url: 'https://cdn.test/x.js', type: 'js', enabled: true }],
      analytics: { enabled: false }, compliance: { enabled: false }, seo: {},
    } as unknown as Deployment;
    act(() => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={messages}>
          <DeploymentCard
            deployment={deployment}
            project={{ id: 'p1', name: 'Bakery Site' } as Project}
            onViewAnalytics={() => {}}
            onEditProject={() => {}}
            onPublish={() => {}}
            onUnpublish={() => {}}
            onDelete={() => {}}
          />
        </NextIntlClientProvider>,
      );
    });

    expect(container.textContent).not.toMatch(/\bScripts?\b|CDN Resources?/);
    expect(container.textContent).toContain(t('scriptCount', { count: 2 }));
    expect(container.textContent).toContain(t('cdnCount', { count: 1 }));
  });
});
