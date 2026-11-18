/**
 * The house style the built-in content templates ship with, written for whoever edits one next.
 *
 * Every one of those templates opens its stylesheet with the same set of custom property names, so
 * this text can describe the system once instead of each template describing its own. The values
 * differ per template; the names do not.
 */
export const TEMPLATE_STYLE_PROMPT = `## The style this project ships with

The stylesheet opens with a \`:root\` block of custom properties. Nothing below it reads a raw colour,
so restyling is one edit in one place. Keep it that way: when you add a component, style it through
the tokens.

**This project commits to one colour scheme, and \`color-scheme\` in \`:root\` says which.** That is
deliberate. Supporting light and dark at once means two palettes to keep in step, two sets of
contrast to check, and a design that is nobody's first choice; a real site picks one and commits.
So when asked to change how it looks, **change the values in \`:root\`**. Do not add a
\`prefers-color-scheme\` block, and do not add a theme toggle, which additionally means storing a
preference. If the whole thing should flip from light to dark, rewrite those values and update
\`color-scheme\` to match.

- **Surfaces**: \`--canvas\` (the page), \`--base\` (a band that steps away from it), \`--raised\` (cards
  and rows), \`--sunken\` (inputs, code, wells).
- **Ink, three weights**: \`--ink\`, \`--ink-soft\`, \`--ink-faint\`. A fourth becomes noise.
- **Separation is a hairline**, \`--line\` or \`--line-strong\`, plus space. Shadows are for buttons and
  for things that genuinely float.
- **One accent**: \`--accent\` for a fill with \`--on-accent\` on it, \`--accent-text\` for accent-coloured
  text on a page ground, \`--accent-quiet\` for labels. To retheme, change \`--accent\` and leave
  everything else alone: its hover, soft, text and quiet variants are worked out from it in the
  \`@supports\` block under \`:root\`. Keep the fixed values above that block in step with it, for
  browsers that cannot work them out.
- **Type sizes are steps**, \`--text-2xs\` to \`--text-lg\`, with \`--text-h2\` and \`--text-h1\` for
  headings. Set a \`font-size\` with a step, not a number, and change a step to change every rule on it.
- **Spacing on the quarter-rem grid is a step**, one of \`--space-2\` (0.5rem), \`--space-3\`,
  \`--space-4\`, \`--space-5\`, \`--space-6\`, \`--space-8\` and \`--space-10\` (2.5rem), and no others. A
  padding, margin or gap is written with steps or with numbers, not a mix; a value tuned by eye off
  the grid (\`0.85rem\`) keeps its number.
- **Semantic colour** (\`--ok\`, \`--warn\`, \`--stop\`, where the template has them) means state. Never
  use it for emphasis, and never use the accent for state.

Type: **everything runs at weight 400**, headings included. Only buttons carry weight. Headings take
negative letter-spacing and get tighter as they get larger; labels are uppercase at
\`letter-spacing: 0.16em\`. That contrast is what carries the page, which is why there is no second
typeface and no bold. Fonts are system stacks on purpose: a webfont makes a published page wait on
a CDN. \`--mono\` is for values (prices, dates, counts, code), not for prose.

Buttons have two roles. The ink-filled one is the workhorse and can appear as often as it is needed.
The accent-filled one should appear about **once per screen**; if a screen is covered in accent, the
hierarchy has stopped working.

Whatever you add, keep the floor: a visible \`:focus-visible\` outline, transitions that collapse
under \`prefers-reduced-motion\`, a skip link ahead of any navigation, and \`overflow-x: auto\` on wide
content so the page body never scrolls sideways.

## Writing the words

- **No em-dashes.** Use a comma, a colon, a semicolon, or a second sentence.
- **Avoid the words that read as machine-written**: seamless, elevate, unlock, empower, leverage,
  robust, cutting-edge, world-class, effortless, "solutions" as a noun, "we're passionate about",
  "in today's fast-paced". Also rhetorical-question openers, three-item lists as a reflex,
  exclamation marks, Title Case On Everything, and emoji as section markers.
- **Be concrete.** "We measure your room, make the piece here, and fit it ourselves" beats "bespoke
  solutions tailored to your needs". A number, a date or a price beats an adjective.
- **Never invent a fact.** No testimonials, clients, logos or metrics that were made up, and no
  guessed coordinates, prices or dates. Ask, or leave the section out.
- **Controls say what happens.** A button reads \`Publish\` and the message after it reads
  \`Published\`. An error says what went wrong and how to fix it.`;
