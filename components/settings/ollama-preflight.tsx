'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import { apiFetch } from '@/lib/api/backend-status';
import { track } from '@/lib/telemetry';
import type { PreflightResult } from '@/lib/llm/ollama-preflight';

/**
 * The Ollama model a task would run: the agent model when Ollama is the active provider,
 * else the model last picked for Ollama. Another provider's model must not be checked
 * against Ollama, or the fix would be to pull a model that does not exist there.
 */
function ollamaModelToCheck(): string {
  const agent = configManager.getActiveAssignment().agent;
  if (agent.provider === 'ollama' && agent.model) return agent.model;
  return configManager.getProviderModel('ollama') ?? '';
}

/**
 * "Check setup" for Ollama: runs the same reachability, model, tool-support and context
 * checks a task depends on, and shows the command that fixes each failed one.
 */
export function OllamaPreflight() {
  const t = useTranslations('settings');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreflightResult | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const res = await apiFetch('/api/ollama/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModelToCheck(), contextLength: configManager.getLocalContextLength('ollama') }),
      });
      const data: PreflightResult = await res.json();
      setResult(data);
      const failed = data.checks.filter((c) => !c.ok).map((c) => c.id);
      track('preflight_result', { provider: 'ollama', ok: failed.length === 0, failed });
    } catch {
      toast.error(t('checkFailed'));
    } finally {
      setRunning(false);
    }
  };

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <div className="mt-2 space-y-2" data-testid="ollama-preflight">
      <Button size="sm" variant="outline" onClick={run} disabled={running} className="h-7 text-xs">
        {running ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
        {t('checkSetup')}
      </Button>
      {result && (
        <ul className="space-y-1.5 text-xs">
          {result.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2" data-testid={`preflight-${check.id}`} data-ok={check.ok}>
              {check.ok
                ? <Check className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
                : <X className="h-3.5 w-3.5 mt-0.5 shrink-0 text-destructive" />}
              <div className="min-w-0 flex-1">
                <span className={check.ok ? '' : 'text-foreground'}>{check.detail}</span>
                {check.fix && (
                  <div className="mt-1 flex items-center gap-1">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{check.fix}</code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5"
                      onClick={() => copy(check.fix ?? '')}
                      aria-label={t('copyValue', { value: check.fix ?? '' })}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
