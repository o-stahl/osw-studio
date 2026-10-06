'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { configManager } from '@/lib/config/storage';
import {
  GATE_COMMANDS,
  ASK_DEFAULT_KEYS,
  ALWAYS_ALLOWED_NOTES,
  type GateDecision,
} from '@/lib/llm/permissions';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

function effectiveDecision(
  key: string,
  overrides: Record<string, GateDecision>
): GateDecision {
  return overrides[key] ?? (ASK_DEFAULT_KEYS.has(key) ? 'ask' : 'allow');
}

function facetOf(key: string): string | null {
  const idx = key.indexOf(':');
  return idx === -1 ? null : key.slice(idx + 1);
}

// `permissions.ts` keeps its English labels and reasons; these word them at render.
export const FACET_KEYS = {
  read: 'facets.read',
  write: 'facets.write',
  local: 'facets.local',
  external: 'facets.external',
} as const;

export const GLOSS_KEYS = {
  cat: 'gloss.cat',
  mv: 'gloss.mv',
  cp: 'gloss.cp',
  rm: 'gloss.rm',
  ss: 'gloss.ss',
  ask: 'gloss.ask',
  search: 'gloss.search',
} as const;

export const NOTE_KEYS = {
  status: 'notes.status',
  agent: 'notes.agent',
  cd: 'notes.cd',
  brief: 'notes.brief',
  spec: 'notes.spec',
  'propose-create': 'notes.proposeCreate',
} as const;

function lookup<M extends Record<string, string>>(map: M, id: string): M[keyof M] | undefined {
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id as keyof M] : undefined;
}

interface PermissionMatrixProps {
  onModeChange?: () => void;
}

export function PermissionMatrix({ onModeChange }: PermissionMatrixProps) {
  const tc = useTranslations('common');
  const t = useTranslations('permissions');

  const commandLabel = (cmd: (typeof GATE_COMMANDS)[number]) => {
    const gloss = lookup(GLOSS_KEYS, cmd.command);
    return gloss ? `${cmd.label.replace(/ \(.*\)$/, '')} (${t(gloss)})` : cmd.label;
  };
  const facetLabel = (key: string) => {
    const facet = facetOf(key);
    if (!facet) return null;
    const known = lookup(FACET_KEYS, facet);
    return known ? t(known) : facet;
  };
  const noteReason = (note: (typeof ALWAYS_ALLOWED_NOTES)[number]) => {
    const known = lookup(NOTE_KEYS, note.command);
    return known ? t(known) : note.reason;
  };
  const [overrides, setOverrides] = useState<Record<string, GateDecision>>(() =>
    configManager.getPermissionOverrides()
  );

  const setDecision = (key: string, decision: GateDecision) => {
    configManager.setPermissionMode('custom');
    configManager.setPermissionOverride(key, decision);
    setOverrides(configManager.getPermissionOverrides());
    onModeChange?.();
  };

  const resetToAskDefaults = () => {
    configManager.setPermissionOverrides({});
    configManager.setPermissionMode('ask');
    setOverrides(configManager.getPermissionOverrides());
    onModeChange?.();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/50 p-3 text-xs space-y-1">
        <p className="font-medium text-foreground">{t('configuresCustom')}</p>
        <p className="text-muted-foreground">
          {t('customExplain')}
        </p>
      </div>

      <div className="space-y-2">
        {GATE_COMMANDS.map((cmd) => (
          <div
            key={cmd.command}
            className="flex items-center justify-between gap-3 py-1.5 border-b border-border/50 last:border-b-0"
          >
            <span className="font-mono text-xs text-foreground truncate">
              {commandLabel(cmd)}
            </span>
            <div className="flex items-center gap-3 shrink-0">
              {cmd.keys.map((key) => {
                const facet = facetLabel(key);
                return (
                  <div key={key} className="flex items-center gap-1.5">
                    {facet && (
                      <span className="text-[10px] text-muted-foreground min-w-12 text-right">
                        {facet}
                      </span>
                    )}
                    <ToggleGroup
                      type="single"
                      value={effectiveDecision(key, overrides)}
                      onValueChange={(value: string) => {
                        if (value === 'ask' || value === 'allow') {
                          setDecision(key, value);
                        }
                      }}
                    >
                      <ToggleGroupItem value="ask" size="sm" className="text-xs px-2">
                        {t('ask')}
                      </ToggleGroupItem>
                      <ToggleGroupItem value="allow" size="sm" className="text-xs px-2">
                        {tc('actions.allow')}
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-1.5 pt-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('alwaysAllowed')}
        </p>
        {ALWAYS_ALLOWED_NOTES.map((note) => (
          <p key={note.command} className="text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{note.command}</span>: {noteReason(note)}
          </p>
        ))}
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={resetToAskDefaults}>
          {t('resetToAsk')}
        </Button>
      </div>
    </div>
  );
}
