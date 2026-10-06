import type { ProviderId, ProviderModel } from '@/lib/llm/providers/types';
import { modelKey, type ModelScore, type ScoreSnapshot } from './snapshot';
import type { ObservedModel } from './observed';
import { FREE_MODELS_ID } from './free-models';

/**
 * The order OSWS suggests models in.
 *
 * Filtered to what can do the work at all: models that take tools, fit the conversation, are not
 * reported down, and on the free path cost nothing. Then ordered: models that keep failing here go
 * last, then by Artificial Analysis Agentic Index, Coding Index, and share of coding traffic. A
 * model with no figures sorts after the ones with figures; it is not excluded, because new free
 * models often arrive before any benchmark has run them.
 */

interface Candidate {
  provider: ProviderId;
  model: ProviderModel;
}

export interface RankedModel extends Candidate {
  score?: ModelScore;
  /** Passed over for now: it was busy or missing within the cooldown. */
  coolingDown: boolean;
}

interface RankOptions {
  scores: ScoreSnapshot;
  /** Only free models. Set on the free path so a switch never starts spending money. */
  freeOnly?: boolean;
  /** Tokens the conversation needs; models known to hold fewer are left out. */
  minContext?: number;
  observed?: (provider: string, model: string) => ObservedModel | undefined;
  coolingDown?: (provider: string, model: string) => boolean;
}

export function isFreeModel(model: ProviderModel): boolean {
  if (model.free === true) return true;
  if (model.id.endsWith(':free')) return true;
  return !!model.pricing && model.pricing.input === 0 && model.pricing.output === 0;
}

/** Fails more than it works, on enough tries to mean it. */
function struggling(observed?: ObservedModel): boolean {
  return !!observed && observed.fail >= 2 && observed.fail > observed.ok;
}

export function rankModels(candidates: Candidate[], options: RankOptions): RankedModel[] {
  const usable = candidates.filter(({ model }) => {
    // The rotating entry is what suggestions feed, never a suggestion itself.
    if (model.id === FREE_MODELS_ID) return false;
    if (model.supportsFunctions === false) return false;
    if (model.health === 'down') return false;
    if ((model.outputModalities ?? ['text']).includes('text') === false) return false;
    if (options.freeOnly && !isFreeModel(model)) return false;
    if (options.minContext && model.contextLength && model.contextLength < options.minContext) return false;
    return true;
  });

  const ranked: RankedModel[] = usable.map((candidate) => ({
    ...candidate,
    score: options.scores.models[modelKey(candidate.model.id)],
    coolingDown: options.coolingDown?.(candidate.provider, candidate.model.id) ?? false,
  }));
  // What this browser has seen of each model, looked up once rather than in every comparison.
  const seen = new Map(ranked.map((r) => [r, options.observed?.(r.provider, r.model.id)]));

  const metric = (v: number | undefined) => (v === undefined ? -1 : v);
  return ranked.sort((a, b) =>
    Number(a.coolingDown) - Number(b.coolingDown)
    || Number(struggling(seen.get(a))) - Number(struggling(seen.get(b)))
    || metric(b.score?.agentic) - metric(a.score?.agentic)
    || metric(b.score?.coding) - metric(a.score?.coding)
    || metric(b.score?.usage) - metric(a.score?.usage)
    || (seen.get(b)?.ok ?? 0) - (seen.get(a)?.ok ?? 0)
    || a.model.id.localeCompare(b.model.id));
}

/**
 * The model to carry on with after `current` failed: the best-ranked one that is not `current` and
 * is not cooling down. Undefined when there is nothing better to offer than waiting.
 */
export function nextSuggestion(ranked: RankedModel[], current: { provider: string; model: string }): RankedModel | undefined {
  return ranked.find((r) => !r.coolingDown && !(r.provider === current.provider && r.model.id === current.model));
}
