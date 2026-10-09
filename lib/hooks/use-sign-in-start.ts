'use client';

import { useCallback, useEffect, useState } from 'react';
import { prepareSignIn, startSignIn } from '@/lib/auth/provider-sign-in';
import { checkHFCapabilities } from '@/lib/auth/hf-auth';
import { isEmbedded } from '@/lib/i18n/config';

/**
 * `startSignIn` for a control that offers provider sign-in. Prepares the PKCE pair on mount so the
 * click opens the popup straight at the provider, and inside the HuggingFace Space's frame sends the
 * return to the Space's page on huggingface.co (see `startSignIn`).
 */
export function useSignInStart(): (provider: 'openrouter', options?: { popup?: boolean }) => Promise<boolean> {
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    void prepareSignIn();
    if (!isEmbedded()) return;
    let live = true;
    checkHFCapabilities()
      .then((c) => { if (live && c.spaceId) setReturnTo(`https://huggingface.co/spaces/${c.spaceId}`); })
      .catch(() => { /* not a Space */ });
    return () => { live = false; };
  }, []);

  return useCallback(
    (provider: 'openrouter', options: { popup?: boolean } = {}) =>
      startSignIn(provider, { ...options, ...(options.popup && returnTo ? { returnTo } : {}) }),
    [returnTo],
  );
}
