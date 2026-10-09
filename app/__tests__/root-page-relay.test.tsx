// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * The HuggingFace Space's popup, back from a relayed provider sign-in, shows the relay screen in
 * place of the studio; any other visit to the root gets the studio.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/components/studio-app', () => ({ StudioApp: () => <div data-testid="studio" /> }));
vi.mock('@/components/sign-in-relay', () => ({ SignInRelay: () => <div data-testid="relay" /> }));

import Home from '../page';

const PENDING_KEY = 'osw_provider_sign_ins';
let container: HTMLElement;
let root: Root;

function pending(relay: boolean) {
  localStorage.setItem(PENDING_KEY, JSON.stringify({
    n1: { provider: 'openrouter', verifier: 'v'.repeat(43), redirectUri: 'https://huggingface.co/spaces/o/s', returnProject: null, ...(relay ? { relay: true } : {}), startedAt: Date.now() },
  }));
}

async function render() {
  await act(async () => root.render(withMessages(<Home />)));
}

const shown = () => container.querySelector('[data-testid]')?.getAttribute('data-testid');

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '/');
});

describe('the root page', () => {
  it('shows the relay screen for a relayed sign-in coming back', async () => {
    pending(true);
    window.history.replaceState(null, '', '/?code=abc');
    await render();
    expect(shown()).toBe('relay');
  });

  it('shows the studio for an ordinary sign-in return, which the studio finishes', async () => {
    pending(false);
    window.history.replaceState(null, '', '/?code=abc');
    await render();
    expect(shown()).toBe('studio');
  });

  it('shows the studio when the page is not a return', async () => {
    pending(true);
    await render();
    expect(shown()).toBe('studio');
  });
});
