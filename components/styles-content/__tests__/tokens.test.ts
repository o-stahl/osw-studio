import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import {
  sameColor,
  COLOR_TOLERANCE,
  colorsMatch,
  discoverColorTokens,
  hexColor,
  matchToken,
  parseColor,
  swatchAction,
  tokenAgentPrompt,
  tokenSupersedeMessage,
  type ColorToken,
} from '../tokens';
import { propertyEntry, type SwatchEntry } from '../properties';
import { templateTokens } from '@/lib/vfs/templates/theme';

/**
 * Colour detection, and the note built on it.
 *
 * The colour-space cases are load-bearing rather than decorative: the same colour reaches this code
 * as `oklch()` from `templateTokens()`, as hex from the `demo` template's stylesheet, and as `rgb()`
 * from `getComputedStyle`. A token check written as string equality passes none of them and would
 * silently never fire, which is indistinguishable from the feature working.
 *
 * The reference triple below is not produced by this module's own maths — sRGB red is
 * `oklch(0.6279554 0.257683 29.2338)` by the published oklab matrices, so a converter with the signs
 * or the matrix wrong fails it.
 */

const background = propertyEntry('background-color') as SwatchEntry;
const text = propertyEntry('color') as SwatchEntry;

const RED_OKLCH = 'oklch(0.6279554 0.257683 29.2338)';

describe('parseColor', () => {
  it('reads hex in every length', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#FF0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#ff000080')?.a).toBeCloseTo(0.5, 1);
    expect(parseColor('#f00f')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('reads both rgb spellings, including the one getComputedStyle answers with', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgb(255 0 0 / 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  });

  it('reads oklch, the spelling every built-in template writes', () => {
    const red = parseColor(RED_OKLCH)!;
    expect(red.r).toBeGreaterThan(250);
    expect(red.g).toBeLessThan(5);
    expect(red.b).toBeLessThan(5);
    expect(parseColor('oklch(1 0 0)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('oklch(0 0 0)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('oklch(0.57 0.19 40 / 0.12)')?.a).toBeCloseTo(0.12, 2);
  });

  it('is null for anything it cannot read, rather than guessing', () => {
    // A guess here becomes a false token match, which becomes a note claiming a token was
    // superseded when none was — or a `var()` write pointing at a token the user never chose.
    expect(parseColor('var(--accent)')).toBeNull();
    expect(parseColor('color-mix(in oklch, red, blue)')).toBeNull();
    expect(parseColor('linear-gradient(red, blue)')).toBeNull();
    expect(parseColor('inherit')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor(null)).toBeNull();
    expect(parseColor('#ff00')).toEqual({ r: 255, g: 255, b: 0, a: 0 });
  });
});

describe('matching across colour spaces', () => {
  it('recognises one colour written three different ways', () => {
    const oklch = parseColor(RED_OKLCH)!;
    const hex = parseColor('#ff0000')!;
    const rgb = parseColor('rgb(255, 0, 0)')!;
    expect(colorsMatch(oklch, hex)).toBe(true);
    expect(colorsMatch(oklch, rgb)).toBe(true);
    expect(colorsMatch(hex, rgb)).toBe(true);
  });

  it('still tells two colours apart', () => {
    expect(colorsMatch(parseColor('#ff0000')!, parseColor('#ee0000')!)).toBe(false);
    expect(colorsMatch(parseColor('#ff0000')!, parseColor('rgb(0, 0, 255)')!)).toBe(false);
  });

  it('does not match a tint to its base colour', () => {
    // `--accent-soft` is `--accent` at 12% alpha in every built-in template. Matching them would
    // report the wrong token in the note.
    expect(colorsMatch(parseColor('rgba(255, 0, 0, 0.12)')!, parseColor('#ff0000')!)).toBe(false);
  });

  it('tolerates only transform noise, not a different shade', () => {
    const base = parseColor('rgb(100, 100, 100)')!;
    expect(colorsMatch(base, { r: 100 + COLOR_TOLERANCE, g: 100, b: 100, a: 1 })).toBe(true);
    expect(colorsMatch(base, { r: 100 + COLOR_TOLERANCE + 1, g: 100, b: 100, a: 1 })).toBe(false);
  });

  it('matches an oklch token declared by the real template generator', () => {
    // Not a fixture: this is the stylesheet a built-in template actually ships.
    const tokens = discoverColorTokens([{ path: '/styles.css', content: templateTokens({ hue: 40 }) }]);
    const accent = tokens.find(token => token.name === '--accent')!;
    expect(accent.value.startsWith('oklch(')).toBe(true);
    const asRgb = `rgb(${accent.rgba.r}, ${accent.rgba.g}, ${accent.rgba.b})`;
    expect(matchToken(asRgb, tokens)?.name).toBe('--accent');
  });
});

describe('sameColor', () => {
  it('sees through the spelling', () => {
    // The pair the panel actually compares: what the engine computed against what the stylesheet
    // declared. These are the same colour and were never the same string, which is the bug it fixes.
    expect(sameColor('rgb(255, 0, 0)', '#ff0000')).toBe(true);
    expect(sameColor('rgb(29, 24, 19)', '#1D1813')).toBe(true);
  });

  it('separates colours that merely look close', () => {
    expect(sameColor('rgb(255, 0, 0)', '#00ff00')).toBe(false);
  });

  it('answers false rather than throwing on anything it cannot read', () => {
    // A swatch row must go unpressed for an unreadable colour, not break.
    expect(sameColor(null, '#ff0000')).toBe(false);
    expect(sameColor('rgb(255, 0, 0)', undefined)).toBe(false);
    expect(sameColor('not-a-colour', '#ff0000')).toBe(false);
  });
});

describe('hexColor', () => {
  /**
   * What `<input type="color">` is given as its value, which is the only spelling it accepts:
   * exactly `#rrggbb`, six digits, lower case. Anything else and the control silently falls back to
   * black, so the picker opens on the wrong colour and the user's own colour is the one they cannot
   * see.
   */

  it('writes six digits for a colour whose channels are all large', () => {
    expect(hexColor('rgb(18, 52, 86)')).toBe('#123456');
  });

  it('pads a channel below 16 rather than emitting five digits', () => {
    // The case the panel meets constantly and the one a test written from a mid-tone misses: every
    // dark colour has a channel under 16. Unpadded, `rgb(10, 11, 12)` spells `#abc` — a valid but
    // completely different colour — and `rgb(0, 0, 0)` spells `#000`.
    expect(hexColor('rgb(10, 11, 12)')).toBe('#0a0b0c');
    expect(hexColor('rgb(0, 0, 0)')).toBe('#000000');
    expect(hexColor('rgb(15, 0, 255)')).toBe('#0f00ff');
  });

  it('always answers seven characters, whatever the colour', () => {
    const colours = ['rgb(0, 0, 0)', 'rgb(1, 2, 3)', 'rgb(255, 255, 255)', 'rgb(9, 128, 16)'];
    for (const colour of colours) expect(hexColor(colour)).toHaveLength(7);
  });

  it('drops alpha, since the control has nowhere to put it', () => {
    expect(hexColor('rgba(10, 11, 12, 0.5)')).toBe('#0a0b0c');
  });

  it('answers null for anything it cannot read, rather than a broken hex', () => {
    // `#NaNNaNNaN` in the value attribute is worse than no value: the control shows black and the
    // panel has no way to tell that it did.
    expect(hexColor(null)).toBeNull();
    expect(hexColor(undefined)).toBeNull();
    expect(hexColor('not-a-colour')).toBeNull();
  });
});

describe('token discovery', () => {
  it('reads the project\'s own stylesheets, not a fixed list', () => {
    // A project that never used a built-in template, and never heard of `--accent`.
    const tokens = discoverColorTokens([{
      path: '/css/brand.css',
      content: ':root { --tuesday: #123456; --spacing-lg: 2rem; --font-body: serif; }',
    }]);
    expect(tokens.map(t => t.name)).toEqual(['--tuesday']);
    expect(tokens[0].file).toBe('/css/brand.css');
    expect(tokens[0].value).toBe('#123456');
  });

  it('keeps only the declarations that are colours', () => {
    const tokens = discoverColorTokens([{
      path: '/a.css',
      content: ':root { --r-lg: 13px; --t-fast: 130ms; --measure: 66ch; --ink: #1D1813; }',
    }]);
    expect(tokens.map(t => t.name)).toEqual(['--ink']);
  });

  it('skips a token defined through another token rather than mis-reading it', () => {
    const tokens = discoverColorTokens([{ path: '/a.css', content: ':root { --btn: var(--accent); }' }]);
    expect(tokens).toEqual([]);
  });

  it('lets a later stylesheet redeclare one', () => {
    const tokens = discoverColorTokens([
      { path: '/a.css', content: ':root { --accent: #ff0000; }' },
      { path: '/b.css', content: ':root { --accent: #0000ff; }' },
    ]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].file).toBe('/b.css');
    expect(tokens[0].value).toBe('#0000ff');
  });

  it('finds tokens across several files', () => {
    const tokens = discoverColorTokens([
      { path: '/a.css', content: ':root { --one: #111111; }' },
      { path: '/b.css', content: '.x { --two: rgb(2, 2, 2); }' },
    ]);
    expect(tokens.map(t => t.name).sort()).toEqual(['--one', '--two']);
  });
});

describe('the colour control', () => {
  const tokens: ColorToken[] = discoverColorTokens([{
    path: '/styles.css',
    content: `:root { --accent: ${RED_OKLCH}; --ink: #1d1813; }`,
  }]);

  it('writes a per-element override for a colour matching no token', () => {
    const action = swatchAction(background, '#00ff00', { 'background-color': 'rgb(9, 9, 9)' }, tokens);
    expect(action).toEqual({
      declaration: { property: 'background-color', value: '#00ff00' },
      superseded: null,
    });
  });

  it('STILL writes when the element\'s colour is a token, and names the token it superseded', () => {
    // The regression this file exists for. This case used to return a refusal and write nothing —
    // and since every built-in template styles everything through tokens, that made it the *normal*
    // case: pressing a swatch almost never applied anything.
    const action = swatchAction(background, '#00ff00', { 'background-color': 'rgb(255, 0, 0)' }, tokens);
    expect(action.declaration).toEqual({ property: 'background-color', value: '#00ff00' });
    expect(action.superseded?.name).toBe('--accent');
  });

  it('writes whichever spelling the frame answers the token in, and still names it', () => {
    for (const current of ['#ff0000', 'rgb(255, 0, 0)', RED_OKLCH]) {
      const action = swatchAction(text, '#00ff00', { color: current }, tokens);
      expect(action.declaration).toEqual({ property: 'color', value: '#00ff00' });
      expect(action.superseded?.name).toBe('--accent');
    }
  });

  it('writes a chosen token as var(), not as its literal', () => {
    // Live again now that nothing refuses ahead of it: an element pointed at `--ink` keeps following
    // `--ink`, so a later token change still reaches it.
    const action = swatchAction(text, '#1d1813', { color: 'rgb(9, 9, 9)' }, tokens);
    expect(action.declaration).toEqual({ property: 'color', value: 'var(--ink)' });
    expect(action.superseded).toBeNull();
  });

  it('writes a chosen token as var() even when it supersedes another token', () => {
    // Both halves at once — the case a project made entirely of tokens is always in.
    const action = swatchAction(text, '#1d1813', { color: 'rgb(255, 0, 0)' }, tokens);
    expect(action.declaration).toEqual({ property: 'color', value: 'var(--ink)' });
    expect(action.superseded?.name).toBe('--accent');
  });

  it('writes normally for a project that declares no tokens at all', () => {
    const action = swatchAction(text, '#00ff00', { color: 'rgb(255, 0, 0)' }, []);
    expect(action.declaration).toEqual({ property: 'color', value: '#00ff00' });
    expect(action.superseded).toBeNull();
  });

  it('writes when the frame has no value to compare', () => {
    const action = swatchAction(text, '#00ff00', {}, tokens);
    expect(action.declaration).toEqual({ property: 'color', value: '#00ff00' });
    expect(action.superseded).toBeNull();
  });

  it('describes the change in the past tense, naming the token and its file', () => {
    const token = tokens.find(t => t.name === '--accent')!;
    const message = tokenSupersedeMessage(background.label, token, createTranslator({ locale: 'en', messages: en, namespace: 'styles' }));
    expect(message).toContain(background.label);
    expect(message).toContain('--accent');
    expect(message).toContain('/styles.css');
    expect(message).toContain('Only this element changed');
    // It reports a write that has happened. A conditional in it is a lie about the file on disk.
    expect(message).not.toMatch(/\bwould\b/);

    const prompt = tokenAgentPrompt(background, token, '#00ff00');
    expect(prompt).toContain('--accent');
    expect(prompt).toContain('/styles.css');
    expect(prompt).toContain('#00ff00');
  });
});
