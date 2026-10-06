import { configManager } from '@/lib/config/storage';
import { getDefaultModel } from '@/lib/llm/providers/registry';
import type { ProviderId } from '@/lib/llm/providers/types';
import { isProviderConnected, getConnectedProviders } from '@/lib/llm/providers/connection-status';
import { BUILT_IN_MODEL_TEMPLATES } from './registry';
import { loadProviderModels } from './model-catalog';
import { pickModelForProvider, shouldAutoAssignAgent } from './project-assignment';
import { fetchProviderStatus } from '@/lib/llm/provider-status';
import { FREE_MODELS_ID, FREE_MODELS_PROVIDERS, isFreeModels } from '@/lib/llm/suggestions/free-models';

/**
 * Make `provider` the GLOBAL active model. This is the onboarding auto-assign path:
 * when a user connects a provider and no working model is selected yet, point the
 * single global active template at that provider so every project inherits it.
 *
 * Prefer the provider's built-in Recommended template (synchronous, no model load);
 * otherwise rewrite the editable `default` template's agent to a sensible model for
 * that provider and activate it. Both configManager writes dispatch modelConfigChanged,
 * which drives workspace reactivity.
 */
export async function activateProviderAsGlobalDefault(provider: ProviderId): Promise<void> {
  const recommended = BUILT_IN_MODEL_TEMPLATES.find((t) => t.assignment.agent.provider === provider);
  if (recommended) {
    configManager.setDefaultTemplateId(recommended.id);
    return;
  }

  const models = await loadProviderModels(provider);
  // Re-check after the async load: config may have changed (another connect) meanwhile.
  if (!shouldAutoAssignAgent()) return;

  const model = pickModelForProvider(getDefaultModel(provider), models.map((m) => m.id));
  if (!model) return; // do not assign an empty model (e.g. custom provider with no models)

  // Accepted narrow edge: the readiness guard keys on provider credentials, not on whether the
  // user deliberately customized default's agent. A user who set default's agent to a specific
  // model of a provider they had NOT yet keyed, then connects that provider, will have that
  // specific model replaced by pickModelForProvider's choice here. The outcome is still a working
  // model, so this is accepted rather than special-cased.

  const base = configManager.getModelTemplate('default');
  if (!base) return; // default exists post-migration; bail rather than fabricate one

  configManager.saveModelTemplate({
    ...base,
    id: 'default',
    builtin: false,
    assignment: { ...base.assignment, agent: { provider, model } },
  });
  configManager.setDefaultTemplateId('default');
}

/**
 * Load-time counterpart to the connect-time auto-assign. The connect-time path only fires on the
 * `apiKeyUpdated` event, so a user who is ALREADY connected when the app loads is never reconciled.
 * That leaves a real gap: the pre-global migration seeds the Default template's agent from
 * `getSelectedProvider()` (a keyless default when the user's real provider was stored per-project),
 * so `isProjectProviderReady()` is false even though a provider is genuinely connected. The onboarding
 * UI then keys off that — showing the HF "Sign in" button and disabling the composer — until the user
 * deletes and re-adds the connection (which fires `apiKeyUpdated`). See issue #17.
 *
 * When the active agent provider is unready but a provider IS connected, point the global default at a
 * connected provider (preferring the globally selected one). No-op when the active agent is already
 * ready, or when nothing is connected (a genuine new user, whose onboarding UI must stay as-is).
 */
export async function reconcileActiveProviderIfConnected(): Promise<void> {
  if (!shouldAutoAssignAgent()) return; // active agent already ready — don't clobber the user's choice
  const selected = configManager.getSelectedProvider();
  const target = isProviderConnected(selected) ? selected : getConnectedProviders()[0];
  if (!target) return; // genuine new user: leave onboarding as-is
  await activateProviderAsGlobalDefault(target);
}

/**
 * After `provider` is connected, make sure the working model is one the account can use. An
 * OpenRouter account that has never bought credit only gets answers from free models, while the
 * Recommended template and the seeded default point at a paid one: its first request would fail.
 * Such an account is given "Free models". OpenRouter publishes no balance for an ordinary key, so
 * an account that has bought credit before keeps its model; if the credit has since run out, the
 * stopped task suggests "Free models" then.
 */
export async function fitModelToAccount(provider: ProviderId): Promise<void> {
  const active = configManager.getActiveAssignment();
  if (active.agent.provider !== provider || !FREE_MODELS_PROVIDERS.has(provider)) return;
  if (isFreeModels(active.agent.model)) return;
  const key = configManager.getProviderApiKey(provider);
  if (!key) return;
  if ((await fetchProviderStatus(provider, key)).freeOnly !== true) return;

  const { isFreeModel } = await import('@/lib/llm/suggestions/rank');
  const current = (await loadProviderModels(provider)).find((m) => m.id === active.agent.model);
  // A free model the user picked can stay; it is one the account can use.
  if (current ? isFreeModel(current) : active.agent.model.endsWith(':free')) return;
  // Re-read: another connect may have moved the selection while the list loaded.
  const now = configManager.getActiveAssignment();
  if (now.agent.provider !== provider || now.agent.model !== active.agent.model) return;
  configManager.setActiveAssignment({ ...now, agent: { provider, model: FREE_MODELS_ID } });
}

let settling: Promise<void> = Promise.resolve();

/** Record the connect handling in flight, so work that needs its outcome can wait for it. */
export function trackConnectSettling(work: Promise<void>): void {
  settling = Promise.all([settling, work.catch(() => {})]).then(() => {});
}

/**
 * Resolves once every connect's model assignment in flight has finished. A message held until a model
 * was connected waits for this, or it would go out on a model the account cannot use.
 */
export function connectSettled(): Promise<void> {
  return settling;
}
