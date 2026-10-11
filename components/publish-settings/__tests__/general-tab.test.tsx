// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { SitesMode } from '@/lib/web/site-origin';
import { GeneralTab } from '../general-tab';

/**
 * The General tab shows the studio-path address only when sites really are served on the studio's
 * origin: elsewhere that path just redirects, and before the hosting answer arrives nobody knows.
 * It warns that the source project is gone, until another project is picked in its place.
 */

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

const SETTINGS = { underConstruction: false, settingsVersion: 1, headScripts: [], bodyScripts: [], cdnLinks: [] };
const PROJECTS = [
  { id: 'p1', name: 'One' },
  { id: 'p2', name: 'Two' },
];

function render(props: { sitesMode?: SitesMode | null; projectMissing?: boolean; projectId?: string }) {
  act(() => {
    root.render(withMessages(
      <GeneralTab
        settings={SETTINGS as never}
        onChange={() => {}}
        projectId={props.projectId ?? 'p1'}
        deploymentId="d1"
        publicUrl="https://shop.example.com"
        projects={PROJECTS as never}
        onProjectChange={() => {}}
        sitesMode={props.sitesMode}
        projectMissing={props.projectMissing}
      />,
    ));
  });
}

const text = () => container.textContent ?? '';

describe('the direct path row', () => {
  it.each<[SitesMode | null | undefined, boolean]>([
    ['same-origin', true],
    ['proxy', false],
    ['host', false],
    [null, false],
    [undefined, false],
  ])('with sites mode %s: shown %s', (sitesMode, shown) => {
    render({ sitesMode });
    expect(text().includes(en.publishSettings.directPath)).toBe(shown);
    expect(text().includes(`${window.location.origin}/deployments/d1`)).toBe(shown);
    // The public address is shown either way.
    expect(text()).toContain('https://shop.example.com');
  });
});

describe('the missing project banner', () => {
  it('is shown while the deployment still points at the missing project', () => {
    render({ projectMissing: true });
    expect(text()).toContain(en.publishSettings.projectMissingTitle);
    expect(text()).toContain(en.publishSettings.projectMissingDetail);
  });

  it('is not shown when the project exists', () => {
    render({ projectMissing: false });
    expect(text()).toContain(en.publishSettings.sourceProjectHelp);
    expect(text()).not.toContain(en.publishSettings.projectMissingTitle);
  });

  it('goes once another project is chosen', () => {
    render({ projectMissing: true });
    render({ projectMissing: true, projectId: 'p2' });
    expect(text()).not.toContain(en.publishSettings.projectMissingTitle);
    expect(text()).toContain(en.publishSettings.changingSourceWarning);
  });
});
