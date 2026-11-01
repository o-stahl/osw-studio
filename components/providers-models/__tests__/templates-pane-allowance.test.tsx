// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A model template whose agent is the free allowance: no warning while the allowance counts as
 * connected, which its status check decides rather than a key.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

import { TemplatesPane } from '../templates-pane';
import { configManager } from '@/lib/config/storage';
import { checkAllowance, resetAllowanceStatus } from '@/lib/inference/allowance-status';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetAllowanceStatus();
  document.documentElement.dataset.demoGateway = 'https://gateway.oswstudio.com';
  const assignment = structuredClone(Object.values(configManager.getModelTemplates())[0].assignment);
  configManager.saveModelTemplate({ id: 'free', name: 'Free one', builtin: false, assignment: { ...assignment, agent: { provider: 'osws', model: 'osws/agent' } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAllowanceStatus();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.demoGateway;
});

/** The card of the template named "Free one". */
function card(): HTMLElement {
  const name = [...container.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent === 'Free one');
  const found = name?.closest<HTMLElement>('.bg-card');
  if (!found) throw new Error('no card for the template');
  return found;
}
const warning = en.connections.needsProvider.replace('{provider}', 'OSW Studio');

describe('a template whose agent is the free allowance', () => {
  it('has no warning until the status check fails', async () => {
    act(() => { root.render(withMessages(<TemplatesPane />)); });
    expect(card().textContent).not.toContain(warning);

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ available: false }), { status: 200 }));
    await checkAllowance();
    act(() => { root.render(withMessages(<TemplatesPane key="again" />)); });
    expect(card().textContent).toContain(warning);
  });
});
