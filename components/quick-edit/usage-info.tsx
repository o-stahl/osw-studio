'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import type { Usage } from '@/lib/quick-edit/runs';

/** An opened group's full breakdown, in the usage line's style: its calls, tokens in and out. */
export function UsageBreakdown({ usage }: { usage: Usage }) {
  const t = useTranslations('quickEdit.usage');
  const { number } = useLocalFormat();
  const parts = [
    t('calls', { count: usage.calls }),
    usage.cachedTokens > 0
      ? t('inCached', { tokens: number(usage.promptTokens), cached: number(usage.cachedTokens) })
      : t('in', { tokens: number(usage.promptTokens) }),
    usage.reasoningTokens > 0
      ? t('outReasoning', { tokens: number(usage.completionTokens), reasoning: number(usage.reasoningTokens) })
      : t('out', { tokens: number(usage.completionTokens) }),
  ];
  return <div className="text-xs text-muted-foreground">{parts.join(' • ')}</div>;
}
