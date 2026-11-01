// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The Browser Mode dashboard reads its counts from this browser's stores; an empty install is enough here.
vi.mock('@/lib/vfs', () => ({ vfs: { init: async () => {}, listProjects: async () => [] } }));
vi.mock('@/lib/vfs/template-service', () => ({ templateService: { listCustomTemplates: async () => [] } }));
vi.mock('@/lib/vfs/skills', () => ({ skillsService: { getAllSkills: async () => [] } }));

import { DashboardView, DemoCard } from '../dashboard-view';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

/**
 * The hosted demo's dashboard card: the storage note and the way to an account, shown only on the
 * demo that offers accounts.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // No What's New entry, so the dashboard needs nothing from the network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.demoGateway;
  delete document.documentElement.dataset.demoAccounts;
});

const link = (text: string) => Array.from(container.querySelectorAll('a')).find((a) => a.textContent === text);

describe('DemoCard', () => {
  it('says where projects are kept and links to creating an account and signing in, in a new tab', () => {
    act(() => {
      root.render(withMessages(<DemoCard signInUrl="https://g.example/login" signUpUrl="https://g.example/register" />));
    });
    expect(container.textContent).toContain(en.demo.cardBody);
    expect(link(en.demo.signUp)?.getAttribute('href')).toBe('https://g.example/register');
    expect(link(en.demo.signIn)?.getAttribute('href')).toBe('https://g.example/login');
    for (const label of [en.demo.signUp, en.demo.signIn]) {
      expect(link(label)?.getAttribute('target')).toBe('_blank');
      expect(link(label)?.getAttribute('rel')).toBe('noopener');
    }
  });
});

describe('DashboardView in Browser Mode', () => {
  async function renderDashboard() {
    await act(async () => { root.render(withMessages(<DashboardView />)); });
    await vi.waitFor(() => expect(container.textContent).toContain(en.dashboard.recentProjects));
  }

  it('shows the demo card on the demo that offers accounts', async () => {
    document.documentElement.dataset.demoGateway = 'https://g.example';
    document.documentElement.dataset.demoAccounts = 'on';
    await renderDashboard();
    expect(container.textContent).toContain(en.demo.cardBody);
    expect(link(en.demo.signUp)?.getAttribute('href')).toBe('https://g.example/register');
    expect(link(en.demo.signIn)?.getAttribute('href')).toBe('https://g.example/login');
  });

  it.each([
    ['on the demo while it offers no accounts', 'https://g.example'],
    ['on any other install', undefined],
  ])('shows no demo card %s', async (_, gateway) => {
    if (gateway) document.documentElement.dataset.demoGateway = gateway;
    await renderDashboard();
    expect(container.textContent).not.toContain(en.demo.cardBody);
  });
});
