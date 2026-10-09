'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import { getProvider } from '@/lib/llm/providers/registry';
import type { ProviderId } from '@/lib/llm/providers/types';
import { completeSignIn, pendingSignIn, returnParams, SignInError, SIGN_IN_CHANNEL, SIGN_IN_PARAMS } from '@/lib/auth/provider-sign-in';
import { translator } from '@/lib/i18n/runtime';
import { track } from '@/lib/telemetry';
import { connectSettled } from '@/lib/llm/models/global-auto-assign';

let inFlight = false;

const SIGNED_IN_MESSAGE = 'osw-provider-signed-in';

/** This page, so a broadcast it sent is not taken for one from another page. */
const PAGE_ID = Math.random().toString(36).slice(2);

function announce(provider: ProviderId): void {
  toast.success(translator()('connect.connected', { name: getProvider(provider).name }));
  window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey: true } }));
}

/**
 * Finish a relayed sign-in (see `isRelayedReturn`): store the key in the storage this frame shares
 * with the page that started it, and tell that page over `SIGN_IN_CHANNEL`. The connect handling runs
 * there, not here. Throws a `SignInError` like `completeSignIn`.
 */
export async function finishRelayedSignIn(search: URLSearchParams): Promise<ProviderId> {
  const result = await completeSignIn(returnParams(search));
  configManager.setProviderApiKey(result.provider, result.key);
  configManager.clearModelCache(result.provider);
  track('connection_added', { provider: result.provider, method: 'oauth' });
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    channel.postMessage({ type: SIGNED_IN_MESSAGE, provider: result.provider, from: PAGE_ID });
    channel.close();
  }
  return result.provider;
}

/**
 * Finish a provider sign-in when the page is its return, store the key like a pasted one, and
 * announce it with `apiKeyUpdated` so the usual connect handling runs.
 *
 * A sign-in opened in a popup (inside a frame, or from a stopped task's card) finishes in
 * the popup, tells the page that opened it, and closes; the key is already in the shared storage.
 * A relayed one (the HuggingFace Space, where the popup has no opener) tells it over
 * `SIGN_IN_CHANNEL`, which reaches pages sharing that storage.
 * Mounted from both mode roots, like `useProviderAutoAssign`.
 */
export function useProviderSignInReturn(): void {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== SIGNED_IN_MESSAGE) return;
      announce(e.data.provider as ProviderId);
    };
    window.addEventListener('message', onMessage);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SIGN_IN_CHANNEL);
    if (channel) {
      channel.onmessage = (e: MessageEvent) => {
        if (e.data?.type === SIGNED_IN_MESSAGE && e.data.from !== PAGE_ID) announce(e.data.provider as ProviderId);
      };
    }
    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, []);

  useEffect(() => {
    const search = returnParams(new URLSearchParams(window.location.search));
    const pending = pendingSignIn(search);
    // A relayed return is finished by the page that shows it (`SignInRelay`), not by the studio.
    if (inFlight || !(search.has('code') || search.has('error')) || !pending || pending.relay) return;
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
