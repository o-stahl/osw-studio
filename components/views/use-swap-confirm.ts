'use client';

import { useCallback, useEffect, useState } from 'react';

/** What the swap dialog shows while a deployment save waits on it. */
export interface SwapDetails {
  deploymentId: string;
  deploymentName: string;
  currentProjectId: string;
  newProjectId: string;
  newProjectName: string;
}

/**
 * A deployment save that changes a published deployment's project waits on the swap dialog.
 * `ask` opens it and resolves true on confirm, false on cancel. A dialog still open when the view
 * goes away is settled as cancelled, so the save does not wait forever.
 */
export function useSwapConfirm() {
  const [pending, setPending] = useState<(SwapDetails & { resolve: (confirmed: boolean) => void }) | null>(null);

  // Settling a promise that is already settled does nothing, so this is safe on every change.
  useEffect(() => () => pending?.resolve(false), [pending]);

  const ask = useCallback(async (details: SwapDetails): Promise<boolean> => {
    const confirmed = await new Promise<boolean>((resolve) => setPending({ ...details, resolve }));
    setPending(null);
    return confirmed;
  }, []);

  return { pending, ask };
}
