'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { configManager } from '@/lib/config/storage';
import { DEFAULT_LOCAL_CONTEXT_LENGTH, LOCAL_CONTEXT_APPLIED } from '@/lib/llm/local-context';
import type { ProviderId } from '@/lib/llm/providers/types';

/** Each local server's own way of setting its window, worded under `settings.localContext`. */
const HELP_KEY: Partial<Record<ProviderId, 'ollama' | 'lmstudio' | 'llamacpp' | 'meshllm'>> = {
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  llamacpp: 'llamacpp',
  meshllm: 'meshllm',
};

interface LocalContextLengthProps {
  providerId: ProviderId;
}

/**
 * The context length a local provider is loaded with. Applied at load for servers that
 * take it per request (Ollama); for the others it has to match how the server was
 * started, and either way it bounds compaction so the conversation never outgrows the
 * window. Empty means the default.
 */
export function LocalContextLength({ providerId }: LocalContextLengthProps) {
  const t = useTranslations('settings.localContext');
  const [value, setValue] = useState(() => {
    const stored = configManager.getLocalContextLength(providerId);
    return stored ? String(stored) : '';
  });

  const commit = (raw: string) => {
    const digits = raw.replace(/[^\d]/g, '');
    setValue(digits);
    const parsed = parseInt(digits, 10);
    configManager.setLocalContextLength(providerId, Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
  };

  const applied = LOCAL_CONTEXT_APPLIED[providerId] === true;

  return (
    <div data-testid="local-context-length">
      <Label htmlFor={`context-length-${providerId}`}>
        {t('label')}
        <span className="text-muted-foreground text-xs ml-1">{t('unit')}</span>
      </Label>
      <Input
        id={`context-length-${providerId}`}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => commit(e.target.value)}
        placeholder={String(DEFAULT_LOCAL_CONTEXT_LENGTH)}
        className="mt-2 font-mono w-full sm:w-[180px]"
      />
      <p className="text-xs text-muted-foreground mt-2">
        {HELP_KEY[providerId] ? t(HELP_KEY[providerId]) : t('default')}
        {applied ? '' : ` ${t('compacts')}`}
      </p>
    </div>
  );
}
