// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Deleting a saved model template: a delete the server refused says why (the refusal's own
 * message, e.g. an expired session); any other failure says the delete failed.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

import { TemplatesPane } from '../templates-pane';
import { configManager } from '@/lib/config/storage';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  const assignment = structuredClone(Object.values(configManager.getModelTemplates())[0].assignment);
  configManager.saveModelTemplate({ id: 'mine', name: 'Mine', builtin: false, assignment });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function deleteMine(rejection: Error) {
  vi.spyOn(configManager, 'deleteModelTemplate').mockRejectedValue(rejection);
  act(() => { root.render(withMessages(<TemplatesPane />)); });
  const del = Array.from(container.querySelectorAll('button')).filter(b => b.textContent === en.common.actions.delete);
  expect(del).toHaveLength(1);
  await act(async () => { del[0].click(); });
}

describe('deleting a model template', () => {
  it("shows the server's refusal", async () => {
    await deleteMine(new ServerDeleteRefused('auth'));
    expect(toast.error).toHaveBeenCalledWith(en.sync.deleteRefused.auth);
  });

  it('says the delete failed on any other error', async () => {
    await deleteMine(new Error('quota exceeded'));
    expect(toast.error).toHaveBeenCalledWith(en.connections.deleteTemplateFailed);
  });
});
