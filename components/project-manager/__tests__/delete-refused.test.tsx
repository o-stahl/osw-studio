// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Deleting a project from the gallery: a delete the server refused says why (the refusal's own
 * message, e.g. a deployment still uses the project); any other failure says the delete failed.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const PROJECT = vi.hoisted(() => ({ id: 'p1', name: 'Site', description: '', createdAt: new Date(), updatedAt: new Date() }));
const vfsMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listProjects: vi.fn(async () => [PROJECT]),
}));
vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/vfs/template-service', () => ({ templateService: { listCustomTemplates: vi.fn(async () => []) } }));
vi.mock('@/lib/vfs/templates/preview-project', () => ({ sweepTemplatePreviewProjects: vi.fn(async () => {}) }));
vi.mock('@/components/guided-tour/context', () => ({
  useGuidedTour: () => ({ state: { status: 'idle' }, setProjectList: () => {}, start: () => {} }),
}));
vi.mock('@/components/guided-tour/overlay', () => ({ GuidedTourOverlay: () => null }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ useViewMode: () => ['grid', () => {}], ViewModeToggle: () => null }));
vi.mock('@/lib/hooks/use-narrow-container', () => ({ useNarrowContainer: () => [false, () => {}] }));
// The card is a separate component; here it only has to hand its project to the manager's delete.
vi.mock('../project-card', () => ({
  ProjectCard: ({ project, onDelete }: { project: { id: string }; onDelete: (p: unknown) => void }) => (
    <button data-delete={project.id} onClick={() => onDelete(project)} />
  ),
}));
const deleteProjectServerFirst = vi.hoisted(() => vi.fn());
vi.mock('@/lib/vfs/auto-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vfs/auto-sync')>()),
  deleteProjectServerFirst,
}));

import { ProjectManager } from '..';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal('confirm', () => true);
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

async function deleteSite(rejection: Error) {
  deleteProjectServerFirst.mockRejectedValue(rejection);
  await act(async () => { root.render(withMessages(<ProjectManager onProjectSelect={() => {}} />)); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  const del = container.querySelector<HTMLButtonElement>('[data-delete="p1"]');
  expect(del).not.toBeNull();
  await act(async () => { del!.click(); });
  expect(deleteProjectServerFirst).toHaveBeenCalledWith('p1');
}

describe('deleting a project', () => {
  it("shows the server's refusal", async () => {
    await deleteSite(new ServerDeleteRefused('in_use'));
    expect(toast.error).toHaveBeenCalledWith(en.sync.deleteRefused.in_use);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says the delete failed on any other error', async () => {
    await deleteSite(new Error('disk full'));
    expect(toast.error).toHaveBeenCalledWith(en.projects.deleteFailed);
  });
});
