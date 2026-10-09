// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { NextIntlClientProvider } from 'next-intl';
import { deepMerge } from '@/lib/i18n/merge';
import en from '@/messages/en.json';
import fi from '@/messages/fi.json';

/**
 * The footer holds what is not a place in the app: a help menu (tour, About, Discussions, GitHub)
 * and the language picker. The list above keeps only destinations.
 */
const refresh = vi.fn();
const setLocale = vi.fn();
let studio = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: (l: string) => setLocale(l) }));
vi.mock('@/components/view-mode-provider', () => ({ useStudioView: () => studio }));
vi.mock('@/lib/vfs', () => ({ vfs: { init: vi.fn(async () => {}), listProjects: vi.fn(async () => []) } }));
vi.mock('@/lib/hooks/use-project-sync-state', () => ({ useProjectSyncState: () => ({ pendingCount: 0 }) }));
vi.mock('@/components/workspace-switcher', () => ({ WorkspaceSwitcher: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { Sidebar } from '../index';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  studio = true;
  refresh.mockClear();
  setLocale.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  localStorage.removeItem('osw-admin-sidebar-pinned');
});

async function render(handlers: { onStartTour?: () => void; onOpenAbout?: () => void } = {}) {
  await act(async () => {
    root.render(withMessages(
      <Sidebar currentView="projects" onNavigate={vi.fn()} onProjectSelect={vi.fn()} {...handlers} />,
    ));
  });
}

/** Radix opens a menu from the keyboard as well as the pointer; jsdom only does the former well. */
async function open(label: string) {
  const trigger = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  );
  expect(trigger, `no ${label} trigger`).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    trigger!.focus();
    trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')] as HTMLElement[];
}

const texts = (items: HTMLElement[]) => items.map((i) => i.textContent?.trim());

describe('Sidebar footer', () => {
  it('keeps the tour, About and outside links out of the main list', async () => {
    await render({ onStartTour: vi.fn(), onOpenAbout: vi.fn() });
    const nav = container.querySelector('nav')!.textContent ?? '';
    for (const gone of ['Guided Tour', 'About', 'Discord', 'GitHub']) expect(nav).not.toContain(gone);
  });

  it('offers the tour, About, Discussions and GitHub in the help menu', async () => {
    const onStartTour = vi.fn();
    await render({ onStartTour, onOpenAbout: vi.fn() });
    const items = await open('Help');
    expect(texts(items)).toEqual(['Guided Tour', 'About', 'Discussions', 'GitHub']);
    expect(items[2].getAttribute('href')).toBe('https://github.com/o-stahl/osw-studio/discussions');
    await act(async () => { items[0].click(); });
    expect(onStartTour).toHaveBeenCalledTimes(1);
  });

  it('leaves the tour out of the simple view', async () => {
    studio = false;
    await render({ onStartTour: vi.fn(), onOpenAbout: vi.fn() });
    expect(texts(await open('Help'))).toEqual(['About', 'Discussions', 'GitHub']);
  });

  it('lists each language in its own name and switches to the one picked', async () => {
    await render();
    const items = await open('Language');
    expect(texts(items)).toEqual(['English', '한국어', 'Suomi']);
    await act(async () => { items[2].click(); });
    expect(setLocale).toHaveBeenCalledWith('fi');
    expect(refresh).toHaveBeenCalled();
  });

  it('marks each language with its own lang, and leaves the current one alone when picked', async () => {
    await render();
    const items = await open('Language');
    expect(items.map((i) => i.getAttribute('lang'))).toEqual(['en', 'ko', 'fi']);
    await act(async () => { items[0].click(); });
    expect(setLocale).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('holds the languages while a switch is saving', async () => {
    setLocale.mockReturnValue(new Promise(() => {}));
    await render();
    const first = await open('Language');
    await act(async () => { first[2].click(); });
    const items = await open('Language');
    expect(items.every((i) => i.hasAttribute('data-disabled'))).toBe(true);
  });

  it('keeps the backdrop while a footer menu holds the unpinned sidebar open', async () => {
    localStorage.setItem('osw-admin-sidebar-pinned', 'false');
    const onHoverChange = vi.fn();
    await act(async () => {
      root.render(withMessages(
        <Sidebar currentView="projects" onNavigate={vi.fn()} onProjectSelect={vi.fn()} onHoverChange={onHoverChange} />,
      ));
    });
    const sidebar = container.querySelector('nav')!.parentElement!;
    const last = () => onHoverChange.mock.calls[onHoverChange.mock.calls.length - 1][0];

    await act(async () => { sidebar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    expect(last()).toBe(true);
    await open('Help');
    // The menu renders in a portal, so moving onto it leaves the sidebar.
    await act(async () => { sidebar.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    expect(last()).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(last()).toBe(false);
  });

  it('lets the sidebar close when a footer menu closes away from it', async () => {
    // The menu can close without the sidebar ever hearing the pointer leave (Escape, or a click
    // elsewhere): on close, whether the pointer is over the sidebar decides.
    localStorage.setItem('osw-admin-sidebar-pinned', 'false');
    const onHoverChange = vi.fn();
    await act(async () => {
      root.render(withMessages(
        <Sidebar currentView="projects" onNavigate={vi.fn()} onProjectSelect={vi.fn()} onHoverChange={onHoverChange} />,
      ));
    });
    const sidebar = container.querySelector('nav')!.parentElement!;
    const last = () => onHoverChange.mock.calls[onHoverChange.mock.calls.length - 1][0];

    await act(async () => { sidebar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    await open('Help');
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(last()).toBe(false);
  });
});

describe('Sidebar labels in another language', () => {
  async function renderFinnish(currentView: string) {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={deepMerge(en, fi)}>
          <Sidebar currentView={currentView} onNavigate={vi.fn()} onProjectSelect={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });
    return container.querySelector('nav')!.textContent ?? '';
  }

  it('names the top-level views in the interface language', async () => {
    const nav = await renderFinnish('projects');
    expect(nav).toContain(fi.common.terms.projects);
    expect(nav).not.toContain('Projects');
  });

  it('names the settings pages from the settings labels', async () => {
    const nav = await renderFinnish('settings');
    expect(nav).toContain(fi.nav.settings.connections);
    expect(nav).toContain(fi.nav.settings.appearance);
    expect(nav).not.toContain('Connections');
  });

  it('names the docs pages from the docs labels', async () => {
    const nav = await renderFinnish('docs');
    expect(nav).toContain(fi.nav.docs.overview);
  });
});
