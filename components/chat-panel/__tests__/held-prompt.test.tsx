// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createTranslator } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { DebugEvent } from '@/lib/stores/types';

/**
 * A message typed before anything is connected is held (in sessionStorage, per project) rather
 * than sent, and goes out on its own once a model is ready — unless another tab already took or
 * replaced it, or a run is still going. Attachments cannot be held.
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
let settle: () => void = () => {};
vi.mock('@/lib/llm/models/global-auto-assign', async (orig) => ({
  ...(await orig<object>()),
  connectSettled: () => new Promise<void>((r) => { settle = r; }),
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
const KEY = 'osw_held_prompt:p1';

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

async function typeAndSend(text: string) {
  const area = container.querySelector('textarea') as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  });
}

async function connectAndSettle(extra: { generating?: boolean } = {}) {
  await render({ providerReady: true, ...extra });
  await act(async () => { settle(); await new Promise((r) => setTimeout(r, 0)); });
}

describe('ChatPanel — a message held until a model is connected', () => {
  it('holds the message in session storage instead of sending it', async () => {
    await render({ providerReady: false });
    await typeAndSend('make me a site');
    expect(onGenerate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(KEY)).toBe('make me a site');
  });

  it('sends it once a model is ready, and forgets it', async () => {
    await render({ providerReady: false });
    await typeAndSend('make me a site');
    await connectAndSettle();
    expect(onGenerate).toHaveBeenCalledWith('make me a site');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('does not send it when another tab replaced or took it', async () => {
    await render({ providerReady: false });
    await typeAndSend('make me a site');
    sessionStorage.setItem(KEY, 'something else');
    await connectAndSettle();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('waits for a running generation to finish', async () => {
    await render({ providerReady: false });
    await typeAndSend('make me a site');
    await connectAndSettle({ generating: true });
    expect(onGenerate).not.toHaveBeenCalled();
    await connectAndSettle({ generating: false });
    expect(onGenerate).toHaveBeenCalledWith('make me a site');
  });
});

describe('ChatPanel — attachments before a model is connected', () => {
  it('refuses to hold a message with an attachment, and keeps nothing', async () => {
    await render({ providerReady: false });
    const input = container.querySelector('input[type="file"][accept^=".txt"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['hello'], 'notes.txt', { type: 'text/plain' })], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await typeAndSend('use these notes');
    expect(toastError).toHaveBeenCalledWith(chat('connectBeforeAttachments'));
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(onGenerate).not.toHaveBeenCalled();
  });
});

const chat = createTranslator({ locale: 'en', messages: en, namespace: 'chat' });
const limits = createTranslator({ locale: 'en', messages: en, namespace: 'limits' });

let n = 0;
const ev = (event: string, data: unknown): DebugEvent =>
  ({ id: `e${++n}`, timestamp: Date.now() + n, event, data, count: 1, version: 1 }) as DebugEvent;
const user = (content: string) => ev('conversation_message', { message: { role: 'user', content } });
const stop = () => ev('api_stopped', { errorCategory: 'rate_limited', provider: 'groq', model: 'm' });

describe('ChatPanel — which stop is live', () => {
  it('treats the last stop as live when nothing has run since', async () => {
    await render({ providerReady: true, events: [user('go'), stop()] });
    expect(container.textContent).toContain(limits('stoppedHere'));
  });

  it('keeps an earlier stop as history once a later message was sent', async () => {
    await render({ providerReady: true, events: [user('go'), stop(), user('again')] });
    expect(container.textContent).not.toContain(limits('stoppedHere'));
  });

  it('has no live stop while a run is going', async () => {
    await render({ providerReady: true, generating: true, events: [user('go'), stop()] });
    expect(container.textContent).not.toContain(limits('stoppedHere'));
  });
});
