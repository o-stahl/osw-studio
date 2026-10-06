'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, LogIn, RotateCw, X } from 'lucide-react';
import { getBackendStatus, subscribeBackendStatus, markBackendUp, type BackendStatus } from '@/lib/api/backend-status';
import { getLoginUrl } from '@/lib/config/storage';

export function BackendStatusBanner() {
  const tc = useTranslations('common');
  const tsb = useTranslations('statusBanner');
  const [status, setStatus] = useState<BackendStatus>({ backendDown: false, authExpired: false });
  const [dismissed, setDismissed] = useState<'backend' | 'auth' | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setStatus(getBackendStatus());
    return subscribeBackendStatus((s) => {
      setStatus(s);
      if (!s.backendDown && dismissed === 'backend') setDismissed(null);
      if (!s.authExpired && dismissed === 'auth') setDismissed(null);
    });
  }, [dismissed]);

  const handleRefresh = async () => {
    setChecking(true);
    try {
      // Just check if the server is reachable — any non-network response means it's up
      const res = await fetch('/', { method: 'HEAD' });
      if (res.ok || res.status < 500) {
        markBackendUp();
      }
    } catch {
      // Still down
    } finally {
      setChecking(false);
    }
  };

  if (status.backendDown && dismissed !== 'backend') {
    return (
      <div
        role="alert"
        className="fixed top-0 inset-x-0 z-[60] flex items-center justify-center gap-3 px-4 py-2 text-sm bg-neutral-800 text-neutral-100 shadow-md"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
        <span>
          {tsb('backendDown')}
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={checking}
          className="inline-flex items-center gap-1 rounded border border-neutral-500 px-2 py-0.5 hover:bg-neutral-700 transition-colors disabled:opacity-50"
        >
          <RotateCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
          {tc('actions.refresh')}
        </button>
        <button
          type="button"
          onClick={() => setDismissed('backend')}
          className="ml-1 p-0.5 rounded hover:bg-neutral-700 transition-colors"
          aria-label={tc('actions.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (status.authExpired && dismissed !== 'auth') {
    return (
      <div
        role="alert"
        className="fixed top-0 inset-x-0 z-[60] flex items-center justify-center gap-3 px-4 py-2 text-sm bg-amber-600 text-white shadow-md"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {tsb('sessionExpired')}
        </span>
        <a
          href={getLoginUrl()}
          className="inline-flex items-center gap-1 rounded border border-white/40 px-2 py-0.5 hover:bg-white/10 transition-colors"
        >
          <LogIn className="h-3 w-3" />
          {tsb('logIn')}
        </a>
        <button
          type="button"
          onClick={() => setDismissed('auth')}
          className="ml-1 p-0.5 rounded hover:bg-white/10 transition-colors"
          aria-label={tc('actions.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return null;
}
