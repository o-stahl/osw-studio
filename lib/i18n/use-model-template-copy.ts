'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

/**
 * A model template's name and description as the list shows them: a built-in one in the interface
 * language, a saved one exactly as its owner wrote it.
 */
export function useModelTemplateCopy(): (template: { id: string; name: string; description?: string; builtin?: boolean }) => { name: string; description: string } {
  const t = useTranslations('modelTemplates');
  return useCallback((template) => {
    if (template.builtin) {
      if (template.id === 'or-recommended') return { name: t('orRecommended'), description: t('recommendedDescription') };
      if (template.id === 'hf-recommended') return { name: t('hfRecommended'), description: t('recommendedDescription') };
    }
    return { name: template.name, description: template.description ?? '' };
  }, [t]);
}
