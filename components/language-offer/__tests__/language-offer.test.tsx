// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The first-visit offer to switch language. It writes the locale cookie whichever way it is
 * answered, so it is asked once; it stays out of the pages that are not the studio and out from
 * under the urgent banners that share the top of the window.
 */
const mocks = vi.hoisted(() => ({
  setLocale: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  pathname: '/w/w1/projects',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  usePathname: () => mocks.pathname,
}));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: mocks.setLocale }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { LanguageOffer } from '..';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { getOfferStrings } from '@/lib/i18n/offer';
import { markBackendDown, markBackendUp } from '@/lib/api/backend-status';
import { markMcpActivity, clearMcpActivity } from '@/lib/api/mcp-activity';
import en from '@/messages/en.json';

const fi = getOfferStrings('fi');
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.setLocale.mockResolvedValue(undefined);
  mocks.pathname = '/w/w1/projects';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  markBackendUp();
  clearMcpActivity();
});

function mount() {
  act(() => {
    root.render(withMessages(<LanguageOffer locale="fi" strings={fi} declineLabel="No thanks" />));
  });
}

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);

async function press(el: Element | undefined) {
  if (!el) throw new Error('no such button');
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('LanguageOffer', () => {
  it('offers the language in its own words', () => {
    mount();
    expect(container.textContent).toContain(fi.message);
    expect(button(fi.accept)).toBeDefined();
  });

  it('switches to the offered language, then refreshes', async () => {
    mount();
    await press(button(fi.accept));
    expect(mocks.setLocale).toHaveBeenCalledWith('fi', { embedded: false });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.setLocale.mock.invocationCallOrder[0]).toBeLessThan(mocks.refresh.mock.invocationCallOrder[0]);
  });

  it('records a decline as English, from either button', async () => {
    mount();
    await press(button('No thanks'));
    expect(mocks.setLocale).toHaveBeenLastCalledWith('en', { embedded: false });

    await press(container.querySelector('button[aria-label="No thanks"]') ?? undefined);
    expect(mocks.setLocale).toHaveBeenCalledTimes(2);
    expect(mocks.setLocale).toHaveBeenLastCalledWith('en', { embedded: false });
  });

  it('says so and does not refresh when the choice cannot be saved', async () => {
    mocks.setLocale.mockRejectedValue(new Error('no cookie'));
    mount();
    await press(button(fi.accept));
    expect(mocks.toastError).toHaveBeenCalledWith(en.settings.languageChangeFailed);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(['/mcp/authorize', '/admin/login', '/review/abc', '/deployments/d1/'])('stays off %s', (path) => {
    mocks.pathname = path;
    mount();
    expect(container.textContent).toBe('');
  });

  it('shows on the studio routes', () => {
    mocks.pathname = '/w/w1/dashboard';
    mount();
    expect(container.textContent).toContain(fi.message);
  });

  it('gives way to the backend-down banner and comes back after it', () => {
    mount();
    act(() => markBackendDown());
    expect(container.textContent).toBe('');
    act(() => markBackendUp());
    expect(container.textContent).toContain(fi.message);
  });

  it('gives way to the MCP activity banner', () => {
    mount();
    act(() => markMcpActivity({ kind: 'run', clientLabel: 'Claude', projectId: 'p1', projectName: 'Site' }));
    expect(container.textContent).toBe('');
  });
});
