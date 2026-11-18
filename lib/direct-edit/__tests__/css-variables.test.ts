import { describe, it, expect } from 'vitest';
import {
  countUses,
  findDefinition,
  isSafeVariableValue,
  scanProjectVariables,
  scanVariables,
  variableKind,
  variableOf,
  withoutShadowed,
  writeVariable,
} from '../css-variables';
import { templateStylesheet } from '@/lib/vfs/templates/theme';

/**
 * The project's custom properties, read out of its stylesheets as written and edited where they
 * stand. Checked on hand-built CSS for each case, and on a built-in template's real stylesheet so a
 * scanner that only handles tidy fixtures does not pass.
 */

const CSS = [
  '/* tokens: --fake: 1px; */',
  ':root {',
  '  color-scheme: light;',
  '  --accent: oklch(0.57 0.19 40);',
  '  --space-4: 1rem; --radius: 13px',
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root { --accent: #ff8844; }',
  '}',
  '.card {',
  '  --pad: var(--space-4);',
  '  padding: var(--pad);',
  '  background: url("data:image/svg+xml;utf8,<svg>{--not: 1}</svg>");',
  '}',
  '[data-theme="dark"] { --accent: #000 !important; }',
].join('\n');

const names = (css: string) => scanVariables('/styles.css', css).map(def => `${def.name}=${def.value}`);

describe('scanVariables', () => {
  it('finds every definition with the value as written, in order', () => {
    expect(names(CSS)).toEqual([
      '--accent=oklch(0.57 0.19 40)',
      '--space-4=1rem',
      '--radius=13px',
      '--accent=#ff8844',
      '--pad=var(--space-4)',
      '--accent=#000 !important',
    ]);
  });

  it('gives the span of the value, so the file can be edited in place', () => {
    for (const def of scanVariables('/styles.css', CSS)) expect(CSS.slice(def.start, def.end)).toBe(def.value);
  });

  it('says which rule each stands in, and whether that is the whole document', () => {
    const defs = scanVariables('/styles.css', CSS);
    expect(defs.map(def => [def.selector, def.context, def.root])).toEqual([
      [':root', [], true],
      [':root', [], true],
      [':root', [], true],
      [':root', ['@media (prefers-color-scheme: dark)'], true],
      ['.card', [], false],
      ['[data-theme="dark"]', [], false],
    ]);
  });

  it('is not fooled by a comment, a string, a url, or a property that only starts like one', () => {
    expect(names('/* --a: 1 */ .x { content: "--b: 2;"; background: url(--c:3;x); color: red; -webkit-x: 1 }')).toEqual([]);
    expect(names('.x { color: var(--a); }')).toEqual([]);
    // A semicolon inside the string would otherwise end the statement and start one at `--b`.
    expect(names('.x { content: "a; --b: 2"; }')).toEqual([]);
  });

  it('finds a definition that a comment in its rule stands before', () => {
    const css = ':root {\n  /* Colours */\n  --accent: #f60;\n  --bg: #fff;\n  /* Spacing */ /* in rem */\n  --space-1: 4px;\n}';
    expect(names(css)).toEqual(['--accent=#f60', '--bg=#fff', '--space-1=4px']);
    for (const def of scanVariables('/styles.css', css)) expect(css.slice(def.start, def.end)).toBe(def.value);
  });

  it('reads a value with a semicolon or a brace inside parentheses whole', () => {
    const css = ':root { --icon: url(data:image/svg+xml;utf8,<svg>{}</svg>); --after: 1px; }';
    expect(names(css)).toEqual(['--icon=url(data:image/svg+xml;utf8,<svg>{}</svg>)', '--after=1px']);
  });

  it('reads nested rules and several declarations on one line', () => {
    const defs = scanVariables('/a.css', '.a { --x: 1px; .b & { --y: 2px } --z: 3px }');
    expect(defs.map(def => [def.name, def.selector, def.context])).toEqual([
      ['--x', '.a', []],
      ['--y', '.b &', ['.a']],
      ['--z', '.a', []],
    ]);
  });

  it('counts html, a list with :root, and conditions around it as the document; a rule inside another rule not', () => {
    const root = (css: string) => scanVariables('/a.css', css)[0].root;
    expect(root('html { --a: 1 }')).toBe(true);
    expect(root(':root, :host { --a: 1 }')).toBe(true);
    expect(root('@layer base { @supports (color: oklch(0 0 0)) { :root { --a: 1 } } }')).toBe(true);
    expect(root(':root.dark { --a: 1 }')).toBe(false);
    expect(root('.theme { :root { --a: 1 } }')).toBe(false);
  });

  it('reads a built-in template\'s stylesheet: every definition it writes, each span exact', () => {
    const css = templateStylesheet({ hue: 40 });
    const defs = scanVariables('/styles.css', css);
    // The theme writes `--name:` only as a declaration, never in a comment or a string.
    expect(defs).toHaveLength(css.match(/--[\w-]+\s*:/g)!.length);
    for (const def of defs) expect(css.slice(def.start, def.end)).toBe(def.value);
  });
});

describe('variableKind', () => {
  it.each([
    ['#fff', 'color'], ['#1D1813', 'color'], ['rgba(18,20,26,0.11)', 'color'], ['oklch(0.57 0.19 40 / 0.12)', 'color'],
    ['color-mix(in oklch, var(--accent), black 8%)', 'color'], ['transparent', 'color'], ['light-dark(#fff, #000)', 'color'],
    ['13px', 'length'], ['1.5rem', 'length'], ['66ch', 'length'], ['200ms', 'length'], ['0', 'length'], ['1.6', 'length'],
    ['ui-sans-serif, system-ui, sans-serif', 'font'], ['"Inter", serif', 'font'],
    ['0 1px 2px rgba(40,28,16,0.06), 0 2px 8px -2px rgba(40,28,16,0.08)', 'shadow'],
    ['var(--sans)', 'other'], ['cubic-bezier(.2,.7,.2,1)', 'other'], ['clamp(1rem, 2vw, 2rem)', 'other'],
  ])('%s is %s', (value, kind) => {
    expect(variableKind(value)).toBe(kind);
  });
});

describe('writeVariable', () => {
  const light = { name: '--accent', selector: ':root', context: [], value: 'oklch(0.57 0.19 40)' };
  const dark = { name: '--accent', selector: ':root', context: ['@media (prefers-color-scheme: dark)'], value: '#ff8844' };

  it('changes the one definition named, by its rule, and nothing else in the file', () => {
    const out = writeVariable('/styles.css', CSS, dark, '#00ff00')!;
    expect(out).toBe(CSS.replace('--accent: #ff8844;', '--accent: #00ff00;'));
    expect(writeVariable('/styles.css', CSS, light, 'rebeccapurple')).toBe(CSS.replace('--accent: oklch(0.57 0.19 40);', '--accent: rebeccapurple;'));
  });

  it('finds the definition again after its value changed under it', () => {
    const edited = CSS.replace('#ff8844', '#123456');
    expect(writeVariable('/styles.css', edited, dark, '#00ff00')).toBe(edited.replace('#123456', '#00ff00'));
  });

  it('keeps !important on a definition that had it', () => {
    const ref = { name: '--accent', selector: '[data-theme="dark"]', context: [], value: '#000 !important' };
    expect(writeVariable('/styles.css', CSS, ref, '#111')).toContain('[data-theme="dark"] { --accent: #111 !important; }');
  });

  it('writes the definition in force when a comment stands before it, not the one it overrides', () => {
    const css = ':root {\n  --a: 1px;\n  /* wider */\n  --a: 2px;\n}';
    const ref = { name: '--a', selector: ':root', context: [], value: '2px' };
    expect(writeVariable('/a.css', css, ref, '3px')).toBe(':root {\n  --a: 1px;\n  /* wider */\n  --a: 3px;\n}');
  });

  it('takes the one in force when a rule declares the name twice and neither has the value it had', () => {
    const css = ':root { --a: 1px; --a: 2px; }';
    expect(writeVariable('/a.css', css, { name: '--a', selector: ':root', context: [], value: '9px' }, '3px')).toBe(':root { --a: 1px; --a: 3px; }');
    expect(writeVariable('/a.css', css, { name: '--a', selector: ':root', context: [], value: '1px' }, '3px')).toBe(':root { --a: 3px; --a: 2px; }');
  });

  it('answers null for a value whose parenthesis, bracket or quote is never closed, and takes one that closes', () => {
    for (const bad of ['rgb(255 102 0', 'calc(1px + 2px', '"Inter', 'url("a.png"', '[a', 'red\\']) {
      expect(isSafeVariableValue(bad), bad).toBe(false);
      expect(writeVariable('/styles.css', CSS, light, bad), bad).toBeNull();
    }
    for (const good of ['rgb(255 102 0)', 'oklch(from var(--a) calc(l - 0.05) c h)', '"Inter", sans-serif', 'url("a(b.png")']) {
      expect(isSafeVariableValue(good), good).toBe(true);
    }
  });

  it('answers null when the rule no longer declares it, and for a value that would end the declaration', () => {
    expect(writeVariable('/styles.css', CSS, { ...light, selector: '.gone' }, '#fff')).toBeNull();
    expect(findDefinition('/styles.css', CSS, { ...light, name: '--nope' })).toBeNull();
    for (const bad of ['red; } body { color: blue', 'a } b', '/* x */ red', '   ']) {
      expect(isSafeVariableValue(bad), bad).toBe(false);
      expect(writeVariable('/styles.css', CSS, light, bad)).toBeNull();
    }
  });
});

describe('withoutShadowed', () => {
  const css = [
    ':root { --accent: #f00; --accent-hover: #c00; --plain: 1px; }',
    '@supports (color: oklch(from red l c h)) { :root { --accent-hover: oklch(from var(--accent) calc(l - 0.05) c h); } }',
    '@media (min-width: 800px) { :root { --plain: 2px; } }',
    '.card { --plain: 3px; }',
  ].join('\n');
  const defs = scanVariables('/styles.css', css);
  const shown = (supports: boolean) => withoutShadowed(defs, () => supports).map(def => `${def.name}=${def.value}`);

  it('keeps the @supports definition and drops the plain one it replaces, where the browser meets the condition', () => {
    expect(shown(true)).toEqual(['--accent=#f00', '--plain=1px', '--accent-hover=oklch(from var(--accent) calc(l - 0.05) c h)', '--plain=2px', '--plain=3px']);
  });

  it('keeps the plain one where it does not', () => {
    expect(shown(false)).toEqual(['--accent=#f00', '--accent-hover=#c00', '--plain=1px', '--plain=2px', '--plain=3px']);
  });

  it('asks about the condition as the stylesheet wrote it', () => {
    const asked: string[] = [];
    withoutShadowed(defs, (condition) => { asked.push(condition); return true; });
    expect(new Set(asked)).toEqual(new Set(['(color: oklch(from red l c h))']));
  });

  it('leaves a built-in template one definition of each name it redefines under @supports', () => {
    const template = scanVariables('/styles.css', templateStylesheet({ hue: 40 }));
    const redefined = new Set(template.filter(def => def.root && def.context.length > 0).map(def => def.name));
    expect(redefined.size).toBeGreaterThan(0);
    for (const supports of [true, false]) {
      const names = withoutShadowed(template, () => supports).map(def => def.name);
      for (const name of redefined) {
        expect(names.filter(n => n === name), `${name} supports=${supports}`).toHaveLength(1);
      }
    }
  });
});

describe('countUses and variableOf', () => {
  it('counts the places the CSS reads a variable, not names that only start with it', () => {
    const sources = [
      { path: '/a.css', content: '.a { color: var(--accent); border-color: var( --accent , red); background: var(--accent-soft); }' },
      { path: '/b.css', content: '.b { fill: var(--accent) }' },
    ];
    expect(countUses(sources, '--accent')).toBe(3);
    expect(countUses(sources, '--accent-soft')).toBe(1);
    expect(countUses(sources, '--none')).toBe(0);
  });

  it('names the variable a value is, when it is one reference and nothing else', () => {
    expect(variableOf('var(--accent)')).toBe('--accent');
    expect(variableOf(' var( --space-4 , 1rem) ')).toBe('--space-4');
    expect(variableOf('calc(var(--space-4) * 2)')).toBeNull();
    expect(variableOf('0 var(--gutter)')).toBeNull();
    expect(variableOf(null)).toBeNull();
  });

  it('scans several files in the order given', () => {
    expect(scanProjectVariables([{ path: '/a.css', content: ':root{--a:1px}' }, { path: '/b.css', content: ':root{--b:2px}' }]).map(d => `${d.file}${d.name}`))
      .toEqual(['/a.css--a', '/b.css--b']);
  });
});
