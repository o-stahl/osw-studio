import type { ProviderModel } from '@/lib/llm/providers/types';

/**
 * "Free models": a selection in the model list that is not one model but the best free model
 * available at the moment.
 *
 * It is the only selection the app moves on its own. A model the user picked stays picked: when it
 * is busy or out of allowance the task stops and the chat suggests alternatives, but switching is
 * the user's call. With this entry the user has chosen rotation, so each request goes to the top
 * suggested free model, and one that is busy is passed over for the next.
 *
 * Offered on OpenRouter, which has enough free models with tool calling to rotate through.
 */
export const FREE_MODELS_ID = 'osw/free-models';

export const FREE_MODELS_PROVIDERS: ReadonlySet<string> = new Set(['openrouter']);

/**
 * What a request goes to when no suggestion could be worked out (a server-side run, or the
 * catalogue failed to load): OpenRouter's own router, which picks a free model at random.
 */
export const FREE_MODELS_FALLBACK = 'openrouter/free';

export function isFreeModels(model: string | undefined | null): boolean {
  return model === FREE_MODELS_ID;
}

/**
 * The list entry. Its English name is a fallback only: lists and the chat footer name it in the
 * current language, by id.
 */
export function freeModelsEntry(): ProviderModel {
  return {
    id: FREE_MODELS_ID,
    name: 'Free models', // i18n-ignore: rendered through models.freeModels by id
    contextLength: 128_000,
    supportsFunctions: true,
    free: true,
    pricing: { input: 0, output: 0 },
  };
}
