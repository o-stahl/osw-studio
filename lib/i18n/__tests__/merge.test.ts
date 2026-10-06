import { describe, it, expect } from 'vitest';

import { deepMerge } from '../merge';

describe('deepMerge', () => {
  it('lets the active locale win and fills the rest from English', () => {
    const en = { a: 'en-a', nested: { keep: 'en-keep', over: 'en-over' } };
    const ko = { nested: { over: 'ko-over' } };

    expect(deepMerge(en, ko)).toEqual({
      a: 'en-a',
      nested: { keep: 'en-keep', over: 'ko-over' },
    });
  });

  it('replaces arrays and scalars instead of merging them', () => {
    expect(deepMerge({ list: ['a', 'b'] }, { list: ['c'] })).toEqual({ list: ['c'] });
    expect(deepMerge({ v: { deep: 1 } }, { v: 'flat' })).toEqual({ v: 'flat' });
    expect(deepMerge({ v: 'flat' }, { v: { deep: 1 } })).toEqual({ v: { deep: 1 } });
  });

  it('does not mutate either input', () => {
    const en = { nested: { a: 'en' } };
    const ko = { nested: { a: 'ko' } };
    deepMerge(en, ko);

    expect(en.nested.a).toBe('en');
    expect(ko.nested.a).toBe('ko');
  });
});
