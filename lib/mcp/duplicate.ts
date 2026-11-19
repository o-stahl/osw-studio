import type { Deployment } from '@/lib/vfs/types';

const MAX_COPY_NAME = 50;

/** `Site (Copy)`, then `Site (Copy 2)`: a name no other item has, cut so its suffix survives. */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (Copy)' : ` (Copy ${n})`;
    const candidate = `${name.slice(0, MAX_COPY_NAME - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** `seo-audit-copy`, then `seo-audit-copy-2`: a skill's name is also its id. */
export function skillCopyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name}-copy` : `${name}-copy-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A SKILL.md under another name, every other byte as it was. */
export function renameSkillFile(content: string, name: string): string {
  return content.replace(/^[ \t]*name[ \t]*:.*$/m, () => `name: ${name}`);
}

/**
 * An unpublished deployment with another's settings.
 *
 * Fields are listed rather than spread, so a field added to `Deployment` later stays out until
 * someone decides a copy should have it. The address (slug, custom domain), the review password
 * and everything about having been published belong to the original.
 */
export function deploymentCopy(source: Deployment, id: string, name: string, now: Date): Deployment {
  return {
    id,
    projectId: source.projectId,
    name,
    underConstruction: source.underConstruction,
    headScripts: source.headScripts,
    bodyScripts: source.bodyScripts,
    cdnLinks: source.cdnLinks,
    analytics: source.analytics,
    seo: source.seo,
    compliance: source.compliance,
    databaseEnabled: source.databaseEnabled,
    settingsVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}
