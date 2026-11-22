// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Settings → Data: how many unpinned automatic checkpoints, and how many saves, each project keeps.
 * Stored in this browser, with the checkpoints, and read by pruning (`unpinnedLimit`, `savesLimit`).
 */

vi.mock('@/lib/vfs/backup-service', () => ({ BackupService: { exportAllData: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/components/about-modal', () => ({ AboutModal: () => null }));

import { DataPane } from '../data-pane';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { savesLimit, unpinnedLimit } from '@/lib/vfs/checkpoint';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;

const group = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const automatic = () => group(en.settings.checkpointsKept);
const saves = () => group(en.settings.savesKept);
const options = (scope: HTMLElement) => [...scope.querySelectorAll('[role="radio"]')].map((b) => b.textContent);
const choice = (scope: HTMLElement, n: number) => [...scope.querySelectorAll('[role="radio"]')].find((b) => b.textContent === String(n)) as HTMLElement;

async function render() {
  await act(async () => { root.render(withMessages(<DataPane />)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

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
  localStorage.clear();
});

describe('automatic checkpoints kept per project', () => {
  it('offers 5, 10, 20 and 50, with 10 chosen until something else is', async () => {
    await render();
    expect(options(automatic())).toEqual(['5', '10', '20', '50']);
    expect(choice(automatic(), 10).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the number this browser chose', async () => {
    localStorage.setItem('osw-studio-settings', JSON.stringify({ checkpointsKept: 50 }));
    await render();
    expect(choice(automatic(), 50).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a new choice where pruning reads it', async () => {
    await render();
    await act(async () => { choice(automatic(), 20).click(); });
    expect(choice(automatic(), 20).getAttribute('aria-checked')).toBe('true');
    expect(unpinnedLimit()).toBe(20);
    expect(savesLimit()).toBe(5);
  });
});

describe('saves kept per project', () => {
  it('offers 3, 5, 10 and 20, with 5 chosen until something else is', async () => {
    await render();
    expect(options(saves())).toEqual(['3', '5', '10', '20']);
    expect(choice(saves(), 5).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the number this browser chose', async () => {
    localStorage.setItem('osw-studio-settings', JSON.stringify({ savesKept: 10 }));
    await render();
    expect(choice(saves(), 10).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a new choice where pruning reads it, apart from the automatic one', async () => {
    await render();
    await act(async () => { choice(saves(), 3).click(); });
    expect(choice(saves(), 3).getAttribute('aria-checked')).toBe('true');
    expect(savesLimit()).toBe(3);
    expect(unpinnedLimit()).toBe(10);
  });
});
