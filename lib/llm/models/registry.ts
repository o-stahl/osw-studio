import type { ModelTemplate } from './assignment';

/**
 * Built-in model templates, defined in code and merged with the user's stored
 * templates at read time (see configManager.getModelTemplates). They are never
 * persisted, so editing this file updates every user's presets on next load —
 * the same pattern as built-in skills and project templates.
 *
 * Built-ins are read-only: configManager refuses to save or delete them, and the
 * UI offers "Save as" to clone one into an editable template. Keep the model ids
 * current — these are curated recommendations, not a stable contract.
 */

const RECOMMENDED_DESCRIPTION =
  'A recommended starting point, updated over time as better models appear. Save as a copy to customize.';

export const BUILT_IN_MODEL_TEMPLATES: ModelTemplate[] = [
  {
    id: 'or-recommended',
    name: 'OpenRouter · Recommended', // i18n-ignore: shown through useModelTemplateCopy
    builtin: true,
    description: RECOMMENDED_DESCRIPTION,
    assignment: {
      agent: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
      imageGen: { provider: 'openrouter', model: 'google/gemini-3.1-flash-image' },
      voiceInput: 'browser',
      autoCompact: true,
      compactLimit: null,
    },
  },
  {
    id: 'hf-recommended',
    name: 'HuggingFace · Recommended', // i18n-ignore: shown through useModelTemplateCopy
    builtin: true,
    description: RECOMMENDED_DESCRIPTION,
    assignment: {
      agent: { provider: 'huggingface', model: 'deepseek-ai/DeepSeek-V4-Flash' },
      imageGen: null,
      voiceInput: 'browser',
      autoCompact: true,
      compactLimit: null,
    },
  },
];

/** True if `id` belongs to a built-in (read-only, code-defined) template. */
export function isBuiltInTemplateId(id: string): boolean {
  return BUILT_IN_MODEL_TEMPLATES.some((t) => t.id === id);
}
