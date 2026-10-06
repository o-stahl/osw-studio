import { configManager } from '@/lib/config/storage';
import type { ProviderId } from './types';

/**
 * A model's name as its provider lists it ("Qwen: Qwen3.8 27B (free)"), from the cached model list,
 * else its id without the vendor prefix. Provider-supplied, so it is not translated.
 */
export function modelLabel(provider: ProviderId, id: string): string {
  const cached = configManager.getCachedModels(provider)?.models as Array<{ id: string; name?: string }> | undefined;
  const name = cached?.find((m) => m.id === id)?.name;
  if (name) return name.replace(/^[^:]+:\s*/, '');
  return id.split('/').pop() ?? id;
}
