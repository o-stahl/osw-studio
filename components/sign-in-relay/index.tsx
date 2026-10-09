'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SignInError } from '@/lib/auth/provider-sign-in';
import { finishRelayedSignIn } from '@/lib/hooks/use-provider-sign-in-return';
import { getProvider } from '@/lib/llm/providers/registry';
import { Spinner } from '@/components/ui/spinner';

type State = { kind: 'working' } | { kind: 'done'; name: string } | { kind: 'failed'; reason: 'denied' | 'other' };

/**
 * What the HuggingFace Space's popup shows when a relayed sign-in comes back to it: the sign-in is
 * finished for the page that started it, and the studio is not loaded here. The popup cannot be
 * closed from this frame (huggingface.co cuts it off from its opener), so it says to close it.
 */
export function SignInRelay() {
  const t = useTranslations('connect');
  const [state, setState] = useState<State>({ kind: 'working' });

  useEffect(() => {
    let live = true;
    finishRelayedSignIn(new URLSearchParams(window.location.search))
      .then((provider) => {
        if (!live) return;
        setState({ kind: 'done', name: getProvider(provider).name });
        try { window.top?.close(); } catch { /* left open: the screen says to close it */ }
      })
      .catch((error) => {
        if (live) setState({ kind: 'failed', reason: error instanceof SignInError && error.reason === 'denied' ? 'denied' : 'other' });
      });
    return () => { live = false; };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div role="status" className="grid w-[380px] max-w-full gap-3 rounded-lg border bg-card p-6 text-card-foreground">
        {state.kind === 'working' && (
          <div className="flex items-center gap-3">
            <Spinner size={20} />
            <p className="text-sm">{t('relayWorking')}</p>
          </div>
        )}
        {state.kind === 'done' && (
          <>
            <p className="text-lg leading-none font-semibold">{t('connected', { name: state.name })}</p>
            <p className="text-sm text-muted-foreground">{t('relayDone')}</p>
          </>
        )}
        {state.kind === 'failed' && (
          <>
            <p className="text-lg leading-none font-semibold">{t(state.reason === 'denied' ? 'signInCancelled' : 'signInFailed')}</p>
            <p className="text-sm text-muted-foreground">{t('relayClose')}</p>
          </>
        )}
      </div>
    </div>
  );
}
