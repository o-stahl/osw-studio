/**
 * Parser for SKILL.md files with YAML frontmatter
 * Follows Anthropic conventions for skill file format
 */

import { translator } from '@/lib/i18n/runtime';
import { SkillFrontmatter } from './types';

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

/**
 * Parse SKILL.md content into frontmatter and markdown
 */
export function parseSkillFile(content: string): {
  frontmatter: SkillFrontmatter;
  markdown: string;
} {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    throw new Error(translator()('skills.errors.noFrontmatter'));
  }

  const [, yamlContent, markdown] = match;

  try {
    const frontmatter = parseYAML(yamlContent);
    validateFrontmatter(frontmatter);
    return {
      frontmatter,
      markdown: markdown.trim()
    };
  } catch (error) {
    throw new Error(translator()('skills.parseFailed', { error: error instanceof Error ? error.message : '' }));
  }
}

/**
 * Simple YAML parser for frontmatter
 * Handles basic key-value pairs (sufficient for skill metadata)
 */
function parseYAML(yamlContent: string): SkillFrontmatter {
  const lines = yamlContent.split('\n');
  const result: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value: string | boolean | number = trimmed.slice(colonIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Convert boolean and number values
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (!isNaN(Number(value)) && value !== '') value = Number(value);

    result[key] = value;
  }

  return result as SkillFrontmatter;
}

/**
 * Validate required frontmatter fields
 */
function validateFrontmatter(frontmatter: SkillFrontmatter): void {
  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    throw new Error(translator()('skills.errors.badName'));
  }

  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    throw new Error(translator()('skills.errors.badDescription'));
  }

  // Validate name format (lowercase, hyphens, no spaces)
  if (!/^[a-z0-9-]+$/.test(frontmatter.name)) {
    throw new Error(translator()('skills.errors.nameFormat'));
  }

  // Validate description length
  if (frontmatter.description.length > 500) {
    throw new Error(translator()('skills.errors.descriptionTooLong', { max: 500 }));
  }
}

/**
 * Generate SKILL.md content from frontmatter and markdown
 */
export function generateSkillFile(frontmatter: SkillFrontmatter, markdown: string): string {
  const yamlLines: string[] = [];

  // Write frontmatter fields
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;

    if (typeof value === 'string' && (value.includes(':') || value.includes('\n'))) {
      yamlLines.push(`${key}: "${value}"`);
    } else {
      yamlLines.push(`${key}: ${value}`);
    }
  }

  return `---\n${yamlLines.join('\n')}\n---\n\n${markdown.trim()}\n`;
}

/**
 * Create a starter skill template
 */
export function createSkillTemplate(name: string, description: string): string {
  const frontmatter: SkillFrontmatter = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    description
  };

  const markdown = `# ${name}

## Purpose
[Describe what this skill helps with]

## Guidelines
- Guideline 1
- Guideline 2
- Guideline 3

## Examples
[Provide code examples or usage patterns]

## Best Practices
[List best practices and recommendations]
`;

  return generateSkillFile(frontmatter, markdown);
}
