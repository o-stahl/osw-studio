import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/vfs', () => ({ vfs: {} }));
vi.mock('@/lib/vfs/skills', () => ({ skillsService: {} }));

import { filterSkills, filterGroups } from '../SkillsManager';
import type { Skill, SkillGroup } from '@/lib/vfs/skills/types';

/** The Skills page's search and its built-in/custom filters. */
const skill = (id: string, description: string, isBuiltIn: boolean) =>
  ({ id, name: id, description, isBuiltIn }) as Skill;
const group = (id: string, name: string, description?: string, isBuiltIn = false) =>
  ({ id, name, description, isBuiltIn, memberIds: [] }) as unknown as SkillGroup;

const SKILLS = [
  skill('Accessibility', 'Check contrast and labels', true),
  skill('my-forms', 'Our house style for forms', false),
  skill('SEO', 'Meta tags and sitemaps', true),
  skill('brand-voice', 'How we write', false),
];

describe('filterSkills', () => {
  it('lists custom skills before built-in ones, keeping each side in order', () => {
    expect(filterSkills(SKILLS, '', true, true).map((s) => s.id))
      .toEqual(['my-forms', 'brand-voice', 'Accessibility', 'SEO']);
  });

  it('matches the name or the description, ignoring case', () => {
    expect(filterSkills(SKILLS, 'seo', true, true).map((s) => s.id)).toEqual(['SEO']);
    expect(filterSkills(SKILLS, 'FORMS', true, true).map((s) => s.id)).toEqual(['my-forms']);
    expect(filterSkills(SKILLS, 'contrast', true, true).map((s) => s.id)).toEqual(['Accessibility']);
  });

  it('hides built-in or custom skills when that filter is off', () => {
    expect(filterSkills(SKILLS, '', false, true).map((s) => s.id)).toEqual(['my-forms', 'brand-voice']);
    expect(filterSkills(SKILLS, '', true, false).map((s) => s.id)).toEqual(['Accessibility', 'SEO']);
  });
});

describe('filterGroups', () => {
  // A built-in group is shown by its translated copy, so that is what the search has to match.
  const shown = (g: SkillGroup) =>
    g.isBuiltIn ? { name: 'Verkkosivun perusteet', description: 'Saavutettavuus ja hakukoneet' } : { name: g.name, description: g.description ?? '' };
  const GROUPS = [group('web-basics', 'Web basics', 'Accessibility and SEO', true), group('mine', 'Client work')];

  it('shows every group without a search', () => {
    expect(filterGroups(GROUPS, '', shown)).toHaveLength(2);
  });

  it('matches what the person sees, not the stored English', () => {
    expect(filterGroups(GROUPS, 'perusteet', shown).map((g) => g.id)).toEqual(['web-basics']);
    expect(filterGroups(GROUPS, 'web basics', shown)).toEqual([]);
  });

  it('matches the description, ignoring case, and copes with none', () => {
    expect(filterGroups(GROUPS, 'HAKUKONEET', shown).map((g) => g.id)).toEqual(['web-basics']);
    expect(filterGroups(GROUPS, 'client', shown).map((g) => g.id)).toEqual(['mine']);
  });
});
