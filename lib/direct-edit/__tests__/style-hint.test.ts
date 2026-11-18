import { describe, it, expect } from 'vitest';
import { styleHint } from '../style-hint';
import { parseBashCommand } from '@/lib/llm/bash-command';

/**
 * The `style` command the agent is handed for a selected element, read the way the shell reads it:
 * the element has to arrive as one argument, whatever its file is called.
 */

/** The command in a hint, as the agent would run it. */
const commandIn = (hint: string) => /: (style .*?) \(your own/.exec(hint)?.[1] ?? '';

describe('styleHint', () => {
  it('gives a marker and a plain position as they are written', () => {
    expect(commandIn(styleHint('@h7x2m4qp'))).toBe('style @h7x2m4qp font-size=36px color=#111');
    expect(commandIn(styleHint('/index.html:42:5'))).toBe('style /index.html:42:5 font-size=36px color=#111');
  });

  it('offers --width for an element selected in a frame narrower than 1000 px, and not otherwise', () => {
    expect(styleHint('@h7x2m4qp', 390)).toContain('Add --width 390 when the change is for screens that narrow and narrower.');
    for (const width of [1000, 1440, null, undefined]) expect(styleHint('@h7x2m4qp', width)).not.toContain('--width');
  });

  it.each([
    '/blog posts/first post.html:3:5',
    "/it's here.html:1:1",
  ])('quotes a position the shell would split, so it runs as one argument: %s', (position) => {
    expect(parseBashCommand(commandIn(styleHint(position)))).toEqual(['style', position, 'font-size=36px', 'color=#111']);
  });
});
