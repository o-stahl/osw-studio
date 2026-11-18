import { describe, it, expect } from 'vitest';
import { heightMode, heightModeChanges, widthMode, widthModeChanges, type SizeFacts } from '../size-mode';

const v = (value: string, ours = false) => ({ value, origin: ours ? '/overrides.css' : '/styles/main.css', ours });
const row = { display: 'flex', flexDirection: 'row' };
const column = { display: 'flex', flexDirection: 'column' };
const block = { display: 'block', flexDirection: 'row' };

describe('widthMode', () => {
  it('reads the declarations as written', () => {
    expect(widthMode({ width: v('fit-content'), parent: block })).toBe('hug');
    expect(widthMode({ width: v('100%'), parent: block })).toBe('fill');
    expect(widthMode({ flex: v('1 1 0px'), parent: row })).toBe('fill');
    expect(widthMode({ width: v('320px'), parent: block })).toBe('fixed');
    expect(widthMode({ width: v('60ch'), parent: block })).toBe('custom');
    expect(widthMode({ parent: block })).toBe('auto');
  });

  it('counts a growing flex as Fill only in a flex row', () => {
    expect(widthMode({ flex: v('1'), parent: column })).toBe('auto');
    expect(heightMode({ flex: v('1'), parent: column })).toBe('fill');
  });
});

describe('heightMode', () => {
  it('reads the declarations as written', () => {
    expect(heightMode({ height: v('100%'), parent: block })).toBe('fill');
    expect(heightMode({ height: v('320px'), parent: block })).toBe('fixed');
    expect(heightMode({ height: v('50vh'), parent: block })).toBe('custom');
    expect(heightMode({ height: v('auto'), parent: block })).toBe('auto');
    expect(heightMode({ parent: block })).toBe('auto');
  });
});

describe('widthModeChanges', () => {
  it('writes flex in a flex row and width elsewhere for Fill', () => {
    expect(widthModeChanges('fill', { parent: row }, 300)).toEqual([
      { property: 'width', value: null },
      { property: 'flex', value: '1 1 0' },
    ]);
    expect(widthModeChanges('fill', { parent: block }, 300)).toEqual([
      { property: 'width', value: '100%' },
      { property: 'flex', value: null },
    ]);
  });

  it('fixes the width the element has now, and hugs with fit-content', () => {
    expect(widthModeChanges('fixed', { parent: block }, 319.6)[0]).toEqual({ property: 'width', value: '320px' });
    expect(widthModeChanges('hug', { parent: block }, null)[0]).toEqual({ property: 'width', value: 'fit-content' });
  });

  it('writes nothing for Fixed when the element\'s size now is not a number of pixels', () => {
    expect(widthModeChanges('fixed', { parent: block }, null)).toEqual([]);
    expect(heightModeChanges('fixed', { parent: block }, null)).toEqual([]);
  });

  it('takes its own declarations off for Auto, and writes over another stylesheet\'s', () => {
    const facts: SizeFacts = { width: v('320px', true), flex: v('1', false), parent: row };
    expect(widthModeChanges('auto', facts, null)).toEqual([
      { property: 'width', value: null },
      { property: 'flex', value: '0 1 auto' },
    ]);
  });
});

describe('heightModeChanges', () => {
  it('writes height: 100% for Fill outside a flex column, and flex inside one', () => {
    expect(heightModeChanges('fill', { parent: block }, null)).toEqual([{ property: 'height', value: '100%' }]);
    expect(heightModeChanges('fill', { parent: column }, null)).toEqual([
      { property: 'height', value: null },
      { property: 'flex', value: '1 1 0' },
    ]);
  });

  it('fixes the height the element has now', () => {
    expect(heightModeChanges('fixed', { parent: block }, 199.6)).toEqual([{ property: 'height', value: '200px' }]);
  });

  it('takes its own height off for Auto, writes auto over another stylesheet\'s, and lets a growing flex go', () => {
    expect(heightModeChanges('auto', { height: v('320px', true), parent: block }, null)).toEqual([{ property: 'height', value: null }]);
    expect(heightModeChanges('auto', { height: v('320px'), parent: block }, null)).toEqual([{ property: 'height', value: 'auto' }]);
    expect(heightModeChanges('auto', { height: v('320px', true), flex: v('1', true), parent: column }, null)).toEqual([
      { property: 'height', value: null },
      { property: 'flex', value: null },
    ]);
  });
});

describe('Auto over a stylesheet the override was hiding', () => {
  it('writes auto rather than uncover another stylesheet\'s width', () => {
    const width = { value: '320px', origin: '/overrides.css', ours: true, under: { value: '50%', origin: '/styles/main.css' } };
    expect(widthModeChanges('auto', { width, parent: { display: 'block', flexDirection: 'row' } }, null)[0])
      .toEqual({ property: 'width', value: 'auto' });
  });
});
