'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { TemplateIntent } from '@/lib/vfs/types';

interface IntentCopy {
  label: string;
  description: string;
}

/**
 * Translated headings for the template list's sections.
 *
 * `groupByIntent` stays structural and keeps the English from `TEMPLATE_INTENTS`, so the grouping
 * and its tests do not depend on the locale; the panel swaps the copy in by group key when it
 * draws a heading. Typed over `TemplateIntent`, so a new intent without translated copy fails `tsc`.
 */
export function useTemplateIntents(): (key: string, fallback: IntentCopy) => IntentCopy {
  const t = useTranslations('templatesUi.intents');

  return useMemo(() => {
    const copy: Record<TemplateIntent | 'uncategorized', IntentCopy> = {
      starter: { label: t('starter.label'), description: t('starter.description') },
      website: { label: t('website.label'), description: t('website.description') },
      workspace: { label: t('workspace.label'), description: t('workspace.description') },
      app: { label: t('app.label'), description: t('app.description') },
      'project-kit': { label: t('project-kit.label'), description: t('project-kit.description') },
      uncategorized: { label: t('uncategorized.label'), description: t('uncategorized.description') },
    };
    return (key: string, fallback: IntentCopy) =>
      (copy as Record<string, IntentCopy>)[key] ?? fallback;
  }, [t]);
}
