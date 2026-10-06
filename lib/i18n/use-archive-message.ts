'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import type { ArchiveText } from '@/lib/vfs/archive/text';

/**
 * What an archive issue, failure or thrown error says, in the interface language.
 *
 * The archive layer attaches `text` to everything it words itself; what it passes through from
 * elsewhere — a storage error, JSZip's own wording — has only `message`, which is shown as it is.
 */
export function useArchiveMessage(): (item: unknown) => string {
  const t = useTranslations('archive');
  return useCallback((item) => {
    const said = item as { message?: unknown; text?: ArchiveText } | null;
    if (said?.text) return t(said.text.key, said.text.values);
    if (typeof said?.message === 'string') return said.message;
    return String(item);
  }, [t]);
}
