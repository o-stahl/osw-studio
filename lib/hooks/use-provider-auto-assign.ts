'use client';

import { useEffect } from 'react';
import type { ProviderId } from '@/lib/llm/providers/types';
import { configManager } from '@/lib/config/storage';
import { shouldAutoAssignAgent } from '@/lib/llm/models/project-assignment';
import { activateProviderAsGlobalDefault, fitModelToAccount, reconcileActiveProviderIfConnected, trackConnectSettling } from '@/lib/llm/models/global-auto-assign';

/**
 * Auto-assign the GLOBAL active model to a freshly connected provider when no working
 * model is selected yet. Fixes the model-picker still showing "Select provider" after a
 * user pastes an API key on the Connections screen, and means a newly created project
 * inherits the just-connected provider.
 *
 * Event-driven (apiKeyUpdated window event): activateProviderAsGlobalDefault writes the
 * global default (dispatching modelConfigChanged), which the root-mounted useModelConfigSignal
 * turns into a providerReady refresh. No re-entrancy since the config writes do not
 * dispatch apiKeyUpdated.
 *
 * Mounted from BOTH mode roots (StudioInner in browser mode, PageWrapperInner in server
 * mode) so it is always active regardless of the current view. The Connections UI is
 * reachable OUTSIDE a project workspace (dashboard -> Settings -> Connections), so this
 * listener must not live inside Workspace, which mounts only while a project is open.
 */
export function useProviderAutoAssign(): void {
  // Load-time reconciliation: the event handler below only fixes the active model on a fresh
  // connect. A user who is ALREADY connected on load (e.g. after the pre-global migration seeded
  // the Default template with a keyless provider) would otherwise be stuck showing onboarding UI —
  // the HF "Sign in" button and a disabled composer — until they re-add the connection. See issue #17.
  useEffect(() => {
    const work = (async () => {
      await reconcileActiveProviderIfConnected();
      await fitModelToAccount(configManager.getActiveAssignment().agent.provider);
    })();
    trackConnectSettling(work);
    work.catch((err) => {
      console.warn('[useProviderAutoAssign] load-time provider reconcile failed:', err);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const handler = async (e: Event) => {
      // Self-contained safety: this is an un-awaited async event handler, so a throw here would
      // become an unhandled rejection. Wrap the whole body rather than relying on the downstream
      // no-throw contract (loadProviderModels).
      try {
        const detail = (e as CustomEvent).detail as { provider?: ProviderId; hasKey?: boolean } | undefined;
        const provider = detail?.provider;
        if (!provider || !detail?.hasKey) return;

        const work = (async () => {
          // Only when no working model exists yet: don't clobber the user's existing choice.
          if (shouldAutoAssignAgent()) await activateProviderAsGlobalDefault(provider);
          // Either way, a model the account cannot use is no choice at all.
          await fitModelToAccount(provider);
        })();
        trackConnectSettling(work);
        await work;
      } catch (err) {
        if (cancelled) return;
        console.warn('[useProviderAutoAssign] auto-select model on connect failed:', err);
      }
    };
    window.addEventListener('apiKeyUpdated', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('apiKeyUpdated', handler);
    };
  }, []);
}
