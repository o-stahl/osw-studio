'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { PanelKey } from '@/lib/workspace-layout';

/**
 * The workspace panels' names, translated: what each panel's header says, and so what its tab, the
 * drop previews, the menus and the toasts call it.
 */
export function usePanelTitles(): Record<PanelKey, string> {
  const t = useTranslations();

  return useMemo(() => ({
    chat: t('common.terms.chat'),
    files: t('workspace.tabs.fileExplorer'),
    editor: t('workspace.tabs.codeEditor'),
    preview: t('preview.livePreview'),
    elements: t('workspace.tabs.inspector'),
    skills: t('common.terms.skills'),
    console: t('workspace.tabs.console'),
    checkpoints: t('workspace.tabs.checkpoints'),
    debug: t('workspace.tabs.debugEvents'),
  }), [t]);
}
