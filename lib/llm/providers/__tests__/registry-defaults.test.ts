import { describe, it, expect } from 'vitest';
import { getDefaultModel, providers } from '@/lib/llm/providers/registry';
import type { BuiltInProviderId } from '@/lib/llm/providers/types';

/**
 * The default model each provider starts on.
 *
 * `getDefaultModel` is a switch whose `default` arm returns no model, so a built-in provider with no
 * case of its own does not fail loudly: it starts with nothing selected. Before that arm returned '',
 * it handed out another vendor's slug: `deepseek` sent api.deepseek.com an OpenRouter-style
 * `minimax/minimax-m2.7` that it rejects.
 *
 * The sweep below is the part that matters. It reads the built-ins from the registry, so a new
 * provider added without a case is caught here rather than by a user whose first task fails.
 */

const BUILT_INS = Object.keys(providers) as BuiltInProviderId[];

/** Providers that intentionally have no default: the user picks from a discovered list. */
const NO_DEFAULT: BuiltInProviderId[] = ['opencode-go', 'meshllm'];

describe('getDefaultModel', () => {
  it('gives deepseek a model its own API accepts', () => {
    // Native naming, no vendor prefix. Real traffic on this provider uses `deepseek-v4-flash`.
    expect(getDefaultModel('deepseek')).toBe('deepseek-v4-flash');
  });

  it('returns no model for an unknown id instead of inventing one', () => {
    // The fallthrough arm itself. A stale id from localStorage should read as "nothing selected".
    expect(getDefaultModel('some-provider-that-was-removed')).toBe('');
  });

  it('returns something for every built-in that should have one', () => {
    for (const provider of BUILT_INS) {
      if (NO_DEFAULT.includes(provider)) continue;
      expect(getDefaultModel(provider), provider).not.toBe('');
    }
  });

  it('names a model in the list of every provider that cannot discover its models', () => {
    // Without discovery the hand-kept list is all the picker has, so a default missing from it is
    // never shown and a connect falls back to another model.
    const checked: string[] = [];
    for (const provider of BUILT_INS) {
      const config = providers[provider];
      const model = getDefaultModel(provider);
      if (config.supportsModelDiscovery || !model || !config.models?.length) continue;
      checked.push(provider);
      expect(config.models.map(m => m.id), provider).toContain(model);
    }
    expect(checked).toContain('minimax');
  });

  it('returns nothing for each built-in named as having no default', () => {
    // The control: an exemption kept after its provider gained a default, or left the registry,
    // would widen the sweep's blind spot unnoticed.
    for (const provider of NO_DEFAULT) {
      expect(BUILT_INS, provider).toContain(provider);
      expect(getDefaultModel(provider), provider).toBe('');
    }
  });
});
