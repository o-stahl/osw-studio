// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';

/**
 * Bringing a visitor's demo projects into their new workspace: offered once, on the landing the
 * gateway marks, into an empty workspace only; what reaches the server is what may leave the demo.
 */
const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DEMO = 'https://demo.example.com';

const state = vi.hoisted(() => ({
  serverProjects: [] as { id: string }[],
  quota: null as null | { projects: { used: number; max: number } },
  pushed: [] as string[],
  /** Listed by the server from a first batch, but never stamped as pushed: the rest did not land. */
  partial: [] as string[],
  /** Stamped as pushed in this browser, yet missing from the server's list. */
  unlisted: [] as string[],
  /** Backend features in this browser, per project; the file sync does not carry them. */
  edgeFunctions: {} as Record<string, Array<{ id: string; name: string }>>,
  backendPushed: [] as Array<{ projectId: string; edgeFunctions: unknown[] }>,
  backendRefused: false,
  /** Projects this browser already holds for the workspace. */
  localProjects: [] as { id: string }[],
}));
const bridge = vi.hoisted(() => ({
  list: vi.fn(),
  exportProjects: vi.fn(async () => new Blob(['zip'])),
  deleteProjects: vi.fn(async (ids: string[]) => ids.length),
  close: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  openDemoBridge: vi.fn(),
  importAllData: vi.fn(async () => {}),
  apiFetch: vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));

vi.mock('@/lib/demo', () => ({ hostedDemoOrigin: () => DEMO }));
vi.mock('@/lib/demo-bridge/client', () => ({ openDemoBridge: mocks.openDemoBridge }));
vi.mock('@/lib/vfs/backup-service', () => ({ BackupService: { importAllData: mocks.importAllData } }));
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/vfs/auto-sync', () => ({
  setAutoSyncWorkspaceId: vi.fn(),
  invalidateSyncStatusCache: vi.fn(),
  fetchSyncStatus: vi.fn(async () => ({ projects: state.serverProjects, quota: state.quota })),
  reconcileProjectsToServer: vi.fn(async () => {
    const listed = [...state.pushed, ...state.partial].filter((id) => !state.unlisted.includes(id));
    state.serverProjects = [...state.serverProjects, ...listed.map((id) => ({ id }))];
    return { pushed: state.pushed.length, skipped: 0, errors: state.partial.length };
  }),
}));
vi.mock('@/lib/vfs/sync-manager', () => ({
  getSyncManager: () => ({
    pushBackendFeatures: async (projectId: string, features: { edgeFunctions: unknown[] }) => {
      if (state.backendRefused) return { success: false, error: 'refused' };
      state.backendPushed.push({ projectId, edgeFunctions: features.edgeFunctions });
      return { success: true };
    },
  }),
}));
vi.mock('@/lib/vfs', () => ({
  vfs: {
    listProjects: async () => state.localProjects,
    getStorageAdapter: () => ({
      listEdgeFunctions: async (projectId: string) => state.edgeFunctions[projectId] ?? [],
      listServerFunctions: async () => [],
      listSecrets: async () => [],
      listScheduledFunctions: async () => [],
    }),
    getProject: async (id: string) => {
      const at = '2026-10-17T09:00:00.000Z';
      const whole = state.pushed.includes(id);
      return { id, updatedAt: at, serverUpdatedAt: whole ? at : undefined, lastSyncedAt: whole ? at : undefined };
    },
  },
}));

import { DemoImportDialog, DemoImportOffer } from '..';
import { DEMO_OFFER_WAIT_MS, demoOfferDecision, resetDemoOffer, settleDemoOffer } from '@/lib/demo-bridge/offer';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { fetchSyncStatus, reconcileProjectsToServer } from '@/lib/vfs/auto-sync';
import en from '@/messages/en.json';

const t = createTranslator({ locale: 'en', messages: en, namespace: 'demoImport' });

const PROJECTS = [
  { id: 'a', name: 'Bakery site', updatedAt: '2026-10-16T09:00:00.000Z', fileCount: 4 },
  { id: 'b', name: 'Portfolio', updatedAt: '2026-10-15T09:00:00.000Z', fileCount: 2 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  resetDemoOffer();
  state.serverProjects = [];
  state.quota = null;
  state.pushed = ['a', 'b'];
  state.partial = [];
  state.unlisted = [];
  state.edgeFunctions = {};
  state.backendPushed = [];
  state.backendRefused = false;
  state.localProjects = [];
  bridge.list.mockResolvedValue({ projects: PROJECTS, unreachable: 0 });
  mocks.openDemoBridge.mockResolvedValue(bridge);
  // jsdom does not navigate; the dialog reloads the page when it is done.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '/');
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const text = () => document.body.textContent ?? '';
const button = (label: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === label);
async function press(label: string) {
  const el = button(label);
  if (!el) throw new Error(`no button "${label}"`);
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
}

async function arrive(search: string, { strict = false, owner = true } = {}) {
  window.history.replaceState(null, '', `/w/${WS}/dashboard${search}`);
  const offer = withMessages(<DemoImportOffer workspaceId={WS} owner={owner} />);
  // At the root, as Next.js applies it: a nested StrictMode does not run effects twice.
  act(() => root.render(strict ? <React.StrictMode>{offer}</React.StrictMode> : offer));
  await settle();
}

const handled = () => mocks.apiFetch.mock.calls.filter(([url, init]) => url === `/api/w/${WS}/demo-import` && (init as RequestInit)?.method === 'POST');

describe('DemoImportOffer', () => {
  it('stays quiet without the mark the gateway puts on the landing', async () => {
    await arrive('');
    expect(mocks.openDemoBridge).not.toHaveBeenCalled();
  });

  it('takes the mark off the address, and asks nothing in a workspace that has projects', async () => {
    state.serverProjects = [{ id: 'existing' }];
    await arrive('?demo_import=1');
    expect(window.location.search).toBe('');
    expect(mocks.openDemoBridge).not.toHaveBeenCalled();
    // The first run still goes ahead (lib/demo-bridge/offer.ts).
    expect(demoOfferDecision()).toBe('none');
  });

  it('asks a member who does not own the workspace nothing, and tells the first run so at once', async () => {
    await arrive('?demo_import=1', { owner: false });
    expect(window.location.search).toBe('');
    expect(mocks.openDemoBridge).not.toHaveBeenCalled();
    expect(demoOfferDecision()).toBe('none');
  });

  it('asks nothing when the server does not say what the workspace holds, and tells the first run so at once', async () => {
    vi.mocked(fetchSyncStatus).mockResolvedValueOnce(null);
    await arrive('?demo_import=1');
    expect(mocks.openDemoBridge).not.toHaveBeenCalled();
    expect(demoOfferDecision()).toBe('none');
  });

  it('lists the demo projects in an empty workspace, brings the chosen ones, and removes only what reached the server', async () => {
    state.pushed = ['a'];
    await arrive('?demo_import=1');
    expect(mocks.openDemoBridge.mock.calls[0][0]).toBe(DEMO);
    expect(text()).toContain(en.demoImport.offerTitle);
    // Asked: the first run makes no starter project of its own.
    expect(demoOfferDecision()).toBe('offered');
    expect(text()).toContain('Bakery site');
    expect(text()).toContain('Portfolio');

    await press(t('import', { count: 2 }));
    expect(bridge.exportProjects).toHaveBeenCalledWith(['a', 'b']);
    expect(mocks.importAllData).toHaveBeenCalledWith(expect.any(File), { mode: 'merge' });
    expect(handled()).toHaveLength(1);
    expect(text()).toContain(t('imported', { count: 1 }));
    expect(text()).toContain(t('notSaved', { count: 1 }));

    await press(en.demoImport.remove);
    expect(bridge.deleteProjects).toHaveBeenCalledWith(['a']);
  });

  it('counts a project the server lists but did not get whole as not saved, and offers to remove only the rest', async () => {
    state.pushed = ['a'];
    state.partial = ['b'];
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(text()).toContain(t('imported', { count: 1 }));
    expect(text()).toContain(t('notSaved', { count: 1 }));
    await press(en.demoImport.remove);
    expect(bridge.deleteProjects).toHaveBeenCalledWith(['a']);
  });

  it("counts a project stamped as pushed but missing from the server's list as not saved, and leaves it in the demo", async () => {
    state.unlisted = ['b'];
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(text()).toContain(t('imported', { count: 1 }));
    expect(text()).toContain(t('notSaved', { count: 1 }));
    await press(en.demoImport.remove);
    expect(bridge.deleteProjects).toHaveBeenCalledWith(['a']);
  });

  it("takes a project's backend features to the server, and counts it imported only once they arrive", async () => {
    state.edgeFunctions = { a: [{ id: 'fn-1', name: 'contact' }] };
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(state.backendPushed).toEqual([{ projectId: 'a', edgeFunctions: [{ id: 'fn-1', name: 'contact' }] }]);
    expect(text()).toContain(t('imported', { count: 2 }));
  });

  it('leaves a project whose backend features did not reach the server in the demo', async () => {
    state.edgeFunctions = { a: [{ id: 'fn-1', name: 'contact' }] };
    state.backendRefused = true;
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(text()).toContain(t('imported', { count: 1 }));
    expect(text()).toContain(t('notSaved', { count: 1 }));
    await press(en.demoImport.remove);
    expect(bridge.deleteProjects).toHaveBeenCalledWith(['b']);
  });

  it('asks under Strict Mode too, which runs the effect twice after the mark is taken off', async () => {
    await arrive('?demo_import=1', { strict: true });
    expect(mocks.openDemoBridge).toHaveBeenCalledTimes(1);
    expect(text()).toContain(en.demoImport.offerTitle);
  });

  it('chooses nothing when the demo has more than the plan has room for, though it listed them first', async () => {
    state.quota = { projects: { used: 0, max: 3 } };
    bridge.list.mockResolvedValue({ projects: [...PROJECTS, { ...PROJECTS[0], id: 'c', name: 'Band page' }, { ...PROJECTS[0], id: 'd', name: 'Blog' }], unreachable: 0 });
    await arrive('?demo_import=1');
    expect(text()).toContain(t('room', { count: 3 }));
    expect(document.body.querySelectorAll('button[role="checkbox"][data-state="checked"]')).toHaveLength(0);
    expect(button(t('import', { count: 0 }))?.disabled).toBe(true);
  });

  it('closes the bridge when the workspace is left before the demo answers', async () => {
    let answer!: (list: { projects: typeof PROJECTS; unreachable: number }) => void;
    bridge.list.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await arrive('?demo_import=1');
    expect(mocks.openDemoBridge).toHaveBeenCalled();
    act(() => root.unmount());
    await act(async () => { answer({ projects: PROJECTS, unreachable: 0 }); });
    expect(bridge.close).toHaveBeenCalled();
    root = createRoot(container);
  });

  it('takes its hidden frame along when the workspace is left with the offer open', async () => {
    await arrive('?demo_import=1');
    expect(text()).toContain(en.demoImport.offerTitle);
    bridge.close.mockClear();
    act(() => root.unmount());
    expect(bridge.close).toHaveBeenCalled();
    root = createRoot(container);
  });

  it('says so when this browser will not store the projects, and leaves the offer open', async () => {
    mocks.importAllData.mockRejectedValueOnce(new Error('too large'));
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(text()).toContain(en.demoImport.notAdded);
    expect(text()).not.toContain(en.demoImport.failed);
    expect(handled()).toHaveLength(0);
  });

  it('says so when the demo does not send the projects, and leaves the offer open', async () => {
    bridge.exportProjects.mockRejectedValueOnce(new Error('The demo did not answer'));
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(text()).toContain(en.demoImport.failed);
    expect(mocks.importAllData).not.toHaveBeenCalled();
    expect(button(en.demoImport.remove)).toBeUndefined();
    await press(en.demoImport.close);
    expect(handled()).toHaveLength(0);
    expect(bridge.deleteProjects).not.toHaveBeenCalled();
  });

  it('offers to remove nothing from the demo when the push to the server fails, and leaves the offer open', async () => {
    vi.mocked(reconcileProjectsToServer).mockRejectedValueOnce(new Error('offline'));
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(text()).toContain(t('imported', { count: 0 }));
    expect(text()).toContain(t('notSaved', { count: 2 }));
    expect(button(en.demoImport.remove)).toBeUndefined();
    await press(en.demoImport.close);
    expect(handled()).toHaveLength(0);
    expect(bridge.deleteProjects).not.toHaveBeenCalled();
  });

  it('says so when the demo keeps its copies, and still shows what was imported', async () => {
    bridge.deleteProjects.mockRejectedValueOnce(new Error('The demo did not answer'));
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    await press(en.demoImport.remove);
    expect(text()).toContain(en.demoImport.notRemoved);
    expect(button(en.demoImport.close)).toBeDefined();
  });

  it('leaves the offer open when nothing reached the server', async () => {
    state.pushed = [];
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    expect(handled()).toHaveLength(0);
    expect(text()).toContain(t('notSaved', { count: 2 }));
    expect(bridge.deleteProjects).not.toHaveBeenCalled();
  });

  it('stays away when the first visit has stopped waiting for it', async () => {
    // The first run's wait ran out before the demo answered: it went ahead with a starter project.
    settleDemoOffer('none');
    await arrive('?demo_import=1');
    expect(text()).not.toContain(en.demoImport.offerTitle);
    expect(bridge.close).toHaveBeenCalled();
  });

  it("opens the bridge with a limit that leaves time to open it and list inside the first visit's wait", async () => {
    await arrive('?demo_import=1');
    expect(mocks.openDemoBridge).toHaveBeenCalledWith(DEMO, { timeoutMs: expect.any(Number) });
    const { timeoutMs } = mocks.openDemoBridge.mock.calls[0][1] as { timeoutMs: number };
    // The client gives opening the frame this limit, and the list request the same again.
    expect(2 * timeoutMs).toBeLessThan(DEMO_OFFER_WAIT_MS);
  });

  it('lets the first run go ahead at once when the demo does not load', async () => {
    mocks.openDemoBridge.mockRejectedValueOnce(new Error('The demo did not load'));
    await arrive('?demo_import=1');
    expect(demoOfferDecision()).toBe('none');
  });

  it('closes the bridge, and lets the first run go ahead at once, when the demo does not answer', async () => {
    bridge.list.mockRejectedValueOnce(new Error('The demo did not answer'));
    await arrive('?demo_import=1');
    expect(bridge.close).toHaveBeenCalled();
    expect(demoOfferDecision()).toBe('none');
  });

  it('asks nothing, and closes the bridge, when the demo has nothing at all', async () => {
    bridge.list.mockResolvedValue({ projects: [], unreachable: 0 });
    await arrive('?demo_import=1');
    expect(text()).not.toContain(en.demoImport.offerTitle);
    expect(bridge.close).toHaveBeenCalled();
    expect(demoOfferDecision()).toBe('none');
  });

  it('explains export and import when the demo has projects the bridge page cannot read (Safari)', async () => {
    bridge.list.mockResolvedValue({ projects: [], unreachable: 2 });
    await arrive('?demo_import=1');
    expect(text()).toContain(en.demoImport.offerTitle);
    expect(text()).toContain(t('unreachable', { count: 2 }));
    expect(text()).toContain(t('unreachableExport', { exportJson: en.projects.menu.exportJson }));
    expect(text()).toContain(t('unreachableImport', { import: en.common.actions.import, fromFile: en.projects.fromFile }));
    const link = Array.from(document.body.querySelectorAll('a')).find((a) => a.textContent === en.demoImport.openDemo)!;
    expect(link.getAttribute('href')).toBe(DEMO);
    expect(link.getAttribute('target')).toBe('_blank');

    // Opening the demo settles the offer and leaves the steps on screen.
    document.addEventListener('click', (e) => e.preventDefault(), { once: true, capture: true });
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await settle();
    expect(handled()).toHaveLength(1);
    expect(text()).toContain(en.demoImport.openDemo);

    await press(en.demoImport.close);
    expect(handled()).toHaveLength(2);
    expect(text()).not.toContain(en.demoImport.offerTitle);
  });

  it('says no for good with "No thanks", bringing nothing and leaving the demo as it is', async () => {
    await arrive('?demo_import=1');
    await press(en.demoImport.noThanks);
    expect(handled()).toHaveLength(1);
    expect(mocks.importAllData).not.toHaveBeenCalled();
    expect(bridge.deleteProjects).not.toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalled();
  });

  it('keeps the demo copies with "Keep them" after the import', async () => {
    await arrive('?demo_import=1');
    await press(t('import', { count: 2 }));
    await press(en.demoImport.keep);
    expect(bridge.deleteProjects).not.toHaveBeenCalled();
    expect(text()).not.toContain(en.demoImport.offerTitle);
  });
});

describe('DemoImportDialog', () => {
  it('lists only the demo projects this workspace does not have yet, and brings only those', async () => {
    // Brought over before with "Keep them": on the server, and in this browser.
    state.serverProjects = [{ id: 'a' }];
    state.localProjects = [{ id: 'a' }];
    state.pushed = ['b'];
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={() => {}} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    expect(text()).not.toContain('Bakery site');
    expect(text()).toContain('Portfolio');
    await press(t('import', { count: 1 }));
    expect(bridge.exportProjects).toHaveBeenCalledWith(['b']);
  });

  it('says so when everything in the demo is already here', async () => {
    state.serverProjects = [{ id: 'a' }];
    state.localProjects = [{ id: 'b' }];
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={() => {}} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    expect(text()).toContain(en.demoImport.allHere);
    expect(button(t('import', { count: 0 }))).toBeUndefined();
  });

  it("chooses nothing for the user when the demo has more than the plan has room for", async () => {
    state.serverProjects = [{ id: 'x' }, { id: 'y' }];
    state.quota = { projects: { used: 2, max: 3 } };
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={() => {}} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    expect(text()).toContain(t('room', { count: 1 }));
    expect(button(t('import', { count: 0 }))?.disabled).toBe(true);

    const boxes = Array.from(document.body.querySelectorAll('button[role="checkbox"]'));
    await act(async () => { boxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(button(t('import', { count: 1 }))?.disabled).toBe(false);
    await act(async () => { boxes[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(button(t('import', { count: 2 }))?.disabled).toBe(true);
  });

  it('takes its hidden frame along when it goes away without finishing', async () => {
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={() => {}} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    bridge.close.mockClear();
    act(() => root.unmount());
    expect(bridge.close).toHaveBeenCalled();
    root = createRoot(container);
  });

  it('explains export and import from the Import menu too, and settles nothing there', async () => {
    bridge.list.mockResolvedValue({ projects: [], unreachable: 1 });
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={() => {}} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    expect(text()).toContain(t('unreachable', { count: 1 }));
    await press(en.demoImport.close);
    expect(handled()).toHaveLength(0);
  });

  it('says so when the demo in this browser has nothing', async () => {
    bridge.list.mockResolvedValue({ projects: [], unreachable: 0 });
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={() => {}} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    expect(text()).toContain(en.demoImport.empty);
  });

  it('says the demo could not be reached when its bridge does not open', async () => {
    mocks.openDemoBridge.mockRejectedValueOnce(new Error('The demo did not load'));
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={() => {}} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    expect(text()).toContain(en.demoImport.failed);
    expect(button(en.demoImport.close)).toBeDefined();
  });

  it('stays open on the import when the demo keeps its copies, rather than finishing as if they went', async () => {
    bridge.deleteProjects.mockRejectedValueOnce(new Error('The demo did not answer'));
    const onOpenChange = vi.fn();
    act(() => root.render(withMessages(
      <DemoImportDialog open onOpenChange={onOpenChange} workspaceId={WS} demoOrigin={DEMO} mode="manual" />,
    )));
    await settle();
    await press(t('import', { count: 2 }));
    await press(en.demoImport.remove);
    expect(text()).toContain(en.demoImport.notRemoved);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();

    await press(en.demoImport.close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(bridge.close).toHaveBeenCalled();
  });
});
