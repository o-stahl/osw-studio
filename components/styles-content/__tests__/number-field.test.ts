import { describe, it, expect } from 'vitest';
import { baseNumber, columnsOf, convertNumber, keywordOf, parseNumber, scrubNumber, shownNumber, stepNumber, typedKeyword, typedNumber, writeNumber, type NumberContext } from '../number-field';
import { STYLE_PROPERTIES, type NumberEntry } from '../properties';

const entry = (id: string) => STYLE_PROPERTIES.find((e) => e.id === id) as NumberEntry;
const ctx = (over: Partial<NumberContext> = {}): NumberContext => ({ rootFontSize: 16, fontSize: 20, ...over });

describe('shownNumber', () => {
  it('prefers what was asked for, then the declaration as written, then the computed value', () => {
    const left = entry('left');
    expect(shownNumber(left, ctx({ requested: '12px', specified: { value: '50%', origin: 'a', ours: false }, computed: '80px' }))).toEqual({ n: 12, unit: 'px' });
    expect(shownNumber(left, ctx({ specified: { value: '50%', origin: 'a', ours: false }, computed: '80px' }))).toEqual({ n: 50, unit: '%' });
    expect(shownNumber(left, ctx({ computed: '80px' }))).toEqual({ n: 80, unit: 'px' });
  });

  it('turns the computed px into the unit picked, where it can', () => {
    expect(shownNumber(entry('width'), ctx({ computed: '320px', unit: 'rem' }))).toEqual({ n: 20, unit: 'rem' });
    expect(shownNumber(entry('letter-spacing'), ctx({ computed: '2px', unit: 'em' }))).toEqual({ n: 0.1, unit: 'em' });
    // A percentage of what is not known here.
    expect(shownNumber(entry('width'), ctx({ computed: '320px', unit: '%' }))).toEqual({ n: null, unit: '%' });
  });

  it('shows nothing for auto, and 0 for no rotation and normal letter spacing', () => {
    expect(shownNumber(entry('z-index'), ctx({ computed: 'auto' })).n).toBeNull();
    expect(shownNumber(entry('rotate'), ctx({ computed: 'none' }))).toEqual({ n: 0, unit: 'deg' });
    expect(shownNumber(entry('letter-spacing'), ctx({ computed: 'normal' }))).toEqual({ n: 0, unit: 'px' });
  });

  it('shows opacity as a percentage and a grid as its number of columns', () => {
    expect(shownNumber(entry('opacity'), ctx({ computed: '0.35' }))).toEqual({ n: 35, unit: '%' });
    expect(shownNumber(entry('grid-columns'), ctx({ computed: '200px 200px 200px' }))).toEqual({ n: 3, unit: '' });
    expect(shownNumber(entry('grid-columns'), ctx({ requested: 'repeat(4, minmax(0, 1fr))', computed: '1px' }))).toEqual({ n: 4, unit: '' });
  });
});

describe('writing a number', () => {
  it('writes the row\'s own shape, clamped to its range', () => {
    expect(writeNumber(entry('opacity'), 140, '%')).toBe('1');
    expect(writeNumber(entry('opacity'), 35, '%')).toBe('0.35');
    expect(writeNumber(entry('grid-columns'), 0, '')).toBe('repeat(1, minmax(0, 1fr))');
    expect(writeNumber(entry('z-index'), 2.6, '')).toBe('3');
    expect(writeNumber(entry('width'), -5, 'px')).toBe('0px');
    expect(writeNumber(entry('rotate'), -15, 'deg')).toBe('-15deg');
  });

  it('steps from what is shown, or from 0 when nothing is', () => {
    expect(stepNumber(entry('left'), { n: 12, unit: 'px' }, 1)).toBe('13px');
    expect(stepNumber(entry('z-index'), { n: null, unit: '' }, 1)).toBe('1');
    expect(stepNumber(entry('opacity'), { n: 50, unit: '%' }, -1)).toBe('0.45');
  });

  it('scrubs by steps from where the drag began', () => {
    expect(scrubNumber(entry('rotate'), { n: 10, unit: 'deg' }, -25)).toBe('-15deg');
    expect(scrubNumber(entry('letter-spacing'), { n: 0, unit: 'px' }, 3)).toBe('1.5px');
  });

  it('converts between px, rem and em, and not into %', () => {
    expect(convertNumber(entry('width'), { n: 320, unit: 'px' }, 'rem', ctx())).toBe('20rem');
    expect(convertNumber(entry('width'), { n: 320, unit: 'px' }, '%', ctx())).toBeNull();
    expect(convertNumber(entry('width'), { n: null, unit: 'px' }, 'rem', ctx())).toBeNull();
  });

  it('takes a typed number with or without the unit on screen, and nothing else', () => {
    expect(typedNumber(entry('left'), '24', 'px')).toBe('24px');
    expect(typedNumber(entry('left'), '24px', 'px')).toBe('24px');
    expect(typedNumber(entry('left'), '24rem', 'px')).toBeNull();
    expect(typedNumber(entry('left'), '12px;color:red', 'px')).toBeNull();
  });
});

describe('keywords', () => {
  it('take the first source that says anything: a keyword there, or a number', () => {
    const keywords = ['auto'] as const;
    expect(keywordOf(keywords, [undefined, 'auto', '12px'])).toBe('auto');
    expect(keywordOf(keywords, ['12px', 'auto'])).toBeNull();
    expect(keywordOf(keywords, ['', null, 'AUTO'])).toBe('auto');
    expect(keywordOf(keywords, ['none'])).toBeNull();
    expect(keywordOf(undefined, ['auto'])).toBeNull();
  });

  it('are typed as words the row takes, and nothing else', () => {
    expect(typedKeyword(['none'], ' None ')).toBe('none');
    expect(typedKeyword(['none'], 'auto')).toBeNull();
    expect(typedKeyword(undefined, 'auto')).toBeNull();
  });
});

describe('viewport units and where a step starts', () => {
  it('reads vw and vh, and converts vw where the frame\'s width is known', () => {
    expect(parseNumber('100vh')).toEqual({ n: 100, unit: 'vh' });
    expect(shownNumber(entry('min-height'), ctx({ specified: { value: '100vh', origin: 'a', ours: false }, computed: '900px' }))).toEqual({ n: 100, unit: 'vh' });
    expect(shownNumber(entry('max-width'), ctx({ computed: '720px', unit: 'vw', viewportWidth: 1440 }))).toEqual({ n: 50, unit: 'vw' });
    expect(shownNumber(entry('max-width'), ctx({ computed: '720px', unit: 'vw' }))).toEqual({ n: null, unit: 'vw' });
  });

  it('starts from the row\'s startFrom when there is no number to show', () => {
    const shown = shownNumber(entry('max-width'), ctx({ computed: 'none' }));
    expect(shown.n).toBeNull();
    expect(baseNumber(shown, ctx({ start: '600px' }))).toEqual({ n: 600, unit: 'px' });
    expect(baseNumber({ n: null, unit: 'rem' }, ctx({ start: '600px' }))).toEqual({ n: 37.5, unit: 'rem' });
    expect(baseNumber({ n: 12, unit: 'px' }, ctx({ start: '600px' }))).toEqual({ n: 12, unit: 'px' });
    expect(baseNumber({ n: null, unit: '%' }, ctx({ start: '600px' }))).toEqual({ n: null, unit: '%' });
  });
});

describe('columnsOf', () => {
  it('counts tracks outside parentheses and line names', () => {
    expect(columnsOf('[a] 100px [b] minmax(0, 1fr) 2fr')).toBe(3);
    expect(columnsOf('repeat(5, 1fr)')).toBe(5);
    expect(columnsOf('none')).toBeNull();
  });
});
