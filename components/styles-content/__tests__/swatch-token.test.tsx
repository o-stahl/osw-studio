// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StylesContent, type StylesContentHandle, type StylesContentProps } from '..';
import { COMMIT_DEBOUNCE_MS } from '../commit';
import { discoverColorTokens } from '../tokens';
import type { FocusContextPayload } from '@/lib/preview/types';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';

/**
 * Pressing a colour swatch on an element whose colour comes from a design token.
 *
 * This is the shipped bug, and the reason it shipped was that nothing asserted the *write*. The panel
 * used to consult `swatchAction`, see that the element's current colour matched a token, and render an
 * offer to ask the agent instead of applying anything. Every built-in template styles everything
 * through tokens, so the token branch was not the corner case — it was almost every press, and the
 * colour control did nothing at all.
 *
 * So the assertions here are on `applyStyle` and on the controls staying live, never on the absence of
 * a refusal: an absence passes just as well when the whole control is broken. `tokens.test.ts` owns
 * what `swatchAction` returns; this owns that the panel writes it, and where it puts the note.
 *
 * Mounted because both halves are wiring. A note that only appears in the scrolling body, or controls
 * that a note leaves disabled, are both invisible to a pure-function test.
 */

/** `--accent` and `--ink` as hex, so the offered swatches are strings a test can name. */
const tokens = discoverColorTokens([{
  path: '/styles.css',
  content: ':root { --accent: #ff0000; --ink: #1d1813; }',
}]);

const ACCENT = '#ff0000';
const INK = '#1d1813';

const selection: FocusContextPayload = {
  domPath: 'html > body > main > p',
  tagName: 'P',
  nodeId: 'n1',
  attributes: { class: 'card' },
  outerHTML: '<p></p>',
};

let container: HTMLDivElement;
let root: Root;
let applyStyle: ReturnType<typeof vi.fn>;
let onAskAgent: ReturnType<typeof vi.fn>;
const ref = createRef<StylesContentHandle>();

function props(over: Partial<StylesContentProps> = {}): StylesContentProps {
  return {
    selection,
    sendToFrame: vi.fn(),
    applyStyle,
    tokens,
    onOpenFile: vi.fn(),
    onAskAgent,
    onRefreshPreview: vi.fn(),
    ...over,
  };
}

/** Hand the panel a `style-computed` reply, as `multipage-preview` would. */
function computed(values: Record<string, string>): void {
  act(() => {
    ref.current!.handleStyleComputed({ type: 'style-computed', nodeId: 'n1', values });
  });
}

/**
 * Open a colour row's popover.
 *
 * Every colour control now lives behind one, and Radix portals the content into `document.body`
 * rather than into the panel — so a `container`-scoped query finds nothing, and an assertion that
 * something is absent would pass merely because the popover was shut.
 *
 * Awaited because Radix opens through a state update: a synchronous `act` returns before the
 * content is portalled, which is indistinguishable from a popover that refused to open.
 */
async function openColour(label: string): Promise<void> {
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-osw-color-trigger]'))
    .find(el => el.getAttribute('aria-label') === `${label} colour`);
  if (!trigger) throw new Error(`no ${label} colour trigger`);
  // Idempotent. The popover deliberately stays open after a press — picking a colour applies live,
  // so trying several is the normal thing to do — and Radix's trigger is a toggle, which means a
  // second unconditional click would shut it and the next query would find nothing.
  if (trigger.getAttribute('data-state') === 'open') return;
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/** The swatch offering this colour, inside the popover that is currently open. */
function swatch(colour: string): HTMLButtonElement {
  // By title, which carries `--name — value`. The label is the *token name* now, since that is what
  // pressing the swatch writes; the colour is still what a test wants to name, so match on the part
  // of the title that holds it.
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-osw-color-popover] button'))
    .find(el => (el.getAttribute('title') ?? '').includes(colour));
  if (!button) throw new Error(`no ${colour} swatch in the open popover`);
  return button;
}

/** Open the row, press it, then let the commit debounce elapse and the apply settle. */
async function press(label: string, colour: string): Promise<void> {
  await openColour(label);
  act(() => {
    swatch(colour).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, COMMIT_DEBOUNCE_MS + 20));
  });
}

/** The outermost element of the panel. */
function panel(): Element {
  return container.firstElementChild!;
}

/** Every leaf carrying the token note's sentence, however many there are. */
function notes(): Element[] {
  return Array.from(container.querySelectorAll('*'))
    .filter(el => el.children.length === 0 && (el.textContent || '').includes('Only this element changed'));
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  applyStyle = vi.fn().mockResolvedValue({ ok: true, markerId: 'm1', filesWritten: ['/overrides.css'] });
  onAskAgent = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(withMessages(<StylesContent ref={ref} {...props()} />));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('pressing a colour swatch', () => {
  it('writes a declaration even though the colour it replaces comes from a token', async () => {
    // The regression. `--accent` is what `background-color` currently resolves to, which used to be
    // the end of it — no write, just an offer to ask the agent.
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);

    expect(applyStyle).toHaveBeenCalledTimes(1);
    expect(applyStyle.mock.calls[0][1]).toEqual({ property: 'background-color', value: 'var(--ink)' });
  });

  it('writes the chosen token as var(), not as the literal the swatch shows', async () => {
    // The behaviour the refusal made unreachable: the element is pointed at `--ink` rather than
    // frozen at its current value, so a later change to `--ink` still reaches it.
    computed({ color: 'rgb(9, 9, 9)' });
    await press('Text', INK);

    expect(applyStyle.mock.calls[0][1].value).toBe('var(--ink)');
    expect(applyStyle.mock.calls[0][1].value).not.toBe(INK);
  });

  it('leaves every control live afterwards, so a second press is possible', async () => {
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);

    // The old refusal was in the panel's `disabled` expression: raising it froze the whole tab until
    // it was dismissed. A note must not.
    await openColour('Background');
    expect(swatch(ACCENT).disabled).toBe(false);
    // Both surfaces: the panel itself and the portalled popover, which is where the swatches are.
    expect(container.querySelectorAll('button[disabled]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-osw-color-popover] button[disabled]')).toHaveLength(0);

    await press('Background', ACCENT);
    expect(applyStyle).toHaveBeenCalledTimes(2);
  });
});

describe('the swatch the element is wearing', () => {
  /** The open popover's swatches, in order, as `[label, pressed]`. */
  async function swatchesOn(label: string): Promise<Array<[string, string | null]>> {
    await openColour(label);
    return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-osw-color-popover] button'))
      .filter(el => el.getAttribute('title'))
      .map(el => [el.getAttribute('aria-label') ?? '', el.getAttribute('aria-pressed')]);
  }

  it('marks it even though the two colours are spelled differently', async () => {
    // The whole point. The element reports what the engine computed — `rgb(255, 0, 0)` — while the
    // swatch carries what the stylesheet declared — `#ff0000`. Comparing those as text is never
    // true, which is why no swatch ever read as current. Both forms must name the same colour here
    // or this passes for the wrong reason.
    computed({ color: 'rgb(255, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)' });

    const pressed = (await swatchesOn('Text')).filter(([, state]) => state === 'true');

    expect(pressed).toEqual([['--accent', 'true']]);
  });

  it('marks nothing when the element wears none of them', async () => {
    computed({ color: 'rgb(1, 2, 3)', 'background-color': 'rgba(0, 0, 0, 0)' });

    expect((await swatchesOn('Text')).every(([, state]) => state === 'false')).toBe(true);
  });

  it('names the token rather than its colour', async () => {
    computed({ color: 'rgb(255, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)' });

    // Pressing a swatch writes `var(--accent)`, so the name is what the press is about — and with
    // two tokens rendered as coloured squares it is the only thing telling them apart.
    expect((await swatchesOn('Text')).map(([label]) => label)).toEqual(['--accent', '--ink']);
  });

  it('offers every token the project declares, not the first six', async () => {
    const many = discoverColorTokens([{
      path: '/styles.css',
      content: ':root {'
        + ' --c1:#010101; --c2:#020202; --c3:#030303; --c4:#040404;'
        + ' --c5:#050505; --c6:#060606; --c7:#070707; --c8:#080808; }',
    }]);
    await act(async () => { root.render(withMessages(<StylesContent ref={ref} {...props({ tokens: many })} />)); });

    // Capped at six, the last two were unreachable except by typing a literal into the picker — the
    // one route that writes a plain colour instead of a `var()` reference.
    expect((await swatchesOn('Text')).map(([label]) => label))
      .toEqual(['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8']);
  });
});

describe('the superseded-token note', () => {
  it('is absent until a press actually supersedes one', async () => {
    computed({ 'background-color': 'rgb(9, 9, 9)' });
    expect(notes()).toHaveLength(0);

    await press('Background', INK);
    expect(applyStyle).toHaveBeenCalledTimes(1);
    // Nothing was displaced, so there is nothing to volunteer.
    expect(notes()).toHaveLength(0);
  });

  it('names the token it superseded, and its file', async () => {
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);

    expect(notes()).toHaveLength(1);
    const text = notes()[0].textContent || '';
    expect(text).toContain('--accent');
    expect(text).toContain('/styles.css');
    // It says which of the element's colours it was, in the row's own label.
    expect(text.startsWith('Background')).toBe(true);
    // The note is about the colour that was there, not the one that was picked.
    expect(text).not.toContain('--ink');
    // The headline answers the question the user is about to ask, in the same words.
    expect(notes()[0].parentElement!.textContent).toContain('--accent was not changed');
  });

  it('does not follow the user to another element', async () => {
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);
    expect(notes()).toHaveLength(1);

    act(() => {
      root.render(withMessages(
        <StylesContent ref={ref} {...props({ selection: { ...selection, nodeId: 'n2' } })} />,
      ));
    });

    // It described one element's colour. Left standing, it describes the wrong one.
    expect(notes()).toHaveLength(0);
  });

  it('sits at the foot of the panel, outside the scrolling controls', async () => {
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);

    const foot = panel().lastElementChild!;
    const body = panel().children[panel().children.length - 2];
    expect(foot.contains(notes()[0])).toBe(true);
    // The correction this placement exists for: it used to render in the body, above the controls.
    expect(body.contains(notes()[0])).toBe(false);
    expect(body.textContent).toContain('Corner radius');
  });

  it('follows the most recent press rather than accumulating', async () => {
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);
    expect(notes()[0].textContent).toContain('--accent');

    // The element now reads as `--ink`, so this press displaces that one instead.
    await press('Background', ACCENT);
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain('--ink');
    expect(notes()[0].textContent).not.toContain('--accent');
  });

  it('goes away on a press that supersedes nothing', async () => {
    // Not the same as never appearing: a note left standing from an earlier press attributes this
    // one to a token it had nothing to do with.
    computed({ 'background-color': 'rgb(255, 0, 0)', color: 'rgb(9, 9, 9)' });
    await press('Background', INK);
    expect(notes()).toHaveLength(1);

    await press('Text', INK);
    expect(applyStyle).toHaveBeenCalledTimes(2);
    expect(notes()).toHaveLength(0);
  });

  it('shares the foot with the loss banner instead of displacing it', async () => {
    // One notification surface, two things it can say. The maintainer's correction was that these
    // belong together at the foot; a note that evicted the loss banner would honour the placement
    // and lose the message.
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);
    act(() => {
      ref.current!.handleStyleProbeResult({
        type: 'style-probe-result',
        nodeId: 'n1',
        lost: ['background-color'],
        winner: '/styles.css',
      });
    });

    const foot = panel().lastElementChild!;
    expect(foot.textContent).toContain('loses to /styles.css');
    expect(foot.textContent).toContain('Only this element changed');
    expect(foot.contains(notes()[0])).toBe(true);
  });

  it('offers the token edit to the agent, and closes on being taken up', async () => {
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);

    const offer = container.querySelector<HTMLButtonElement>('[data-osw-token-note-agent]')!;
    // It offers the *other* intention, and says which one it is — the escalation is the point.
    expect(offer.textContent).toContain('Change the token instead');
    act(() => {
      offer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onAskAgent).toHaveBeenCalledTimes(1);
    const prompt = onAskAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('--accent');
    expect(prompt).toContain('/styles.css');
    expect(prompt).toContain(INK);
    expect(notes()).toHaveLength(0);
  });

  it('is dismissable without asking anyone anything', async () => {
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);

    const dismiss = Array.from(container.querySelectorAll('button'))
      .find(el => el.textContent === 'Dismiss')!;
    act(() => {
      dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(notes()).toHaveLength(0);
    expect(onAskAgent).not.toHaveBeenCalled();
  });
});

describe('a press the source refuses or asks about', () => {
  const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });

  it('shows the refusal in the panel\'s words, naming the file', async () => {
    applyStyle.mockResolvedValue({ ok: false, reason: 'stale-index', file: '/about.html', filesWritten: [] });
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);
    expect(container.textContent).toContain(ts('msgStaleFile', { file: '/about.html' }));
  });

  it('asks before writing to a tag rendered several times, saying how many and from where', async () => {
    applyStyle.mockResolvedValue({ ok: false, reason: 'needs-confirmation', instances: 3, file: '/partials/nav.hbs', filesWritten: [] });
    computed({ 'background-color': 'rgb(255, 0, 0)' });
    await press('Background', INK);
    expect(container.textContent).toContain(ts('confirmManyFrom', { count: 3, file: '/partials/nav.hbs' }));
  });
});
