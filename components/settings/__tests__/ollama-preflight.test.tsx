// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The Ollama setup check in the Connections pane: one row per check with a copyable fix
 * command on the failed ones, and a telemetry event that names which checks failed.
 */

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  track: vi.fn(),
  agent: { provider: 'ollama', model: 'qwen3:4b' },
  providerModel: null as string | null,
}));

vi.mock('@/lib/api/backend-status', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/telemetry', () => ({ track: mocks.track }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getActiveAssignment: () => ({ agent: mocks.agent }),
    getProviderModel: () => mocks.providerModel,
    getLocalContextLength: () => 65536,
  },
}));

import { OllamaPreflight } from '@/components/settings/ollama-preflight';

let container: HTMLDivElement;
let root: Root;

const RESULT = {
  version: '0.34.1',
  models: ['llama2:7b'],
  checks: [
    { id: 'reachable', ok: true, detail: 'Ollama 0.34.1' },
    { id: 'models', ok: true, detail: '1 model pulled' },
    { id: 'model_pulled', ok: true, detail: 'llama2:7b is pulled' },
    { id: 'tools', ok: false, detail: 'no tool calls', fix: 'ollama pull qwen3:4b' },
    { id: 'context', ok: true, detail: '32,768' },
  ],
};

async function clickCheck() {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Check setup'))!;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.apiFetch.mockReset();
  mocks.track.mockReset();
  mocks.apiFetch.mockResolvedValue({ json: async () => RESULT });
  mocks.agent = { provider: 'ollama', model: 'qwen3:4b' };
  mocks.providerModel = null;
  act(() => { root.render(withMessages(<OllamaPreflight />)); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('OllamaPreflight', () => {
  it('renders nothing but the button until the check runs', () => {
    expect(container.querySelector('[data-testid="preflight-reachable"]')).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('shows one row per check and the fix command on the failed one', async () => {
    await clickCheck();

    const rows = Array.from(container.querySelectorAll('[data-testid^="preflight-"]'));
    expect(rows.map((r) => [r.getAttribute('data-testid'), r.getAttribute('data-ok')])).toEqual([
      ['preflight-reachable', 'true'], ['preflight-models', 'true'], ['preflight-model_pulled', 'true'],
      ['preflight-tools', 'false'], ['preflight-context', 'true'],
    ]);
    expect(container.querySelector('[data-testid="preflight-tools"] code')?.textContent).toBe('ollama pull qwen3:4b');
    expect(container.querySelector('[data-testid="preflight-reachable"] code')).toBeNull();
  });

  it('checks the agent model when Ollama is the active provider', async () => {
    await clickCheck();

    const body = JSON.parse(String(mocks.apiFetch.mock.calls[0][1].body));
    expect(body).toEqual({ model: 'qwen3:4b', contextLength: 65536 });
  });

  it('checks the model last picked for Ollama when another provider is active', async () => {
    mocks.agent = { provider: 'gemini', model: 'gemini-3.8-flash' };
    mocks.providerModel = 'llama2:7b';

    await clickCheck();

    expect(JSON.parse(String(mocks.apiFetch.mock.calls[0][1].body))).toMatchObject({ model: 'llama2:7b' });
  });

  it('reports which checks failed, and nothing else, to telemetry', async () => {
    await clickCheck();

    expect(mocks.track).toHaveBeenCalledWith('preflight_result', { provider: 'ollama', ok: false, failed: ['tools'] });
  });
});
