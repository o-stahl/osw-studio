import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import {
  textConfirmationMessage,
  textIsChanged,
  textRefusal,
  textRefusalMessage,
  textRefusalOffersAgent,
  textRefusalTitle,
  type TextRefusalReason,
} from '../state';

// The English catalogue, so these read as the sentences a user sees.
const t = createTranslator({ locale: 'en', messages: en, namespace: 'textPopover' });

const REASONS: TextRefusalReason[] = [
  'unresolvable', 'generating', 'stale-index', 'missing-file',
  'has-children', 'has-expression', 'unclosed', 'void-element',
];

describe('textRefusal', () => {
  it('is nothing for a success and nothing for the confirmation', () => {
    expect(textRefusal({ ok: true })).toBeNull();
    // Held, not refused. The dialog renders the two differently, and collapsing them would put a
    // red banner in front of a question the user can answer yes to.
    expect(textRefusal({ ok: false, reason: 'needs-confirmation', instances: 3 })).toBeNull();
  });

  it('carries the file the refusal concerns', () => {
    expect(textRefusal({ ok: false, reason: 'has-children', file: '/index.html' }))
      .toEqual({ reason: 'has-children', file: '/index.html' });
  });

  it('lands a reason this surface has no sentence for on unresolvable', () => {
    // `ApplyResult['reason']` is shared with the style and image paths, so it carries refusals this
    // dialog can never produce. Widening `TextRefusal` to reasons with no message written for them
    // would put an empty banner on the screen.
    expect(textRefusal({ ok: false, reason: 'ambiguous-stylesheet' })?.reason).toBe('unresolvable');
    expect(textRefusal({ ok: false, reason: 'no-src' })?.reason).toBe('unresolvable');
  });
});

describe('what the popover says', () => {
  it('gives every reason a headline and a sentence, and they are all different', () => {
    const titles = REASONS.map(reason => textRefusalTitle({ reason }, t));
    const messages = REASONS.map(reason => textRefusalMessage({ reason }, t));
    expect(new Set(titles).size).toBe(REASONS.length);
    expect(new Set(messages).size).toBe(REASONS.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(20);
  });

  it('tells the user the way out of mixed content, which is selecting the inner part', () => {
    // Without this the refusal reads as "this element cannot be edited", and the user stops. The
    // child *is* editable — they just have to select it.
    expect(textRefusalMessage({ reason: 'has-children' }, t)).toContain('Select the part');
  });

  it('names the file in the refusals that have one', () => {
    expect(textRefusalMessage({ reason: 'stale-index', file: '/about.html' }, t)).toContain('/about.html');
    expect(textRefusalMessage({ reason: 'missing-file', file: '/gone.html' }, t)).toContain('/gone.html');
    expect(textRefusalMessage({ reason: 'unclosed', file: '/broken.html' }, t)).toContain('/broken.html');
  });

  it('offers the agent only where the agent could do something', () => {
    // A wait and a refresh are not the agent's problem, and an element that holds no text is not a
    // request anyone can act on.
    expect(REASONS.filter(reason => textRefusalOffersAgent({ reason })))
      .toEqual(['unresolvable', 'missing-file', 'has-children', 'has-expression', 'unclosed']);
  });
});

describe('textConfirmationMessage', () => {
  it('says the number when there is one', () => {
    expect(textConfirmationMessage(3, t, '/index.html'))
      .toBe('This text from /index.html is rendered 3 times. Changing it changes all 3.');
  });

  it('says it is shared when the count is not known', () => {
    expect(textConfirmationMessage(0, t)).toBe('This text is shared. Changing it changes every place it renders.');
  });
});

describe('textIsChanged', () => {
  it('is false for the text as it was read, whitespace and all', () => {
    expect(textIsChanged('Hello', 'Hello')).toBe(false);
    // Not trimmed on either side: a trailing space the user added is a change to the source, and
    // treating it as no change would leave Save inert on an edit they can see in the field.
    expect(textIsChanged('Hello', 'Hello ')).toBe(true);
    expect(textIsChanged('Hello', 'Hi')).toBe(true);
  });
});

describe('textConfirmationMessage, once', () => {
  it('calls text rendered once shared, and names its file', () => {
    expect(textConfirmationMessage(1, t, '/index.html')).toBe(t('confirmSharedFrom', { file: '/index.html' }));
    expect(textConfirmationMessage(1, t)).toBe(t('confirmShared'));
  });
});
