// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import { approvalPhrase } from '../approval-phrase';
import { useApprovalSentence } from '@/lib/i18n/use-approval-sentence';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

const t = createTranslator({ locale: 'en', messages: en, namespace: 'quickEdit.wants' });

/** The sentence the approval card shows for a gate, rendered through the hook with English messages. */
function sentence(gateKey: string, capabilityLabel: string): string {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let out = '';
  function Probe() {
    out = useApprovalSentence()(gateKey, capabilityLabel);
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(withMessages(React.createElement(Probe))));
  act(() => root.unmount());
  return out;
}

describe('approvalPhrase', () => {
  it('says what a known gate does, in plain words', () => {
    expect(t(approvalPhrase('rm')!)).toBe('It wants to delete a file.');
    expect(t(approvalPhrase('curl:external')!)).toBe('It wants to fetch something from the internet.');
  });

  it('leaves an unknown gate to its own label', () => {
    expect(approvalPhrase('something-new')).toBeUndefined();
    expect(sentence('something-new', 'something-new (label)')).toBe('It wants to something-new (label).');
    expect(sentence('rm', 'rm / rmdir (delete)')).toBe('It wants to delete a file.');
  });
});
