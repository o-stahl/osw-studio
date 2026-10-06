'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

interface InterviewCopy {
  title: string;
  description: string;
}

/**
 * The built-in interview templates' copy, translated.
 *
 * Only what a person reads in the list: the title and the description. An interview's `elicit` and
 * `criteria` stay English because they address the model, not the user, and the spec keeps the
 * agent's language free of the interface locale. The handoff button is not here: its label reaches
 * the chat as a bare InterviewHandoff with no template id, so translating it needs that id threaded
 * through the run data first.
 */
export function useInterviewCatalog(): Record<string, InterviewCopy> {
  const t = useTranslations('interviewCatalog');

  return useMemo(() => ({
    'understand-company': { title: t('understand-company.title'), description: t('understand-company.description') },
    'plan-feature': { title: t('plan-feature.title'), description: t('plan-feature.description') },
    'plan-website': { title: t('plan-website.title'), description: t('plan-website.description') },
    'prepare-publish': { title: t('prepare-publish.title'), description: t('prepare-publish.description') },
  }), [t]);
}
