/**
 * Benchmark and usage figures for models, keyed so the same model matches across providers.
 *
 * Built from OpenRouter's Data API: Artificial Analysis composite indices (`/benchmarks`) and the
 * share of coding and agent traffic each model carries (`/classifications/task`). A copy is bundled
 * so suggestions work with no key and no network; a user with OpenRouter connected refreshes it from
 * the live API once a day (`/api/model-scores`). The figures are a guide to ordering, never shown as
 * a promise: they come from other people's tasks, not from building sites here.
 */

export interface ModelScore {
  /** Artificial Analysis Agentic Index. */
  agentic?: number;
  /** Artificial Analysis Coding Index. */
  coding?: number;
  /** Share of OpenRouter's coding and agent traffic over the trailing week, 0–1. */
  usage?: number;
}

export interface ScoreSnapshot {
  /** The date the figures describe, `YYYY-MM-DD`, for the attribution line. */
  asOf: string;
  models: Record<string, ModelScore>;
}

/**
 * One key per model however a provider spells it: `qwen/qwen3.8-27b:free` (OpenRouter),
 * `Qwen/Qwen3.8-27B` (HuggingFace), `alibaba/qwen3.8-27b` (Vercel) and the benchmark's
 * `qwen/qwen3.8-27b-20260814` all become `qwen3.8-27b`. The vendor prefix is dropped because
 * providers disagree about it; variant and date suffixes are dropped because the benchmark dates
 * its runs and providers do not. A model this cannot match simply has no score.
 */
export function modelKey(id: string): string {
  let key = id.toLowerCase().split('/').pop() ?? id.toLowerCase();
  key = key.split(':')[0];
  key = key.replace(/-free$/, '');
  key = key.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/, '');
  return key;
}

interface BenchmarkRow {
  model_permaslug?: string;
  agentic_index?: number | null;
  coding_index?: number | null;
}

interface Classification {
  tag?: string;
  usage_share?: number;
  models?: Array<{ id?: string; tag_usage_share?: number }>;
}

/** Tags whose traffic looks like what the agent does here: writing code and using tools. */
const RELEVANT_TAG = /^(code|agent):/;

const dateOf = (slug: string) => slug.match(/-(\d{8})$/)?.[1] ?? '';

/** Build a snapshot from the two Data API responses. Pure, so the route and the bundle agree. */
export function buildSnapshot(benchmarks: unknown, tasks: unknown, asOf: string): ScoreSnapshot {
  const models: Record<string, ModelScore & { _date?: string }> = {};

  const rows = ((benchmarks as { data?: BenchmarkRow[] })?.data ?? []);
  for (const row of rows) {
    if (!row.model_permaslug) continue;
    const agentic = typeof row.agentic_index === 'number' ? row.agentic_index : undefined;
    const coding = typeof row.coding_index === 'number' ? row.coding_index : undefined;
    if (agentic === undefined && coding === undefined) continue;
    const key = modelKey(row.model_permaslug);
    const date = dateOf(row.model_permaslug);
    const existing = models[key];
    // Several runs of one family: keep the newest, which is what a provider serves under the bare name.
    if (existing && (existing._date ?? '') >= date) continue;
    models[key] = { ...existing, agentic, coding, _date: date };
  }

  const classifications = ((tasks as { data?: { classifications?: Classification[] } })?.data?.classifications ?? []);
  for (const c of classifications) {
    if (!c.tag || !RELEVANT_TAG.test(c.tag) || typeof c.usage_share !== 'number') continue;
    for (const m of c.models ?? []) {
      if (!m.id || typeof m.tag_usage_share !== 'number') continue;
      const key = modelKey(m.id);
      const entry = models[key] ?? (models[key] = {});
      entry.usage = (entry.usage ?? 0) + c.usage_share * m.tag_usage_share;
    }
  }

  const out: Record<string, ModelScore> = {};
  for (const [key, { _date, ...score }] of Object.entries(models)) {
    void _date;
    if (score.usage !== undefined) score.usage = Math.round(score.usage * 10000) / 10000;
    out[key] = score;
  }
  return { asOf, models: out };
}
