'use client';

import { useLayoutEffect } from 'react';
import { useTranslations } from 'next-intl';

import { setRuntimeTranslator } from './runtime';

/**
 * Hands the provider's translator to `lib/i18n/runtime`, for code outside components.
 *
 * A layout effect, so it is in place before any component's ordinary effect can run a store action
 * that fires a toast. Keyed on `t`, which changes when the language does.
 */
export function TranslatorBridge() {
  const t = useTranslations();
  useLayoutEffect(() => {
    setRuntimeTranslator(t);
    return () => setRuntimeTranslator(null);
  }, [t]);
  return null;
}
