// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Keenable's key is optional: it connects without one and becomes active, or keeps a key that is
 * shown masked on its card. Without a key it is connected only while active, so disconnecting it
 * hands the active slot to another connected provider.
 */

const mocks = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
// The card's menu, flattened: Radix's pointer handling does not run in jsdom.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) =>
    <button type="button" onClick={() => onSelect?.()}>{children}</button>,
}));

import { SearchConnectionsSection } from '../search-connections';
import { configManager } from '@/lib/config/storage';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registerEnglishTranslator();
  localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const buttons = () => [...document.body.querySelectorAll('button')];
async function click(match: (b: HTMLButtonElement) => boolean) {
  const b = buttons().find(match);
  if (!b) throw new Error('button not found');
  await act(async () => { b.click(); });
}
async function typeKey(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('#search-key');
  if (!input) throw new Error('no key field');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function connectKeenable(key: string) {
  await act(async () => { root.render(withMessages(<SearchConnectionsSection />)); });
  await click((b) => b.textContent === en.connections.addSearchProvider);
  await click((b) => !!b.textContent?.startsWith('KEKeenable'));
  expect(document.body.querySelector('#search-key'), 'Keenable opens its form instead of connecting').not.toBeNull();
  if (key) await typeKey(key);
  await click((b) => b.textContent === en.common.actions.save);
}

describe('Keenable optional key', () => {
  it('connects without a key and becomes the active provider', async () => {
    configManager.setWebSearchProvider('tavily');
    configManager.setWebSearchKey('tavily', 'tvly-x');
    await connectKeenable('');
    expect(configManager.getWebSearchProvider()).toBe('keenable');
    expect(configManager.getWebSearchKey('keenable')).toBeFalsy();
    expect(container.textContent).toContain('Keenable');
  });

  it('keeps a saved key, shows it masked, and leaves the active provider alone', async () => {
    configManager.setWebSearchProvider('tavily');
    configManager.setWebSearchKey('tavily', 'tvly-x');
    await connectKeenable('kn-secret-1234');
    expect(configManager.getWebSearchKey('keenable')).toBe('kn-secret-1234');
    expect(configManager.getWebSearchProvider()).toBe('tavily');
    expect(container.textContent).toContain('···1234');
  });

  it('hands the active slot on when the keyless active Keenable is disconnected', async () => {
    configManager.setWebSearchKey('tavily', 'tvly-x');
    configManager.setWebSearchProvider('keenable');
    await act(async () => { root.render(withMessages(<SearchConnectionsSection />)); });
    const card = [...container.querySelectorAll('div.font-semibold')]
      .find((d) => d.textContent === 'Keenable')?.closest('.rounded-md.px-4');
    const disconnect = [...(card?.querySelectorAll('button') ?? [])].find((b) => b.textContent === en.connections.disconnect);
    if (!disconnect) throw new Error('no Keenable disconnect item');
    await act(async () => { disconnect.click(); });
    expect(configManager.getWebSearchProvider()).toBe('tavily');
    expect(container.textContent).not.toContain('Keenable');
  });
});

describe('search provider picker', () => {
  it('lists providers alphabetically and marks only Keenable as recommended', async () => {
    await act(async () => { root.render(withMessages(<SearchConnectionsSection />)); });
    await click((b) => b.textContent === en.connections.addSearchProvider);
    const names = ['Brave', 'DuckDuckGo', 'Firecrawl', 'Keenable', 'SearXNG', 'Tavily'];
    const rows = names.map((n) => buttons().find((b) => b.querySelector('span.font-semibold')?.textContent === n));
    expect(rows.every(Boolean)).toBe(true);
    const all = buttons();
    expect(rows.map((r) => all.indexOf(r!))).toEqual([...rows.map((r) => all.indexOf(r!))].sort((a, b) => a - b));
    for (const [i, row] of rows.entries()) {
      expect(row!.textContent!.includes(en.connections.searchRecommended), names[i]).toBe(names[i] === 'Keenable');
    }
  });
});
