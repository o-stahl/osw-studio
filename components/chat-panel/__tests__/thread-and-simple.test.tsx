// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { DebugEvent } from '@/lib/stores/types';

/**
 * What the panel draws for the conversation, and what the simple view hides.
 *
 * The workspace hands the panel its thread in both views, and describe mode its own; `simple` is a
 * separate choice, so the studio keeps its full composer around the same thread.
 */

vi.mock('@/components/unified-settings', () => ({ UnifiedSettingsModal: () => null }));
vi.mock('@/components/providers-models/project-models-panel', () => ({ ProjectModelsPanel: () => null }));
vi.mock('@/components/interview/InterviewTemplatesManager', () => ({ InterviewTemplatesManager: () => null }));
vi.mock('@/components/permissions/PermissionModeSelector', () => ({ PermissionModeSelector: () => <span data-testid="permission-mode" /> }));
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
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ChatPanel } from '../index';
import { useWorkspaceStore } from '@/lib/stores/workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useWorkspaceStore.setState({ projectId: 'p1', workspaceReady: true } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ev = (event: string, data: unknown): DebugEvent =>
  ({ id: Math.random().toString(36), timestamp: Date.now(), event, data }) as unknown as DebugEvent;
const asked = [ev('conversation_message', { message: { role: 'user', content: 'make me a site' } })];

async function render(props: Partial<React.ComponentProps<typeof ChatPanel>>) {
  await act(async () => {
    root.render(withMessages(
      <ChatPanel
        events={asked}
        generating={false}
        onGenerate={vi.fn()}
        onStop={() => {}}
        focusContext={null}
        onClearFocus={() => {}}
        mode="code"
        setMode={() => {}}
        activeInterview={null}
        onStartInterview={() => {}}
        thread={null}
        currentModel="m"
        getModelDisplayName={(m) => m}
        providerReady
        {...props}
      />,
    ));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const thread = <div data-testid="thread">the thread</div>;
const placeholder = () => container.querySelector('textarea')?.getAttribute('placeholder');
const permissionMode = () => container.querySelector('[data-testid="permission-mode"]');

describe('ChatPanel — the thread and the simple view', () => {
  it('draws the thread it is given, and nothing of the events itself, in either view', async () => {
    for (const simple of [false, true]) {
      await render({ thread, simple });
      expect(container.querySelector('[data-testid="thread"]')).not.toBeNull();
      expect(container.textContent).not.toContain('make me a site');
    }
  });

  it('keeps the permission selector and the build placeholder around the thread outside the simple view', async () => {
    await render({ thread });
    expect(permissionMode()).not.toBeNull();
    expect(placeholder()).toBe(en.chat.placeholder.describe);
  });

  it('hides the permission selector and asks for a change in the simple view', async () => {
    await render({ thread, simple: true });
    expect(permissionMode()).toBeNull();
    expect(placeholder()).toBe(en.chat.placeholder.askForChange);
  });
});

/**
 * The panel follows its thread with `useFollowNewest` (tested on its own), from the panel's own
 * reading of the events: the person's messages and the project shown. jsdom does no layout, so the
 * scroll box is stood in for, 500px high over content that grows with each event.
 */
describe('ChatPanel — following the thread', () => {
  let height: number;
  let top: number;
  let frames: Array<FrameRequestCallback | null>;
  const box = () => container.querySelector('div.flex-1.overflow-y-auto.p-4') as HTMLDivElement;
  const runFrames = () => { const due = frames; frames = []; for (const frame of due) frame?.(0); };
  const said = (text: string) => ev('assistant_delta', { text });
  const request = (content: string) => ev('conversation_message', { message: { role: 'user', content } });
  const show = async (events: DebugEvent[]) => { height += 400; await render({ events, thread }); runFrames(); };

  beforeEach(() => {
    height = 1000;
    top = 0;
    frames = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => top,
      set(this: HTMLElement, y: number) {
        const next = Math.max(0, Math.min(y, height - 500));
        if (next === top) return;
        top = next;
        this.dispatchEvent(new Event('scroll'));
      },
    });
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = null; });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  });

  async function scrolledUp(): Promise<DebugEvent[]> {
    const events = [...asked];
    await show(events);
    expect(top).toBe(height - 500);
    act(() => {
      box().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      box().scrollTop = 100;
    });
    // A new response: what used to pull the view back down.
    const more = [...events, ev('iteration', {}), said('Working on it')];
    await show(more);
    expect(top).toBe(100);
    return more;
  }

  it('stays where the person scrolled up to, and follows again once they send a message', async () => {
    const events = await scrolledUp();

    await show([...events, request('and make it green')]);
    expect(top).toBe(height - 500);
  });

  it('follows again when another project is opened', async () => {
    const events = await scrolledUp();

    act(() => { useWorkspaceStore.setState({ projectId: 'p2' } as never); });
    await show([...events, said('Elsewhere')]);
    expect(top).toBe(height - 500);
  });
});
