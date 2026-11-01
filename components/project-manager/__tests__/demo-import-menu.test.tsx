// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The Import menu's way to the demo's projects: on a hosted instance behind the demo, it opens
 * the demo-import dialog by hand, the Import menu's own version of it rather than the arrival offer.
 */

const WS = 'w1';
const DEMO = 'https://try.example.com';

const openDemoBridge = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/vfs', () => ({ vfs: { init: vi.fn(async () => {}), listProjects: vi.fn(async () => []) } }));
vi.mock('@/lib/vfs/template-service', () => ({ templateService: { listCustomTemplates: vi.fn(async () => []) } }));
vi.mock('@/lib/vfs/templates/preview-project', () => ({ sweepTemplatePreviewProjects: vi.fn(async () => {}) }));
vi.mock('@/components/guided-tour/context', () => ({
  useGuidedTour: () => ({ state: { status: 'idle' }, setProjectList: () => {}, start: () => {} }),
}));
vi.mock('@/components/guided-tour/overlay', () => ({ GuidedTourOverlay: () => null }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ useViewMode: () => ['grid', () => {}], ViewModeToggle: () => null }));
vi.mock('@/lib/hooks/use-narrow-container', () => ({ useNarrowContainer: () => [false, () => {}] }));
// Server Mode's background pull, and the dialog's look at the workspace, find an empty server.
vi.mock('@/lib/vfs/auto-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vfs/auto-sync')>()),
  setAutoSyncWorkspaceId: vi.fn(),
  fetchSyncStatus: vi.fn(async () => null),
  autoPullAllProjects: vi.fn(async () => ({ pulled: 0, conflicts: [] })),
  reconcileProjectsToServer: vi.fn(async () => ({ pushed: 0, skipped: 0, errors: 0 })),
}));
vi.mock('@/lib/demo-bridge/client', () => ({ openDemoBridge }));

import { ProjectManager } from '..';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // The demo never answers, so the dialog stays on its first page.
  openDemoBridge.mockReturnValue(new Promise(() => {}));
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.hostedDemo;
  vi.unstubAllEnvs();
});

async function openImportMenu() {
  await act(async () => { root.render(withMessages(<ProjectManager onProjectSelect={() => {}} workspaceId={WS} />)); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  const trigger = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === en.common.actions.import);
  expect(trigger).toBeDefined();
  await act(async () => { trigger!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
}

const menuItem = (label: string) =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent === label);

describe('the Import menu', () => {
  it('opens the demo import by hand on an instance behind the demo', async () => {
    document.documentElement.dataset.hostedDemo = DEMO;
    await openImportMenu();
    const fromDemo = menuItem(en.demoImport.fromDemo);
    expect(fromDemo).toBeDefined();
    await act(async () => { fromDemo!.click(); });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(en.demoImport.manualTitle);
    expect(dialog?.textContent).not.toContain(en.demoImport.offerTitle);
    expect(openDemoBridge).toHaveBeenCalledWith(DEMO);
  });

  it('has no way to the demo on an instance without one', async () => {
    await openImportMenu();
    expect(menuItem(en.projects.fromFile)).toBeDefined();
    expect(menuItem(en.demoImport.fromDemo)).toBeUndefined();
  });
});
