'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Bot, CheckCircle, ChevronRight, ClipboardList, FileCode, Loader2, RefreshCw, Square, Terminal, Wrench, XCircle } from 'lucide-react';
import { classifyCommand } from '@/lib/agent-activity/classify-command';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { cn } from '@/lib/utils';
import type { InterviewGate } from '@/lib/interview/completion';
import type { InterviewHandoff } from '@/lib/interview/types';
import type { ToolCall } from './event-processor';

/**
 * Items the chat thread draws: a tool call in an opened group, a correction, a compaction, an
 * interview's completion check and a usage line.
 */

const toolIcons: Record<string, React.ReactNode> = {
  bash: <Terminal className="h-3 w-3 text-blue-500" />,
  write: <FileCode className="h-3 w-3 text-orange-500" />,
  status: <CheckCircle className="h-3 w-3 text-orange-500" />,
  agent: <Bot className="h-3 w-3 text-purple-500" />,
};

const statusIcons: Record<string, React.ReactNode> = {
  pending: <Loader2 className="h-3 w-3 animate-spin text-gray-400" />,
  executing: <Loader2 className="h-3 w-3 animate-spin text-blue-500" />,
  completed: <CheckCircle className="h-3 w-3 text-green-500" />,
  failed: <XCircle className="h-3 w-3 text-red-500" />,
  stopped: <Square className="h-3 w-3 text-muted-foreground" />,
};

/**
 * A tool call as an opened step shows it: its command on one line, then its parameters, result and
 * error. The step's own row opens and closes it, so the command line is its heading, not a toggle.
 */
export function ToolDisplay({ tool }: { tool: ToolCall }) {
  const t = useTranslations('chat');
  const tc = useTranslations('common');
  const category = (tool.name === 'bash' || tool.name === 'shell') ? classifyCommand(tool.parameters?.command ?? tool.parameters?.cmd) : tool.name;
  return (
    <div
      className={`bg-muted/30 rounded-md transition-all ${
        tool.status === 'executing' ? 'ring-2 ring-blue-500/20 animate-pulse' : ''
      } p-1.5`}
    >
      <div className="flex items-center gap-2 w-full px-1 overflow-hidden">
        <div className="flex items-center gap-1.5 shrink-0">
          {toolIcons[category] || <Wrench className="h-3 w-3" />}
          <span className="text-xs font-mono">{category}</span>
        </div>

        {/* Tool-specific preview */}
        {(tool.name === 'bash' || tool.name === 'shell') && (tool.parameters?.command ?? tool.parameters?.cmd) && (
          <code className="text-xs text-muted-foreground truncate min-w-0">
            {(() => { const c = tool.parameters.command ?? tool.parameters.cmd; return Array.isArray(c) ? c.slice(1).join(' ') : String(c); })()}
          </code>
        )}
        {(tool.parameters?.path || tool.parameters?.file_path) && (
          <code className="text-xs text-muted-foreground truncate min-w-0">
            {tool.parameters.path || tool.parameters.file_path}
          </code>
        )}

        <div className="ml-auto shrink-0">
          {statusIcons[tool.status || 'completed']}
        </div>
      </div>

      <div className="mt-2 space-y-2">
        {/* Parameters */}
        {tool.parameters && Object.keys(tool.parameters).length > 0 && (
          <div className="px-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {t('parameters')}
            </div>
            <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto">
              {JSON.stringify(tool.parameters, null, 2)}
            </pre>
          </div>
        )}

        {/* Result */}
        {tool.result && (
          <div className="px-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {t('result')}
            </div>
            <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto">
              {typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
            </pre>
          </div>
        )}

        {/* Error */}
        {tool.error && (
          <div className="px-2">
            <div className="text-[10px] uppercase tracking-wider text-destructive mb-1">
              {tc('labels.error')}
            </div>
            <pre className="text-xs bg-destructive/10 text-destructive p-2 rounded overflow-x-auto">
              {tool.error}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

interface SyntheticErrorDisplayProps {
  content: string;
  isExpanded: boolean;
  onToggle: () => void;
}

export function SyntheticErrorDisplay({ content, isExpanded, onToggle }: SyntheticErrorDisplayProps) {
  const t = useTranslations('chat');
  return (
    <div className={`bg-amber-500/10 rounded-md transition-all ${isExpanded ? 'p-2' : 'p-1.5'}`}>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left hover:bg-amber-500/20 rounded px-1"
      >
        <div className="flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3 text-amber-600" />
          <span className="text-xs font-mono">{t('autoCorrection')}</span>
        </div>
        <div className="ml-auto">
          <CheckCircle className="h-3 w-3 text-amber-600" />
        </div>
      </button>

      {/* Expanded view */}
      {isExpanded && (
        <div className="mt-2 px-2">
          <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto whitespace-pre-wrap">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Where the context was compacted: a dashed rule with the before and after token counts. */
export function CompactionNotice({ before, after }: { before: number; after: number }) {
  const t = useTranslations('chat');
  const { number } = useLocalFormat();
  return (
    <div className="flex items-center gap-2 py-2 my-1">
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {t('contextCompacted', { before: number(before, { notation: 'compact' }), after: number(after, { notation: 'compact' }) })}
      </span>
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
    </div>
  );
}

/**
 * Where an interview stands after its completion check: complete, with the follow-up its template
 * offers; not yet, with what is missing; or unverified, when the check itself failed.
 */
export function InterviewGateCard({ gate, onHandoff, disabled }: {
  gate: InterviewGate;
  onHandoff?: (handoff: InterviewHandoff) => void;
  /** The follow-up clears the chat and starts a task, so it waits while one runs. */
  disabled?: boolean;
}) {
  const t = useTranslations('chat');
  if (gate.errored) {
    return (
      <div className="text-sm bg-muted/50 border border-border px-3 py-2 rounded">
        <div className="flex items-start gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground">{t('interviewUnverified')}</div>
        </div>
      </div>
    );
  }
  if (gate.complete) {
    const handoff = gate.handoff;
    return (
      <div className="text-sm bg-green-500/10 border border-green-500/30 px-3 py-2 rounded">
        <div className="flex items-start gap-2">
          <CheckCircle className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-semibold text-green-700 dark:text-green-400 mb-0.5">{t('interviewComplete')}</div>
            <div className="text-xs text-muted-foreground">{t('allItemsCaptured')}</div>
            {handoff && (
              <button
                type="button"
                onClick={() => onHandoff?.(handoff)}
                disabled={disabled}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white px-2.5 py-1 rounded disabled:opacity-40 disabled:cursor-default"
              >
                <ChevronRight className="h-3 w-3" />
                {handoff.label}
              </button>
            )}
            <div className="text-[11px] text-muted-foreground mt-1.5">{t('orClearChat')}</div>
          </div>
        </div>
      </div>
    );
  }
  const unmet = (gate.items ?? []).filter(g => !g.passed);
  return (
    <div className="text-sm bg-amber-500/10 border border-amber-500/30 px-3 py-2 rounded">
      <div className="flex items-start gap-2">
        <ClipboardList className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold text-amber-700 dark:text-amber-400 mb-1">{t('notCompleteYet')}</div>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {unmet.map((u, idx) => (
              <li key={idx}>• {u.elicit}{u.reason ? ` — ${u.reason}` : ''}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** A duration as the usage line words it: "49s", "2m 49s". */
export function useDuration(): (ms: number) => string {
  const { number } = useLocalFormat();
  const seconds = (n: number) => number(n, { style: 'unit', unit: 'second', unitDisplay: 'narrow' });
  return (ms) => {
    const total = Math.round(ms / 1000);
    return total < 60
      ? seconds(total)
      : `${number(Math.floor(total / 60), { style: 'unit', unit: 'minute', unitDisplay: 'narrow' })} ${seconds(total % 60)}`;
  };
}

/** A cost as the usage line shows it: dollars to four places. */
function useCost(): (cost: number) => string {
  const { number } = useLocalFormat();
  return (cost) => number(cost, { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/** What a task cost: "Tokens: 854,936 • Cost: $0.0252 • 2m 49s". */
export function UsageLine({ tokens, cost, ms, className }: { tokens: number; cost: number; ms: number; className?: string }) {
  const t = useTranslations('chat');
  const { number } = useLocalFormat();
  const duration = useDuration();
  const money = useCost();
  const durationSec = ms > 0 ? Math.round(ms / 1000) : 0;
  return (
    <div className={cn('text-xs text-muted-foreground', className)}>
      {t('usageTokens', { tokens: number(tokens) })}
      {cost > 0 && ` • ${t('usageCost', { cost: money(cost) })}`}
      {durationSec > 0 && ` • ${duration(ms)}`}
    </div>
  );
}
