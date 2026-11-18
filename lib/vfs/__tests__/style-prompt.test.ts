import { describe, it, expect } from 'vitest';
import { TEMPLATE_STYLE_PROMPT } from '@/lib/vfs/templates/style-prompt';
import { SPACE_SCALE } from '@/lib/vfs/templates/theme';

/**
 * The text the built-in templates give whoever edits one next. A step it names that the stylesheet
 * does not define (`var(--space-7)`) is a value the browser drops.
 */
describe('the house style prompt', () => {
  it('names each spacing step the stylesheet defines, and no other', () => {
    const named = new Set(Array.from(TEMPLATE_STYLE_PROMPT.matchAll(/--space-\d+/g), (match) => match[0]));
    expect([...named].sort()).toEqual(SPACE_SCALE.map(([name]) => name).sort());
  });
});
