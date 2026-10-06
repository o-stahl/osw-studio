'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

/** Every top-level view the app routes to. */
type ViewId =
  | 'dashboard' | 'projects' | 'deployments' | 'templates' | 'skills' | 'interviews'
  | 'docs' | 'settings' | 'users' | 'workspaces' | 'mail';

/**
 * The views' names, translated: what the sidebar lists, the mobile header titles and a workspace's
 * Back button names. One map, so the three cannot disagree.
 */
export function useViewNames(): Record<ViewId, string> {
  const t = useTranslations();

  return useMemo(() => ({
    dashboard: t('common.terms.dashboard'),
    projects: t('common.terms.projects'),
    deployments: t('common.terms.deployments'),
    templates: t('common.terms.templates'),
    skills: t('common.terms.skills'),
    interviews: t('nav.items.interviews'),
    docs: t('common.terms.docs'),
    settings: t('common.terms.settings'),
    users: t('nav.settings.users'),
    workspaces: t('common.terms.workspaces'),
    mail: t('nav.settings.mail'),
  }), [t]);
}
