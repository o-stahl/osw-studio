'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { Project } from '@/lib/vfs/types';
import type { DebugEvent } from '@/lib/stores/types';
import type { GenerationTask } from '@/lib/stores/types';
import { ChevronDown } from 'lucide-react';
import { parseToolArgs, type ActionKind } from '@/lib/agent-activity/parse-command';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

interface GenerationShelfProps {
  selectedProject: Project | null;
  onNavigateToProject: (project: { id: string; name: string }) => void;
}

interface ActivityItem {
  kind: ActionKind;
  target: string;
  status: 'executing' | 'completed' | 'failed';
}

export function parseBashAction(argsJson: string): { kind: ActionKind; target: string } | null {
  const action = parseToolArgs(argsJson);
  if (!action) return null;
  return { kind: action.kind, target: action.detail ?? '' };
}

export function deriveActivity(events: DebugEvent[], since: number | null): { items: ActivityItem[]; total: number } {
  const all: ActivityItem[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (since && e.timestamp < since) break;
    if (e.event !== 'tool_status') continue;
    const { status, args } = e.data || {};
    if (status !== 'executing' && status !== 'completed' && status !== 'failed') continue;
    const action = parseBashAction(args || '{}');
    if (!action) continue;
    all.unshift({ kind: action.kind, target: action.target, status });
  }
  return { items: all.slice(-5), total: all.length };
}

export function deriveUsage(events: DebugEvent[]): { tokens: number; cost: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'usage') {
      const d = events[i].data;
      const tokens = d?.totalUsage?.totalTokens ?? 0;
      const cost = d?.totalCost ?? 0;
      if (tokens > 0) return { tokens, cost };
    }
  }
  return null;
}

function formatElapsed(startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface GenerationShelfEntryProps {
  task: GenerationTask;
  expanded: boolean;
  onToggleExpand: () => void;
  onNavigateToProject: (project: { id: string; name: string }) => void;
}

function GenerationShelfEntry({ task, expanded, onToggleExpand, onNavigateToProject }: GenerationShelfEntryProps) {
  const t = useTranslations('generationShelf');
  const tc = useTranslations('common');
  const tChat = useTranslations('chat');
  const { number } = useLocalFormat();
  const formatCost = (cost: number) =>
    number(cost, { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const verb = (item: ActivityItem) =>
    t(`verbs.${item.kind}.${item.status === 'executing' ? 'running' : 'done'}`);
  const isActive = task.result === null;
  const hasResult = task.result !== null;

  // Imperative read — backgroundEvents aren't in the reactive store, so the
  // 1-second polling interval above triggers re-renders that re-read this.
  const genEvents = useWorkspaceStore.getState().getGenerationEvents(task.projectId);
  const { items: activity, total: totalActions } = deriveActivity(genEvents, task.startedAt);
  const usage = deriveUsage(genEvents);

  const latestAction = activity.length > 0 ? activity[activity.length - 1] : null;

  const dotColor = task.result === 'completed' ? 'bg-green-500' :
    task.result === 'failed' ? 'bg-destructive' :
    task.result === 'unavailable' ? 'bg-muted-foreground' :
    task.paused ? 'bg-yellow-500' : 'bg-orange-400';

  const verbColor = task.result === 'completed' ? 'text-green-500' :
    task.result === 'failed' ? 'text-destructive' :
    task.result === 'unavailable' ? 'text-muted-foreground' :
    task.paused ? 'text-yellow-500' : 'text-orange-400';

  // An unnamed project's task is stored without a name, so the fallback is in the reader's language.
  const projectName = task.projectName || tc('labels.untitled');

  const handleNavigate = () => {
    onNavigateToProject({ id: task.projectId, name: projectName });
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    useWorkspaceStore.getState().stopGeneration(task.projectId);
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    useWorkspaceStore.getState().dismissGenerationResult(task.projectId);
  };

  return (
    <div className="w-[380px] rounded-xl border border-border bg-card shadow-[0_8px_32px_rgba(0,0,0,0.3)] overflow-hidden">

      {/* Collapsed bar — always visible */}
      <div
        className="flex items-center gap-2.5 px-3.5 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors select-none"
        onClick={onToggleExpand}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor} ${isActive && !task.paused ? 'animate-pulse' : ''}`} />
        <span className="text-[13px] font-semibold text-foreground whitespace-nowrap font-mono">{projectName}</span>
        {isActive && (
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {formatElapsed(task.startedAt)}
          </span>
        )}
        <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
          {task.result === 'completed' && <><span className={verbColor}>{tc('actions.done')}</span>{usage ? ` ${t('actionsCost', { count: totalActions, cost: formatCost(usage.cost) })}` : ''}</>}
          {task.result === 'failed' && <span className={verbColor}>{tc('labels.error')}</span>}
          {task.result === 'unavailable' && <span className={verbColor}>{t('statusUnknown')}</span>}
          {isActive && task.paused && <span className={verbColor}>{t('pausedNeedsAttention')}</span>}
          {isActive && !task.paused && latestAction && <><span className={verbColor}>{verb(latestAction)}</span> {latestAction.target}</>}
          {isActive && !task.paused && !latestAction && <span className={verbColor}>{t('starting')}</span>}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-300 ${expanded ? '' : 'rotate-180'}`} />
      </div>

      {/* Expanded content */}
      <div
        className="overflow-hidden transition-[max-height] duration-300 ease-out"
        style={{ maxHeight: expanded ? 400 : 0 }}
      >
        <div className="px-3.5 pb-3.5">
          <div className="h-px bg-border mb-3" />

          {/* Meta tags */}
          <div className="flex items-center gap-2 mb-2.5 flex-wrap">
            {task.model && (
              <span className="text-[11px] font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                {task.model}
              </span>
            )}
            {usage && (
              <>
                <span className="text-[11px] font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                  {t('tokens', { tokens: number(usage.tokens, { notation: 'compact', maximumFractionDigits: 1 }) })}
                </span>
                <span className="text-[11px] font-mono text-blue-400 bg-muted px-2 py-0.5 rounded">
                  {formatCost(usage.cost)}
                </span>
              </>
            )}
          </div>

          {/* Prompt */}
          {task.prompt && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">{t('prompt')}</div>
              <p className="text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">{task.prompt}</p>
            </div>
          )}

          {/* Activity log */}
          {activity.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1.5">{t('activity')}</div>
              <div className="flex flex-col gap-0.5">
                {totalActions > activity.length && (
                  <div className="text-[11px] text-muted-foreground/40 font-mono py-0.5">{t('earlierActions', { count: totalActions - activity.length })}</div>
                )}
                {activity.map((item, i) => {
                  const isCurrent = i === activity.length - 1 && isActive && item.status === 'executing';
                  return (
                    <div key={i} className={`flex items-center gap-2 py-0.5 font-mono text-xs ${isCurrent ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                      <span className={`shrink-0 ${isCurrent ? verbColor : ''}`}>{verb(item)}</span>
                      <span className="truncate">{item.target}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action buttons */}
          {hasResult ? (
            <div className="flex gap-2">
              <button
                className="flex-1 py-2 rounded-lg border border-border text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                onClick={handleNavigate}
              >
                {t('openProject')}
              </button>
              <button
                className="px-3 py-2 rounded-lg border border-border text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                onClick={handleDismiss}
              >
                {tc('actions.dismiss')}
              </button>
            </div>
          ) : task.paused ? (
            <div className="flex gap-2">
              <button
                className="flex-1 py-2 rounded-lg border border-yellow-500/50 text-[13px] font-medium text-yellow-500 hover:bg-yellow-500/10 transition-colors"
                onClick={handleNavigate}
              >
                {t('openProject')}
              </button>
              <button
                className="px-3 py-2 rounded-lg border border-destructive/50 text-[13px] text-destructive hover:bg-destructive/10 transition-colors"
                onClick={handleStop}
              >
                {tc('actions.cancel')}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                className="flex-1 py-2 rounded-lg border border-border text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                onClick={handleNavigate}
              >
                {t('openProject')}
              </button>
              <button
                className="px-3 py-2 rounded-lg border border-destructive/50 text-[13px] text-destructive hover:bg-destructive/10 transition-colors"
                onClick={handleStop}
              >
                {tChat('stop')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function GenerationShelf({ selectedProject, onNavigateToProject }: GenerationShelfProps) {
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);

  const viewingProjectId = selectedProject?.id ?? '';
  const generationTasks = useWorkspaceStore(s => s.generationTasks);
  const backgroundTasks = useMemo(() => {
    const tasks: GenerationTask[] = [];
    for (const [id, task] of generationTasks) {
      if (id !== viewingProjectId) tasks.push(task);
    }
    return tasks;
  }, [generationTasks, viewingProjectId]);
  const shouldShow = backgroundTasks.length > 0;

  // Poll for updates — background events aren't in the reactive store, so we
  // re-derive activity on a short interval while the shelf is visible.
  useEffect(() => {
    if (!shouldShow) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [shouldShow]);

  if (!shouldShow) return null;

  const handleToggleExpand = (projectId: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 items-end">
      {backgroundTasks.map(task => (
        <GenerationShelfEntry
          key={task.projectId}
          task={task}
          expanded={expandedTasks.has(task.projectId)}
          onToggleExpand={() => handleToggleExpand(task.projectId)}
          onNavigateToProject={onNavigateToProject}
        />
      ))}
    </div>
  );
}
