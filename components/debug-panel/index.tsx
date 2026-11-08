'use client';

import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronUp, ChevronsUpDown, ChevronsDownUp, Bug, Trash2, Copy, Download } from 'lucide-react';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { MemoryMonitor } from './memory-monitor';
import { MessagesTab, type ForceState } from './messages-tab';
import { configManager } from '@/lib/config/storage';
import { requestSnapshotStore } from '@/lib/llm/request-snapshot';
import { toast } from 'sonner';

import type { DebugEvent } from '@/lib/stores/types';

interface DebugPanelProps {
  events: DebugEvent[];
  onClear?: () => void;
  onClose?: () => void;
}

export function DebugPanel({ events, onClear, onClose }: DebugPanelProps) {
  const t = useTranslations('debug');
  const tw = useTranslations('workspace');
  const [activeTab, setActiveTab] = useState<'events' | 'messages'>('events');
  const [filter, setFilter] = useState<string>('');
  const eventsListRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamDebug, setStreamDebug] = useState<boolean>(() => configManager.getDebugStreamEnabled());
  const [eventsForce, setEventsForce] = useState<ForceState>(null);
  const messageSnapshot = useSyncExternalStore(
    (l) => requestSnapshotStore.subscribe(l),
    () => requestSnapshotStore.getSnapshot(),
    () => requestSnapshotStore.getSnapshot(),
  );

  // Compress consecutive assistant_delta, tool_param_delta, and reasoning_delta events
  // Only store count, not individual events - prevents O(N²) memory growth
  const compressedEvents = useMemo(() => {
    const result: DebugEvent[] = [];
    let currentDeltaGroup: DebugEvent | null = null;

    const COMPRESSIBLE_EVENTS = new Set(['assistant_delta', 'tool_param_delta', 'reasoning_delta']);

    for (const event of events) {
      const shouldCompress = COMPRESSIBLE_EVENTS.has(event.event);

      if (shouldCompress) {
        // If we're already in a group of the same type, just increment count
        if (currentDeltaGroup && currentDeltaGroup.event === event.event) {
          currentDeltaGroup.count = (currentDeltaGroup.count || 1) + 1;
          // Don't accumulate data.all - that causes O(N²) memory usage
          // The count is sufficient for debugging purposes
        } else {
          // Start a new group
          if (currentDeltaGroup) {
            result.push(currentDeltaGroup);
          }
          currentDeltaGroup = { ...event, count: 1 };
        }
      } else {
        // Non-compressible event, flush any current group and add this event
        if (currentDeltaGroup) {
          result.push(currentDeltaGroup);
          currentDeltaGroup = null;
        }
        result.push(event);
      }
    }

    // Flush any remaining group
    if (currentDeltaGroup) {
      result.push(currentDeltaGroup);
    }

    return result;
  }, [events]);

  // Scroll to bottom when new events arrive. The list scrolls itself: scrollIntoView would also scroll
  // the panel's own box, which in a short cell takes the header out of view.
  useEffect(() => {
    const list = eventsListRef.current;
    if (autoScroll && list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [compressedEvents, autoScroll]);

  // Clear all events
  const handleClear = () => {
    onClear?.();
  };

  // Export events as JSON
  const handleExport = () => {
    const json = JSON.stringify(events, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-events-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyEvents = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
      toast.success(t('eventsCopied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  // Filter events
  const filteredEvents = filter
    ? compressedEvents.filter(e => e.event.toLowerCase().includes(filter.toLowerCase()))
    : compressedEvents;

  // Group events by type (use original events for accurate counts)
  const eventCounts = events.reduce((acc, e) => {
    acc[e.event] = (acc[e.event] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <PanelContainer>
      <PanelHeader
        icon={Bug}
        title={tw('tabs.debugEvents')}
        onClose={onClose}
        panelKey="debug"
      >
        <MemoryMonitor />
      </PanelHeader>

      {/* Tabs */}
      <div className="flex border-b border-border text-xs">
        {([
          ['events', t('tabEvents', { shown: filteredEvents.length, total: events.length })],
          ['messages', messageSnapshot ? t('tabMessagesCount', { count: messageSnapshot.messages.length }) : t('tabMessages')],
        ] as const).map(([key, label]) => (
          <Tip key={key} label={key === 'events' ? t('tips.events') : t('tips.messages')} side="bottom">
            <button
              onClick={() => setActiveTab(key)}
              className={`flex-1 px-3 py-1.5 border-b-2 -mb-px whitespace-nowrap ${
                activeTab === key
                  ? 'border-primary text-foreground font-semibold'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          </Tip>
        ))}
      </div>

      {activeTab === 'messages' ? (
        <MessagesTab />
      ) : (
        <>
          {/* Event Counts */}
          <div className="p-2 border-b border-border bg-muted/20 text-xs">
            <div className="flex flex-wrap gap-2">
              {Object.entries(eventCounts).map(([event, count]) => (
                <Tip key={event} label={filter === event ? t('tips.showAll') : t('tips.showOnly', { event })}>
                  <button
                    onClick={() => setFilter(filter === event ? '' : event)}
                    aria-pressed={filter === event}
                    className={`px-2 py-1 rounded ${
                      filter === event
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    }`}
                  >
                    {event} ({count})
                  </button>
                </Tip>
              ))}
            </div>
          </div>

          {/* Filter Input */}
          <div className="p-2 border-b border-border">
            <input
              type="text"
              placeholder={t('filterEvents')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full px-2 py-1 text-xs rounded bg-background border border-border"
            />
          </div>

          {/* Toggles + actions */}
          <div className="p-2 border-b border-border flex items-center gap-3 flex-wrap">
            <Tip label={t('tips.autoScroll')}>
            <label className="text-xs flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              {t('autoScroll')}
            </label>
            </Tip>
            <Tip label={t('streamDebugHint')}>
            <label className="text-xs flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={streamDebug}
                onChange={(e) => {
                  setStreamDebug(e.target.checked);
                  configManager.setDebugStreamEnabled(e.target.checked);
                }}
                className="rounded"
              />
              {t('streamDebug')}
            </label>
            </Tip>
            <div className="ml-auto flex items-center">
              <Tip label={t('expandAll')}>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" aria-label={t('expandAll')}
                  onClick={() => setEventsForce(v => ({ open: true, v: (v?.v ?? 0) + 1 }))}>
                  <ChevronsUpDown className="h-3 w-3" />
                </Button>
              </Tip>
              <Tip label={t('collapseAll')}>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" aria-label={t('collapseAll')}
                  onClick={() => setEventsForce(v => ({ open: false, v: (v?.v ?? 0) + 1 }))}>
                  <ChevronsDownUp className="h-3 w-3" />
                </Button>
              </Tip>
              <Tip label={t('copyEventsJson')}>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" aria-label={t('copyEventsJson')} onClick={handleCopyEvents}>
                  <Copy className="h-3 w-3" />
                </Button>
              </Tip>
              <Tip label={t('exportJson')}>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" aria-label={t('exportJson')} onClick={handleExport}>
                  <Download className="h-3 w-3" />
                </Button>
              </Tip>
              <Tip label={t('clearEventsHint')} align="end">
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" aria-label={t('clearEventsHint')} onClick={handleClear}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </Tip>
            </div>
          </div>

          {/* Events List */}
          <div ref={eventsListRef} className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredEvents.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center p-4">
                {t('noEvents')}
              </div>
            ) : (
              filteredEvents.map((event) => (
                <EventItem key={event.id} event={event} force={eventsForce} />
              ))
            )}
          </div>
        </>
      )}

    </PanelContainer>
  );
}

function EventItem({ event, force }: { event: DebugEvent; force?: ForceState }) {
  const { dateTime } = useLocalFormat();
  const [isOpen, setIsOpen] = useState(false);
  // Expand/collapse-all override — rows remain individually toggleable after
  useEffect(() => {
    if (force) setIsOpen(force.open);
  }, [force]);
  const time = dateTime(event.timestamp, { timeStyle: 'medium' });

  // Color code by event type
  const getEventColor = (eventType: string) => {
    if (eventType.includes('error') || eventType.includes('failed')) return 'text-red-500';
    if (eventType.includes('retry')) return 'text-yellow-500';
    if (eventType.includes('completed') || eventType.includes('success')) return 'text-green-500';
    if (eventType.includes('tool')) return 'text-blue-500';
    if (eventType.includes('agent')) return 'text-purple-500';
    if (eventType.includes('plan')) return 'text-orange-500';
    return 'text-foreground';
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="w-full text-left">
        <div className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/50 text-xs">
          {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span className="text-muted-foreground font-mono">{time}</span>
          <span className={`font-semibold ${getEventColor(event.event)}`}>
            {event.event}
          </span>
          {event.count && event.count > 1 && (
            <span className="text-muted-foreground font-mono">
              ({event.count})
            </span>
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 p-2 bg-muted/30 rounded text-xs font-mono overflow-x-auto">
          <pre>{JSON.stringify(event.data, null, 2)}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
