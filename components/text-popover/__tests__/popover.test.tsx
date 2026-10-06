// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The dialog's own wiring, which the pure module cannot reach.
 *
 * Four things only a mounted component can be wrong about: that the field is filled from the *read*
 * rather than from anything the host held, that Save sends what is in the field, that
 * `needs-confirmation` holds instead of closing, and that the confirm button re-applies with the
 * flag set. The last is the one that matters — a confirm that re-sends `false` produces the same
 * refusal forever, and reads to the user as a button that does nothing.
 */

import { TextPopover } from '..';
import type { ApplyResult } from '@/lib/direct-edit/types';
import type { TextReadResult } from '@/lib/direct-edit/apply-text';

let container: HTMLDivElement;
let root: Root;
const onRead = vi.fn<() => Promise<TextReadResult>>();
const onApply = vi.fn<(text: string, confirmed: boolean) => Promise<ApplyResult>>();
const onOpenChange = vi.fn();
const onAskAgent = vi.fn();

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  onRead.mockResolvedValue({ ok: true, text: 'Old words', file: '/index.html', instances: 1 });
  onApply.mockResolvedValue({ ok: true, filesWritten: ['/index.html'] });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(open = true) {
  await act(async () => {
    root.render(withMessages(
      <TextPopover
        open={open}
        onOpenChange={onOpenChange}
        onRead={onRead}
        onApply={onApply}
        onAskAgent={onAskAgent}
      />,
    ));
  });
}

/** The dialog portals out of `container`, so every query is against the document. */
const field = () => document.querySelector('[data-osw-text-field]') as HTMLTextAreaElement | null;
const saveButton = () => document.querySelector('[data-osw-text-save]') as HTMLButtonElement | null;
const buttonSaying = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').includes(text));

const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

/** React owns the textarea's value, so a raw assignment is not seen. */
const type = async (value: string) => {
  const el = field()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('TextPopover', () => {
  it('fills the field from the read, not from the selection', async () => {
    await mount();
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(field()?.value).toBe('Old words');
  });

  it('does not read anything while it is closed', async () => {
    await mount(false);
    expect(onRead).not.toHaveBeenCalled();
  });

  it('leaves Save inert until the text differs from what was read', async () => {
    await mount();
    // Pressing Save on unchanged text writes nothing, so a live button invites the user to press
    // something that visibly does nothing.
    expect(saveButton()?.disabled).toBe(true);

    await type('New words');

    expect(saveButton()?.disabled).toBe(false);
  });

  it('saves what is in the field, unconfirmed, and closes on success', async () => {
    await mount();
    await type('New words');
    await click(saveButton()!);

    expect(onApply).toHaveBeenCalledWith('New words', false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('holds a multi-instance edit open, says the number, and confirms it', async () => {
    onApply.mockResolvedValueOnce({ ok: false, reason: 'needs-confirmation', instances: 3, file: '/index.html' });
    await mount();
    await type('New words');
    await click(saveButton()!);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('rendered 3 times');

    const confirm = buttonSaying('Change all 3')!;
    expect(confirm).toBeTruthy();
    await click(confirm);

    // The flag, not a second unconfirmed attempt — which would refuse identically and for ever.
    expect(onApply).toHaveBeenLastCalledWith('New words', true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a refusal from the read instead of an editable field', async () => {
    onRead.mockResolvedValue({ ok: false, reason: 'has-expression', file: '/index.html' });
    await mount();

    expect(field()).toBeNull();
    expect(saveButton()).toBeNull();
    expect(document.body.textContent).toContain('This text comes from the template');
  });

  it('shows a refusal from the write and stays open', async () => {
    onApply.mockResolvedValueOnce({ ok: false, reason: 'stale-index', file: '/index.html' });
    await mount();
    await type('New words');
    await click(saveButton()!);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('The preview is out of date');
  });

  it('hands a refusal the agent can act on to the agent, and closes', async () => {
    onRead.mockResolvedValue({ ok: false, reason: 'has-children', file: '/index.html' });
    await mount();

    await click(buttonSaying('Ask the agent')!);

    expect(onAskAgent).toHaveBeenCalledWith(expect.stringContaining('Select the part'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not offer the agent a refusal it cannot act on', async () => {
    onRead.mockResolvedValue({ ok: false, reason: 'generating' });
    await mount();

    expect(buttonSaying('Ask the agent')).toBeUndefined();
  });
});
