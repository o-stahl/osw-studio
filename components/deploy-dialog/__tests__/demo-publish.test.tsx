// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** On the hosted demo, the OSW Studio target asks for a hosted account instead of Server Mode. */
vi.mock('@/lib/vfs', () => ({ vfs: {} }));
vi.mock('@/lib/config/storage', () => ({ configManager: { getHFAuth: () => null } }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: vi.fn(), loginHF: vi.fn() }));
vi.mock('../hf-space-target', () => ({ HFSpaceTarget: () => null }));
vi.mock('@/lib/deployments/pending-create', () => ({ requestDeploymentFor: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { DeployDialog } from '..';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
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
  delete document.documentElement.dataset.demoGateway;
  delete document.documentElement.dataset.demoAccounts;
});

function mount() {
  act(() => {
    root.render(withMessages(<DeployDialog open projectId="p1" onOpenChange={() => {}} />));
  });
}

describe('DeployDialog on the hosted demo', () => {
  it('offers signing in to the hosted service, in a new tab, where Server Mode would publish', () => {
    document.documentElement.dataset.demoGateway = 'https://gateway.example.com';
    document.documentElement.dataset.demoAccounts = 'on';
    mount();
    const signIn = Array.from(document.body.querySelectorAll('a')).find((a) => a.textContent === en.demo.signIn);
    expect(signIn?.getAttribute('href')).toBe('https://gateway.example.com/login');
    expect(signIn?.getAttribute('target')).toBe('_blank');
    expect(signIn?.getAttribute('rel')).toBe('noopener');
    expect(document.body.textContent).toContain(en.demo.publishHere);
    expect(document.body.textContent).toContain(en.demo.publishSubtitle);
    expect(document.body.textContent).not.toContain(en.deployDialog.availableInServerMode);
    expect(document.body.textContent).not.toContain(en.tooltips.publishHere);
  });

  it('points at Server Mode, as any Browser Mode install does, while the demo offers no accounts', () => {
    document.documentElement.dataset.demoGateway = 'https://gateway.example.com';
    mount();
    expect(document.body.textContent).toContain(en.deployDialog.availableInServerMode);
    expect(document.body.textContent).not.toContain(en.demo.publishHere);
    expect(Array.from(document.body.querySelectorAll('a')).some((a) => a.textContent === en.demo.signIn)).toBe(false);
  });

  it('still points a Browser Mode install at Server Mode', () => {
    mount();
    expect(document.body.textContent).toContain(en.deployDialog.availableInServerMode);
    expect(document.body.textContent).not.toContain(en.demo.publishHere);
  });
});
