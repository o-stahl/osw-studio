// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TallyList } from '../tally-list';
import type { Tally, TallyStep } from '@/lib/quick-edit/tally';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { collate, phraseCollated } from '@/lib/quick-edit/collate';

/**
 * What a stretch of tool activity looks like at rest, and what it takes to open.
 *
 * `collate` is tested as a function in `lib/quick-edit/__tests__/collate.test.ts`; the sentence it
 * produces is not re-asserted here. What needs a DOM is the choice this component makes *around*
 * that sentence: a stretch of one step is shown as that step, and only a longer one is folded
 * behind a disclosure. A version that collated everything passes every assertion about `collate`
 * and still puts a single row behind a caret, restated in more general words.
 */

let container: HTMLDivElement;
let root: Root;

function step(over: Partial<TallyStep> = {}): TallyStep {
  return { kind: 'read', path: '/index.html', steps: 1, done: true, failed: false, ...over };
}

function tally(steps: TallyStep[], over: Partial<Tally> = {}): Tally {
  return {
    status: 'done',
    steps,
    commandCount: steps.reduce((n, s) => n + s.steps, 0),
    filesChanged: [],
    summary: null,
    ...over,
  };
}

function mount(t: Tally, live = false) {
  act(() => { root.render(withMessages(<TallyList tally={t} live={live} />)); });
}

/** The caret is the only control this component renders, so its presence is the disclosure. */
function disclosure(): HTMLButtonElement | null {
  return container.querySelector('button');
}

/**
 * The labels of the step rows on screen.
 *
 * Keyed on the row's own label span and on being outside the disclosure, because the collated
 * sentence is a span too and reads like a step ("Read index.html, then edited styles.css") — a
 * looser selector counts the summary as a row and cannot tell a closed stretch from an open one.
 */
function rowLabels(): string[] {
  return Array.from(container.querySelectorAll('span.flex-1'))
    .filter((el) => el.closest('button') === null)
    .map((el) => el.textContent ?? '');
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a stretch of tool activity', () => {
  it('shows a single step as itself, with nothing to open', () => {
    mount(tally([step()]));

    expect(disclosure()).toBeNull();
    expect(container.textContent).toContain('Read index.html');
  });

  it('does not restate a single step in more general words', () => {
    // `collate` files a write under the changes it groups ("Edited index.html"); the step says what
    // happened ("Wrote index.html"). A read would not tell the two apart: both name the file.
    mount(tally([step({ kind: 'write' })]));

    expect(container.textContent).toContain('Wrote index.html');
    expect(container.textContent).not.toContain('Edited');
  });

  it('folds a longer stretch behind a disclosure', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]));

    expect(disclosure()).not.toBeNull();
    // The sentence is showing; the individual rows are not, until it is opened.
    expect(rowLabels()).not.toContain('Edited styles.css');
  });

  it('heads the folded stretch with the collated sentence', () => {
    const t = tally([step(), step({ kind: 'edit', path: '/styles.css' })]);
    mount(t);

    const sentence = phraseCollated(collate(t)!, createTranslator({ locale: 'en', messages: en, namespace: 'quickEdit.collate' }));
    expect(sentence).not.toBe('');
    expect(disclosure()!.textContent).toContain(sentence);
  });

  it('opens onto every step', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]));

    act(() => { disclosure()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(rowLabels()).toContain('Read index.html');
    expect(rowLabels()).toContain('Edited styles.css');
  });

  it('shows the step in flight under the sentence while the stretch is live', () => {
    const running = step({ kind: 'edit', path: '/styles.css', done: false });
    mount(tally([step(), running], { status: 'working' }), true);

    // Closed, so the only row on screen is the one still running.
    expect(rowLabels()).toEqual(['Edited styles.css']);
  });

  it('shows no step in flight once the stretch is finished', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]), false);

    expect(rowLabels()).toEqual([]);
  });

  it('renders nothing for a tally with no steps', () => {
    mount(tally([]));

    expect(container.textContent).toBe('');
  });

  it('counts a repeated step rather than listing it twice', () => {
    mount(tally([step({ path: null, steps: 3 })]));

    expect(container.textContent).toContain('x3');
  });
});
