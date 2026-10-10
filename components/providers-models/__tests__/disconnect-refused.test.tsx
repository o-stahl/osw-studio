// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Disconnecting a custom provider deletes its record on the server first. When the server refuses,
 * the key stays and the connection is still listed, and the toast says why in the refusal's own
 * words: removing the key first would leave a provider that is neither usable here nor deleted there.
 */

const mocks = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/lib/auth/provider-sign-in', () => ({ startSignIn: vi.fn(), prepareSignIn: async () => {} }));
vi.mock('../search-connections', () => ({ SearchConnectionsSection: () => null }));
// The row's menu, flattened: the menu itself is not what is under test, and Radix's pointer
// handling does not run in jsdom.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) =>
    <button type="button" onClick={() => onSelect?.()}>{children}</button>,
}));

import { ConnectionsPane } from '../connections-pane';
import { configManager } from '@/lib/config/storage';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

const ID = 'custom-acme';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registerEnglishTranslator();
  localStorage.clear();
  vi.clearAllMocks();
  configManager.setCustomProviders({ [ID]: configManager.buildCustomProviderConfig(ID, 'Acme', 'https://llm.acme.test/v1', true) });
  configManager.setProviderApiKey(ID, 'sk-acme');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function disconnect() {
  await act(async () => { root.render(withMessages(<ConnectionsPane />)); });
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === en.connections.disconnect);
  if (!button) throw new Error('no disconnect item');
  await act(async () => { button.click(); });
  await act(async () => { await Promise.resolve(); });
}

describe('disconnecting a custom provider the server refuses to delete', () => {
  it('keeps the key and shows the refusal', async () => {
    vi.spyOn(configManager, 'removeCustomProvider').mockRejectedValue(new ServerDeleteRefused('forbidden'));
    const setKey = vi.spyOn(configManager, 'setProviderApiKey');
    await disconnect();
    expect(setKey).not.toHaveBeenCalled();
    expect(configManager.getProviderApiKey(ID)).toBe('sk-acme');
    expect(mocks.toast.error).toHaveBeenCalledWith(en.sync.deleteRefused.forbidden);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('removes the key once the server has deleted the record', async () => {
    vi.spyOn(configManager, 'removeCustomProvider').mockResolvedValue();
    await disconnect();
    expect(configManager.getProviderApiKey(ID)).toBeFalsy();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
