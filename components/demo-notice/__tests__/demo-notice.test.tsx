// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The hosted demo's top bar: where projects are kept, and the hosted service for keeping them on a
 * server. Dismissed for good with a cookie; out of the way of the urgent banners and of the pages
 * that are not the studio.
 */
const mocks = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));

import { DemoNotice } from '..';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { markBackendDown, markBackendUp, markAuthExpired, clearAuthExpired } from '@/lib/api/backend-status';
import { markMcpActivity, clearMcpActivity } from '@/lib/api/mcp-activity';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.pathname = '/';
  document.cookie = 'osws_demo_notice=; path=/; max-age=0';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  markBackendUp();
  clearAuthExpired();
  clearMcpActivity();
  vi.restoreAllMocks();
});

function mount() {
  act(() => {
    root.render(withMessages(
      <DemoNotice signInUrl="https://gateway.example.com/login" signUpUrl="https://gateway.example.com/register" />,
    ));
  });
}

const link = (text: string) => Array.from(container.querySelectorAll('a')).find((a) => a.textContent === text);
const notice = () => container.querySelector('[role="status"]');

describe('DemoNotice', () => {
  it('says where projects are kept and links to the hosted service, in a new tab', () => {
    mount();
    expect(container.textContent).toContain(en.demo.notice);
    expect(link(en.demo.signUp)?.getAttribute('href')).toBe('https://gateway.example.com/register');
    expect(link(en.demo.signIn)?.getAttribute('href')).toBe('https://gateway.example.com/login');
    for (const label of [en.demo.signUp, en.demo.signIn]) {
      expect(link(label)?.getAttribute('target')).toBe('_blank');
      expect(link(label)?.getAttribute('rel')).toBe('noopener');
    }
  });

  it('goes away when dismissed, and writes the cookie that keeps it away', async () => {
    const written = vi.spyOn(document, 'cookie', 'set');
    mount();
    const close = container.querySelector(`button[aria-label="${en.common.actions.dismiss}"]`);
    await act(async () => { close!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(notice()).toBeNull();
    expect(document.cookie).toContain('osws_demo_notice=dismissed');
    // For every page and for later visits: a session cookie, or one scoped to this path, brings it back.
    const cookie = written.mock.calls.map(([value]) => value).find((value) => value.startsWith('osws_demo_notice=dismissed'));
    expect(cookie).toMatch(/;\s*path=\/\s*(;|$)/);
    expect(cookie).toMatch(/;\s*max-age=31536000\s*(;|$)/);
  });

  it('takes room at the top while it shows, instead of covering the studio, and gives it back', async () => {
    mount();
    expect(document.documentElement.style.getPropertyValue('--app-top-offset')).not.toBe('');
    const close = container.querySelector(`button[aria-label="${en.common.actions.dismiss}"]`);
    await act(async () => { close!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.documentElement.style.getPropertyValue('--app-top-offset')).toBe('');
  });

  it('gives the room back when it stops being rendered, as after a refresh that leaves it out', () => {
    mount();
    expect(document.documentElement.style.getPropertyValue('--app-top-offset')).not.toBe('');
    act(() => root.render(withMessages(<div />)));
    expect(document.documentElement.style.getPropertyValue('--app-top-offset')).toBe('');
  });

  it('stays away while an urgent banner is already up', () => {
    markBackendDown();
    mount();
    expect(notice()).toBeNull();
  });

  it('gives way to the backend-down banner and comes back after it', () => {
    mount();
    act(() => markBackendDown());
    expect(notice()).toBeNull();
    act(() => markBackendUp());
    expect(notice()).not.toBeNull();
  });

  it('gives way to the expired-session banner and comes back after it', () => {
    mount();
    act(() => markAuthExpired());
    expect(notice()).toBeNull();
    act(() => clearAuthExpired());
    expect(notice()).not.toBeNull();
  });

  it('gives way to the MCP activity banner and comes back after it', () => {
    mount();
    act(() => markMcpActivity({ kind: 'run', clientLabel: 'Claude', projectId: 'p1', projectName: 'Site' }));
    expect(notice()).toBeNull();
    act(() => clearMcpActivity());
    expect(notice()).not.toBeNull();
  });

  it.each(['/mcp/authorize', '/admin/login', '/review/abc', '/deployments/abc', '/demo-bridge'])('stays off %s', (path) => {
    mocks.pathname = path;
    mount();
    expect(notice()).toBeNull();
  });
});
