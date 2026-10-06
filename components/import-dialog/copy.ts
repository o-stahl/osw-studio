'use client';

import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { useLocalFormat } from '@/lib/i18n/use-local-format';

import type { ConfirmAction } from './logic';

type Counts = { files?: number; backend?: number; settings?: number };

/**
 * The dialog's sentences that are built from counts: the confirm button, the 'nothing to do'
 * summary and the closing report. `logic.ts` decides the numbers; this words them, with each
 * count pluralised on its own and the parts joined the way the language lists things.
 */
export function useImportCopy() {
  const t = useTranslations('importDialog');
  const format = useFormatter();
  const { bytes } = useLocalFormat();

  return useMemo(() => {
    const list = (counts: Counts, backendAs: 'nFunctions' | 'nServerFunctions') => {
      const parts: string[] = [];
      if (counts.files) parts.push(t('nFiles', { count: counts.files }));
      if (counts.backend) parts.push(t(backendAs, { count: counts.backend }));
      if (counts.settings) parts.push(t('nSettings', { count: counts.settings }));
      return parts.length ? format.list(parts, { type: 'conjunction' }) : '';
    };

    return {
      size: bytes,
      confirm(action: ConfirmAction): string {
        if (action.kind === 'create') return t('confirmCreate');
        const replaced = list(action, 'nFunctions');
        return replaced ? t('confirmReplace', { list: replaced }) : t('confirmImport');
      },
      nothingToDo(counts: { files: number; backend: number }): string {
        const matched = list(counts, 'nServerFunctions');
        if (!matched) return t('nothingInArchive');
        return t('allMatch', { list: matched, total: counts.files + counts.backend });
      },
      applied(counts: { files: number; backend: number; settings: number }): string {
        const done = list(counts, 'nFunctions');
        return done ? t('imported', { list: done }) : t('nothingWritten');
      },
    };
  }, [t, format, bytes]);
}
