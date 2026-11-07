// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { deepMerge } from '@/lib/i18n/merge';

/** The card of errors the preview reported, in the app's language like the rest of the panel. */

vi.mock('@/components/unified-settings', () => ({ UnifiedSettingsModal: () => null }));
vi.mock('@/components/providers-models/project-models-panel', () => ({ ProjectModelsPanel: () => null }));
vi.mock('@/components/interview/InterviewTemplatesManager', () => ({ InterviewTemplatesManager: () => null }));
vi.mock('@/components/permissions/PermissionModeSelector', () => ({ PermissionModeSelector: () => null }));
vi.mock('@/lib/interview/templates-service', () => ({ interviewTemplatesService: { getAllTemplates: async () => [] } }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: async () => ({ oauthAvailable: false, clientId: null, scopes: '' }), loginHF: vi.fn() }));
vi.mock('@/lib/llm/models/global-auto-assign', async (orig) => ({ ...(await orig<object>()), connectSettled: () => new Promise<void>(() => {}) }));
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

describe('the runtime errors card', () => {
  it('is labelled in the app\'s language', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={deepMerge(en, fi)}>
          <ChatPanel
            events={[]} generating={false} onGenerate={vi.fn()} onStop={() => {}}
            focusContext={null} onClearFocus={() => {}} mode="code" setMode={() => {}}
            activeInterview={null} onStartInterview={() => {}} thread={null}
            currentModel="m" getModelDisplayName={(m) => m} providerReady
            runtimeErrors={['TypeError: x is undefined']}
          />
        </NextIntlClientProvider>,
      );
    });

    expect(container.textContent).toContain(fi.chat.runtimeErrors);
    expect(container.textContent).not.toContain('runtime errors');
  });
});
