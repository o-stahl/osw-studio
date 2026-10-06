// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StylesContent, type StylesContentHandle } from '..';
import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult } from '@/lib/direct-edit/types';

/**
 * The two reworked controls, mounted — the wiring their pure halves cannot show.
 *
 * `controls.test.ts` owns what a conversion, a typed value and a step *produce*. What only a mount
 * can answer is whether the panel hands those functions the frame's root font size rather than a
 * constant, whether a colour picked writes without a Save step, and whether Reset is offered exactly
 * when there is something to remove. All three are wiring, and all three are silent when wrong.
 *
 * The second test in this file mounts under a **10px root**, which is the whole point: every
 * assertion here would also pass against a hardcoded 16 if the document used the browser default.
 */

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > main > p',
  tagName: 'P',
  nodeId: 'n1',
  attributes: { class: 'card' },
  outerHTML: '<p></p>',
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();
let applyStyle: ReturnType<typeof vi.fn>;
let removeStyle: ReturnType<typeof vi.fn>;
let readOverrides: ReturnType<typeof vi.fn>;

const okResult: ApplyResult = { ok: true, markerId: 'm1', filesWritten: ['/overrides.css'] };

function mount(options: {
  removable?: boolean;
  /** The element as the frame reports it — a marker here means it was edited before today. */
  selection?: FocusContextPayload;
  /** What `/overrides.css` says the marker's block declares. Absent = the host offers no reader. */
  overridden?: readonly string[];
} = {}): void {
  applyStyle = vi.fn(async () => okResult);
  removeStyle = vi.fn(async () => okResult);
  readOverrides = vi.fn(async () => options.overridden ?? []);
  act(() => {
    root.render(withMessages(
      <StylesContent
        ref={ref}
        selection={options.selection ?? payload()}
        sendToFrame={vi.fn()}
        applyStyle={applyStyle}
        removeStyle={options.removable === false ? undefined : removeStyle}
        onReadOverrides={options.overridden === undefined ? undefined : readOverrides}
        tokens={[]}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
      />,
    ));
  });
}

/** Hand the panel a computed reply, as `multipage-preview` would. */
function computed(values: Record<string, string>, rootFontSize: string): void {
  act(() => {
    ref.current!.handleStyleComputed({
      type: 'style-computed',
      nodeId: 'n1',
      values,
      rootFontSize,
    });
  });
}

/**
 * Search the panel *and* anything it portals.
 *
 * The colour control is a Radix popover, whose content Radix renders into `document.body` rather
 * than inside the panel — so a `container`-scoped query cannot see the picker, the swatches or
 * Reset at all, and `toBeNull()` on any of them would pass for the wrong reason.
 */
function find<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  expect(el, `no ${selector} in the panel`).not.toBeNull();
  return el!;
}

/** As `find`, but for asking whether something is absent. Same scope, so absence means absence. */
function found(selector: string): Element | null {
  return document.querySelector(selector);
}

/**
 * Open a colour row's popover.
 *
 * Everything about a colour now lives behind it, so a test that does not open it is testing a shut
 * door. Verified in jsdom: Radix opens on a plain click and portals the content out of the host.
 */
async function openColour(label: string): Promise<void> {
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-osw-color-trigger]'))
    .find(el => el.getAttribute('aria-label') === `${label} colour`);
  expect(trigger, `no ${label} colour trigger`).toBeTruthy();
  // Idempotent, because Radix's trigger is a toggle and the popover stays open after a press.
  if (trigger!.getAttribute('data-state') === 'open') return;
  // Awaited: Radix opens through a state update, and a synchronous `act` returns before the content
  // has been portalled — which reads exactly like a popover that refused to open.
  await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/**
 * The Reset inside one row's open colour popover, found through the trigger's `aria-controls`.
 *
 * Keyed on the data attribute rather than the translated label, so an absence means no Reset, not
 * a renamed one. Throws if that popover is not open, which an absence would otherwise also cover.
 */
function resetIn(label: string): Element | null {
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-osw-color-trigger]'))
    .find(el => el.getAttribute('aria-label') === `${label} colour`);
  const id = trigger?.getAttribute('aria-controls');
  const popover = id ? document.getElementById(id) : null;
  if (!popover) throw new Error(`the ${label} colour popover is not open`);
  return popover.querySelector('[data-osw-color-reset]');
}

/** Set a controlled input's value the way a user's typing reaches React. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Let the 300ms commit debounce fire, and the promise it produces settle. */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

/** Every declaration the panel actually wrote, in order. */
function written(): { property: string; value: string }[] {
  return applyStyle.mock.calls.map(call => call[1]);
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('the value control', () => {
  it('writes what was typed, in the unit the control is showing', async () => {
    mount();
    computed({ 'padding-block-start': '16px', 'padding-block-end': '16px' }, '16px');

    const open = find<HTMLButtonElement>('[aria-label="Padding, vertical value"]');
    expect(open.textContent).toBe('1');
    act(() => { open.click(); });

    const input = find<HTMLInputElement>('input[data-osw-stepper-input]');
    type(input, '2.75');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(written()).toEqual([{ property: 'padding-block', value: '2.75rem' }]);
  });

  it('writes nothing for a value it cannot use, rather than some parse of it', async () => {
    mount();
    computed({ 'padding-block-start': '16px', 'padding-block-end': '16px' }, '16px');

    act(() => { find<HTMLButtonElement>('[aria-label="Padding, vertical value"]').click(); });
    const input = find<HTMLInputElement>('input[data-osw-stepper-input]');
    type(input, '12px}');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(applyStyle).not.toHaveBeenCalled();
  });

  it('converts against the root size the FRAME reported when the unit changes', async () => {
    mount();
    // Corner radius, because its own unit is px: switching it to **rem** is the direction that has
    // to divide by something. A 62.5% root makes 20px 2rem here and 1.25rem under a hardcoded 16 —
    // both plausible-looking numbers, and only one of them leaves the corner the size it already is.
    const corners = Object.fromEntries([
      'border-top-left-radius', 'border-top-right-radius',
      'border-bottom-right-radius', 'border-bottom-left-radius',
    ].map(name => [name, '20px']));
    computed(corners, '10px');

    const unit = find<HTMLSelectElement>('[aria-label="Corner radius unit"]');
    expect(unit.value).toBe('px');
    act(() => {
      unit.value = 'rem';
      unit.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    expect(written()).toEqual([{ property: 'border-radius', value: '2rem' }]);
    // And the control now shows, and writes in, the unit it was switched to.
    expect(find('[aria-label="Corner radius value"]').textContent).toBe('2');
    expect(find<HTMLSelectElement>('[aria-label="Corner radius unit"]').value).toBe('rem');
  });

  it('offers the unitless option on line-height and nowhere else', () => {
    mount();
    computed({ 'line-height': '30px', 'font-size': '20px' }, '16px');

    const lineHeight = find<HTMLSelectElement>('[aria-label="Line height unit"]');
    expect(Array.from(lineHeight.options).map(o => o.value)).toEqual(['', 'rem', 'px']);
    expect(lineHeight.value).toBe('');

    const padding = find<HTMLSelectElement>('[aria-label="Padding, vertical unit"]');
    expect(Array.from(padding.options).map(o => o.value)).toEqual(['rem', 'px']);
  });
});

describe('opening a value into its sides', () => {
  const valueOf = (label: string) => find<HTMLElement>(`[aria-label="${label} value"]`);

  function expander(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-osw-stepper-expand]'))
      .find(el => el.getAttribute('aria-label') === `${label} sides`);
  }

  function open(label: string): void {
    const button = expander(label);
    expect(button, `no disclosure on ${label}`).toBeTruthy();
    act(() => { button!.click(); });
  }

  /** Sides that genuinely disagree, so nothing here can pass by reading the shorthand. */
  function lopsided(): void {
    computed({
      'padding-block-start': '8px',
      'padding-block-end': '24px',
      'font-size': '16px',
    }, '16px');
  }

  it('is offered only where there are sides to open', () => {
    mount();
    lopsided();

    expect(expander('Padding, vertical')).toBeTruthy();
    // `Size` is one number about the whole element; there is nothing to open it into.
    expect(expander('Size')).toBeUndefined();
  });

  it('stays shut until asked', () => {
    mount();
    lopsided();

    expect(expander('Padding, vertical')!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[aria-label="Top value"]')).toBeNull();
  });

  it('shows each side its own value, not the one the collapsed control shows', () => {
    mount();
    lopsided();
    open('Padding, vertical');

    // Collapsed it can only say the sides disagree. That is the whole reason to open it.
    expect(valueOf('Padding, vertical').textContent).toBe('Mixed');
    expect(valueOf('Top').textContent).toBe('0.5');
    expect(valueOf('Bottom').textContent).toBe('1.5');
  });

  it('writes the side it was stepped on, not the shorthand', async () => {
    mount();
    lopsided();
    open('Padding, vertical');

    act(() => {
      find<HTMLButtonElement>('[aria-label="Increase Top"]').click();
    });
    await settle();

    // `padding-block`, the collapsed control's property, would set both sides and undo the very
    // difference the user opened the row to see.
    expect(written()).toEqual([{ property: 'padding-block-start', value: '0.75rem' }]);
  });

  it('does not offer to open a side into further sides', () => {
    mount();
    lopsided();
    open('Padding, vertical');

    // A part that kept its parent's `parts` would carry a disclosure of its own, back into the very
    // sides it is one of.
    expect(expander('Top')).toBeUndefined();
    expect(expander('Bottom')).toBeUndefined();
  });

  it('offers horizontal margin, and opens it into left and right', async () => {
    mount();
    computed({
      'margin-inline-start': '16px',
      'margin-inline-end': '48px',
      'font-size': '16px',
    }, '16px');

    // Left out originally, on the grounds that horizontal margin is the layout's business. Offered
    // now by decision — see the note in `properties.ts`, which also records what it costs.
    expect(valueOf('Margin, horizontal').textContent).toBe('Mixed');
    open('Margin, horizontal');
    expect(valueOf('Left').textContent).toBe('1');
    expect(valueOf('Right').textContent).toBe('3');

    act(() => {
      find<HTMLButtonElement>('[aria-label="Decrease Right"]').click();
    });
    await settle();

    expect(written()).toEqual([{ property: 'margin-inline-end', value: '2rem' }]);
  });

  it('shows the new number on the side that was stepped', () => {
    mount();
    lopsided();
    open('Padding, vertical');
    expect(valueOf('Top').textContent).toBe('0.5');

    act(() => {
      find<HTMLButtonElement>('[aria-label="Increase Top"]').click();
    });

    // The optimistic overlay, not the frame: a write is answered by a fresh `style-computed` much
    // later, and the control has to move under the finger or it reads as a dead button.
    expect(valueOf('Top').textContent).toBe('0.75');
    // And only that side.
    expect(valueOf('Bottom').textContent).toBe('1.5');
  });

  it('closes again', () => {
    mount();
    lopsided();
    open('Padding, vertical');
    expect(container.querySelector('[aria-label="Top value"]')).not.toBeNull();

    open('Padding, vertical');
    expect(container.querySelector('[aria-label="Top value"]')).toBeNull();
  });
});

describe('the colour picker', () => {
  it('writes on change, with no Save step anywhere near it', async () => {
    mount();
    computed({ color: 'rgb(0, 0, 0)' }, '16px');

    await openColour('Text');

    const picker = find<HTMLInputElement>('[aria-label="Custom colour: Text"]');
    expect(picker.getAttribute('type')).toBe('color');
    type(picker, '#ff8800');
    await settle();

    expect(written()).toEqual([{ property: 'color', value: '#ff8800' }]);
    // Nothing to press afterwards: a control whose result can be left uncommitted is the thing
    // being avoided, and this panel has no Save for any other control either.
    const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent);
    expect(labels).not.toContain('Save');
    expect(labels).not.toContain('Apply');
  });

  it('opens on the element\'s current colour', async () => {
    mount();
    computed({ color: 'rgb(18, 52, 86)' }, '16px');
    await openColour('Text');

    expect(find<HTMLInputElement>('[aria-label="Custom colour: Text"]').value).toBe('#123456');
  });
});

describe('Reset', () => {
  it('is not offered until this element actually overrides the property', async () => {
    mount();
    computed({ color: 'rgb(0, 0, 0)' }, '16px');
    await openColour('Text');
    expect(found('[data-osw-color-reset]')).toBeNull();

    type(find<HTMLInputElement>('[aria-label="Custom colour: Text"]'), '#ff8800');
    await settle();

    expect(found('[aria-label="Reset colour: Text"]')).toBeTruthy();

    // The other colour row was not touched, so it gets no Reset either. Opened, or its absence
    // would only mean that popover was shut.
    await openColour('Background');
    expect(resetIn('Background')).toBeNull();
  });

  it('is never offered when the host passes no removal path', async () => {
    mount({ removable: false });
    computed({ color: 'rgb(0, 0, 0)' }, '16px');
    await openColour('Text');
    type(find<HTMLInputElement>('[aria-label="Custom colour: Text"]'), '#ff8800');
    await settle();

    expect(found('[data-osw-color-reset]')).toBeNull();
  });

  it('removes that property, against the marker the write returned', async () => {
    mount();
    computed({ color: 'rgb(0, 0, 0)' }, '16px');
    await openColour('Text');
    type(find<HTMLInputElement>('[aria-label="Custom colour: Text"]'), '#ff8800');
    await settle();

    await act(async () => {
      find<HTMLButtonElement>('[data-osw-color-reset]').click();
    });

    expect(removeStyle).toHaveBeenCalledTimes(1);
    const [selection, markerId, property, confirmed] = removeStyle.mock.calls[0];
    expect(selection.nodeId).toBe('n1');
    expect(markerId).toBe('m1');
    expect(property).toBe('color');
    expect(confirmed).toBe(false);
    // And it stops being offered, because there is nothing left to remove.
    expect(found('[data-osw-color-reset]')).toBeNull();
  });
});

/**
 * The group's geometry, asserted on the classes it emits.
 *
 * **jsdom has no layout**, so a measured width here would be `0` for every variant and the
 * assertion would pass whatever the code did — which is precisely how a width regression ships. The
 * classes are the only honest handle: they are what the browser is given, and the specific ones
 * asserted (`min-w-0` on the segments, `overflow-hidden` on the wrapper) are the pair that makes a
 * declared width a *used* width. Without `min-w-0` a flex item's `min-width: auto` lets its content
 * push it wider, which is the regression this pins; without the clip a value too long for its box
 * would spill over the neighbouring segment instead of being cut.
 *
 * What this cannot see, and what needs a browser: that the resulting numbers add up to a group that
 * fits the panel without the `overflow-auto` clipping its rounded right edge.
 */
describe('the stepper group', () => {
  const valueOf = (label: string) => find<HTMLElement>(`[aria-label="${label} value"]`);

  it('gives Mixed and a four-decimal number the same box', () => {
    mount();
    // `Margin, vertical` reads Mixed — the sides disagree — while `Size` has a long single value.
    computed({
      'margin-block-start': '8px',
      'margin-block-end': '24px',
      'font-size': '10.8624px',
    }, '16px');

    const mixed = valueOf('Margin, vertical');
    const long = valueOf('Size');
    expect(mixed.textContent).toBe('Mixed');
    expect(long.textContent).toBe('0.6789');
    // Same box: identical classes, so nothing about the box is decided by what is in it.
    expect(mixed.className).toBe(long.className);

    const classes = mixed.className.split(/\s+/);
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('shrink-0');
    // And a width to hold: `min-w-0` alone would let it collapse.
    expect(classes.some(c => /^w-\d/.test(c))).toBe(true);

    for (const group of [mixed.parentElement!, long.parentElement!]) {
      expect(group.className.split(/\s+/)).toContain('overflow-hidden');
    }
  });

  it('holds that box while a value is being typed into it', () => {
    // The `<input>` is the widest offender: its default preferred size is about twenty characters,
    // so without `min-w-0` opening the field for editing widens the whole group.
    mount();
    computed({ 'font-size': '16px' }, '16px');
    act(() => { valueOf('Size').click(); });

    const input = find<HTMLInputElement>('input[data-osw-stepper-input]');
    const classes = input.className.split(/\s+/);
    expect(classes).toContain('min-w-0');
    expect(classes.some(c => /^w-\d/.test(c))).toBe(true);
  });

  it('right-aligns the value', () => {
    mount();
    computed({ 'font-size': '16px' }, '16px');
    expect(valueOf('Size').className.split(/\s+/)).toContain('text-right');
    expect(valueOf('Size').className).not.toContain('text-center');

    act(() => { valueOf('Size').click(); });
    const input = find<HTMLInputElement>('input[data-osw-stepper-input]');
    expect(input.className.split(/\s+/)).toContain('text-right');
    expect(input.className).not.toContain('text-center');
  });
});

/**
 * Reset for an override this session did not write.
 *
 * The panel used to offer Reset only for a property it had committed since the element was
 * selected, so every override made before a reload lost its control — at the moment the user is
 * most likely to want one. The element's marker is in source, so the file can be asked.
 */
describe('Reset after a reload', () => {
  const marked = payload({ attributes: { class: 'card', 'data-osw-id': 'm1' } });

  it('is offered for a property /overrides.css already declares, with no session state at all', async () => {
    mount({ selection: marked, overridden: ['color'] });
    await act(async () => {});
    computed({ color: 'rgb(0, 0, 0)', 'background-color': 'rgb(255, 255, 255)' }, '16px');

    expect(readOverrides).toHaveBeenCalledWith('m1');
    // Nothing was written this session: the control is there because the *file* says so.
    expect(applyStyle).not.toHaveBeenCalled();
    await openColour('Text');
    expect(find('[aria-label="Reset colour: Text"]')).toBeTruthy();
    // And only for the property the file names — the background is not overridden. Opened, or its
    // absence would only mean that popover was shut.
    await openColour('Background');
    expect(resetIn('Background')).toBeNull();
  });

  it('removes against the marker the element arrived with', async () => {
    mount({ selection: marked, overridden: ['color'] });
    await act(async () => {});
    computed({ color: 'rgb(0, 0, 0)' }, '16px');
    await openColour('Text');

    await act(async () => {
      find<HTMLButtonElement>('[data-osw-color-reset]').click();
    });

    expect(removeStyle).toHaveBeenCalledTimes(1);
    const [, markerId, property] = removeStyle.mock.calls[0];
    expect(markerId).toBe('m1');
    expect(property).toBe('color');
  });

  it('is read on the element, not on the keystroke', async () => {
    // The read scans a project file. Putting it behind a control would run it once per debounced
    // commit — four presses of `+`, four scans — for an answer that cannot have changed: what this
    // session writes is already known to be resettable without asking anyone.
    mount({ selection: marked, overridden: ['color'] });
    await act(async () => {});
    computed({ 'font-size': '16px' }, '16px');
    expect(readOverrides).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i++) {
      act(() => { find<HTMLButtonElement>('[aria-label="Increase Size"]').click(); });
    }
    await settle();

    expect(applyStyle).toHaveBeenCalled();
    expect(readOverrides).toHaveBeenCalledTimes(1);
  });

  it('stays hidden when the file has no block for this marker', async () => {
    mount({ selection: marked, overridden: [] });
    await act(async () => {});
    computed({ color: 'rgb(0, 0, 0)' }, '16px');

    expect(readOverrides).toHaveBeenCalledWith('m1');
    expect(found('[data-osw-color-reset]')).toBeNull();
  });

  it('stays hidden when the host offers no reader at all', async () => {
    // The two file-level absences — no `/overrides.css`, and a file with no block for this marker —
    // reach the panel as the same empty list, and the test above covers both; that they *are* the
    // same answer is `readOverriddenProperties`'s own test. This is the third absence: a host that
    // passes no reader keeps the session-only behaviour rather than getting a Reset that refuses.
    mount({ selection: marked, overridden: undefined });
    await act(async () => {});
    computed({ color: 'rgb(0, 0, 0)' }, '16px');

    expect(found('[data-osw-color-reset]')).toBeNull();
  });
});
