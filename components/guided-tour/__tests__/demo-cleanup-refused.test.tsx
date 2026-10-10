// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Leaving the tour deletes its demo project when there are others. A delete the server refused
 * keeps the demo project and says why; any other cleanup failure is only logged. The refusal is
 * recognised by its name, since the tour loads auto-sync with a dynamic import.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('../demo-runner', () => ({ runGuidedDemoEdit: vi.fn(), runGuidedFocusDemo: vi.fn() }));
vi.mock('@/lib/vfs/checkpoint', () => ({ checkpointManager: { restoreCheckpoint: vi.fn() } }));
vi.mock('@/lib/vfs/save-manager', () => ({ saveManager: { runWithSuppressedDirty: vi.fn() } }));
const vfsMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listProjects: vi.fn(async () => [{ id: 'demo' }, { id: 'other' }]),
}));
vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
const deleteProjectServerFirst = vi.hoisted(() => vi.fn());
vi.mock('@/lib/vfs/auto-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vfs/auto-sync')>()),
  deleteProjectServerFirst,
}));

import { GuidedTourProvider, useGuidedTour } from '../context';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
let tour: ReturnType<typeof useGuidedTour>;
let consoleError: ReturnType<typeof vi.spyOn>;

function Probe() {
  tour = useGuidedTour();
  return null;
}

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function skipTourWhileDeleteFails(error: Error) {
  deleteProjectServerFirst.mockRejectedValue(error);
  act(() => { root.render(<GuidedTourProvider><Probe /></GuidedTourProvider>); });
  act(() => { tour.setTourDemoProjectId('demo'); });
  await act(async () => { tour.skip(); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  expect(deleteProjectServerFirst).toHaveBeenCalledWith('demo');
}

describe('cleaning up the tour demo project', () => {
  it("shows the server's refusal", async () => {
    await skipTourWhileDeleteFails(new ServerDeleteRefused('auth'));
    expect(toast.error).toHaveBeenCalledWith(en.sync.deleteRefused.auth);
  });

  it('recognises a refusal by its name', async () => {
    const refusal = Object.assign(new Error(en.sync.deleteRefused.failed), { name: 'ServerDeleteRefused' });
    await skipTourWhileDeleteFails(refusal);
    expect(toast.error).toHaveBeenCalledWith(en.sync.deleteRefused.failed);
  });

  it('only logs any other failure', async () => {
    await skipTourWhileDeleteFails(new Error('disk full'));
    expect(toast.error).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});
