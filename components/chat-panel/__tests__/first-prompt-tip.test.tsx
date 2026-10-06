// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { DebugEvent } from '@/lib/stores/types';

/**
 * Someone who has never sent a message gets a one-time tip above the suggestions: a suggestion
 * fills in the message, and nothing is sent until Send. It is done with once a conversation has a
 * message or the tip is dismissed, and never comes back.
 */

vi.mock('@/components/unified-settings', () => ({ UnifiedSettingsModal: () => null }));
vi.mock('@/components/providers-models/project-models-panel', () => ({ ProjectModelsPanel: () => null }));
vi.mock('@/components/interview/InterviewTemplatesManager', () => ({ InterviewTemplatesManager: () => null }));
vi.mock('@/components/permissions/PermissionModeSelector', () => ({ PermissionModeSelector: () => null }));
vi.mock('@/lib/interview/templates-service', () => ({ interviewTemplatesService: { getAllTemplates: async () => [] } }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: async () => ({ oauthAvailable: false, clientId: null, scopes: '' }), loginHF: vi.fn() }));
vi.mock('@/lib/llm/providers/connection-status', async (orig) => ({
  ...(await orig<object>()),
  hasAnyConnectedProvider: () => false,
}));
vi.mock('@/lib/llm/models/global-auto-assign', async (orig) => ({
  ...(await orig<object>()),
  connectSettled: () => new Promise<void>(() => {}),
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { ChatPanel } from '../index';
import { useWorkspaceStore } from '@/lib/stores/workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onGenerate = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  onGenerate.mockClear();
  toastError.mockClear();
  useWorkspaceStore.setState({ projectId: 'p1', workspaceReady: true } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(props: { providerReady: boolean; generating?: boolean; events?: DebugEvent[] }) {
  await act(async () => {
    root.render(withMessages(
      <ChatPanel
        events={props.events ?? []}
        generating={props.generating ?? false}
        onGenerate={onGenerate}
        onStop={() => {}}
        focusContext={null}
        onClearFocus={() => {}}
        mode="code"
        setMode={() => {}}
        activeInterview={null}
        onStartInterview={() => {}}
        onHandoff={() => {}}
        currentModel="m"
        getModelDisplayName={(m) => m}
        providerReady={props.providerReady}
      />,
    ));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const tipText = en.chat.firstPromptTip;
const ev = (event: string, data: unknown): DebugEvent =>
  ({ id: Math.random().toString(36), timestamp: Date.now(), event, data }) as unknown as DebugEvent;
const user = (content: string) => ev('conversation_message', { message: { role: 'user', content } });

describe('ChatPanel — the first-message tip', () => {
  beforeEach(() => { localStorage.clear(); });

  it('shows above the suggestions in an empty chat, and goes for good when dismissed', async () => {
    await render({ providerReady: true });
    expect(container.textContent).toContain(tipText);

    const dismiss = container.querySelector(`button[aria-label="${en.chat.firstPromptTipDismiss}"]`) as HTMLButtonElement;
    await act(async () => { dismiss.click(); });
    expect(container.textContent).not.toContain(tipText);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ providerReady: true });
    expect(container.textContent).not.toContain(tipText);
  });

  it('is done with once a conversation has a message', async () => {
    await render({ providerReady: true, events: [user('make me a site')] });
    expect(container.textContent).not.toContain(tipText);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ providerReady: true });
    expect(container.textContent).not.toContain(tipText);
  });

  it('is done with once a suggestion is picked', async () => {
    await render({ providerReady: true });
    expect(container.textContent).toContain(tipText);
    const label = container.querySelector('.text-muted-foreground.mb-1\\.5')!;
    const pill = label.nextElementSibling!.querySelector('button') as HTMLButtonElement;
    await act(async () => { pill.click(); });
    expect(container.textContent).not.toContain(tipText);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).not.toBe('');

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ providerReady: true });
    expect(container.textContent).not.toContain(tipText);
  });
});
