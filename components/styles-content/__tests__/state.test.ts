import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { describe, it, expect } from 'vitest';
import {
  canMakeApply,
  OVERRIDES_PATH,
  REFUSAL_REASONS,
  canReset,
  confirmationMessage,
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
  css: '/* the file as written */',
  ...over,
});

/** What reading `/overrides.css` back says this marker sets for every width. */
const overridesOf = (properties: readonly string[]) => ({
  byScope: new Map([['all' as const, Object.fromEntries(properties.map(p => [p, 'x']))]]),
  text: '',
  widths: [],
});

/** Fold a run of events, discarding commands. */
function run(state: StylesState, ...events: StylesEvent[]): StylesState {
  return events.reduce((s, event) => reduceStyles(s, event).state, state);
}

function kinds(commands: StylesCommand[]): string[] {
  return commands.map(c => c.kind);
}

/** The one command of a kind, by kind rather than by position. */
function command<K extends StylesCommand['kind']>(commands: StylesCommand[], kind: K): Extract<StylesCommand, { kind: K }> {
  const found = commands.filter(c => c.kind === kind);
  expect(found).toHaveLength(1);
  return found[0] as Extract<StylesCommand, { kind: K }>;
}

/** Selected, one padding edit committed to `/overrides.css`, and a probe answered. */
function edited(): StylesState {
  let state = run(emptyStylesState(), { type: 'select', payload: payload() });
  state = run(state, { type: 'change', changes: [padding] });
  state = run(state, { type: 'applied', changes: [padding], scope: 'all', result: ok() });
  return state;
}

/**
 * `edited`, after its padding lost once and was made `!important`: from here a loss is one a
 * stylesheet cannot beat, and is recorded.
 */
function strengthened(): StylesState {
  let state = edited();
  state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start', 'padding-block-end'], winner: '/styles.css' });
  return run(state, { type: 'applied', changes: [], scope: 'all', result: ok() });
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
    let state = strengthened();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/s.css' });
    state = run(state, { type: 'confirm' }); // no-op without a pending, so arm it the real way
    state = run(state,
      { type: 'change', changes: [colour] },
      { type: 'applied', changes: [colour], scope: 'all', result: { ok: false, reason: 'needs-confirmation', instances: 4, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', changes: [colour], scope: 'all', result: { ok: false, reason: 'unresolvable', filesWritten: [] } },
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
      changes: [padding],
      scope: 'all',
      result: { ok: false, reason: 'needs-confirmation', file: '/partials/nav.hbs', instances: 6, filesWritten: [] },
    });
    expect(commands).toEqual([]);
    expect(armed.pending).toEqual({ changes: [padding], scope: 'all', file: '/partials/nav.hbs', instances: 6 });
    expect(armed.confirmed).toBe(false);
    expect(armed.refusal).toBeNull();
  });

  it('replays the pending declaration with confirmedMultiInstance: true', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state, {
      type: 'applied',
      changes: [padding],
      scope: 'all',
      result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] },
    });
    const { state: confirmed, commands } = reduceStyles(state, { type: 'confirm' });
    expect(commands).toEqual([{ kind: 'apply', changes: [padding], scope: 'all', confirmedMultiInstance: true }]);
    expect(confirmed.pending).toBeNull();
    expect(confirmed.confirmed).toBe(true);
  });

  it('is armed per SELECTION, not per edit', () => {
    // Adjusting padding four steps must not ask four times.
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state,
      { type: 'applied', changes: [padding], scope: 'all', result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', changes: [padding], scope: 'all', result: ok({ filesWritten: ['/partials/nav.hbs', OVERRIDES_PATH] }) },
    );
    const { commands } = reduceStyles(state, { type: 'change', changes: [{ property: 'padding-block', value: '1.5rem' }] });
    expect(commands).toEqual([{
      kind: 'apply',
      changes: [{ property: 'padding-block', value: '1.5rem' }],
      scope: 'all',
      confirmedMultiInstance: true,
    }]);
  });

  it('survives the recompile the first commit triggers', () => {
    // The first commit writes source, the preview recompiles, and the panel re-selects the same
    // element — now carrying its marker, and with a `srcAttr` index the <link> insertion shifted.
    let state = run(emptyStylesState(), { type: 'select', payload: payload({ srcAttr: '/index.html:120' }) });
    state = run(state,
      { type: 'applied', changes: [padding], scope: 'all', result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', changes: [padding], scope: 'all', result: ok({ filesWritten: ['/index.html', OVERRIDES_PATH] }) },
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
      { type: 'applied', changes: [padding], scope: 'all', result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', changes: [padding], scope: 'all', result: ok({ filesWritten: ['/index.html', OVERRIDES_PATH] }) },
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
      { type: 'applied', changes: [padding], scope: 'all', result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
    );
    expect(state.markerId).toBeNull();
    const next = run(state, { type: 'select', payload: payload({ nodeId: 'n5' }) });
    expect(next.confirmed).toBe(true);
  });

  it('is disarmed by changing selection', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state,
      { type: 'applied', changes: [padding], scope: 'all', result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
    );
    expect(state.confirmed).toBe(true);
    expect(run(state, { type: 'select', payload: other }).confirmed).toBe(false);
  });

  it('emits apply without confirmation for an ordinary element', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { commands } = reduceStyles(state, { type: 'change', changes: [padding] });
    expect(commands).toEqual([{ kind: 'apply', changes: [padding], scope: 'all', confirmedMultiInstance: false }]);
  });

  it('writes nothing when there is no element selected', () => {
    // Reachable: a control can be mid-press when the preview reloads and the selection is dropped.
    // An apply with no selection would resolve against whatever the last payload happened to be.
    const { commands } = reduceStyles(emptyStylesState(), { type: 'change', changes: [padding] });
    expect(commands).toEqual([]);
  });

  it('drops the pending declaration when the user backs out', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() });
    state = run(state, {
      type: 'applied',
      changes: [padding],
      scope: 'all',
      result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] },
    });
    const { state: cancelled, commands } = reduceStyles(state, { type: 'cancel' });
    expect(commands).toEqual([]);
    expect(cancelled.pending).toBeNull();
    expect(cancelled.confirmed).toBe(false);
  });

  it('says how many elements the change reaches', () => {
    expect(confirmationMessage({ changes: [padding], scope: 'all', file: '/partials/nav.hbs', instances: 6 }, t))
      .toBe(t('confirmManyFrom', { count: 6, file: '/partials/nav.hbs' }));
    expect(confirmationMessage({ changes: [padding], scope: 'all', instances: 6 }, t))
      .toBe(t('confirmMany', { count: 6, file: '' }));
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
      changes: [padding],
      scope: 'all',
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
      changes: [padding],
      scope: 'all',
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
  it('emits NO broadcast and NO probe when the apply wrote source', () => {
    // A source write is not silent, so a recompile is already coming: the file would be swapped
    // into a document about to be replaced, and the probe would answer about a document that does
    // not carry the marker yet — reporting every property lost.
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { state: after, commands } = reduceStyles(state, {
      type: 'applied',
      changes: [padding],
      scope: 'all',
      result: ok({ filesWritten: ['/index.html', OVERRIDES_PATH] }),
    });
    // The read is not a message into the doomed document, so it is the one command that still goes:
    // this write is where the marker became known, and the file may carry an older session's block.
    expect(kinds(commands)).toEqual(['read-overrides']);
    expect(after.markerId).toBe('m1');
    expect(after.committed).toEqual(['padding-block']);
  });

  it('swaps the file into the frames, reads the element again and probes when the apply wrote only /overrides.css', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { state: after, commands } = reduceStyles(state, {
      type: 'applied',
      changes: [padding],
      scope: 'all',
      result: ok({ filesWritten: [OVERRIDES_PATH] }),
    });
    // In that order: the frame swaps the file in before it answers the query and the probe.
    expect(kinds(commands)).toEqual(['broadcast', 'query', 'probe', 'read-overrides']);
    expect(commands[0]).toEqual({ kind: 'broadcast', css: '/* the file as written */' });
    expect(command(commands, 'probe')).toEqual({
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
      changes: [padding],
      scope: 'all',
      result: ok({ filesWritten: [OVERRIDES_PATH, '/about.html'] }),
    });
    expect(kinds(commands)).toEqual(['read-overrides']);
  });

  it('probes, and swaps nothing in, when nothing at all was written — the value was already there', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    const { commands } = reduceStyles(state, {
      type: 'applied',
      changes: [padding],
      scope: 'all',
      result: ok({ filesWritten: [] }),
    });
    expect(kinds(commands)).toEqual(['probe', 'read-overrides']);
  });

  it('broadcasts the whole file as the write left it, so every earlier edit stays on screen', () => {
    // One rule per send would visually revert the element's earlier edits, and every other element's.
    let state = edited();
    const { commands } = reduceStyles(state, { type: 'applied', changes: [colour], scope: 'all', result: ok({ css: '/* both rules */' }) });
    expect(command(commands, 'broadcast')).toEqual({ kind: 'broadcast', css: '/* both rules */' });
    state = run(state, { type: 'applied', changes: [colour], scope: 'all', result: ok() });
    expect(state.committed).toEqual(['padding-block', 'color']);
  });

  it('probes every property committed so far, not only the newest', () => {
    const state = edited();
    const { commands } = reduceStyles(state, { type: 'applied', changes: [colour], scope: 'all', result: ok() });
    expect(command(commands, 'probe').properties).toEqual(['padding-block-start', 'padding-block-end', 'color']);
  });

  it('forgets the values this session wrote on frame-ready, because the file carries them now', () => {
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
    let state = strengthened();
    state = run(state, { type: 'applied', changes: [colour], scope: 'all', result: ok() });
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
    let state = strengthened();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'] });
    expect(lossFor(state, 'padding-block')).toEqual({ names: ['padding-block-start'], winner: null });
  });

  it('does not blank a loss the probe did not ask about', () => {
    let state = strengthened();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/a.css' });
    // A probe scoped to colour alone comes back clean. Padding's verdict is not its to overturn.
    state = { ...state, probing: ['color'] };
    state = run(state, { type: 'probed', nodeId: 'n1', lost: [] });
    expect(lossFor(state, 'padding-block')).toEqual({ names: ['padding-block-start'], winner: '/a.css' });
  });

  it('clears a loss the same probe re-asked about and did not repeat', () => {
    let state = strengthened();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/a.css' });
    expect(lossFor(state, 'padding-block')).not.toBeNull();
    state = run(state, { type: 'applied', changes: [padding], scope: 'all', result: ok() });
    state = run(state, { type: 'probed', nodeId: 'n1', lost: [] });
    expect(lossFor(state, 'padding-block')).toBeNull();
  });

  it('drops the old verdict the moment the property is written again', () => {
    let state = strengthened();
    state = run(state, { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/a.css' });
    expect(lossFor(state, 'padding-block')).not.toBeNull();
    state = run(state, { type: 'applied', changes: [padding], scope: 'all', result: ok() });
    expect(lossFor(state, 'padding-block')).toBeNull();
  });

  it('ignores a probe answer for a node it is no longer showing', () => {
    const state = run(edited(), { type: 'probed', nodeId: 'stale', lost: ['padding-block-start'] });
    expect(state.lost).toEqual({});
  });
});

describe('a change that loses is made to win', () => {
  const lostPadding = { type: 'probed', nodeId: 'n1', lost: ['padding-block-start', 'padding-block-end'], winner: '/styles.css' } as const;

  it('asks for the property to be marked important instead of reporting the loss', () => {
    const { state, commands } = reduceStyles(edited(), lostPadding);
    expect(commands).toEqual([{ kind: 'strengthen', scope: 'all', properties: ['padding-block'] }]);
    expect(lossFor(state, 'padding-block')).toBeNull();
    expect(lostOverrides(state)).toEqual([]);
  });

  it('probes again once the stronger rule is written, and is quiet when it won', () => {
    const first = reduceStyles(edited(), lostPadding).state;
    const written = reduceStyles(first, { type: 'applied', changes: [], scope: 'all', result: ok() });
    // The frames get the file, and the frame is asked whether the padding wins now.
    expect(kinds(written.commands)).toEqual(['broadcast', 'query', 'probe', 'read-overrides']);
    expect(command(written.commands, 'probe').properties).toEqual(['padding-block-start', 'padding-block-end']);
    // The declaration is the user's still: strengthening is not an edit of its own.
    expect(written.state.committed).toEqual(['padding-block']);

    const clean = reduceStyles(written.state, { type: 'probed', nodeId: 'n1', lost: [] });
    expect(clean.commands).toEqual([]);
    expect(lostOverrides(clean.state)).toEqual([]);
  });

  it('reports a loss that outlasts it, and does not strengthen twice', () => {
    const again = reduceStyles(strengthened(), { ...lostPadding, winner: 'inline style' });
    expect(again.commands).toEqual([]);
    expect(lossFor(again.state, 'padding-block')).toEqual({ names: ['padding-block-start', 'padding-block-end'], winner: 'inline style' });
  });

  it('leaves alone a property this session did not write', () => {
    // Border radius was set in an earlier session, or by nobody: its loss is reported as it is.
    const { state, commands } = reduceStyles(edited(), { type: 'probed', nodeId: 'n1', lost: ['border-top-left-radius'], winner: '/styles.css' });
    expect(commands).toEqual([]);
    expect(lossFor(state, 'border-radius')).not.toBeNull();
  });

  it('strengthens only what lost, when two properties were written', () => {
    let state = run(edited(), { type: 'change', changes: [colour] }, { type: 'applied', changes: [colour], scope: 'all', result: ok() });
    const out = reduceStyles(state, { type: 'probed', nodeId: 'n1', lost: ['color'], winner: '/styles.css' });
    expect(out.commands).toEqual([{ kind: 'strengthen', scope: 'all', properties: ['color'] }]);
    state = out.state;
    expect(state.strengthened).toEqual(['color']);
  });

  it('starts over for a property that was taken off and set again', () => {
    let state = strengthened();
    state = run(state, { type: 'applied', changes: [{ property: 'padding-block', value: null }], scope: 'all', result: ok() });
    expect(state.strengthened).toEqual([]);
    state = run(state, { type: 'change', changes: [padding] }, { type: 'applied', changes: [padding], scope: 'all', result: ok() });
    expect(reduceStyles(state, lostPadding).commands).toEqual([{ kind: 'strengthen', scope: 'all', properties: ['padding-block'] }]);
  });

  it('forgets what it strengthened with the element and with the width', () => {
    expect(run(strengthened(), { type: 'select', payload: other }).strengthened).toEqual([]);
    expect(run(strengthened(), { type: 'scope', scope: 640 }).strengthened).toEqual([]);
    // The same element coming back after a recompile keeps it: its rule is the same rule.
    expect(run(strengthened(), { type: 'select', payload: payload() }).strengthened).toEqual(['padding-block']);
  });
});

describe('a change from an earlier session that loses', () => {
  /** An element whose block in the file sets a colour and a margin, selected with nothing edited yet. */
  function reopened(): StylesState {
    return run(emptyStylesState(), { type: 'select', payload: payload({ attributes: { 'data-osw-id': 'm1' } }) });
  }
  const held = { type: 'overrides', markerId: 'm1', overrides: overridesOf(['color', 'margin']) } as const;

  it('is asked about when the file is read, by the names the file declares', () => {
    const { commands } = reduceStyles(reopened(), held);
    expect(commands).toEqual([{ kind: 'probe', nodeId: 'n1', markerId: 'm1', properties: ['color', 'margin'], tag: 'earlier' }]);
  });

  it('is shown with what beat it, and is not strengthened unasked', () => {
    let state = run(reopened(), held);
    const out = reduceStyles(state, { type: 'probed', nodeId: 'n1', lost: ['color'], winner: '/styles.css', written: ['color'], tag: 'earlier' });
    state = out.state;
    // Nothing is written: it may have been losing for as long as the site has been published.
    expect(out.commands).toEqual([]);
    expect(lostOverrides(state)).toEqual([{ property: 'color', label: 'color', winner: '/styles.css' }]);
    expect(canMakeApply(state)).toBe(true);
  });

  it('is made to win when the user asks, and asked about again afterwards', () => {
    let state = run(reopened(), held, { type: 'probed', nodeId: 'n1', lost: ['color'], winner: '/styles.css', written: ['color'], tag: 'earlier' });
    const asked = reduceStyles(state, { type: 'make-apply' });
    expect(asked.commands).toEqual([{ kind: 'strengthen', scope: 'all', properties: ['color'], asked: true }]);
    expect(lostOverrides(asked.state)).toEqual([]);

    // The write is answered, the file read again, and the frame asked again about what it holds.
    const written = reduceStyles(asked.state, { type: 'applied', changes: [], scope: 'all', result: ok() });
    expect(kinds(written.commands)).toContain('read-overrides');
    const reread = reduceStyles(written.state, held);
    expect(command(reread.commands, 'probe').tag).toBe('earlier');

    // Still losing after that: shown again, with nothing more to offer but the agent.
    state = run(reread.state, { type: 'probed', nodeId: 'n1', lost: ['color'], winner: 'inline style', written: ['color'], tag: 'earlier' });
    expect(lostOverrides(state)).toEqual([{ property: 'color', label: 'color', winner: 'inline style' }]);
    expect(canMakeApply(state)).toBe(false);
    expect(reduceStyles(state, { type: 'make-apply' }).commands).toEqual([]);
  });

  it('leaves this session\'s own writes to the probe that follows them', () => {
    let state = run(reopened(), { type: 'change', changes: [colour] }, { type: 'applied', changes: [colour], scope: 'all', result: ok() });
    const { commands } = reduceStyles(state, held);
    expect(command(commands, 'probe').properties).toEqual(['margin']);
    // The session's colour loses, is made `!important`, and still loses: its own probe's verdict.
    const lostColour = { type: 'probed', nodeId: 'n1', lost: ['color'], winner: 'inline style' } as const;
    state = run(state, lostColour, { type: 'applied', changes: [], scope: 'all', result: ok() }, lostColour, held);
    expect(lossFor(state, 'color')).toEqual({ names: ['color'], winner: 'inline style' });
    // A clean answer about the rest does not touch that verdict.
    state = run(state, { type: 'probed', nodeId: 'n1', lost: [], written: [], tag: 'earlier' });
    expect(state.earlier).toEqual({});
    expect(lossFor(state, 'color')).toEqual({ names: ['color'], winner: 'inline style' });
  });

  it('is reported and made to win by the name the file declares when one side of a shorthand loses', () => {
    const shorthand = { type: 'overrides', markerId: 'm1', overrides: overridesOf(['padding']) } as const;
    const state = run(reopened(), shorthand, { type: 'probed', nodeId: 'n1', lost: ['padding-top'], winner: '/styles.css', written: ['padding'], tag: 'earlier' });
    expect(lostOverrides(state)).toEqual([{ property: 'padding', label: 'padding', winner: '/styles.css' }]);
    expect(reduceStyles(state, { type: 'make-apply' }).commands).toEqual([{ kind: 'strengthen', scope: 'all', properties: ['padding'], asked: true }]);
  });

  it('is not asked about at a width its block does not apply at, or with nothing in the file', () => {
    const wide = run(reopened(), { type: 'scope', scope: 640 }, { type: 'computed', nodeId: 'n1', values: {}, viewportWidth: 1440 });
    const at640: StylesEvent = { type: 'overrides', markerId: 'm1', overrides: { byScope: new Map([[640, { color: 'x' }]]), text: '', widths: [640] } };
    expect(reduceStyles(wide, at640).commands).toEqual([]);
    const narrow = run(reopened(), { type: 'scope', scope: 640 }, { type: 'computed', nodeId: 'n1', values: {}, viewportWidth: 390 });
    expect(kinds(reduceStyles(narrow, at640).commands)).toEqual(['probe']);
    expect(reduceStyles(reopened(), { type: 'overrides', markerId: 'm1', overrides: overridesOf([]) }).commands).toEqual([]);
  });

  it('is forgotten with the element', () => {
    const state = run(reopened(), held, { type: 'probed', nodeId: 'n1', lost: ['color'], written: ['color'], tag: 'earlier' });
    expect(run(state, { type: 'select', payload: other }).earlier).toEqual({});
  });
});

describe('the one message the panel shows about losses', () => {
  /** Padding lost to one file, border radius lost to another. */
  function twoLosses(): StylesState {
    let state = strengthened();
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
    let state = strengthened();
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
  it('emits one write that removes those properties, at this width', () => {
    const { commands } = reduceStyles(run(edited(), { type: 'scope', scope: 640 }), { type: 'reset', properties: ['padding-block', 'color'] });
    expect(commands).toEqual([
      { kind: 'apply', changes: [{ property: 'padding-block', value: null }, { property: 'color', value: null }], scope: 640, confirmedMultiInstance: false },
    ]);
  });

  it('carries the confirmation the user already gave for this element', () => {
    let state = run(edited(),
      { type: 'change', changes: [colour] },
      { type: 'applied', changes: [colour], scope: 'all', result: { ok: false, reason: 'needs-confirmation', instances: 6, filesWritten: [] } },
      { type: 'confirm' },
      { type: 'applied', changes: [colour], scope: 'all', result: ok() },
    );
    const { commands } = reduceStyles(state, { type: 'reset', properties: ['color'] });
    expect(commands).toEqual([
      { kind: 'apply', changes: [{ property: 'color', value: null }], scope: 'all', confirmedMultiInstance: true },
    ]);
    state = run(state, { type: 'reset', properties: ['color'] });
    expect(state.busy).toBe(true);
  });

  it('emits nothing at all when there is no marker, so no block of ours exists', () => {
    const state = run(emptyStylesState(), { type: 'select', payload: payload() });
    expect(reduceStyles(state, { type: 'reset', properties: ['color'] }).commands).toEqual([]);
  });

  it('swaps the file in rather than rebuilding, since the whole file shows a removal too', () => {
    // A copy of the file without the declaration replaces the old one in the frame, so the value
    // falls back to the stylesheet's at once, with no recompile to cost the toolbar and the scroll.
    const state = edited();
    const { commands } = reduceStyles(state, {
      type: 'applied',
      changes: [{ property: 'padding-block', value: null }],
      scope: 'all',
      result: { ok: true, markerId: 'm1', filesWritten: [OVERRIDES_PATH], css: '/* without it */' },
    });
    // And the block is re-read, because a removal can take the whole block with it. Nothing is
    // probed: the only property this session committed is the one taken off.
    expect(kinds(commands)).toEqual(['broadcast', 'query', 'read-overrides']);
  });

  it('swaps nothing in when the file did not change', () => {
    const { commands } = reduceStyles(edited(), {
      type: 'applied',
      changes: [{ property: 'padding-block', value: null }],
      scope: 'all',
      result: { ok: true, markerId: 'm1', filesWritten: [] },
    });
    expect(kinds(commands)).toEqual(['read-overrides']);
  });

  it('forgets the property: no longer probed, no longer previewed, no longer resettable', () => {
    let state = run(edited(), { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/s.css' });
    expect(canReset(state, 'padding-block')).toBe(true);

    state = run(state, {
      type: 'applied',
      changes: [{ property: 'padding-block', value: null }],
      scope: 'all',
      result: { ok: true, markerId: 'm1', filesWritten: [OVERRIDES_PATH] },
    });

    expect(state.committed).not.toContain('padding-block');
    expect(state.declarations['padding-block']).toBeUndefined();
    expect(state.lost).toEqual({});
    expect(canReset(state, 'padding-block')).toBe(false);
  });

  it('holds a removal for confirmation and replays it on confirm', () => {
    const state = run(edited(), {
      type: 'applied',
      changes: [{ property: 'padding-block', value: null }],
      scope: 'all',
      result: { ok: false, reason: 'needs-confirmation', instances: 6, file: '/partials/nav.hbs', filesWritten: [] },
    });
    expect(state.pending).toEqual({
      changes: [{ property: 'padding-block', value: null }],
      scope: 'all',
      file: '/partials/nav.hbs',
      instances: 6,
    });
    // Nothing was taken out while it waits.
    expect(state.committed).toContain('padding-block');

    const { state: next, commands } = reduceStyles(state, { type: 'confirm' });
    expect(commands).toEqual([
      { kind: 'apply', changes: [{ property: 'padding-block', value: null }], scope: 'all', confirmedMultiInstance: true },
    ]);
    expect(next.confirmed).toBe(true);
  });

  it('renders a refused removal the way a refused write is rendered', () => {
    const state = run(edited(), {
      type: 'applied',
      changes: [{ property: 'padding-block', value: null }],
      scope: 'all',
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
      { type: 'overrides', markerId: 'm1', overrides: overridesOf(['color']) },
    );
    expect(state.committed).toEqual([]);
    expect(canReset(state, 'color')).toBe(true);
    expect(canReset(state, 'background-color')).toBe(false);
  });

  it('matches a custom property the file declares as it is spelled, and any other whatever its case', () => {
    let state = run(emptyStylesState(),
      { type: 'select', payload: payload({ attributes: { 'data-osw-id': 'm1' } }) },
      { type: 'overrides', markerId: 'm1', overrides: overridesOf(['--cardBg', 'color']) },
    );
    expect(canReset(state, '--cardBg')).toBe(true);
    expect(canReset(state, '--cardbg')).toBe(false);
    expect(canReset(state, 'COLOR')).toBe(true);
    // Taken off, it is no longer set, before the file is read again.
    const removal = [{ property: '--cardBg', value: null }];
    state = run(state, { type: 'reset', properties: ['--cardBg'] }, { type: 'applied', changes: removal, scope: 'all', result: ok() });
    expect(state.overridden).toEqual(['color']);
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
      { type: 'overrides', markerId: 'm1', overrides: overridesOf(['color', 'padding-block']) },
    );
    state = run(state, {
      type: 'applied',
      changes: [{ property: 'color', value: null }],
      scope: 'all',
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
      { type: 'overrides', markerId: 'm1', overrides: overridesOf(['color']) },
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
      { type: 'overrides', markerId: 'm1', overrides: overridesOf(['color']) },
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
      { type: 'overrides', markerId: 'm1', overrides: overridesOf(['color']) },
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
    expect(confirmationMessage({ changes: [padding], scope: 'all', file: '/nav.hbs', instances: 1 }, t))
      .toBe(t('confirmSharedFrom', { count: 1, file: '/nav.hbs' }));
    expect(confirmationMessage({ changes: [padding], scope: 'all', file: undefined, instances: 1 } as never, t))
      .toBe(t('confirmShared', { count: 1, file: '' }));
  });

  it('hands the agent the stylesheet problem it was told, not the generic one', () => {
    const prompt = refusalAgentPrompt({ reason: 'ambiguous-stylesheet', detail: 'nested in @media', stamped: false } as never);
    expect(prompt).toContain('nested in @media');
    expect(prompt).not.toContain('its blocks are not in the shape');
  });
});

describe('width scopes', () => {
  /** What the file holds for m1: padding at every width, colour up to 640 px. */
  const file = {
    byScope: new Map<'all' | number, Record<string, string>>([['all', { 'padding-block': '1rem' }], [640, { color: 'red' }]]),
    text: '',
    widths: [640],
  };
  const marked = payload({ attributes: { 'data-osw-id': 'm1' } });

  it('writes into the scope it is in, and reads what that scope sets', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: marked }, { type: 'overrides', markerId: 'm1', overrides: file });
    expect(state.overridden).toEqual(['padding-block']);
    state = run(state, { type: 'scope', scope: 640 });
    expect(state.overridden).toEqual(['color']);
    expect(canReset(state, 'color')).toBe(true);
    expect(canReset(state, 'padding-block')).toBe(false);
    const { commands } = reduceStyles(state, { type: 'change', changes: [padding] });
    expect(commands).toEqual([{ kind: 'apply', changes: [padding], scope: 640, confirmedMultiInstance: false }]);
  });

  it('keeps the scope across selections, since it is the frame\'s and not the element\'s', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() }, { type: 'scope', scope: 640 });
    state = run(state, { type: 'select', payload: other });
    expect(state.scope).toBe(640);
  });

  it('starts the session\'s lists afresh at another width', () => {
    let state = run(strengthened(), { type: 'probed', nodeId: 'n1', lost: ['padding-block-start'], winner: '/styles.css' });
    expect(lossFor(state, 'padding-block')).toEqual({ names: ['padding-block-start'], winner: '/styles.css' });
    state = run(state, { type: 'scope', scope: 640 });
    expect(state.committed).toEqual([]);
    expect(state.lost).toEqual({});
  });

  it('does not count a write that landed in another scope as this one\'s', () => {
    let state = run(emptyStylesState(), { type: 'select', payload: payload() }, { type: 'scope', scope: 640 });
    state = run(state, { type: 'applied', changes: [colour], scope: 'all', result: ok() });
    expect(state.committed).toEqual([]);
    expect(state.overridden).toEqual([]);
  });

  it('reads the element and the file again after an undo, and forgets this session\'s writes', () => {
    const before = edited();
    expect(before.declarations).toEqual({ 'padding-block': '1rem' });
    const { state, commands } = reduceStyles(before, { type: 'reread' });
    expect(kinds(commands)).toEqual(['query', 'read-overrides']);
    expect(state.committed).toEqual([]);
    expect(state.declarations).toEqual({});
  });
});

describe('requery', () => {
  it('asks the frame about the element again and changes nothing else', () => {
    const before = edited();
    const { state, commands } = reduceStyles(before, { type: 'requery' });
    expect(kinds(commands)).toEqual(['query']);
    expect(state).toBe(before);
  });
});
