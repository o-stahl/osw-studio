// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * Where signing in lands. A `?next=` path on this server is honoured; one a URL parser reads as
 * another host (`/\host`, `/` + tab + `/host`) falls back to the default workspace, so a crafted
 * login link cannot send the user off-site after they sign in.
 */

const nav = vi.hoisted(() => ({ query: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.query),
}));
vi.mock('@/components/language-menu', () => ({ LanguagePill: () => null }));

import LoginPage from '../page';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  nav.push.mockClear();
  nav.replace.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url === '/api/auth/setup-status'
      ? { needsSetup: false, registrationOpen: false }
      : { defaultWorkspaceId: 'ws-default' };
    return { ok: true, json: async () => body } as Response;
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signInWith(query: string) {
  nav.query = query;
  await act(async () => { root.render(withMessages(<LoginPage />)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const password = container.querySelector('#password') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(password, 'secret');
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('the ?next= destination after signing in', () => {
  it('is honoured for a path on this server', async () => {
    await signInWith('next=/w/x/projects');
    expect(nav.push).toHaveBeenCalledWith('/w/x/projects');
  });

  it.each([
    ['a backslash host', '/\\evil.com'],
    ['a tab between slashes (%09)', '/\t/evil.com'],
  ])('falls back to the default workspace for %s', async (_label, next) => {
    await signInWith(new URLSearchParams({ next }).toString());
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/w/ws-default/projects');
  });
});
