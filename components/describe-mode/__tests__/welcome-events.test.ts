import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/vfs', () => ({ vfs: {} }));

import { withLocalWelcome } from '../index';
import { WELCOME_TEXT } from '../welcome';
import type { DebugEvent } from '@/lib/stores/types';

/**
 * The Describe chat shows its opening message in the interface language while the transcript the
 * agent reads keeps the English.
 */
const ev = (id: string, data: unknown): DebugEvent => ({ id, timestamp: 1, event: 'assistant_delta', data, count: 1, version: 1 });

describe('withLocalWelcome', () => {
  it('words the welcome in the given language', () => {
    const [shown] = withLocalWelcome([ev('describe-welcome', { text: WELCOME_TEXT })], 'Mitä olet tekemässä?');
    expect(shown.data).toEqual({ text: 'Mitä olet tekemässä?' });
  });

  it('swaps only the first chunk once later deltas have joined the welcome', () => {
    const joined = ev('describe-welcome', { all: [{ text: WELCOME_TEXT }, { text: 'more' }, { text: 'and more' }] });
    const [shown] = withLocalWelcome([joined], 'Hei');
    expect(shown.data).toEqual({ all: [{ text: 'Hei' }, { text: 'more' }, { text: 'and more' }] });
  });

  it('leaves every other event, and the stored events, as they were', () => {
    const welcome = ev('describe-welcome', { text: WELCOME_TEXT });
    const reply = ev('r1', { text: 'A bakery site, then.' });
    const shown = withLocalWelcome([welcome, reply], 'Hei');
    expect(shown[1]).toBe(reply);
    expect(shown[0]).not.toBe(welcome);
    expect(shown[0].id).toBe('describe-welcome');
    expect(welcome.data).toEqual({ text: WELCOME_TEXT });
  });
});
