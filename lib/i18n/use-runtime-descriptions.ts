'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

/**
 * The runtimes' descriptions, translated.
 *
 * Only the descriptions. A runtime's `label` is a framework identifier — React, Svelte, Vue,
 * Handlebars — and reads the same in every language, the same reasoning as the licence names.
 */
export function useRuntimeDescriptions(): Record<string, string> {
  const t = useTranslations('runtimes');

  return useMemo(() => ({
    static: t('static'),
    handlebars: t('handlebars'),
    react: t('react'),
    preact: t('preact'),
    svelte: t('svelte'),
    vue: t('vue'),
    python: t('python'),
    lua: t('lua'),
  }), [t]);
}
