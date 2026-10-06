'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import { getProvider } from '@/lib/llm/providers/registry';
import type { ProviderId } from '@/lib/llm/providers/types';
import { completeSignIn, pendingSignIn, returnParams, SignInError, SIGN_IN_PARAMS } from '@/lib/auth/provider-sign-in';
import { translator } from '@/lib/i18n/runtime';
import { track } from '@/lib/telemetry';
import { connectSettled } from '@/lib/llm/models/global-auto-assign';

let inFlight = false;

const SIGNED_IN_MESSAGE = 'osw-provider-signed-in';

function announce(provider: ProviderId): void {
  toast.success(translator()('connect.connected', { name: getProvider(provider).name }));
  window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey: true } }));
}

/**
 * Finish a provider sign-in when the page is its return, store the key like a pasted one, and
 * announce it with `apiKeyUpdated` so the usual connect handling runs.
 *
 * A sign-in opened in a popup (inside a frame, or from a stopped task's card) finishes in
 * the popup, tells the page that opened it, and closes; the key is already in the shared storage.
 * Mounted from both mode roots, like `useProviderAutoAssign`.
 */
export function useProviderSignInReturn(): void {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== SIGNED_IN_MESSAGE) return;
      announce(e.data.provider as ProviderId);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const search = returnParams(new URLSearchParams(window.location.search));
    const pending = pendingSignIn(search);
    if (inFlight || !(search.has('code') || search.has('error')) || !pending) return;
    inFlight = true;
    const opener = window.opener as Window | null;

    (async () => {
      // Back to the project the sign-in started from, whether or not it worked.
      const returnProject = pending.returnProject;
      try {
        const result = await completeSignIn(search);
        configManager.setProviderApiKey(result.provider, result.key);
        configManager.clearModelCache(result.provider);
        track('connection_added', { provider: result.provider, method: 'oauth' });
        if (opener && !opener.closed) {
          opener.postMessage({ type: SIGNED_IN_MESSAGE, provider: result.provider }, window.location.origin);
          window.close();
          return;
        }
        announce(result.provider);
        // Let the connect handling settle the model before the address changes.
        await connectSettled();
      } catch (error) {
        const reason = error instanceof SignInError ? error.reason : 'exchange';
        toast.error(translator()(reason === 'denied' ? 'connect.signInCancelled' : 'connect.signInFailed'));
      } finally {
        const url = new URL(window.location.href);
        for (const p of SIGN_IN_PARAMS) url.searchParams.delete(p);
        // The roots already opened the project from the pending entry (`signInReturnProject`);
        // naming it in the address keeps it there on a reload.
        if (returnProject && !url.searchParams.has('project')) url.searchParams.set('project', returnProject);
        window.history.replaceState({}, '', url.toString());
        inFlight = false;
      }
    })();
  }, []);
}
