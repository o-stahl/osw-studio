export interface SuggestionPill { id: string; label: string; prompt: string }

/**
 * The built-in starters' ids. Their labels are translated by id in the chat panel, which keys its
 * labels by this type; the lists below only take these ids, so a new starter has to be added here.
 */
export type BuiltInPillId =
  | 'portfolio' | 'multipage-site' | 'workspace-setup'
  | 'quick-reword' | 'quick-colours' | 'quick-section' | 'quick-mobile';

type BuiltInPill = SuggestionPill & { id: BuiltInPillId };

/**
 * How many starters sit on the row above the composer. The rest go behind an overflow menu:
 * the row is directly above the input, so it must not grow enough to push it down.
 */
export const INLINE_SUGGESTION_COUNT = 3;

// Fast first-task starters shown above the composer: a single-page build, a multi-page build,
// and one that configures the workspace for a goal (custom runtime + CDN stack + .PROMPT.md),
// which shows the project space is not limited to the built-in runtimes.
export const SUGGESTION_PILLS: BuiltInPill[] = [
  {
    id: 'portfolio',
    label: 'Personal portfolio (one page)',
    prompt: 'Build a single page personal portfolio: a short intro with my name and role, a projects grid of three cards with links, and a contact section with email and social links.',
  },
  {
    id: 'multipage-site',
    label: 'Multi-page site with shared nav',
    prompt: 'Build a small multi-page site with Home, About, and Contact pages that share the same header and footer, with working navigation between the pages.',
  },
  {
    id: 'workspace-setup',
    label: 'Set up the workspace for an animated site',
    prompt: 'Set up the workspace for building an animated marketing site: use Handlebars templating so pages share a layout, load Tailwind CSS and Motion from a CDN, note the stack and conventions in .PROMPT.md, and scaffold a home page with a shared header and footer and a Motion entrance animation.',
  },
];

// Starters for quick edit, where the project already exists and a person is looking at a page of it.
// The build starters above are wrong there: they describe making a site rather than changing one.
// A project that defines its own suggestions overrides these.
export const QUICK_EDIT_PILLS: BuiltInPill[] = [
  {
    id: 'quick-reword',
    label: 'Reword this page',
    prompt: 'Rewrite the text on the page I am looking at so it reads more clearly and naturally, keeping the same layout, structure and links.',
  },
  {
    id: 'quick-colours',
    label: 'Change the colours',
    prompt: 'Update the colour scheme of this site so it still looks consistent across every page, keeping the same layout and structure.',
  },
  {
    id: 'quick-section',
    label: 'Add a section',
    prompt: 'Add a new section to the page I am looking at, matching the existing design, and tell me what you added.',
  },
  {
    id: 'quick-mobile',
    label: 'Fix it on a phone',
    prompt: 'Check how the page I am looking at behaves on a narrow phone screen and fix anything that overflows, overlaps or is too small to read.',
  },
];
