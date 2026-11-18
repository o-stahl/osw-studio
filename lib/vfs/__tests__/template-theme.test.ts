import { describe, it, expect } from 'vitest';
import { SPACE_SCALE, TEMPLATE_COMPONENT_CSS, TYPE_SCALE, templateStylesheet, templateTokens } from '@/lib/vfs/templates/theme';

/**
 * The component CSS was lifted out of the theme artifact mechanically, and the one thing a
 * mechanical lift gets wrong is context: a rule reads the same whether or not it sat inside an
 * `@media` block. These pin the parts where losing the wrapper would be silent.
 */
describe('shared component CSS', () => {
  it('keeps the motion opt-out behind the media query that asked for it', () => {
    // Extracted flat, `transition: none !important` applies to everyone, and every template ships
    // with its transitions and its button hover dead. Nothing renders wrong, so nothing catches it.
    const reduced = TEMPLATE_COMPONENT_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(reduced).toBeGreaterThan(-1);
    expect(TEMPLATE_COMPONENT_CSS.indexOf('transition: none !important')).toBeGreaterThan(reduced);
    expect(TEMPLATE_COMPONENT_CSS.indexOf('animation: none !important')).toBeGreaterThan(reduced);
  });

  it('balances its braces, so the last rule closes the file rather than the media query', () => {
    const opens = (TEMPLATE_COMPONENT_CSS.match(/\{/g) ?? []).length;
    const closes = (TEMPLATE_COMPONENT_CSS.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('makes the hidden attribute win against components that set a display', () => {
    // [hidden] is a browser default and any author rule outranks it, so `.notice { display: flex }`
    // keeps an element on screen after a script sets `el.hidden = true`.
    expect(TEMPLATE_COMPONENT_CSS).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });
});

describe('tokens and components agree', () => {
  it('defines every custom property the components read', () => {
    // The two halves were extracted separately, and a missing token is silent: the declaration is
    // dropped and the element renders without it. `--shadow-sm` went missing exactly this way, so
    // every primary button sat flat with nothing to show for the box-shadow it asked for.
    const declared = new Set(
      [...templateTokens({ hue: 40 }).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );
    const used = new Set(
      [...TEMPLATE_COMPONENT_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
    );
    // A component may define its own, as .label-mono does for --font-label.
    const definedByComponents = new Set(
      [...TEMPLATE_COMPONENT_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );

    const missing = [...used].filter((v) => !declared.has(v) && !definedByComponents.has(v));
    expect(missing).toEqual([]);
  });

  it('declares the same properties whichever scheme a template picked', () => {
    // Otherwise a dark template quietly loses a token a light one has, and only that template
    // breaks.
    const names = (css: string) =>
      [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
    expect(names(templateTokens({ hue: 40, scheme: 'dark' }))).toEqual(
      names(templateTokens({ hue: 40 })),
    );
  });
});

describe('template tokens', () => {
  it('varies only what the spec allows a template to vary', () => {
    // Section 09 of the artifact: accent hue, light or dark, density, serif. Two templates on the
    // same scheme differ in their accent and nowhere else, which is what keeps them a family.
    const a = templateTokens({ hue: 285 });
    const b = templateTokens({ hue: 145 });

    const surfaceLines = (css: string) =>
      css.split('\n').filter((line) => /--(canvas|sunken|base|raised|ink|line)/.test(line));

    expect(surfaceLines(a)).toEqual(surfaceLines(b));
    expect(a).not.toBe(b);
    expect(a).toContain('oklch(0.57 0.19 285)');
    expect(b).toContain('oklch(0.57 0.19 145)');
  });

  it('scales the smaller radii off the one a template sets', () => {
    // A template picks one number for density; the rest follow, so nothing has to hand-tune three.
    expect(templateTokens({ hue: 40, radius: 6 })).toContain('--r-lg: 6px;');
    expect(templateTokens({ hue: 40, radius: 6 })).toContain('--r-md: 4px;');
  });
});

describe('the type and spacing scales', () => {
  const sizes = [...TEMPLATE_COMPONENT_CSS.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
  const spacing = [...TEMPLATE_COMPONENT_CSS.matchAll(/(?:^|\s)(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?:\s*([^;]+);/g)].map((m) => m[1].trim());

  it('sets every font size from the scale, so the Styles tab can name the step a rule is on', () => {
    // Two are not steps of anything: the size relative to its parent (code inside running text),
    // and the button's own, set half a pixel under the body's by eye.
    expect(sizes.filter((size) => !size.startsWith('var(--text-'))).toEqual(['0.875em', '0.90625rem']);
    const tokens = templateTokens({ hue: 40 });
    for (const [name, value] of TYPE_SCALE) {
      expect(tokens, name).toContain(`  ${name}: ${value};`);
      expect(sizes, name).toContain(`var(${name})`);
    }
  });

  it('writes a spacing declaration with steps or with numbers, never both', () => {
    const mixed = spacing.filter((value) => value.includes('var(--space-') && /\d(?:rem|px|em)\b/.test(value.replace(/var\([^)]*\)/g, '')));
    expect(mixed).toEqual([]);
    expect(spacing.some((value) => value.includes('var(--space-'))).toBe(true);
    // A value tuned by eye, off the quarter-rem grid, keeps its number.
    const offGrid = (value: string) => [...value.matchAll(/(\d*\.?\d+)rem\b/g)].some(([, n]) => (Number(n) * 4) % 1 !== 0);
    expect(spacing.some((value) => !value.includes('var(') && offGrid(value))).toBe(true);
  });

  it('defines no spacing step the components do not use', () => {
    const tokens = templateTokens({ hue: 40 });
    for (const [name, value] of SPACE_SCALE) {
      expect(tokens, name).toContain(`  ${name}: ${value};`);
      expect(TEMPLATE_COMPONENT_CSS, name).toContain(`var(${name})`);
    }
  });
});

describe('the accent and its variants', () => {
  const derived = (css: string) => css.slice(css.indexOf('@supports'));

  it('gives each variant a fixed value, and a value worked out from --accent where the browser can', () => {
    const css = templateTokens({ hue: 40 });
    expect(derived(css)).toMatch(/^@supports \(color: oklch\(from red l c h\)\) \{\n {2}:root \{/);
    for (const name of ['--accent-hover', '--accent-soft', '--accent-text', '--accent-quiet']) {
      // Twice: the fixed one in :root, which an older browser keeps, then the one that follows --accent.
      expect(css.match(new RegExp(`${name}:`, 'g')), name).toHaveLength(2);
      expect(derived(css), name).toMatch(new RegExp(`${name}: oklch\\(from var\\(--accent\\) `));
    }
    // --accent itself is defined once: it is the one colour a template chooses.
    expect(css.match(/--accent:/g)).toHaveLength(1);
  });

  it('works the variants out with the numbers the fixed values were made with', () => {
    const light = templateTokens({ hue: 40 });
    expect(light).toContain('--accent-hover: oklch(0.52 0.19 40);');
    expect(derived(light)).toContain('--accent-hover: oklch(from var(--accent) calc(l - 0.05) c h);');
    expect(light).toContain('--accent-text: oklch(0.50 0.175 40);');
    expect(derived(light)).toContain('--accent-text: oklch(from var(--accent) calc(l - 0.07) calc(c * 0.92) h);');
    expect(derived(light)).toContain('--accent-soft: oklch(from var(--accent) l c h / 0.12);');
    expect(derived(light)).toContain('--accent-quiet: oklch(from var(--accent) 0.48 0.03 h);');

    // A dark template lightens where a light one darkens.
    const dark = templateTokens({ hue: 40, scheme: 'dark' });
    expect(dark).toContain('--accent-hover: oklch(0.63 0.19 40);');
    expect(derived(dark)).toContain('--accent-hover: oklch(from var(--accent) calc(l + 0.06) c h);');
    expect(dark).toContain('--accent-text: oklch(0.72 0.175 40);');
    expect(derived(dark)).toContain('--accent-text: oklch(from var(--accent) calc(l + 0.15) calc(c * 0.92) h);');
    expect(derived(dark)).toContain('--accent-quiet: oklch(from var(--accent) 0.62 0.03 h);');
  });

  it('puts the derived block ahead of the component rules, in the stylesheet a template ships', () => {
    const css = templateStylesheet({ hue: 40 });
    expect(css.indexOf('@supports')).toBeGreaterThan(css.indexOf(':root {'));
    expect(css.indexOf('@supports')).toBeLessThan(css.indexOf(TEMPLATE_COMPONENT_CSS));
  });
});
