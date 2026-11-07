// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * The composer empties when its project starts generating, and takes text from the store's composer
 * draft. A start given up after it claimed the project (refused by the server, or stopped while it
 * was being set up) gives its request back through the draft, which arrives after the composer
 * emptied, and has to fill it whatever the composer did in between.
 */

vi.mock('@/components/unified-settings', () => ({ UnifiedSettingsModal: () => null }));
vi.mock('@/components/providers-models/project-models-panel', () => ({ ProjectModelsPanel: () => null }));
vi.mock('@/components/interview/InterviewTemplatesManager', () => ({ InterviewTemplatesManager: () => null }));
vi.mock('@/components/permissions/PermissionModeSelector', () => ({ PermissionModeSelector: () => null }));
vi.mock('@/lib/interview/templates-service', () => ({ interviewTemplatesService: { getAllTemplates: async () => [] } }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: async () => ({ oauthAvailable: false, clientId: null, scopes: '' }), loginHF: vi.fn() }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { ChatPanel } from '../index';
import { useWorkspaceStore } from '@/lib/stores/workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useWorkspaceStore.setState({ projectId: 'p1', workspaceReady: true, composerDraft: null } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(generating: boolean) {
  await act(async () => {
    root.render(withMessages(
      <ChatPanel
        events={[]}
        generating={generating}
        onGenerate={() => {}}
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
        providerReady={true}
      />,
    ));
  });
}

const composer = () => container.querySelector('textarea') as HTMLTextAreaElement;

async function type(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(composer(), text);
    composer().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const giveBack = (text: string) => act(async () => { useWorkspaceStore.getState().appendComposerDraft(text); });

describe('ChatPanel — a request given back to the composer', () => {
  it('fills the composer after a start that was stopped while it was being set up', async () => {
    await render(false);
    await type('make it blue');
    await render(true);
    expect(composer().value).toBe('');

    await giveBack('make it blue');
    await render(false);

    expect(composer().value).toBe('make it blue');
  });

  it('keeps it when the project starts generating again before it arrives, as a refused start does', async () => {
    await render(false);
    await type('make it blue');
    // The start claims the project, gives the claim back, and the task it was refused for is
    // brought in: the composer empties again, and the request comes back after that.
    await render(true);
    await render(false);
    await render(true);
    await giveBack('make it blue');

    expect(composer().value).toBe('make it blue');
  });
});
