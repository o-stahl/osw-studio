'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { BuiltInProviderId } from '@/lib/llm/providers/types';

/**
 * Translated one-line descriptions for providers.
 *
 * The registry is a module-level constant and keeps its English description as the fallback. The
 * map is typed over `BuiltInProviderId`, so adding a provider without a translated description is a
 * type error rather than an English line in the Choose-a-provider list.
 *
 * A custom provider's description is generated from its URL, never typed by anyone, and is not
 * stored: `fromConnectionRecord` rebuilds it on every load. So it is rebuilt here, translated.
 *
 * Model descriptions in the same registry are left English on purpose: they mirror the vendor's own
 * catalogue blurbs, as the live model lists do.
 */
export function useProviderDescriptions(): (provider: { id: string; description: string; baseUrl?: string }) => string {
  const t = useTranslations('providerCatalog.descriptions');
  const tc = useTranslations('providerCatalog');

  return useMemo(() => {
    const descriptions: Record<BuiltInProviderId, string> = {
      openrouter: t('openrouter'),
      openai: t('openai'),
      'openai-codex': t('openai-codex'),
      anthropic: t('anthropic'),
      groq: t('groq'),
      gemini: t('gemini'),
      huggingface: t('huggingface'),
      ollama: t('ollama'),
      lmstudio: t('lmstudio'),
      llamacpp: t('llamacpp'),
      meshllm: t('meshllm'),
      sambanova: t('sambanova'),
      deepseek: t('deepseek'),
      minimax: t('minimax'),
      zhipu: t('zhipu'),
      'opencode-go': t('opencode-go'),
      pollinations: t('pollinations'),
      vercel: t('vercel'),
    };
    return (provider: { id: string; description: string; baseUrl?: string }) => {
      const builtIn = (descriptions as Record<string, string>)[provider.id];
      if (builtIn) return builtIn;
      return provider.baseUrl ? tc('custom', { url: provider.baseUrl }) : provider.description;
    };
  }, [t, tc]);
}
