'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { setLocale } from './actions';
import { isEmbedded, type Locale } from './config';

/**
 * Switching the interface language from a control. The choice shows as `current` straight away and
 * the control stays `pending` until the refreshed server render comes back in that language; a
 * failed switch releases it with a toast.
 */
export function useLocaleSwitch(): { current: Locale; pending: boolean; change: (next: Locale) => Promise<void> } {
  const t = useTranslations('settings');
  const router = useRouter();
  const activeLocale = useLocale();
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);

  useEffect(() => {
    if (pendingLocale !== null && activeLocale === pendingLocale) setPendingLocale(null);
  }, [activeLocale, pendingLocale]);

  const change = async (next: Locale) => {
    setPendingLocale(next);
    try {
      await setLocale(next, { embedded: isEmbedded() });
    } catch {
      setPendingLocale(null);
      toast.error(t('languageChangeFailed'));
      return;
    }
    // A refresh, not a reload: the open project and editor contents outlive the switch.
    router.refresh();
  };

  return { current: pendingLocale ?? activeLocale, pending: pendingLocale !== null, change };
}
