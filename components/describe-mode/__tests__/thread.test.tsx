// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NextIntlClientProvider } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { deepMerge } from '@/lib/i18n/merge';
import en from '@/messages/en.json';
import fi from '@/messages/fi.json';

/**
 * Describe mode draws its conversation with the workspace's thread: its welcome as the opening card,
 * the setup agent's commands as steps in words, its questions as chips that send the answer, and
 * each run closed by the ending describe mode records, as the workspace records it.
 */

type Emit = (event: string, data?: unknown) => void;
type Ending = { success: boolean; exitReason: string; summary?: string };
const turns: Array<(emit: Emit, prompt: string) => Ending | Promise<Ending>> = [];
const execute = vi.fn();

vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation((_project: string, _agent: string, onProgress: Emit) => ({
    execute: execute.mockImplementation(async (_message: string, options: { displayPrompt: string }) => {
      const turn = turns.shift();
      if (!turn) throw new Error('no turn scripted');
      return turn(onProgress, options.displayPrompt);
    }),
    setAssignment: vi.fn(),
    stop: vi.fn(),
  })),
}));
vi.mock('@/lib/llm/models/project-assignment', () => ({ isProjectProviderReady: () => true }));
vi.mock('@/lib/llm/models/template-store', () => ({ resolveActiveAssignment: () => ({ agent: { provider: 'openai', model: 'gpt-4' } }) }));
vi.mock('@/lib/describe/create-from-brief', () => ({ createProjectFromBrief: vi.fn() }));
let studioView = true;
vi.mock('@/components/view-mode-provider', () => ({ useStudioView: () => studioView }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/unified-settings', () => ({ UnifiedSettingsModal: () => null }));
vi.mock('@/components/providers-models/project-models-panel', () => ({ ProjectModelsPanel: () => null }));
vi.mock('@/components/interview/InterviewTemplatesManager', () => ({ InterviewTemplatesManager: () => null }));
vi.mock('@/components/permissions/PermissionModeSelector', () => ({ PermissionModeSelector: () => null }));
vi.mock('@/lib/interview/templates-service', () => ({ interviewTemplatesService: { getAllTemplates: async () => [] } }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: async () => ({ oauthAvailable: false, clientId: null, scopes: '' }), loginHF: vi.fn() }));
vi.mock('@/lib/llm/models/global-auto-assign', async (orig) => ({ ...(await orig<object>()), connectSettled: () => new Promise<void>(() => {}) }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DescribeMode } from '../index';
import { WELCOME_TEXT } from '../welcome';
import { useWorkspaceStore } from '@/lib/stores/workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  turns.length = 0;
  execute.mockClear();
  studioView = true;
  useWorkspaceStore.setState({ workspaceReady: true } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const text = () => container.textContent ?? '';
const buttons = (label: string) => Array.from(container.querySelectorAll('button')).filter((b) => (b.textContent ?? '').trim().startsWith(label));

async function mount() {
  await act(async () => { root.render(withMessages(<DescribeMode onProjectCreated={vi.fn()} />)); });
}

/** Type into the composer and send, as the person does. */
async function send(message: string) {
  const box = container.querySelector('textarea')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(box, message);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { buttons('Send')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** A run the way the setup agent's events arrive: the request, then one bash call and its words. */
const said = (emit: Emit, prompt: string, command: string, words: string) => {
  emit('conversation_message', { message: { role: 'user', content: prompt, ui_metadata: { displayContent: prompt } } });
  emit('iteration', { current: 1 });
  emit('tool_status', { toolCallId: 'c1', toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) });
  emit('tool_status', { toolCallId: 'c1', toolName: 'bash', status: 'completed', result: 'ok' });
  emit('conversation_message', { message: { role: 'assistant', content: words } });
};

describe('describe mode, in the thread', () => {
  it('opens with its welcome as the agent\'s first card, and no empty-thread line', async () => {
    await mount();

    expect(text()).toContain(en.describe.welcome.split('\n')[0]);
    expect(text()).not.toContain(en.chat.noMessages);
  });

  it('opens with its welcome in the interface\'s language, not the English the agent reads', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={deepMerge(en, fi)}>
          <DescribeMode onProjectCreated={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });

    expect(text()).toContain(fi.describe.welcome.split('\n')[0]);
    expect(text()).not.toContain(WELCOME_TEXT.split('\n')[0]);
  });

  it('asks with chips that send the answer, marks the one picked, and words the setup commands', async () => {
    turns.push((emit, prompt) => {
      emit('conversation_message', { message: { role: 'user', content: prompt, ui_metadata: { displayContent: prompt } } });
      emit('iteration', { current: 1 });
      emit('tool_status', { toolCallId: 'a1', toolName: 'bash', status: 'executing', args: JSON.stringify({ command: 'ask --prompt "What kind of site?" "Portfolio" "Shop"' }) });
      emit('ask', { prompt: 'What kind of site?', options: ['Portfolio', 'Shop'] });
      emit('tool_status', { toolCallId: 'a1', toolName: 'bash', status: 'completed', result: 'ok' });
      return { success: true, exitReason: 'awaiting_user' };
    });
    turns.push((emit, prompt) => {
      said(emit, prompt, "brief --merge << 'EOF'", 'A shop it is.');
      return { success: true, exitReason: 'agent_type_exit' };
    });
    await mount();

    await send('A site for my bakery');
    expect(text()).toContain('A site for my bakery');
    expect(text()).toContain('Asked you to choose');
    expect(text()).toContain('What kind of site?');

    await act(async () => { buttons('Shop')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][1]).toMatchObject({ displayPrompt: 'Shop' });
    expect(text()).toContain('Updated the brief');
    expect(text()).not.toContain('Wrote a file');
    expect(text()).toContain('A shop it is.');
    expect(buttons('Shop')[0].textContent).toContain('✓');
  });

  it('closes a run on its error, in its own words', async () => {
    turns.push((emit, prompt) => {
      said(emit, prompt, "spec --append \"Audience\" << 'EOF'", '');
      return { success: false, exitReason: 'max_iterations', summary: 'Reached maximum iterations (40)' };
    });
    await mount();

    await send('Anything');

    expect(text()).toContain('Added to the spec');
    expect(text()).toContain('Reached maximum iterations (40)');
  });

  it('keeps the composer on Stop until a stopped run has returned', async () => {
    let release!: () => void;
    turns.push((emit, prompt) => {
      emit('conversation_message', { message: { role: 'user', content: prompt, ui_metadata: { displayContent: prompt } } });
      return new Promise<Ending>((resolve) => { release = () => resolve({ success: false, exitReason: 'stopped' }); });
    });
    await mount();
    await send('A site for my bakery');

    await act(async () => { buttons('Stop')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(buttons('Stop')).toHaveLength(1);

    await act(async () => { release(); });
    expect(buttons('Stop')).toHaveLength(0);
    expect(buttons('Send')).toHaveLength(1);
  });

  it('starts one run for two presses of Send in the same moment', async () => {
    turns.push(() => new Promise<Ending>(() => {}));
    await mount();
    const box = container.querySelector('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(box, 'A site for my bakery');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      const sendButton = buttons('Send')[0];
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('opens no step onto its calls in the simple view', async () => {
    studioView = false;
    turns.push((emit, prompt) => {
      said(emit, prompt, 'propose-create', 'Ready when you are.');
      return { success: true, exitReason: 'agent_type_exit' };
    });
    await mount();

    await send('Make it');

    expect(text()).toContain('Proposed creating the project');
    expect(buttons('Proposed creating the project')).toHaveLength(0);
  });
});
