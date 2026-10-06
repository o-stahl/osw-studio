// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';

/**
 * A custom skill's name is its id, so it has to be one the registry can key by, and it cannot take
 * the id of a built-in skill.
 */

vi.mock('@/lib/utils', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { parseSkillFile } from '../parser';
import { skillsService } from '../service';

const skill = (name: string) => `---\nname: ${name}\ndescription: Does a thing well\n---\n\n# Body\n`;

beforeAll(() => {
  registerEnglishTranslator();
});

describe('skill validation', () => {
  it('refuses a name that is not lowercase with hyphens', () => {
    expect(() => parseSkillFile(skill('My Skill'))).toThrow('lowercase letters, numbers and hyphens only');
    expect(parseSkillFile(skill('my-skill')).frontmatter.name).toBe('my-skill');
  });

  it('refuses a custom skill named after a built-in one', async () => {
    await expect(skillsService.createSkill(skill('workflow'))).rejects.toThrow('Skill with name "workflow" already exists');
  });
});
