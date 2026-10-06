'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { SkillGroup } from '@/lib/vfs/skills/types';

interface SkillGroupCopy {
  name: string;
  description: string;
}

/**
 * The built-in skill groups' names and descriptions, translated.
 *
 * Groups exist only in the Skills manager, as bulk toggles; the agent never sees them. The member
 * skill ids in the descriptions (bold-geometric, art-deco, …) are ids and stay as written.
 */
export function useSkillGroupCatalog(): Record<string, SkillGroupCopy> {
  const t = useTranslations('skillGroups');

  return useMemo(() => ({
    'frontend-design': { name: t('frontend-design.name'), description: t('frontend-design.description') },
    'server-mode': { name: t('server-mode.name'), description: t('server-mode.description') },
    'web-standards': { name: t('web-standards.name'), description: t('web-standards.description') },
  }), [t]);
}

/** A group as a list shows it: a built-in one in the interface language, a custom one as written. */
export function useSkillGroupCopy(): (group: SkillGroup) => SkillGroupCopy {
  const catalog = useSkillGroupCatalog();
  return (group) => {
    const builtIn = group.isBuiltIn ? catalog[group.id] : undefined;
    return builtIn ?? { name: group.name, description: group.description ?? '' };
  };
}
