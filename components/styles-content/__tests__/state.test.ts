import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { describe, it, expect } from 'vitest';
import {
  OVERRIDES_PATH,
  REFUSAL_REASONS,
  canReset,
  confirmationMessage,
  declarationBlock,
  emptyStylesState,
  lossAgentPrompt,
  lossFor,
  lossMessage,
  lostOverrides,
  reduceStyles,
  refusalAgentPrompt,
  refusalMessage,
  refusalOffer,
  refusalTitle,
  type RefusalReason,
  type StylesCommand,
  type StylesEvent,
  type StylesState,
  type StylesTranslator,
} from '../state';
import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult } from '@/lib/direct-edit/types';

/** The real English messages, so the assertions below read the text a user sees. */
const t: StylesTranslator = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });

/**
 * The Styles tab's logic, tested where it lives.
 *
 * The reducer emits commands rather than performing them, so "this refusal writes nothing" is an
 * assertion about a returned array rather than about a mock that was not called. That is the whole
 * reason the shape is this way — there is no React Testing Library here.
 */

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > main > p',
  tagName: 'p',
  nodeId: 'n1',
  attributes: {},
  outerHTML: '<p></p>',
  ...over,
});

const other = payload({ domPath: 'html > body > footer', tagName: 'footer', nodeId: 'n2' });

const padding = { property: 'padding-block', value: '1rem' };
const colour = { property: 'color', value: 'rgb(1, 2, 3)' };

const ok = (over: Partial<ApplyResult> = {}): ApplyResult => ({
  ok: true,
  markerId: 'm1',
  filesWritten: [OVERRIDES_PATH],
  skippedPages: [],
  duplicateCount: 1,
  ...over,
});

/** Fold a run of events, discarding commands. */
function run(state: StylesState, ...events: StylesEvent[]): StylesState {
  return events.reduce((s, event) => reduceStyles(s, event).state, state);
}

function kinds(commands: StylesCommand[]): string[] {
  return commands.map(c => c.kind);
}

/** Selected, one padding edit committed to `/overrides.css`, and a probe answered. */
function edited(): StylesState {
  let state = run(emptyStylesState(), { type: 'select', payload: payload() });
  state = run(state, { type: 'change', declaration: padding });
  state = run(state, { type: 'applied', declaration: padding, result: ok() });
  return state;
}

describe('selection', () => {
  it('asks the frame for every property it can show', () => {
    const { commands } = reduceStyles(emptyStylesState(), { type: 'select', payload: payload() });
    expect(kinds(commands)).toEqual(['query']);
    const query = commands[0] as Extract<StylesCommand, { kind: 'query' }>;
    expect(query.nodeId).toBe('n1');
    expect(query.properties).toContain('padding-block-start');
    expect(query.properties).toContain('color');
  });

  it('clears any previous refusal, confirmation and lost-property state', () => {
    let state = edited();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/s.css' });
    state = run(state, { type: 'confirm' }); // no-op without a pending, so arm it the real way
    state = run(state,
      { type: 'change', declaration: colour },
      { type: 'applied', declaration: colour, result: { ok: false, reason: 'needs-confirmation', instances: 4, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', declaration: colour, result: { ok: false, reason: 'unresolvable', filesWritten: [] } },
    );
    expect(state.confirmed).toBe(true);
    expect(state.refusal?.reason).toBe('unresolvable');
    expect(state.lost).not.toEqual({});

    const next = run(state, { type: 'select', payload: other });
    expect(next.refusal).toBeNull();
    expect(next.pending).toBeNull();
    expect(next.confirmed).toBe(false);
    expect(next.lost).toEqual({});
    expect(next.markerId).toBeNull();
    expect(next.committed).toEqual([]);
  });

  it('drops the computed values, which describe the node that was just replaced', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state, { type: 'computed', nodeId: 'n1', values: { color: 'rgb(0, 0, 0)' } });
    expect(state.computed).toEqual({ color: 'rgb(0, 0, 0)' });
    expect(run(state, { type: 'select', payload: other }).computed).toEqual({});
  });

  it('blanks the values when the frame says the node resolves to nothing', () => {
    // `style-computed` answers a dead id with `{}` rather than with silence. Keeping the previous
    // reply's numbers would show one element's measurements under another element's name.
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state, { type: 'computed', nodeId: 'n1', values: { color: 'rgb(0, 0, 0)' } });
    state = run(state, { type: 'computed', nodeId: 'n1', values: {} });
    expect(state.computed).toEqual({});
  });

  it('ignores a computed reply for a node it is no longer showing', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const next = run(state, { type: 'computed', nodeId: 'stale', values: { color: 'red' } });
    expect(next.computed).toEqual({});
  });

  it('clears everything when the selection goes away', () => {
    expect(run(edited(), { type: 'select', payload: null })).toEqual(emptyStylesState());
  });
});

describe('the multi-instance confirmation', () => {
  it('arms a pending declaration and emits NO apply command', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { state: armed, commands } = reduceStyles(state, {
      type: 'applied',
      declaration: padding,
      result: { ok: false, reason: 'needs-confirmation', file: '/partials/nav.hbs', instances: 6, filesWritten: [] },
    });
    expect(commands).toEqual([]);
    expect(armed.pending).toEqual({ declaration: padding, file: '/partials/nav.hbs', instances: 6 });
    expect(armed.confirmed).toBe(false);
    expect(armed.refusal).toBeNull();
  });

  it('replays the pending declaration with confirmedMultiInstance: true', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state, {
      type: 'applied',
      declaration: padding,
      result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] },
    });
    const { state: confirmed, commands } = reduceStyles(state, { type: 'confirm' });
    expect(commands).toEqual([{ kind: 'apply', declaration: padding, confirmedMultiInstance: true }]);
    expect(confirmed.pending).toBeNull();
    expect(confirmed.confirmed).toBe(true);
  });

  it('is armed per SELECTION, not per edit', () => {
    // Adjusting padding four steps must not ask four times.
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state,
      { type: 'applied', declaration: padding, result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', declaration: padding, result: ok({ filesWritten: ['/partials/nav.hbs', OVERRIDES_PATH] }) },
    );
    const { commands } = reduceStyles(state, { type: 'change', declaration: { property: 'padding-block', value: '1.5rem' } });
    expect(commands).toEqual([{
      kind: 'apply',
      declaration: { property: 'padding-block', value: '1.5rem' },
      confirmedMultiInstance: true,
    }]);
  });

  it('survives the recompile the first commit triggers', () => {
    // The first commit writes source, the preview recompiles, and the panel re-selects the same
    // element — now carrying its marker, and with a `srcAttr` index the <link> insertion shifted.
    let state = run(emptyStylesState(), { type: 'select', payload: payload({ srcAttr: '/index.html:120' }) });
    state = run(state,
      { type: 'applied', declaration: padding, result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', declaration: padding, result: ok({ filesWritten: ['/index.html', OVERRIDES_PATH] }) },
      { type: 'frame-ready' },
      { type: 'select', payload: payload({ nodeId: 'n9', srcAttr: '/index.html:167', attributes: { 'data-osw-id': 'm1' } }) },
    );
    expect(state.confirmed).toBe(true);
    expect(state.markerId).toBe('m1');
  });

  it('recognises the same element by its MARKER when its position moved', () => {
    // The agent wrapped the element in a <div> between the commit and the re-select, so the
    // domPath no longer matches. The marker is authored into source and does.
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state,
      { type: 'applied', declaration: padding, result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', declaration: padding, result: ok({ filesWritten: ['/index.html', OVERRIDES_PATH] }) },
      { type: 'frame-ready' },
      {
        type: 'select',
        payload: payload({
          nodeId: 'n9',
          domPath: 'html > body > main > div > p',
          attributes: { 'data-osw-id': 'm1' },
        }),
      },
    );
    expect(state.confirmed).toBe(true);
    expect(state.markerId).toBe('m1');
    expect(state.committed).toEqual(['padding-block']);
  });

  it('recognises the same element by its POSITION before it has a marker', () => {
    // Nothing has been committed yet, so there is no marker to match on — only the domPath, which
    // is what plan 4a re-resolves a selection through after a recompile.
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state,
      { type: 'applied', declaration: padding, result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
    );
    expect(state.markerId).toBeNull();
    const next = run(state, { type: 'select', payload: payload({ nodeId: 'n5' }) });
    expect(next.confirmed).toBe(true);
  });

  it('is disarmed by changing selection', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state,
      { type: 'applied', declaration: padding, result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
    );
    expect(state.confirmed).toBe(true);
    expect(run(state, { type: 'select', payload: other }).confirmed).toBe(false);
  });

  it('emits apply without confirmation for an ordinary element', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { commands } = reduceStyles(state, { type: 'change', declaration: padding });
    expect(commands).toEqual([{ kind: 'apply', declaration: padding, confirmedMultiInstance: false }]);
  });

  it('writes nothing when there is no element selected', () => {
    // Reachable: a control can be mid-press when the preview reloads and the selection is dropped.
    // An apply with no selection would resolve against whatever the last payload happened to be.
    const { commands } = reduceStyles(emptyStylesState(), { type: 'change', declaration: padding });
    expect(commands).toEqual([]);
  });

  it('drops the pending declaration when the user backs out', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state, {
      type: 'applied',
      declaration: padding,
      result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] },
    });
    const { state: cancelled, commands } = reduceStyles(state, { type: 'cancel' });
    expect(commands).toEqual([]);
    expect(cancelled.pending).toBeNull();
    expect(cancelled.confirmed).toBe(false);
  });

  it('says how many elements the change reaches', () => {
    expect(confirmationMessage({ declaration: padding, file: '/partials/nav.hbs', instances: 6 }, t))
      .toContain('/partials/nav.hbs');
    expect(confirmationMessage({ declaration: padding, file: '/partials/nav.hbs', instances: 6 }, t))
      .toContain('6');
  });
});

describe('refusals', () => {
  const refusalOf = (reason: RefusalReason) =>
    ({ reason, file: '/index.html', detail: 'boom', stamped: true } as const);

  it('covers exactly the five non-confirmation reasons', () => {
    expect(REFUSAL_REASONS).toHaveLength(5);
    expect(new Set(REFUSAL_REASONS).size).toBe(5);
    expect(REFUSAL_REASONS).not.toContain('needs-confirmation' as never);
  });

  it('produces five PAIRWISE DISTINCT messages from identical inputs', () => {
    // Identical inputs on purpose: "each reason maps to its own message" is satisfied by a stub
    // returning the same string five times, and this is what that stub fails.
    const messages = REFUSAL_REASONS.map(reason => refusalMessage(refusalOf(reason), t));
    expect(new Set(messages).size).toBe(5);
    for (const message of messages) expect(message.length).toBeGreaterThan(20);
  });

  it('gives each reason its own headline, and never one the sentence contradicts', () => {
    const titles = REFUSAL_REASONS.map(reason => refusalTitle(refusalOf(reason), t));
    expect(new Set(titles).size).toBe(5);
    // The ambiguous-stylesheet message says a marker may already be in source. A headline of
    // "nothing was written" over that sentence is the contradiction this guards against.
    const ambiguous = refusalTitle({ reason: 'ambiguous-stylesheet', stamped: true }, t);
    expect(ambiguous.toLowerCase()).not.toContain('nothing');
    expect(ambiguous).toContain(OVERRIDES_PATH);
  });

  it('does not claim nothing happened when a marker was already stamped', () => {
    const stamped = refusalMessage({ reason: 'ambiguous-stylesheet', detail: 'boom', stamped: true }, t);
    const clean = refusalMessage({ reason: 'ambiguous-stylesheet', detail: 'boom', stamped: false }, t);
    expect(stamped).toContain('marker');
    expect(stamped).not.toBe(clean);
  });

  it('names the file and the reason for an ambiguous stylesheet', () => {
    const message = refusalMessage({ reason: 'ambiguous-stylesheet', detail: 'nested in @media', stamped: false }, t);
    expect(message).toContain(OVERRIDES_PATH);
    expect(message).toContain('nested in @media');
  });

  it('offers nothing at all while the agent is working', () => {
    expect(refusalOffer({ reason: 'generating', stamped: false })).toBeNull();
  });

  it('records the refusal without writing anything', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { state: refused, commands } = reduceStyles(state, {
      type: 'applied',
      declaration: padding,
      result: { ok: false, reason: 'stale-index', file: '/index.html', filesWritten: [] },
    });
    expect(commands).toEqual([]);
    expect(refused.refusal).toEqual({ reason: 'stale-index', file: '/index.html', detail: undefined, stamped: false });
    expect(refused.busy).toBe(false);
  });

  it('marks an ambiguous-stylesheet refusal as stamped when source was already written', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { state: refused } = reduceStyles(state, {
      type: 'applied',
      declaration: padding,
      result: { ok: false, reason: 'ambiguous-stylesheet', message: 'boom', markerId: 'm1', filesWritten: ['/index.html'] },
    });
    expect(refused.refusal?.stamped).toBe(true);
  });
});

describe('the offered action', () => {
  function offer(reason: RefusalReason): StylesCommand[] {
    const state: StylesState = {
      ...emptyStylesState(),
      selection: payload(),
      refusal: { reason, file: '/gone.html', detail: 'boom', stamped: false },
    };
    return reduceStyles(state, { type: 'act-on-refusal' }).commands;
  }

  it('opens the file for ambiguous-stylesheet, and does NOT ask the agent', () => {
    expect(offer('ambiguous-stylesheet')).toEqual([{ kind: 'open-file', path: OVERRIDES_PATH }]);
    expect(kinds(offer('ambiguous-stylesheet'))).not.toContain('ask-agent');
  });

  it('asks the agent for unresolvable and missing-file', () => {
    expect(kinds(offer('unresolvable'))).toEqual(['ask-agent']);
    expect(kinds(offer('missing-file'))).toEqual(['ask-agent']);
  });

  it('offers a refresh for stale-index, not the agent', () => {
    expect(offer('stale-index')).toEqual([{ kind: 'refresh' }]);
  });

  it('offers nothing while the agent is generating', () => {
    expect(offer('generating')).toEqual([]);
  });

  it('hands the agent the refusal in words, naming the file, not a bare code', () => {
    const command = offer('missing-file')[0] as Extract<StylesCommand, { kind: 'ask-agent' }>;
    expect(command.reason).toContain('/gone.html');
  });

  it('does nothing when there is no refusal', () => {
    expect(reduceStyles(emptyStylesState(), { type: 'act-on-refusal' }).commands).toEqual([]);
  });

  it('can be dismissed', () => {
    const state: StylesState = {
      ...emptyStylesState(),
      refusal: { reason: 'stale-index', stamped: false },
    };
    expect(run(state, { type: 'dismiss-refusal' }).refusal).toBeNull();
  });
});

describe('the commit branch', () => {
  it('emits NO preview and NO probe when the apply wrote source', () => {
    // A source write is not silent, so a recompile is already coming: the transient would be sent
    // into a document about to be replaced, and the probe would answer about a document that does
    // not carry the marker yet — reporting every property lost.
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { state: after, commands } = reduceStyles(state, {
      type: 'applied',
      declaration: padding,
      result: ok({ filesWritten: ['/index.html', OVERRIDES_PATH] }),
    });
    // The read is not a message into the doomed document, so it is the one command that still goes:
    // this write is where the marker became known, and the file may carry an older session's block.
    expect(kinds(commands)).toEqual(['read-overrides']);
    expect(after.markerId).toBe('m1');
    expect(after.committed).toEqual(['padding-block']);
  });

  it('emits preview AND probe when the apply wrote only /overrides.css', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { state: after, commands } = reduceStyles(state, {
      type: 'applied',
      declaration: padding,
      result: ok({ filesWritten: [OVERRIDES_PATH] }),
    });
    expect(kinds(commands)).toEqual(['preview', 'probe', 'read-overrides']);
    expect(commands[0]).toEqual({ kind: 'preview', markerId: 'm1', css: 'padding-block: 1rem;' });
    expect(commands[1]).toEqual({
      kind: 'probe',
      nodeId: 'n1',
      markerId: 'm1',
      properties: ['padding-block-start', 'padding-block-end'],
    });
    expect(after.probing).toEqual(['padding-block-start', 'padding-block-end']);
  });

  it('treats a page swept for the <link> as a source write too', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { commands } = reduceStyles(state, {
      type: 'applied',
      declaration: padding,
      result: ok({ filesWritten: [OVERRIDES_PATH, '/about.html'] }),
    });
    expect(kinds(commands)).toEqual(['read-overrides']);
  });

  it('previews and probes when nothing at all was written — the value was already there', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { commands } = reduceStyles(state, {
      type: 'applied',
      declaration: padding,
      result: ok({ filesWritten: [] }),
    });
    expect(kinds(commands)).toEqual(['preview', 'probe', 'read-overrides']);
  });

  it('sends the whole accumulated block, not the declaration that just changed', () => {
    // The frame replaces the transient <style> on every send, so a single declaration would
    // visually revert the earlier edit — and the control, which renders from computed style, with it.
    let state = edited();
    const { commands } = reduceStyles(state, { type: 'applied', declaration: colour, result: ok() });
    const preview = commands[0] as Extract<StylesCommand, { kind: 'preview' }>;
    expect(preview.css).toBe('padding-block: 1rem; color: rgb(1, 2, 3);');
    state = run(state, { type: 'applied', declaration: colour, result: ok() });
    expect(state.committed).toEqual(['padding-block', 'color']);
  });

  it('probes every property committed so far, not only the newest', () => {
    const state = edited();
    const { commands } = reduceStyles(state, { type: 'applied', declaration: colour, result: ok() });
    const probe = commands[1] as Extract<StylesCommand, { kind: 'probe' }>;
    expect(probe.properties).toEqual(['padding-block-start', 'padding-block-end', 'color']);
  });

  it('forgets the transient block on frame-ready, because the file carries it now', () => {
    const state = run(edited(), { type: 'frame-ready' });
    expect(state.declarations).toEqual({});
    // The probe's question list must NOT be forgotten with it, or the first edit's loss is never
    // measured — the only probe that can answer for it runs after the recompile.
    expect(state.committed).toEqual(['padding-block']);
    expect(state.markerId).toBe('m1');
  });

  it('probes again when the same element comes back after a recompile', () => {
    const state = run(edited(), { type: 'frame-ready' });
    const { commands } = reduceStyles(state, {
      type: 'select',
      payload: payload({ nodeId: 'n7', attributes: { 'data-osw-id': 'm1' } }),
    });
    expect(kinds(commands)).toEqual(['query', 'probe', 'read-overrides']);
    const probe = commands[1] as Extract<StylesCommand, { kind: 'probe' }>;
    expect(probe.nodeId).toBe('n7');
    expect(probe.markerId).toBe('m1');
  });

  it('does not probe an element it has never committed anything for', () => {
    const { commands } = reduceStyles(emptyStylesState(), { type: 'select', payload: payload() });
    expect(kinds(commands)).toEqual(['query']);
  });
});

describe('lost overrides', () => {
  it('records a loss per property, with what beat it', () => {
    let state = edited();
    state = run(state, { type: 'applied', declaration: colour, result: ok() });
    state = run(state, {
      type: 'probed',
      nodeId: 'n1',
      lost: ['padding-block-start', 'padding-block-end'],
      winner: '/styles.css',
    });
    expect(lossFor(state, 'padding-block')).toEqual({
      names: ['padding-block-start', 'padding-block-end'],
      winner: '/styles.css',
    });
    expect(lossFor(state, 'color')).toBeNull();
  });

  it('records a loss the frame could not attribute, rather than dropping it', () => {
    let state = edited();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'] });
    expect(lossFor(state, 'padding-block')).toEqual({ names: ['padding-block-start'], winner: null });
  });

  it('does not blank a loss the probe did not ask about', () => {
    let state = edited();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/a.css' });
    // A probe scoped to colour alone comes back clean. Padding's verdict is not its to overturn.
    state = { ...state, probing: ['color'] };
    state = run(state, { type: 'probed', nodeId: 'n1', lost: [] });
    expect(lossFor(state, 'padding-block')).toEqual({ names: ['padding-block-start'], winner: '/a.css' });
  });

  it('clears a loss the same probe re-asked about and did not repeat', () => {
    let state = edited();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/a.css' });
    state = run(state, { type: 'applied', declaration: padding, result: ok() });
    state = run(state, { type: 'probed', nodeId: 'n1', lost: [] });
    expect(lossFor(state, 'padding-block')).toBeNull();
  });

  it('drops the old verdict the moment the property is written again', () => {
    let state = edited();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/a.css' });
    state = run(state, { type: 'applied', declaration: padding, result: ok() });
    expect(lossFor(state, 'padding-block')).toBeNull();
  });

  it('ignores a probe answer for a node it is no longer showing', () => {
    const state = run(edited(), { type: 'probed', nodeId: 'stale', lost: ['padding-block-start'] });
    expect(state.lost).toEqual({});
  });
});

describe('the one message the panel shows about losses', () => {
  /** Padding lost to one file, border radius lost to another. */
  function twoLosses(): StylesState {
    let state = edited();
    state = run(state, {
      type: 'probed',
      nodeId: 'n1',
      lost: ['padding-block-start', 'padding-block-end'],
      winner: '/styles.css',
    });
    state = { ...state, probing: ['border-top-left-radius'] };
    return run(state, {
      type: 'probed',
      nodeId: 'n1',
      lost: ['border-top-left-radius'],
      winner: 'inline style',
    });
  }

  it('collects every lost property at once, in table order', () => {
    expect(lostOverrides(twoLosses())).toEqual([
      { property: 'padding-block', label: 'Padding, vertical', winner: '/styles.css' },
      { property: 'border-radius', label: 'Corner radius', winner: 'inline style' },
    ]);
  });

  it('is empty when nothing is lost, which is what hides the banner', () => {
    expect(lostOverrides(edited())).toEqual([]);
  });

  it('names each property and what beat it, in one message', () => {
    const message = lossMessage(lostOverrides(twoLosses()), t);

    expect(message).toBe('padding-block loses to /styles.css. border-radius loses to inline style.');
  });

  it('says so plainly when the frame could name no winner', () => {
    let state = edited();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'] });

    expect(lossMessage(lostOverrides(state), t)).toContain('cannot name');
    expect(lossMessage(lostOverrides(state), t)).toContain('padding-block');
  });

  it('hands the agent every loss in one request, not one per control', () => {
    const prompt = lossAgentPrompt(lostOverrides(twoLosses()));

    expect(prompt).toContain('`padding-block`');
    expect(prompt).toContain('/styles.css');
    expect(prompt).toContain('`border-radius`');
    expect(prompt).toContain('inline style');
  });

  it('names the value that was asked for, not just the property', () => {
    const state = twoLosses();
    const prompt = lossAgentPrompt(lostOverrides(state), state.declarations);

    // The agent is being asked to make this value stick, so the value has to be in the request.
    expect(prompt).toContain(`\`padding-block: ${state.declarations['padding-block']}\``);
  });

  it('falls back to the property alone when this session set no value for it', () => {
    const prompt = lossAgentPrompt(lostOverrides(twoLosses()), {});

    expect(prompt).toContain('`padding-block`');
    expect(prompt).not.toContain('padding-block:');
  });
});

describe('declarationBlock', () => {
  it('is null when there is nothing to show', () => {
    expect(declarationBlock({})).toBeNull();
  });

  it('writes one declaration list', () => {
    expect(declarationBlock({ color: 'red', 'padding-block': '1rem' }))
      .toBe('color: red; padding-block: 1rem;');
  });
});

describe('the root font size', () => {
  it('is taken from the reply that carries it, whatever it says', () => {
    const state = run(emptyStylesState(),
      { type: 'select', payload: payload() },
      { type: 'computed', nodeId: 'n1', values: { 'font-size': '20px' }, rootFontSize: '10px' },
    );
    expect(state.rootFontSize).toBe(10);
  });

  it('is null — never 16 — when the reply carries none, or one it cannot read', () => {
    const base = run(emptyStylesState(), { type: 'select', payload: payload() });
    expect(run(base, { type: 'computed', nodeId: 'n1', values: {} }).rootFontSize).toBeNull();
    expect(
      run(base, { type: 'computed', nodeId: 'n1', values: {}, rootFontSize: '' }).rootFontSize,
    ).toBeNull();
  });

  it('is cleared with the values on every re-select, the same element included', () => {
    // It is a fact about the document, but its lifetime is the reply's. The same-element branch is
    // the one that matters: that is the post-recompile re-select, which keeps the marker and the
    // history — and a *new document* is exactly where the root size can have changed. A different
    // element resets the whole state anyway, so asserting only that would assert nothing.
    let state = run(emptyStylesState(),
      { type: 'select', payload: payload() },
      { type: 'computed', nodeId: 'n1', values: { color: 'red' }, rootFontSize: '10px' },
    );
    expect(state.rootFontSize).toBe(10);

    const resolved = payload({ nodeId: 'n9' });
    state = run(state, { type: 'select', payload: resolved });
    expect(state.selection?.nodeId).toBe('n9');
    expect(state.computed).toEqual({});
    expect(state.rootFontSize).toBeNull();

    expect(run(state, { type: 'select', payload: other }).rootFontSize).toBeNull();
  });
});

describe('reset', () => {
  it('emits a remove command for that property alone', () => {
    const { commands } = reduceStyles(edited(), { type: 'reset', property: 'padding-block' });
    expect(commands).toEqual([
      { kind: 'remove', property: 'padding-block', confirmedMultiInstance: false },
    ]);
  });

  it('carries the confirmation the user already gave for this element', () => {
    let state = run(edited(),
      { type: 'change', declaration: colour },
      { type: 'applied', declaration: colour, result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', declaration: colour, result: ok() },
    );
    const { commands } = reduceStyles(state, { type: 'reset', property: 'color' });
    expect(commands).toEqual([
      { kind: 'remove', property: 'color', confirmedMultiInstance: true },
    ]);
    state = run(state, { type: 'reset', property: 'color' });
    expect(state.busy).toBe(true);
  });

  it('emits nothing at all when there is no marker, so no block of ours exists', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    expect(reduceStyles(state, { type: 'reset', property: 'color' }).commands).toEqual([]);
  });

  it('rebuilds the document rather than previewing, because a removal cannot be previewed', () => {
    // The transient <style> can only add rules. The document still has the pre-removal
    // /overrides.css compiled into it, so a `preview` here would show the block's *other*
    // declarations changing while the removed one stayed exactly where it was.
    const state = edited();
    const { commands } = reduceStyles(state, {
      type: 'removed',
      property: 'padding-block',
      result: { ok: true, markerId: 'm1', filesWritten: [OVERRIDES_PATH] },
    });
    // And the block is re-read, because a removal can take the whole block with it.
    expect(kinds(commands)).toEqual(['refresh', 'read-overrides']);
  });

  it('asks for no rebuild when the file did not change', () => {
    const { commands } = reduceStyles(edited(), {
      type: 'removed',
      property: 'padding-block',
      result: { ok: true, markerId: 'm1', filesWritten: [] },
    });
    expect(kinds(commands)).toEqual(['read-overrides']);
  });

  it('forgets the property: no longer probed, no longer previewed, no longer resettable', () => {
    let state = run(edited(), { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/s.css' });
    expect(canReset(state, 'padding-block')).toBe(true);

    state = run(state, {
      type: 'removed',
      property: 'padding-block',
      result: { ok: true, markerId: 'm1', filesWritten: [OVERRIDES_PATH] },
    });

    expect(state.committed).not.toContain('padding-block');
    expect(state.declarations['padding-block']).toBeUndefined();
    expect(state.lost).toEqual({});
    expect(canReset(state, 'padding-block')).toBe(false);
  });

  it('holds a removal for confirmation and replays it on confirm', () => {
    const state = run(edited(), {
      type: 'removed',
      property: 'padding-block',
      result: { ok: false, reason: 'needs-confirmation', instances: 6, file: '/partials/nav.hbs', filesWritten: [] },
    });
    expect(state.pending).toEqual({
      removeProperty: 'padding-block',
      file: '/partials/nav.hbs',
      instances: 6,
    });
    // Nothing was taken out while it waits.
    expect(state.committed).toContain('padding-block');

    const { state: next, commands } = reduceStyles(state, { type: 'confirm' });
    expect(commands).toEqual([
      { kind: 'remove', property: 'padding-block', confirmedMultiInstance: true },
    ]);
    expect(next.confirmed).toBe(true);
  });

  it('renders a refused removal the way a refused write is rendered', () => {
    const state = run(edited(), {
      type: 'removed',
      property: 'padding-block',
      result: { ok: false, reason: 'ambiguous-stylesheet', message: 'nested', filesWritten: [] },
    });
    expect(state.refusal?.reason).toBe('ambiguous-stylesheet');
    expect(state.busy).toBe(false);
    // Still committed: nothing was removed, so offering Reset again is correct.
    expect(canReset(state, 'padding-block')).toBe(true);
  });
});

describe('canReset', () => {
  it('is false before anything has been written against the element', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    expect(canReset(state, 'color')).toBe(false);
  });

  it('is false for a property this element never overrode', () => {
    expect(canReset(edited(), 'color')).toBe(false);
    expect(canReset(edited(), 'padding-block')).toBe(true);
  });

  it('survives the recompile a first edit triggers', () => {
    // The marker comes back on the payload, so the panel knows it is the same element and keeps
    // what it committed — which is the state a Reset pressed after the first edit runs in.
    let state = edited();
    state = run(state,
      { type: 'frame-ready' },
      { type: 'select', payload: payload({ nodeId: 'n9', attributes: { 'data-osw-id': 'm1' } }) },
    );
    expect(canReset(state, 'padding-block')).toBe(true);
  });

  it('is true for an override only the FILE knows about — the previous session\'s', () => {
    // Nothing committed here: a fresh panel, an element that arrives already marked, and a file
    // that says the block declares `color`. This is the state after a reload, and it used to be
    // the state in which Reset was missing.
    const state = run(emptyStylesState(),
      { type: 'select', payload: payload({ attributes: { 'data-osw-id': 'm1' } }) },
      { type: 'overrides', markerId: 'm1', properties: ['color'] },
    );
    expect(state.committed).toEqual([]);
    expect(canReset(state, 'color')).toBe(true);
    expect(canReset(state, 'background-color')).toBe(false);
  });
});

describe('reading /overrides.css back', () => {
  it('asks about the marker the element arrives carrying, before anything is written', () => {
    const { commands } = reduceStyles(emptyStylesState(), {
      type: 'select',
      payload: payload({ attributes: { 'data-osw-id': 'm1' } }),
    });
    expect(kinds(commands)).toEqual(['query', 'read-overrides']);
    expect(commands[1]).toEqual({ kind: 'read-overrides', markerId: 'm1' });
  });

  it('asks nothing for an element with no marker — there is no block to have', () => {
    const { commands } = reduceStyles(emptyStylesState(), { type: 'select', payload: payload() });
    expect(kinds(commands)).toEqual(['query']);
  });

  it('stops offering Reset for a previous session\'s override the moment the removal lands', () => {
    // Nothing in `committed` to fall out of: the control was being offered on the file's word alone,
    // so it has to stop on the file's word alone — and the re-read is a promise away.
    let state = run(emptyStylesState(),
      { type: 'select', payload: payload({ attributes: { 'data-osw-id': 'm1' } }) },
      { type: 'overrides', markerId: 'm1', properties: ['color', 'padding-block'] },
    );
    state = run(state, {
      type: 'removed',
      property: 'color',
      result: { ok: true, markerId: 'm1', filesWritten: [OVERRIDES_PATH] },
    });
    expect(canReset(state, 'color')).toBe(false);
    // And only that one: the block's other declaration is still there to remove.
    expect(canReset(state, 'padding-block')).toBe(true);
  });

  it('drops an answer about another element, which is what a slow read produces', () => {
    // The read is a promise: the user clicks the next element while it is in flight, and the answer
    // arrives naming the marker it was asked about. Crediting it here would offer Reset on the new
    // element for the old element's overrides.
    const state = run(emptyStylesState(),
      { type: 'select', payload: payload({ attributes: { 'data-osw-id': 'm2' } }) },
      { type: 'overrides', markerId: 'm1', properties: ['color'] },
    );
    expect(state.overridden).toEqual([]);
    expect(canReset(state, 'color')).toBe(false);
  });

  it('drops what the file said when the same position comes back under a NEW marker', () => {
    // Same `domPath`, so the panel treats it as the element it already had — but the agent has
    // replaced the tag and the marker with it. The old marker's block says nothing about this one,
    // and keeping the list would offer a Reset that removes a declaration from someone else's rule.
    const state = run(emptyStylesState(),
      { type: 'select', payload: payload({ attributes: { 'data-osw-id': 'm1' } }) },
      { type: 'overrides', markerId: 'm1', properties: ['color'] },
    );
    expect(canReset(state, 'color')).toBe(true);

    const { state: next, commands } = reduceStyles(state, {
      type: 'select',
      payload: payload({ attributes: { 'data-osw-id': 'm3' } }),
    });
    expect(next.markerId).toBe('m3');
    expect(next.overridden).toEqual([]);
    expect(canReset(next, 'color')).toBe(false);
    // And the new marker's own block is asked about.
    expect(commands).toContainEqual({ kind: 'read-overrides', markerId: 'm3' });
  });

  it('drops what the file said when the selection moves to another element', () => {
    let state = run(emptyStylesState(),
      { type: 'select', payload: payload({ attributes: { 'data-osw-id': 'm1' } }) },
      { type: 'overrides', markerId: 'm1', properties: ['color'] },
    );
    state = run(state, { type: 'select', payload: other });
    expect(state.overridden).toEqual([]);
  });
});

describe('message variants', () => {
  const padding = { property: 'padding', value: '8px' } as never;

  it('names the file when a stale or missing refusal has one, and does without when not', () => {
    expect(refusalMessage({ reason: 'stale-index', file: '/a.html' } as never, t)).toBe(t('msgStaleFile', { file: '/a.html' }));
    expect(refusalMessage({ reason: 'stale-index' } as never, t)).toBe(t('msgStale'));
    expect(refusalMessage({ reason: 'missing-file', file: '/a.html' } as never, t)).toBe(t('msgMissingFile', { file: '/a.html' }));
    expect(refusalMessage({ reason: 'missing-file' } as never, t)).toBe(t('msgMissing'));
  });

  it('calls a tag rendered once shared, not "all 1", and names its file', () => {
    expect(confirmationMessage({ declaration: padding, file: '/nav.hbs', instances: 1 }, t))
      .toBe(t('confirmSharedFrom', { count: 1, file: '/nav.hbs' }));
    expect(confirmationMessage({ declaration: padding, file: undefined, instances: 1 } as never, t))
      .toBe(t('confirmShared', { count: 1, file: '' }));
  });

  it('hands the agent the stylesheet problem it was told, not the generic one', () => {
    const prompt = refusalAgentPrompt({ reason: 'ambiguous-stylesheet', detail: 'nested in @media', stamped: false } as never);
    expect(prompt).toContain('nested in @media');
    expect(prompt).not.toContain('its blocks are not in the shape');
  });
});
