'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronUp, ChevronsUpDown, ChevronsDownUp, Copy, Trash2 } from 'lucide-react';
import { requestSnapshotStore } from '@/lib/llm/request-snapshot';
import { buildProviderView } from '@/lib/llm/provider-view';
import type { Message } from '@/lib/llm/core/types';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

const subscribe = (listener: () => void) => requestSnapshotStore.subscribe(listener);
const getSnapshot = () => requestSnapshotStore.getSnapshot();
const getEnabled = () => requestSnapshotStore.isEnabled();

/** Versioned expand/collapse-all override — rows stay individually toggleable after. */
export type ForceState = { open: boolean; v: number } | null;

function messagePreview(
  msg: Message,
  t: (
    key: 'toolCallsPreview' | 'contentBlocksPreview' | 'reasoningOnlyPreview' | 'emptyPreview',
    values?: Record<string, string | number>
  ) => string
): string {
  if (msg.tool_calls?.length) {
    const names = msg.tool_calls.map(tc => tc.function?.name || '?').join(', ');
    return t('toolCallsPreview', { count: msg.tool_calls.length, names });
  }
  if (typeof msg.content === 'string' && msg.content.trim()) {
    return msg.content.length > 100 ? msg.content.slice(0, 100) + '…' : msg.content;
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    return t('contentBlocksPreview', { count: msg.content.length });
  }
  if (msg.reasoning_details?.length) return t('reasoningOnlyPreview');
  return t('emptyPreview');
}

const ROLE_COLORS: Record<string, string> = {
  system: 'text-orange-500',
  user: 'text-primary',
  assistant: 'text-green-500',
  tool: 'text-blue-500',
};

function MessageRow({ msg, index, force }: { msg: Message; index: number; force?: ForceState }) {
  const td = useTranslations('debug');
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    if (force) setIsOpen(force.open);
  }, [force]);
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="w-full text-left">
        <div className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/50 text-xs">
          {isOpen ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
          <span className="text-muted-foreground font-mono shrink-0">{index}</span>
          <span className={`font-semibold shrink-0 ${ROLE_COLORS[msg.role] ?? 'text-foreground'}`}>{msg.role}</span>
          {msg.reasoning_details?.length ? (
            <span className="text-violet-500 shrink-0" title={td('hasReasoningDetails')}>R</span>
          ) : null}
          <span className="text-muted-foreground truncate">{messagePreview(msg, td)}</span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 p-2 bg-muted/30 rounded text-xs font-mono overflow-x-auto">
          <pre>{JSON.stringify(msg, null, 2)}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function MessagesTab() {
  const t = useTranslations('debug');
  const { dateTime } = useLocalFormat();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const enabled = useSyncExternalStore(subscribe, getEnabled, getEnabled);
  const [providerView, setProviderView] = useState(false);
  const [force, setForce] = useState<ForceState>(null);

  // Recomputes only when a new request is captured or the view toggles —
  // streaming deltas never reach this component.
  const messages = useMemo(() => {
    if (!snapshot) return null;
    return providerView ? buildProviderView(snapshot.messages, snapshot.model) : snapshot.messages;
  }, [snapshot, providerView]);

  const handleCopy = async () => {
    if (!messages) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(messages, null, 2));
      toast.success(t('historyCopied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <>
      <div className="p-2 border-b border-border flex items-center gap-3 flex-wrap text-xs">
        <label className="flex items-center gap-1 cursor-pointer" title={t('captureHint')}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => requestSnapshotStore.setEnabled(e.target.checked)}
            className="rounded"
          />
          {t('captureRequests')}
        </label>
        <label className="flex items-center gap-1 cursor-pointer" title={t('providerViewHint')}>
          <input
            type="checkbox"
            checked={providerView}
            onChange={(e) => setProviderView(e.target.checked)}
            className="rounded"
            disabled={!snapshot}
          />
          {t('providerView')}
        </label>
        {messages && (
          <div className="ml-auto flex items-center">
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" title={t('expandAll')}
              onClick={() => setForce(v => ({ open: true, v: (v?.v ?? 0) + 1 }))}>
              <ChevronsUpDown className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" title={t('collapseAll')}
              onClick={() => setForce(v => ({ open: false, v: (v?.v ?? 0) + 1 }))}>
              <ChevronsDownUp className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" title={t('copyHistoryJson')} onClick={handleCopy}>
              <Copy className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" title={t('clearHistory')} onClick={() => requestSnapshotStore.clear()}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {snapshot && (
        <div className="p-2 border-b border-border bg-muted/20 text-xs text-muted-foreground font-mono">
          {snapshot.provider} · {snapshot.model} · {t('messageCount', { count: snapshot.messages.length })} · {dateTime(snapshot.timestamp, { timeStyle: 'medium' })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {!messages ? (
          <div className="text-xs text-muted-foreground text-center p-4">
            {enabled ? t('waiting') : t('enableCapture')}
          </div>
        ) : (
          messages.map((msg, i) => <MessageRow key={`${snapshot!.timestamp}-${i}`} msg={msg} index={i} force={force} />)
        )}
      </div>
    </>
  );
}
