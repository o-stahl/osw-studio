// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The free allowance in Connections: always listed where it is offered, with nothing to edit or
 * disconnect, and connected only as its status check says. Revalidate runs the check again.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/lib/auth/provider-sign-in', () => ({ startSignIn: vi.fn(), prepareSignIn: async () => {} }));
vi.mock('../search-connections', () => ({ SearchConnectionsSection: () => null }));
// The row's menu, flattened: Radix's pointer handling does not run in jsdom.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-menu>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) =>
    <button type="button" onClick={() => onSelect?.()}>{children}</button>,
}));

import { ConnectionsPane } from '../connections-pane';
import { resetAllowanceStatus } from '@/lib/inference/allowance-status';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
let available = true;
const fetchMock = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ available }), { status: 200 }));

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registerEnglishTranslator();
  localStorage.clear();
  resetAllowanceStatus();
  available = true;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  // The demo, as the root layout marks it on the page.
  document.documentElement.dataset.demoGateway = 'https://gateway.oswstudio.com';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAllowanceStatus();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete document.documentElement.dataset.demoGateway;
});

const heading = () => [...container.querySelectorAll('p')].find((p) => p.textContent === en.allowance.title);
/** The allowance's row: the block under its title. */
function row(): HTMLElement {
  const block = heading()?.parentElement;
  if (!block) throw new Error('no allowance row');
  return block;
}
const addProvider = () => [...container.querySelectorAll('button')].find((b) => b.textContent === en.connections.addProvider)!;
/** Whether Add provider wears the ring that marks it as the next step, as it does with nothing connected. */
const addProviderRinged = () => addProvider().className.split(/\s+/).includes('ring-2');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('the free allowance in Connections', () => {
  it('is listed while its check runs, then connected when the check passes', async () => {
    let release: () => void = () => {};
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { release = r; });
      return new Response(JSON.stringify({ available: true }), { status: 200 });
    });
    await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
    expect(row().textContent).toContain(en.allowance.statusChecking);
    expect(row().textContent).not.toContain(en.common.labels.connected);

    await act(async () => { release(); });
    await settle();
    expect(row().textContent).toContain(en.common.labels.connected);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/inference/status');
  });

  it('stays listed, unavailable, when the check fails', async () => {
    available = false;
    await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
    await settle();
    expect(row().textContent).toContain(en.allowance.statusUnavailable);
    expect(row().textContent).toContain(en.allowance.unavailableBody);
    expect(row().textContent).not.toContain(en.common.labels.connected);
  });

  it('is not offered under Add provider, even while it is unavailable', async () => {
    available = false;
    await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
    await settle();
    await act(async () => { addProvider().click(); });
    await settle();
    const choices = [...document.body.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(choices.some((text) => text.includes('OpenRouter'))).toBe(true);
    expect(choices.some((text) => text.includes('OSW Studio'))).toBe(false);
  });

  it('offers only Revalidate, which checks again despite a recent answer', async () => {
    await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
    await settle();
    // Across the pane: listed again as an ordinary connection, it would offer Edit and Disconnect.
    const items = [...container.querySelectorAll('[data-menu] button')].map((b) => b.textContent);
    expect(items).toEqual([en.connections.revalidate]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    available = false;
    const revalidate = row().querySelector<HTMLButtonElement>('[data-menu] button')!;
    await act(async () => { revalidate.click(); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(row().textContent).toContain(en.allowance.statusUnavailable);
  });

  it('points to Add provider once the check fails and nothing else is connected', async () => {
    await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
    await settle();
    expect(addProviderRinged()).toBe(false);

    available = false;
    await act(async () => { row().querySelector<HTMLButtonElement>('[data-menu] button')!.click(); });
    await settle();
    expect(addProviderRinged()).toBe(true);
  });

  it('mentions the bot check on the demo, and not on a hosted instance', async () => {
    await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
    await settle();
    expect(row().textContent).toContain(en.allowance.botCheck);

    delete document.documentElement.dataset.demoGateway;
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', 'https://gateway.oswstudio.com');
    await act(async () => { root.render(withMessages(<ConnectionsPane key="hosted" />)); });
    await settle();
    expect(row().textContent).toContain(en.allowance.body);
    expect(row().textContent).not.toContain(en.allowance.botCheck);
  });

  it('is not listed where the allowance is not offered', async () => {
    delete document.documentElement.dataset.demoGateway;
    await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
    await settle();
    expect(addProvider()).toBeDefined();
    expect(heading()).toBeUndefined();
  });
});
