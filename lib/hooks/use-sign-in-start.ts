'use client';

import { useCallback, useEffect, useState } from 'react';
import { prepareSignIn, startSignIn } from '@/lib/auth/provider-sign-in';
import { checkHFCapabilities } from '@/lib/auth/hf-auth';
import { isEmbedded } from '@/lib/web/embedded';

/**
 * `startSignIn` for a control that offers provider sign-in. Prepares the PKCE pair on mount so the
 * click opens the popup straight at the provider, and inside the HuggingFace Space's frame sends the
 * return to the Space's page on huggingface.co (see `startSignIn`).
 *
 * `ready` is false until both are known: a click before that would open a popup that stays blank
 * under huggingface.co's opener policy, or return somewhere the pending sign-in cannot be found. The
 * work cannot wait inside the click, since a popup opened after an `await` is blocked.
 */
export function useSignInStart(): {
  start: (provider: 'openrouter', options?: { popup?: boolean }) => Promise<boolean>;
  ready: boolean;
} {
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    const space = isEmbedded()
      ? checkHFCapabilities()
        .then((c) => { if (live && c.spaceId) setReturnTo(`https://huggingface.co/spaces/${c.spaceId}`); })
        .catch(() => { /* not a Space */ })
      : Promise.resolve();
    void Promise.all([prepareSignIn(), space]).then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);

  const start = useCallback(
    (provider: 'openrouter', options: { popup?: boolean } = {}) =>
      startSignIn(provider, { ...options, ...(options.popup && returnTo ? { returnTo } : {}) }),
    [returnTo],
  );
  return { start, ready };
}
