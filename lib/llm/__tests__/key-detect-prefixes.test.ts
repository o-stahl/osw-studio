import { describe, it, expect } from 'vitest';
import { detectKeyProvider } from '../providers/key-detect';

describe('detectKeyProvider, the rarer prefixes', () => {
  it.each([
    ['pk_abc', 'pollinations'],
    ['sk-svcacct-abc', 'openai'],
    ['sk-admin-abc', 'openai'],
  ])('knows %s is %s for certain', (key, provider) => {
    expect(detectKeyProvider(key).candidates).toEqual([provider]);
  });
});
