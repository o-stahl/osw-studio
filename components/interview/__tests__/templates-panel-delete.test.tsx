// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Deleting a custom interview template: a delete the server refused says why (the refusal's own
 * message, e.g. an expired session); any other failure says the delete failed.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
const service = vi.hoisted(() => ({
  getAllTemplates: vi.fn(),
  deleteTemplate: vi.fn(),
}));
vi.mock('@/lib/interview/templates-service', () => ({ interviewTemplatesService: service }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ useViewMode: () => ['grid', () => {}], ViewModeToggle: () => null }));
vi.mock('@/lib/hooks/use-narrow-container', () => ({ useNarrowContainer: () => [false, () => {}] }));

import { InterviewTemplatesPanel } from '../InterviewTemplatesPanel';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
const CUSTOM = {
  id: 'mine', title: 'Mine', description: 'd', isBuiltIn: false,
  artifacts: [{ path: '/.interviews/mine.md' }], items: [],
};

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  service.getAllTemplates.mockResolvedValue([CUSTOM]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function deleteMine(rejection: Error) {
  service.deleteTemplate.mockRejectedValue(rejection);
  await act(async () => { root.render(withMessages(<InterviewTemplatesPanel />)); });
  const open = container.querySelector<HTMLButtonElement>(`button[title="${en.common.actions.delete}"]`);
  expect(open).not.toBeNull();
  await act(async () => { open!.click(); });
  // The confirm dialog renders in a portal.
  const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
    .find(b => b.textContent === en.common.actions.delete);
  expect(confirm).toBeDefined();
  await act(async () => { confirm!.click(); });
  expect(service.deleteTemplate).toHaveBeenCalledWith('mine');
}

describe('deleting an interview template', () => {
  it("shows the server's refusal", async () => {
    await deleteMine(new ServerDeleteRefused('forbidden'));
    expect(toast.error).toHaveBeenCalledWith(en.sync.deleteRefused.forbidden);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says the delete failed on any other error', async () => {
    await deleteMine(new Error('quota exceeded'));
    expect(toast.error).toHaveBeenCalledWith(en.interviews.deleteFailed);
  });
});
