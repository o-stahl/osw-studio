'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { approvalPhrase } from '@/lib/quick-edit/approval-phrase';

/**
 * What an approval request asks for, as a sentence: the gate's plain wording under
 * `quickEdit.wants`, or its developer label when the gate has none.
 */
export function useApprovalSentence(): (gateKey: string, capabilityLabel: string) => string {
  const t = useTranslations('quickEdit.wants');
  return useCallback((gateKey: string, capabilityLabel: string) => {
    const key = approvalPhrase(gateKey);
    return key ? t(key) : t('other', { label: capabilityLabel });
  }, [t]);
}
