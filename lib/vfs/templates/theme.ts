/**
 * The shared look of the built-in templates.
 *
 * Extracted from `deepstudio/osw-template-theme.html`, which is the spec. Its
 * section 07 is explicit: "Identical markup and identical component CSS. Only
 * token values differ." So this file is the component CSS, byte for byte, and a
 * template contributes nothing but its `:root`.
 *
 * Section 09 lists what a template may vary, and it is four things: accent hue,
 * whether it leans light or dark, density, and whether a serif appears at all.
 * Layout is not one of them. If a template seems to need a component this does
 * not have, add it here so every template gets it, rather than adding a rule to
 * one stylesheet.
 */

/** Every component rule, shared by all templates. */
export const TEMPLATE_COMPONENT_CSS = `* {
  box-sizing: border-box;
}

/*
 * The [hidden] attribute is a browser default, and any author rule beats a
 * browser default. So a component that sets its own display (.notice, .chat,
 * .list-item, an absolutely positioned fallback) stays on screen when a script
 * hides it, and the script looks like it did nothing. This is the one place
 * that can be fixed once for every template.
 */
[hidden] {
  display: none !important;
}

body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--text-body);
  font-weight: 400;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  transition: background var(--t-base) var(--ease), color var(--t-base) var(--ease);
}

::selection {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.wrap {
  max-width: 940px;
  margin: 0 auto;
  padding: clamp(2rem,5vw,4rem) clamp(1.25rem,4vw,2.5rem) 6rem;
}

.prose {
  max-width: var(--measure);
}

h1, h2, h3, h4 {
  margin: 0;
  font-weight: 400;
  text-wrap: balance;
}

h1 {
  font-size: var(--text-h1);
  letter-spacing: -0.03em;
  line-height: 1.08;
}

h2 {
  font-size: var(--text-h2);
  letter-spacing: -0.02em;
  line-height: 1.12;
}

h3 {
  font-size: var(--text-lg);
  letter-spacing: -0.01em;
}

h4 {
  font-size: var(--text-base);
}

p {
  margin: 0;
  max-width: var(--measure);
}

p + p {
  margin-top: 0.85rem;
}

a {
  color: var(--accent-text);
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}

code, .mono {
  font-family: var(--mono);
  font-size: 0.875em;
}

.label {
  font-family: var(--font-label);
  font-size: var(--text-2xs);
  font-weight: var(--label-weight);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--accent-quiet);
}

.label-mono {
  --font-label: var(--mono);
  --label-weight: 500;
}

.muted {
  color: var(--ink-soft);
}

.faint {
  color: var(--ink-faint);
}

.keyline {
  border: 0;
  border-top: 1px solid var(--line);
  margin: var(--space-5) 0;
}

.demo {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--canvas);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: inherit;
  font-size: 0.90625rem;
  font-weight: 600;
  padding: 0.65rem 1.25rem;
  border-radius: var(--r-pill);
  border: 1px solid transparent;
  cursor: pointer;
  text-decoration: none;
  transition: transform var(--t-fast) var(--ease), background var(--t-fast) var(--ease),
                box-shadow var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}

.btn:hover {
  transform: translateY(-2px);
}

.btn-primary {
  background: var(--accent);
  color: var(--on-accent);
  box-shadow: var(--shadow-sm);
}

.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: var(--shadow-md);
}

.btn-line {
  background: var(--ink);
  color: var(--canvas);
  box-shadow: var(--shadow-sm);
}

.btn-line:hover {
  box-shadow: var(--shadow-md);
}

.btn-quiet {
  background: transparent;
  color: var(--ink);
  border-color: var(--line-strong);
}

.btn-quiet:hover {
  border-color: var(--ink-soft);
}

.btn-sm {
  font-size: var(--text-sm);
  padding: 0.4rem 0.85rem;
}

.btn:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
  box-shadow: none;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field > span {
  font-size: var(--text-sm);
  color: var(--ink-soft);
}

.field input, .field textarea, .field select {
  font: inherit;
  font-size: var(--text-base);
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--sunken);
  color: var(--ink);
  width: 100%;
}

.field textarea {
  resize: vertical;
  min-height: 5.5rem;
}

.field input::placeholder, .field textarea::placeholder {
  color: var(--ink-faint);
}

.field input:focus, .field textarea:focus {
  background: var(--raised);
}

.field .hint {
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.field .err {
  font-size: var(--text-xs);
  color: var(--stop);
}

.field.is-error input {
  border-color: var(--stop);
}

.tag {
  font-family: var(--mono);
  font-size: var(--text-2xs);
  padding: 0.18rem 0.55rem;
  border-radius: var(--r-sm);
  background: var(--base);
  color: var(--ink-soft);
  border: 1px solid var(--line);
}

.tag-accent {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: transparent;
}

.tag-ok {
  color: var(--ok);
}

.tag-warn {
  color: var(--warn);
}

.tag-stop {
  color: var(--stop);
}

.filter {
  font: inherit;
  font-size: var(--text-xs);
  padding: 0.28rem 0.7rem;
  cursor: pointer;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--ink-soft);
  transition: border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}

.filter:hover {
  color: var(--ink);
  border-color: var(--ink-soft);
}

.filter[aria-pressed="true"] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.notice {
  display: flex;
  gap: var(--space-3);
  padding: 0.85rem 1rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--base);
  font-size: var(--text-md);
  max-width: var(--measure);
}

.notice .bar {
  width: 2px;
  border-radius: 2px;
  flex-shrink: 0;
  background: var(--warn);
}

.notice-stop .bar {
  background: var(--stop);
}

.notice-ok .bar {
  background: var(--ok);
}

.list {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}

.list-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 0.8rem 1rem;
  background: var(--raised);
}

.list-item + .list-item {
  border-top: 1px solid var(--line);
}

.list-item:hover {
  background: var(--base);
}

.list-item .lead {
  font-size: var(--text-base);
}

.list-item .sub {
  font-size: var(--text-sm);
  color: var(--ink-soft);
}

.table-scroll {
  overflow-x: auto;
}

table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--text-md);
  min-width: 30rem;
}

th, td {
  text-align: left;
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--line);
}

th {
  font-family: var(--mono);
  font-size: var(--text-2xs);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--ink-faint);
  font-weight: 500;
}

td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

pre {
  margin: 0;
  padding: var(--space-4);
  background: var(--sunken);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow-x: auto;
  font-size: var(--text-sm);
  line-height: 1.6;
}

.site-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  padding: 0.85rem 1.25rem;
  border-bottom: 1px solid var(--line);
  background: var(--canvas);
}

.brand {
  font-size: var(--text-lg);
  letter-spacing: -0.015em;
  text-decoration: none;
  color: var(--ink);
}

.brand em {
  font-style: normal;
  color: var(--accent-text);
}

.site-nav {
  display: flex;
  gap: 1.35rem;
  align-items: center;
}

.site-nav a {
  font-size: var(--text-md);
  color: var(--ink-soft);
  text-decoration: none;
}

.site-nav a:hover {
  color: var(--ink);
}

.hero {
  padding: 3rem 1.25rem 3.25rem;
  background: var(--base);
  border-bottom: 1px solid var(--line);
}

.hero .lede {
  font-size: var(--text-lg);
  color: var(--ink-soft);
  max-width: 44ch;
  margin: 1rem 0 1.75rem;
}

.row-set {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px,1fr));
  gap: var(--space-4);
}

.card {
  padding: 1.35rem;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--raised);
}

.card p {
  font-size: var(--text-md);
  color: var(--ink-soft);
  margin: var(--space-2) 0 0;
}

.card .from {
  margin-top: 0.9rem;
  font-size: var(--text-md);
  color: var(--ink);
}

.chat {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: var(--space-5);
  background: var(--base);
}

.bubble {
  max-width: 82%;
  padding: 0.65rem 0.9rem;
  border-radius: var(--r-lg);
  font-size: var(--text-base);
}

.bubble-bot {
  background: var(--raised);
  border: 1px solid var(--line);
  border-bottom-left-radius: 4px;
  align-self: flex-start;
}

.bubble-you {
  background: var(--accent);
  color: var(--on-accent);
  border-bottom-right-radius: 4px;
  align-self: flex-end;
}

.bubble-wait {
  color: var(--ink-faint);
  font-style: italic;
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 0.9rem 1.25rem;
  border-top: 1px solid var(--line);
  background: var(--canvas);
}

.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px,1fr));
  gap: var(--space-4);
}

.col-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.col-count {
  font-family: var(--mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.task {
  background: var(--raised);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 0.75rem 0.85rem;
  margin-bottom: 0.6rem;
}

.task .t {
  font-size: var(--text-base);
}

.task .m {
  font-family: var(--mono);
  font-size: var(--text-2xs);
  color: var(--ink-faint);
  margin-top: 0.35rem;
  display: block;
}

.task.done {
  opacity: 0.7;
}

.task.done .t {
  text-decoration: line-through;
  text-decoration-color: var(--ok);
}

.read {
  font-size: var(--text-lg);
  line-height: 1.75;
  max-width: 60ch;
  letter-spacing: 0.003em;
}

.read h3 {
  margin: var(--space-6) 0 var(--space-2);
}

.read ul {
  margin: 0 0 1rem 1.15rem;
  padding: 0;
}

.read li {
  margin-bottom: 0.35rem;
}

.read blockquote {
  margin: 0 0 var(--space-4);
  padding-left: var(--space-4);
  border-left: 2px solid var(--line-strong);
  color: var(--ink-soft);
}

.read p {
  margin-bottom: var(--space-4);
}

.empty {
  padding: var(--space-10) var(--space-6);
  text-align: center;
  color: var(--ink-soft);
}

.empty h3 {
  color: var(--ink);
  margin-bottom: 0.4rem;
}

.empty p {
  max-width: 42ch;
  margin: 0 auto;
  font-size: var(--text-base);
}

.site-foot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-8);
  justify-content: space-between;
  padding: var(--space-5);
  border-top: 1px solid var(--line);
  font-size: var(--text-sm);
  color: var(--ink-faint);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
  }

  .btn:hover {
    transform: none;
  }
}`;

/**
 * The sizes the component CSS sets type in, as custom properties: a font size in a rule is one of
 * these names, so the Styles tab can show which, and changing a step changes every rule on it.
 */
export const TYPE_SCALE: readonly (readonly [string, string])[] = [
  ['--text-2xs', '0.6875rem'],
  ['--text-xs', '0.75rem'],
  ['--text-sm', '0.8125rem'],
  ['--text-md', '0.875rem'],
  ['--text-base', '0.9375rem'],
  ['--text-body', '1rem'],
  ['--text-lg', '1.0625rem'],
  ['--text-h2', 'clamp(1.3rem,2.4vw,1.7rem)'],
  ['--text-h1', 'clamp(2.2rem,5vw,3.1rem)'],
];

/**
 * The spacing steps on the quarter-rem grid. A padding, margin or gap whose lengths are all on the
 * grid is written with these; one tuned by eye to a value off it (`0.85rem`) keeps its number,
 * and so does one inside `clamp()`.
 */
export const SPACE_SCALE: readonly (readonly [string, string])[] = [
  ['--space-2', '0.5rem'],
  ['--space-3', '0.75rem'],
  ['--space-4', '1rem'],
  ['--space-5', '1.25rem'],
  ['--space-6', '1.5rem'],
  ['--space-8', '2rem'],
  ['--space-10', '2.5rem'],
];

export interface TemplateTokens {
  /** The one accent, as an OKLCH hue. This is the main thing that distinguishes templates. */
  hue: number;
  /** Chroma at the accent. Greens and cyans cannot hold the default 0.19. */
  chroma?: number;
  /** Lightness of the accent fill. Tuned so white on it stays legible. */
  lightness?: number;
  /** Corner radius, 13px by default; 6px gives the tighter look of a reference or data template. */
  radius?: number;
  scheme?: 'light' | 'dark';
}

/**
 * The `:root` block for one template.
 *
 * Surfaces stay neutral on purpose. A warm ground under a muted accent is how
 * this drifted into a stock palette once already: the identity lives in the
 * accent, not in the paper.
 */
export function templateTokens(t: TemplateTokens): string {
  const hue = t.hue;
  const c = t.chroma ?? 0.19;
  const l = t.lightness ?? 0.57;
  const r = t.radius ?? 13;
  const dark = t.scheme === 'dark';

  const surfaces = dark
    ? ['--canvas: #0B0A08;', '--sunken: #0F0D0B;', '--base: #141210;', '--raised: #1C1814;',
       '--ink: #DCE4E2;', '--ink-soft: #93A09D;', '--ink-faint: #5C6866;',
       '--line: rgba(240,225,205,0.09);', '--line-strong: rgba(240,225,205,0.16);']
    : ['--canvas: #FFFFFF;', '--sunken: #F1F2F4;', '--base: #FAFAFA;', '--raised: #FFFFFF;',
       '--ink: #1D1813;', '--ink-soft: #5F574C;', '--ink-faint: #8A8073;',
       '--line: rgba(18,20,26,0.11);', '--line-strong: rgba(18,20,26,0.19);'];

  const semantic = dark
    ? ['--ok: #5BBD7A;', '--warn: #E0A93B;', '--stop: #E5485E;']
    : ['--ok: #2F7D4F;', '--warn: #8A6116;', '--stop: #B33A34;'];

  // The component CSS asks for both of these on every raised button. Omit them and nothing
  // errors; the buttons just sit flat on the page and the reason is invisible.
  const shadows = dark
    ? ['--shadow-sm: 0 2px 8px -2px rgba(0,0,0,0.5);',
       '--shadow-md: 0 8px 24px -6px rgba(0,0,0,0.6);']
    : ['--shadow-sm: 0 1px 2px rgba(40,28,16,0.06), 0 2px 8px -2px rgba(40,28,16,0.08);',
       '--shadow-md: 0 6px 20px -4px rgba(40,28,16,0.12);'];

  return [
    ':root {',
    `  color-scheme: ${dark ? 'dark' : 'light'};`,
    '',
    ...surfaces.map((s) => '  ' + s),
    '',
    `  --accent: oklch(${l} ${c} ${hue});`,
    `  --accent-hover: oklch(${(l + (dark ? 0.06 : -0.05)).toFixed(2)} ${c} ${hue});`,
    `  --accent-soft: oklch(${l} ${c} ${hue} / 0.12);`,
    `  --accent-text: oklch(${(l - (dark ? -0.15 : 0.07)).toFixed(2)} ${(c * 0.92).toFixed(3)} ${hue});`,
    `  --accent-quiet: oklch(${dark ? 0.62 : 0.48} 0.03 ${hue});`,
    '  --on-accent: #FFFFFF;',
    '',
    ...semantic.map((s) => '  ' + s),
    '',
    ...shadows.map((s) => '  ' + s),
    '',
    `  --r-sm: ${Math.max(4, Math.round(r * 0.46))}px; --r-md: ${Math.round(r * 0.7)}px; --r-lg: ${r}px; --r-pill: 999px;`,
    '',
    '  --t-fast: 130ms; --t-base: 200ms; --ease: cubic-bezier(.2,.7,.2,1);',
    '',
    '  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;',
    '  --serif: ui-serif, Georgia, "Times New Roman", serif;',
    '  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  --font-label: var(--sans);',
    '  --label-weight: 500;',
    '',
    ...TYPE_SCALE.map(([name, value]) => `  ${name}: ${value};`),
    '',
    ...SPACE_SCALE.map(([name, value]) => `  ${name}: ${value};`),
    '',
    '  --measure: 66ch;',
    '}',
    '',
    '/* The accent\'s variants, worked out from --accent. Change that one colour and these follow.',
    '   A browser without relative colours keeps the fixed values above. */',
    '@supports (color: oklch(from red l c h)) {',
    '  :root {',
    `    --accent-hover: oklch(from var(--accent) calc(l ${dark ? '+ 0.06' : '- 0.05'}) c h);`,
    '    --accent-soft: oklch(from var(--accent) l c h / 0.12);',
    `    --accent-text: oklch(from var(--accent) calc(l ${dark ? '+ 0.15' : '- 0.07'}) calc(c * 0.92) h);`,
    `    --accent-quiet: oklch(from var(--accent) ${dark ? 0.62 : 0.48} 0.03 h);`,
    '  }',
    '}',
  ].join('\n');
}

/** A template's whole stylesheet: its tokens, then the shared components. */
export function templateStylesheet(tokens: TemplateTokens): string {
  return templateTokens(tokens) + '\n\n' + TEMPLATE_COMPONENT_CSS;
}
