import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildApplyStyle,
  createCommitScheduler,
  overlayRequested,
  toPreviewSelection,
  writtenNumber,
  type StyleWriter,
} from '../commit';
import { propertyEntry, type SegmentedEntry, type StepperEntry } from '../properties';
import { formatComputed, stepValue, activeOptionValue } from '../controls';
import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult, PreviewSelection, RecordedWrite, StyleChange } from '@/lib/direct-edit/types';

/**
 * The debounce, the optimistic overlay and the apply seam.
 *
 * All three are plain functions for the same reason the reducer is: there is no React Testing
 * Library here, so a decision made inside a component is a decision nothing can assert on.
 */

const padding = propertyEntry('padding-block') as StepperEntry;
const lineHeight = propertyEntry('line-height') as StepperEntry;

/** What the frame said one rem is worth. Never defaulted — see `UnitContext` in `../controls`. */
const rem16 = { rootFontSize: 16 };

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > p',
  tagName: 'P',
  nodeId: 'n1',
  attributes: { class: 'lead' },
  outerHTML: '<p></p>',
  ...over,
});

describe('the commit scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of presses into ONE commit, at the value stopped on', () => {
    const commits: StyleChange[][] = [];
    const scheduler = createCommitScheduler(300, d => commits.push(d));

    for (const value of ['0.5rem', '0.75rem', '1rem', '1.5rem']) {
      scheduler.schedule([{ property: 'padding-block', value }]);
      vi.advanceTimersByTime(50);
    }
    expect(commits).toEqual([]);

    vi.advanceTimersByTime(300);
    expect(commits).toEqual([[{ property: 'padding-block', value: '1.5rem' }]]);
  });

  it('writes nothing at all until the burst stops', () => {
    // `applyStyleOverride` char-scans every markup file in the project on each success. This is the
    // assertion that a stepper held down does not do that once per press.
    const commit = vi.fn();
    const scheduler = createCommitScheduler(300, commit);
    for (let i = 0; i < 10; i++) {
      scheduler.schedule([{ property: 'padding-block', value: `${i}rem` }]);
      vi.advanceTimersByTime(299);
    }
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('commits several properties touched in one window together, in first-touch order', () => {
    const commits: StyleChange[][] = [];
    const scheduler = createCommitScheduler(300, d => commits.push(d));
    scheduler.schedule([{ property: 'padding-block', value: '1rem' }]);
    scheduler.schedule([{ property: 'color', value: 'red' }]);
    scheduler.schedule([{ property: 'padding-block', value: '2rem' }]);
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([[
      { property: 'padding-block', value: '2rem' },
      { property: 'color', value: 'red' },
    ]]);
  });

  it('flushes on demand and does not then fire the timer too', () => {
    const commit = vi.fn();
    const scheduler = createCommitScheduler(300, commit);
    scheduler.schedule([{ property: 'padding-block', value: '1rem' }]);
    scheduler.flush();
    expect(commit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('flushes nothing when nothing is outstanding', () => {
    const commit = vi.fn();
    createCommitScheduler(300, commit).flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it('throws away a cancelled burst', () => {
    const commit = vi.fn();
    const scheduler = createCommitScheduler(300, commit);
    scheduler.schedule([{ property: 'padding-block', value: '1rem' }]);
    scheduler.cancel();
    vi.advanceTimersByTime(1000);
    expect(commit).not.toHaveBeenCalled();
    expect(scheduler.pending()).toEqual([]);
  });
});

describe('the optimistic overlay', () => {
  it('lets a second press step from the value the first press asked for', () => {
    // Without it, both presses read the same computed reply and produce the same declaration, so a
    // stepper held down moves one rung however many times it is pressed.
    const computed = { 'padding-block-start': '16px', 'padding-block-end': '16px' };
    const first = stepValue(padding, computed, 1, rem16);
    expect(first).toBe('1.5rem');

    const overlaid = overlayRequested(computed, { 'padding-block': first! }, rem16);
    expect(stepValue(padding, overlaid, 1, rem16)).toBe('2rem');
  });

  it('shows the requested value in the unit the control writes', () => {
    const computed = { 'padding-block-start': '16px', 'padding-block-end': '16px' };
    const overlaid = overlayRequested(computed, { 'padding-block': '3rem' }, rem16);
    expect(formatComputed(padding, overlaid, rem16)).toBe('3rem');
  });

  it('converts a request into every longhand the entry reads', () => {
    const overlaid = overlayRequested({}, { 'padding-block': '1rem' }, rem16);
    expect(overlaid['padding-block-start']).toBe('16px');
    expect(overlaid['padding-block-end']).toBe('16px');
  });

  it('reads the unit off the request, not off the entry default', () => {
    // The control writes whichever unit its selector is showing. Assuming the entry's default
    // reads `24px` as 24rem and lays 384px over an element that is 24.
    const overlaid = overlayRequested({}, { 'padding-block': '24px' }, rem16);
    expect(overlaid['padding-block-start']).toBe('24px');
    expect(formatComputed(padding, overlaid, rem16, 'px')).toBe('24px');
  });

  it('lays nothing over when the root size has not arrived, rather than assuming 16', () => {
    const overlaid = overlayRequested({ 'padding-block-start': '8px' }, { 'padding-block': '1rem' });
    expect(overlaid['padding-block-start']).toBe('8px');
  });

  it('resolves a ratio against a font size that is itself requested', () => {
    // `line-height` is unitless and computes to px, so its divisor is the element's own font size.
    // A request that changed the font size in the same burst has to be the divisor, or the line
    // height jumps the moment the reply lands.
    const computed = { 'font-size': '16px', 'line-height': '24px' };
    const overlaid = overlayRequested(computed, { 'font-size': '2rem', 'line-height': '1.5' }, rem16);
    expect(overlaid['font-size']).toBe('32px');
    expect(overlaid['line-height']).toBe('48px');
    expect(formatComputed(lineHeight, overlaid, rem16)).toBe('1.5');
  });

  it('passes a keyword through untouched', () => {
    const overlaid = overlayRequested({ 'text-align': 'start' }, { 'text-align': 'center' }, rem16);
    expect(overlaid['text-align']).toBe('center');
    expect(activeOptionValue(propertyEntry('text-align') as SegmentedEntry, overlaid)).toBe('center');
  });

  it('leaves everything it was not asked about alone', () => {
    const computed = { color: 'rgb(1, 2, 3)', 'padding-block-start': '8px', 'padding-block-end': '8px' };
    expect(overlayRequested(computed, { 'padding-block': '1rem' }, rem16).color).toBe('rgb(1, 2, 3)');
  });

  it('ignores a request it cannot read as a number rather than writing NaN', () => {
    const overlaid = overlayRequested({ 'padding-block-start': '8px' }, { 'padding-block': 'auto' }, rem16);
    expect(overlaid['padding-block-start']).toBe('8px');
  });
});

describe('writtenNumber', () => {
  it('strips the unit the entry writes', () => {
    expect(writtenNumber('1.5rem', 'rem')).toBe(1.5);
    expect(writtenNumber('999px', 'px')).toBe(999);
    expect(writtenNumber('1.25', '')).toBe(1.25);
  });

  it('is null for a value that is not a number', () => {
    expect(writtenNumber('auto', 'rem')).toBeNull();
    expect(writtenNumber('', 'px')).toBeNull();
  });
});

describe('the apply seam', () => {
  const result: ApplyResult = { ok: true, markerId: 'm1', filesWritten: ['/overrides.css'] };
  const opts = (over: { confirmedMultiInstance?: boolean; group?: string } = {}) =>
    ({ scope: 'all' as const, markerId: null, confirmedMultiInstance: false, ...over });

  function spy() {
    const calls: { projectId: string; selection: PreviewSelection; changes: readonly StyleChange[]; opts: Parameters<StyleWriter>[3] }[] = [];
    const apply: StyleWriter = async (projectId, selection, changes, o) => {
      calls.push({ projectId, selection, changes, opts: o });
      // A write that changes two files, as a first edit does.
      o.record?.({ path: '/index.html', before: 'a', after: 'b', silent: false });
      o.record?.({ path: '/overrides.css', before: null, after: 'c', silent: true });
      return result;
    };
    return { apply, calls };
  }

  it('passes the generation gate through to the write path', async () => {
    // `lib/direct-edit/` takes `isGenerating` as a dependency precisely so it never imports the
    // store. Dropping it here would let a style write land in the middle of the agent's own edits
    // to the same files, and nothing downstream would notice.
    const { apply, calls } = spy();
    const isGenerating = vi.fn(() => true);
    await buildApplyStyle('p1', { apply, isGenerating })(payload(), [{ property: 'color', value: 'red' }], opts());

    expect(calls).toHaveLength(1);
    expect(typeof calls[0].opts.isGenerating).toBe('function');
    expect(calls[0].opts.isGenerating()).toBe(true);
    expect(isGenerating).toHaveBeenCalled();
  });

  it('forwards the confirmation flag, the width block and the marker rather than deciding them', async () => {
    const { apply, calls } = spy();
    const bound = buildApplyStyle('p1', { apply, isGenerating: () => false });
    await bound(payload(), [{ property: 'color', value: 'red' }], opts({ confirmedMultiInstance: true }));
    await bound(payload(), [{ property: 'color', value: null }], { scope: 640, markerId: 'm9', confirmedMultiInstance: false });
    expect(calls.map(c => c.opts.confirmedMultiInstance)).toEqual([true, false]);
    expect(calls.map(c => c.opts.scope)).toEqual(['all', 640]);
    expect(calls.map(c => c.opts.markerId)).toEqual([null, 'm9']);
    expect(calls[1].changes).toEqual([{ property: 'color', value: null }]);
  });

  it('forwards the marker a first write stamps and the properties to make win', async () => {
    const { apply, calls } = spy();
    const bound = buildApplyStyle('p1', { apply, isGenerating: () => false });
    await bound(payload(), [], { scope: 640, markerId: null, newMarkerId: 'm10', confirmedMultiInstance: false, strengthen: ['color'] });
    expect(calls[0].opts.newMarkerId).toBe('m10');
    expect(calls[0].opts.strengthen).toEqual(['color']);
  });

  it('binds the project but NOT the selection', async () => {
    // A commit scheduled a moment ago has to be written against the element it was made on, even
    // though the panel may already be showing another one.
    const { apply, calls } = spy();
    const bound = buildApplyStyle('p1', { apply, isGenerating: () => false });
    await bound(payload({ tagName: 'P' }), [{ property: 'color', value: 'red' }], opts());
    await bound(payload({ tagName: 'FOOTER' }), [{ property: 'color', value: 'red' }], opts());
    expect(calls.map(c => c.projectId)).toEqual(['p1', 'p1']);
    expect(calls.map(c => c.selection.tagName)).toEqual(['P', 'FOOTER']);
  });

  it('records one write\'s files under one group, and a drag\'s writes under the drag\'s group', async () => {
    const { apply } = spy();
    const recorded: { group: string; path: string }[] = [];
    const bound = buildApplyStyle('p1', {
      apply,
      isGenerating: () => false,
      record: (group: string, write: RecordedWrite) => recorded.push({ group, path: write.path }),
    });
    await bound(payload(), [{ property: 'color', value: 'red' }], opts());
    await bound(payload(), [{ property: 'color', value: 'blue' }], opts());
    await bound(payload(), [{ property: 'color', value: 'green' }], opts({ group: 'drag-1' }));
    await bound(payload(), [{ property: 'color', value: 'teal' }], opts({ group: 'drag-1' }));

    const groups = recorded.map(r => r.group);
    // Both files of a write share its group; two writes outside a drag get two groups.
    expect(groups[0]).toBe(groups[1]);
    expect(groups[2]).not.toBe(groups[0]);
    expect(groups.slice(4)).toEqual(['drag-1', 'drag-1', 'drag-1', 'drag-1']);
  });
});

describe('toPreviewSelection', () => {
  it('forwards what the write path resolves through, and nothing else', () => {
    const selection = toPreviewSelection(payload({
      srcAttr: '/index.html:120',
      instanceCount: 6,
      attributes: { 'data-osw-id': 'm1' },
    }));
    expect(selection).toEqual({
      srcAttr: '/index.html:120',
      instanceCount: 6,
      tagName: 'P',
      attributes: { 'data-osw-id': 'm1' },
    });
    expect('domPath' in selection).toBe(false);
    expect('outerHTML' in selection).toBe(false);
  });

  it('sends null rather than undefined for an element with no provenance', () => {
    expect(toPreviewSelection(payload()).srcAttr).toBeNull();
  });
});

describe('the commit scheduler with batches', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits a control\'s several changes, removals included, as one list', () => {
    const commits: StyleChange[][] = [];
    const scheduler = createCommitScheduler(300, d => commits.push(d));
    scheduler.schedule([{ property: 'width', value: null }, { property: 'flex', value: '1 1 0' }]);
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([[{ property: 'width', value: null }, { property: 'flex', value: '1 1 0' }]]);
  });
});
