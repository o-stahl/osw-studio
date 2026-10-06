'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import type { CheckpointLabel } from '@/lib/vfs/checkpoint';
import { useLocalFormat } from './use-local-format';

/**
 * A checkpoint's name in the interface language. Checkpoints the app names itself carry a `label`;
 * older ones, and those named from a description someone typed, show `description` as stored.
 * `time` comes from the checkpoint's own timestamp, so a manual save reads in the viewer's format.
 */
export function useCheckpointLabel(): (cp: { description: string; label?: CheckpointLabel; timestamp: string }) => string {
  const t = useTranslations('checkpoints');
  const { dateTime } = useLocalFormat();
  return useCallback((cp) => {
    if (!cp.label) return cp.description;
    return t(cp.label.key, { ...cp.label.values, time: dateTime(cp.timestamp, { timeStyle: 'medium' }) });
  }, [t, dateTime]);
}
