'use client';

import { useState, useEffect, useRef, useMemo, useCallback, DragEvent, ClipboardEvent } from 'react';
import { MessageSquare, Loader2, CheckCircle, XCircle, ChevronRight, FileCode, ClipboardList, Bot, RotateCcw, RefreshCw, Send, ChevronUp, ChevronDown, Code, Trash2, X, Brain, Image as ImageIcon } from 'lucide-react';
import type { DebugEvent } from '@/lib/stores/types';
import { EventProcessor, classifyShellCommand, type Turn, type TurnItem, type ToolCall } from './event-processor';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ChipsBlock } from './chips';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ModelSettingsPanel } from '@/components/settings/model-settings';
import { FocusContextPayload } from '@/lib/preview/types';
import { PendingImage } from '@/lib/llm/multi-agent-orchestrator';
import { ContentBlock } from '@/lib/llm/types';
import type { PlacedBlock } from '@/lib/semantic-blocks/types';
import { MessageContext } from '@/components/message-context';
import { track } from '@/lib/telemetry';
import { useWorkspaceStore } from '@/lib/stores/workspace';

type FocusTarget = FocusContextPayload & { timestamp: number };

// Helper to render user message content (string or ContentBlock[])
function UserMessageContent({ content, hideImages }: { content: string | ContentBlock[]; hideImages?: boolean }) {
  if (typeof content === 'string') {
    return <div className="whitespace-pre-wrap">{content}</div>;
  }

  // Separate text and image blocks
  const textBlocks = content.filter(b => b.type === 'text');
  const imageBlocks = hideImages ? [] : content.filter(b => b.type === 'image_url');

  return (
    <div className="space-y-2">
      {/* Render text blocks */}
      {textBlocks.map((block, index) => (
        <div key={`text-${index}`} className="whitespace-pre-wrap">
          {block.type === 'text' && block.text}
        </div>
      ))}

      {/* Render images in a flex container (when not handled by MessageContext) */}
      {imageBlocks.length > 0 && (
        <div className="flex flex-wrap gap-2 p-1 rounded-md bg-muted/50">
          {imageBlocks.map((block, index) => (
            block.type === 'image_url' && (
              <img
                key={`img-${index}`}
                src={block.image_url.url}
                alt="Attached image"
                className="h-[60px] w-auto rounded border border-border object-cover"
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

interface ChatPanelProps {
  events: DebugEvent[];
  onRestore?: (checkpointId: string) => void;
  onRetry?: (checkpointId: string) => void;
  // Input functionality
  generating: boolean;
  onGenerate: (prompt: string, images?: PendingImage[]) => void;
  onStop: () => void;
  onContinue?: () => void;
  // Focus context
  focusContext: FocusTarget | null;
  setFocusContext: (context: FocusTarget | null) => void;
  focusPreviewSnippet?: string;
  // Settings
  chatMode: boolean;
  setChatMode: (mode: boolean) => void;
  currentModel: string;
  setCurrentModel: (model: string) => void;
  getModelDisplayName: (modelId: string) => string;
  // Tour/lock state
  isTourLockingInput?: boolean;
  // Clear chat
  onClearChat?: () => void;
  // Close panel
  onClose?: () => void;
  // Vision support
  supportsVision?: boolean;
  // Provider has credentials configured
  providerReady?: boolean;
  // Runtime errors
  runtimeErrors?: string[];
  onSendRuntimeErrors?: () => void;
  onClearRuntimeErrors?: () => void;
  // Semantic blocks
  placedBlocks?: PlacedBlock[];
  onRemovePlacedBlock?: (placementId: string) => void;
  onClearPlacedBlocks?: () => void;
  // Layout overrides
  hideHeader?: boolean;
  className?: string;
  /** Content rendered in place of the composer (e.g. creation confirmation) */
  composerOverlay?: React.ReactNode;
  /** Non-dismissable system note shown in context area (consumed on next send) */
  systemNote?: string | null;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

const toolIcons: Record<string, React.ReactNode> = {
  shell: <ChevronRight className="h-3 w-3 text-blue-500" />,
  write: <FileCode className="h-3 w-3 text-orange-500" />,
  status: <CheckCircle className="h-3 w-3 text-orange-500" />,
  delegate: <Bot className="h-3 w-3 text-purple-500" />,
};

const statusIcons: Record<string, React.ReactNode> = {
  pending: <Loader2 className="h-3 w-3 animate-spin text-gray-400" />,
  executing: <Loader2 className="h-3 w-3 animate-spin text-blue-500" />,
  completed: <CheckCircle className="h-3 w-3 text-green-500" />,
  failed: <XCircle className="h-3 w-3 text-red-500" />,
};

export function ChatPanel({
  events,
  onRestore,
  onRetry,
  generating,
  onGenerate,
  onStop,
  onContinue,
  focusContext,
  setFocusContext,
  focusPreviewSnippet,
  chatMode,
  setChatMode,
  currentModel,
  setCurrentModel,
  getModelDisplayName,
  isTourLockingInput = false,
  onClearChat,
  onClose,
  supportsVision = false,
  providerReady = true,
  runtimeErrors = [],
  onSendRuntimeErrors,
  onClearRuntimeErrors,
  placedBlocks,
  onRemovePlacedBlock,
  onClearPlacedBlocks,
  hideHeader,
  className,
  composerOverlay,
  systemNote,
}: ChatPanelProps) {
  const workspaceReady = useWorkspaceStore(s => s.workspaceReady);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showMobileSettings, setShowMobileSettings] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const isScrollingProgrammatically = useRef(false);

  // Prompt state — owned by ChatPanel, never leaves this component until submit
  const [prompt, setPrompt] = useState('');

  // Clear prompt when generation starts
  const prevGenerating = useRef(generating);
  if (generating && !prevGenerating.current) {
    setPrompt('');
  }
  prevGenerating.current = generating;

  // Image handling state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Handle image drop
  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.types.includes('application/semantic-block')) return;
    if (!supportsVision) return;

    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/')
    );

    if (files.length > 0) {
      track('image_attached', { source: 'drop', count: files.length });
    }

    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const [header, data] = dataUrl.split(',');
        const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/png';

        setPendingImages(prev => [...prev, {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          data,
          mediaType,
          preview: dataUrl
        }]);
      };
      reader.readAsDataURL(file);
    }
  }, [supportsVision]);

  // Handle drag over
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('application/semantic-block')) return;
    if (supportsVision) {
      setIsDragging(true);
    }
  }, [supportsVision]);

  // Handle drag leave
  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  // Handle paste
  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsVision) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    let pastedCount = 0;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          pastedCount++;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const [header, data] = dataUrl.split(',');
            const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/png';

            setPendingImages(prev => [...prev, {
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
              data,
              mediaType,
              preview: dataUrl
            }]);
          };
          reader.readAsDataURL(file);
        }
      }
    }
    if (pastedCount > 0) {
      track('image_attached', { source: 'paste', count: pastedCount });
    }
  }, [supportsVision]);

  // Remove a pending image
  const removeImage = useCallback((imageId: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // Handle send with images
  const handleSend = useCallback(() => {
    if (pendingImages.length > 0) {
      onGenerate(prompt, pendingImages);
      setPendingImages([]);
    } else {
      onGenerate(prompt);
    }
  }, [onGenerate, pendingImages, prompt]);

  // Listen for tour event to open provider settings
  useEffect(() => {
    const handleTourOpenSettings = () => {
      setShowMobileSettings(true);
    };

    window.addEventListener('tour-open-provider-settings', handleTourOpenSettings);
    return () => {
      window.removeEventListener('tour-open-provider-settings', handleTourOpenSettings);
    };
  }, []);

  const processorRef = useRef(new EventProcessor());

  // Transform events into turns with chronologically ordered items (incremental)
  const turns = useMemo(() => processorRef.current.process(events), [events]);

  // Auto-scroll when turns change (throttled with requestAnimationFrame)
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;

    // Use requestAnimationFrame to batch scroll updates and avoid layout thrashing
    const rafId = requestAnimationFrame(() => {
      if (scrollRef.current) {
        isScrollingProgrammatically.current = true;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        // Reset flag after scroll completes
        setTimeout(() => {
          isScrollingProgrammatically.current = false;
        }, 50);
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [turns, autoScroll]);

  // Enable auto-scroll when new turns arrive (user sent a message)
  useEffect(() => {
    if (turns.length > 0) {
      setAutoScroll(true);
    }
  }, [turns.length]);

  // Scroll position detection
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const handleScroll = () => {
      // Ignore programmatic scrolls
      if (isScrollingProgrammatically.current) return;

      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 50;
      setAutoScroll(isAtBottom);
    };

    scrollEl.addEventListener('scroll', handleScroll);
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, []);

  // Toggle expanded state for an item
  const toggleExpanded = (itemId: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  // Focus context snippet for unified context component
  const trimmedSnippet = focusPreviewSnippet?.trim() ?? '';
  const focusContextData = focusContext ? { domPath: focusContext.domPath, snippet: trimmedSnippet } : null;

  // Runtime error card
  const runtimeErrorHint = !generating && runtimeErrors.length > 0 ? (
    <div
      className="rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-foreground">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs uppercase tracking-wide text-destructive">runtime errors</span>
          <span className="inline-flex items-center justify-center rounded-full bg-destructive/15 text-destructive text-[10px] font-medium px-1.5 min-w-[18px] h-[18px]">
            {runtimeErrors.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onClearRuntimeErrors && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={onClearRuntimeErrors}
              title="Dismiss runtime errors"
            >
              Clear
            </Button>
          )}
          {onSendRuntimeErrors && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-destructive"
              onClick={onSendRuntimeErrors}
              title="Send errors to AI for correction"
            >
              Send
            </Button>
          )}
        </div>
      </div>
      <pre className="mt-2 max-h-24 overflow-auto rounded border border-border/50 bg-background/90 px-2 py-1 text-[11px] text-foreground leading-relaxed">
        <code>{runtimeErrors.map(e => `• ${e}`).join('\n')}</code>
      </pre>
    </div>
  ) : null;

  return (
    <PanelContainer dataTourId="assistant-panel" className={className}>
      {!hideHeader && (
        <PanelHeader
          icon={MessageSquare}
          title="Chat"
          color="var(--button-assistant-active)"
          onClose={onClose}
          panelKey="chat"
          actions={onClearChat && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearChat}
              className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:w-5 md:px-0 md:border-0 md:bg-transparent md:rounded-md"
              title="Clear chat"
              data-tour-id="clear-chat-button"
            >
              <Trash2 className="h-2.5 w-2.5 md:h-3 md:w-3" />
              <span className="text-xs md:hidden">Clear chat</span>
            </Button>
          )}
        />
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {!workspaceReady && turns.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-4">
            <Loader2 className="h-5 w-5 animate-spin opacity-40" />
            <span className="text-xs">Loading conversation…</span>
          </div>
        ) : turns.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center p-4">
            No messages yet. Start a conversation to see it here.
          </div>
        ) : (
          (() => {
            // Per-task usage collation: show accumulated usage on the last turn of each task.
            // Task boundaries: turns containing a non-synthetic user message.
            const isTaskStart = (t: Turn) => t.items.some(i => i.type === 'user');

            // Build a map: turnIndex → collated usage data for display.
            // For each task group, the last turn before the next task (or end) gets the usage.
            const usageMap = new Map<number, { usage: Turn['usage']; startTime?: number }>();
            let taskLastUsage: Turn['usage'] = undefined;
            let taskStartTime: number | undefined;

            for (let i = 0; i < turns.length; i++) {
              if (i > 0 && isTaskStart(turns[i])) {
                // Task boundary — assign accumulated usage to the last turn of the previous task
                if (taskLastUsage) {
                  usageMap.set(i - 1, { usage: taskLastUsage, startTime: taskStartTime });
                }
                taskLastUsage = undefined;
                taskStartTime = undefined;
              }
              if (turns[i].usage) {
                taskLastUsage = turns[i].usage;
                taskStartTime = turns[i].taskStartTime;
              }
            }
            // Final task group — assign to last turn
            if (taskLastUsage) {
              usageMap.set(turns.length - 1, { usage: taskLastUsage, startTime: taskStartTime });
            }

            return turns.map((turn, idx) => {
              const collated = usageMap.get(idx);
              return (
                <TurnDisplay
                  key={turn.id}
                  turn={turn}
                  collatedUsage={collated?.usage}
                  collatedTaskStartTime={collated?.startTime}
                  onRestore={onRestore}
                  onRetry={onRetry}
                  onContinue={onContinue}
                  onCancel={onStop}
                  generating={generating}
                  onGenerate={onGenerate}
                  expandedItems={expandedItems}
                  onToggleExpanded={toggleExpanded}
                />
              );
            });
          })()
        )}
      </div>

      {/* Input — or composerOverlay when present */}
      {composerOverlay ? (
        <div className="p-3">{composerOverlay}</div>
      ) : (
      <div className="p-3 space-y-2">
        {runtimeErrorHint}
        {/* Unified context component — focus, blocks, images */}
        <MessageContext
          focusContext={focusContextData}
          semanticBlocks={placedBlocks}
          images={pendingImages}
          systemNote={systemNote}
          onClearFocus={() => setFocusContext(null)}
          onRemoveBlock={onRemovePlacedBlock}
          onClearBlocks={onClearPlacedBlocks}
          onRemoveImage={removeImage}
          onClearImages={() => setPendingImages([])}
        />
        <div
          className={`bg-card border rounded-lg shadow-sm overflow-hidden transition-all ${
            isDragging ? 'border-primary border-2 bg-primary/5' : 'border-border'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >

          {/* Drop overlay */}
          {isDragging && supportsVision && (
            <div className="absolute inset-0 flex items-center justify-center bg-primary/10 z-10 pointer-events-none">
              <div className="text-primary font-medium flex items-center gap-2">
                <ImageIcon className="h-5 w-5" />
                Drop image here
              </div>
            </div>
          )}

          <div className="relative flex bg-card rounded-lg transition-all">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (isTourLockingInput) {
                    return;
                  }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                onPaste={handlePaste}
                placeholder={!providerReady ? "Select a provider to start..." : supportsVision ? "Describe what you want to build... (paste or drop images)" : "Describe what you want to build..."}
                className="flex-1 px-3 py-2 bg-transparent border-0 resize-none focus:outline-none text-sm placeholder:text-muted-foreground text-foreground"
                rows={3}
                disabled={generating || isTourLockingInput || !providerReady}
              />
              <div className="flex flex-col p-2 gap-2">
                <Button
                  onClick={generating ? onStop : handleSend}
                  disabled={isTourLockingInput ? !generating : (!generating && (!prompt.trim() && pendingImages.length === 0 || !providerReady))}
                  size="sm"
                  className="flex items-center gap-2"
                >
                  {generating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" />
                      Send
                    </>
                  )}
                </Button>
              </div>
            </div>

          {/* Footer */}
          <div className="border-t border-border bg-muted/50 px-2 py-2">
            <div className="flex items-center justify-between gap-2">
              <Popover open={showMobileSettings} onOpenChange={setShowMobileSettings}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`h-7 text-xs ${!providerReady ? 'ring-2 ring-primary/70 animate-ring-opacity border-primary' : ''}`}
                    data-tour-id="provider-settings-trigger"
                  >
                    <span>{providerReady ? getModelDisplayName(currentModel) : 'Select provider'}</span>
                    {showMobileSettings ? (
                      <ChevronDown className="h-3 w-3 ml-1" />
                    ) : (
                      <ChevronUp className="h-3 w-3 ml-1" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[460px] max-w-[calc(100vw-2rem)] max-h-[min(680px,calc(100vh-5rem))] overflow-hidden flex flex-col" align="start" data-tour-id="provider-settings-popup">
                  <ModelSettingsPanel
                    onClose={() => setShowMobileSettings(false)}
                    onModelChange={(modelId) => setCurrentModel(modelId)}
                  />
                </PopoverContent>
              </Popover>

              {!hideHeader && (
                <ToggleGroup
                  type="single"
                  value={chatMode ? 'chat' : 'code'}
                  onValueChange={(value) => {
                    if (value) setChatMode(value === 'chat');
                  }}
                  className="gap-1"
                >
                  <ToggleGroupItem value="chat" className="h-7 text-xs px-2">
                    <MessageSquare className="h-3 w-3 mr-1" />
                    Chat
                  </ToggleGroupItem>
                  <ToggleGroupItem value="code" className="h-7 text-xs px-2">
                    <Code className="h-3 w-3 mr-1" />
                    Code
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
            </div>
          </div>
        </div>
      </div>
      )}
    </PanelContainer>
  );
}

interface TurnDisplayProps {
  turn: Turn;
  collatedUsage?: Turn['usage'];
  collatedTaskStartTime?: number;
  onRestore?: (checkpointId: string) => void;
  onRetry?: (checkpointId: string) => void;
  onContinue?: () => void;
  onCancel?: () => void;
  generating?: boolean;
  onGenerate?: (prompt: string, images?: PendingImage[]) => void;
  expandedItems: Set<string>;
  onToggleExpanded: (itemId: string) => void;
}

function TurnDisplay({ turn, collatedUsage, collatedTaskStartTime, onRestore, onRetry, onContinue, onCancel, generating, onGenerate, expandedItems, onToggleExpanded }: TurnDisplayProps) {
  return (
    <div className="space-y-2" {...(turn.checkpointId ? { 'data-checkpoint-id': turn.checkpointId } : {})}>
      {/* Render items in chronological order */}
      {turn.items.map((item) => {
        switch (item.type) {
          case 'waiting':
            return (
              <div key={item.id} className="bg-muted/30 rounded-md p-2 opacity-70">
                <div className="flex items-center gap-2 px-1">
                  <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                  <span className="text-xs text-muted-foreground">Waiting for response...</span>
                </div>
              </div>
            );

          case 'reasoning':
            return (
              <ReasoningDisplay
                key={item.id}

                content={item.data}
                isComplete={item.complete === true}
                isExpanded={expandedItems.has(item.id)}
                onToggle={() => onToggleExpanded(item.id)}
              />
            );

          case 'plan':
            return (
              <PlanDisplay
                key={item.id}

                content={item.data}
                isExpanded={expandedItems.has(item.id)}
                onToggle={() => onToggleExpanded(item.id)}
              />
            );

          case 'agent':
            return (
              <AgentDisplay
                key={item.id}

                content={item.data}
                isExpanded={expandedItems.has(item.id)}
                onToggle={() => onToggleExpanded(item.id)}
              />
            );

          case 'progress':
            return (
              <ProgressDisplay
                key={item.id}

                content={item.data}
                isExpanded={expandedItems.has(item.id)}
                onToggle={() => onToggleExpanded(item.id)}
              />
            );

          case 'tool':
            return (
              <ToolDisplay
                key={item.id}

                tool={item.data as ToolCall}
                isExpanded={expandedItems.has(item.id)}
                onToggle={() => onToggleExpanded(item.id)}
              />
            );

          case 'text':
            return (
              <div key={item.id} className="text-sm text-foreground/90 bg-muted/20 px-3 py-2 rounded">
                <MarkdownRenderer content={item.data} />
              </div>
            );

          case 'ask': {
            const askData = item.data as { prompt?: string; options: string[] };
            if (!askData.options || askData.options.length === 0) return null;
            return (
              <div key={item.id} className="text-sm text-foreground/90 bg-muted/20 px-3 py-2 rounded">
                {askData.prompt && (
                  <p className="text-sm text-foreground mb-1">{askData.prompt}</p>
                )}
                <ChipsBlock
                  options={askData.options}
                  onSelect={(value) => onGenerate?.(value)}
                  disabled={!!generating}
                />
              </div>
            );
          }

          case 'project_context':
            return (
              <div key={item.id} className={`rounded-md transition-all ${expandedItems.has(item.id) ? 'bg-muted/30 p-2' : 'p-1.5'}`}>
                <button
                  onClick={() => onToggleExpanded(item.id)}
                  className="flex items-center gap-2 w-full text-left hover:bg-muted/30 rounded px-1"
                >
                  <ChevronRight className={`h-3 w-3 text-muted-foreground transition-transform ${expandedItems.has(item.id) ? 'rotate-90' : ''}`} />
                  <FileCode className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Project context</span>
                </button>
                {expandedItems.has(item.id) && (
                  <div className="mt-2 px-2">
                    <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                      {item.data}
                    </pre>
                  </div>
                )}
              </div>
            );

          case 'compaction':
            return (
              <div key={item.id} className="flex items-center gap-2 py-2 my-1">
                <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  Context compacted — {formatTokenCount(item.data?.preCompactTokens ?? 0)} → ~{formatTokenCount(item.data?.postCompactEstimate ?? 0)} tokens
                </span>
                <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
              </div>
            );

          case 'user': {
            // Extract image blocks from content if present (to show in unified context)
            const contentData = item.data;
            const userImageBlocks = Array.isArray(contentData)
              ? contentData.filter((b: ContentBlock) => b.type === 'image_url')
              : [];
            const hasAnyContext = !!(item.focusContext || item.semanticBlocks || userImageBlocks.length > 0);
            return (
              <div key={item.id} className="text-sm text-foreground bg-primary/10 px-3 py-2 rounded border border-primary/20">
                <div className="font-semibold text-primary mb-1 text-xs">User</div>
                <UserMessageContent content={contentData} hideImages={hasAnyContext} />
                {hasAnyContext && (
                  <MessageContext
                    focusContext={item.focusContext}
                    semanticBlocks={item.semanticBlocks}
                    imageBlocks={userImageBlocks.length > 0 ? userImageBlocks : undefined}
                    readOnly
                  />
                )}
              </div>
            );
          }

          case 'synthetic_error':
            // Auto-injected error message (e.g., malformed tool call correction)
            // Style it like a collapsible tool call
            return (
              <SyntheticErrorDisplay
                key={item.id}
                content={item.data}
                isExpanded={expandedItems.has(item.id)}
                onToggle={() => onToggleExpanded(item.id)}
              />
            );

          case 'error':
            return (
              <div key={item.id} className="text-sm bg-destructive/10 border border-destructive/20 px-3 py-2 rounded">
                <div className="flex items-start gap-2">
                  <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="font-semibold text-destructive mb-1">Error</div>
                    <div className="text-destructive/90 whitespace-pre-wrap font-mono text-xs">
                      {item.data?.message || JSON.stringify(item.data, null, 2)}
                    </div>
                    {item.data?.stack && (
                      <details className="mt-2">
                        <summary className="text-xs text-destructive/70 cursor-pointer hover:text-destructive">
                          Stack trace
                        </summary>
                        <pre className="text-[10px] text-destructive/60 mt-1 overflow-x-auto">
                          {item.data.stack}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            );

          case 'error_paused':
            return (
              <div key={item.id} className="text-sm bg-destructive/10 border border-destructive/20 px-3 py-2 rounded">
                <div className="flex items-start gap-2">
                  <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="font-semibold text-destructive mb-1">{generating ? 'Task paused' : 'Error'}</div>
                    <div className="text-destructive/90 whitespace-pre-wrap font-mono text-xs">
                      {item.data?.message || 'An API error occurred.'}
                    </div>
                    {generating && (
                      <div className="mt-2 flex gap-3">
                        {onContinue && (
                          <button onClick={onContinue} className="text-xs underline text-primary hover:text-primary/80">
                            Continue
                          </button>
                        )}
                        <button onClick={onCancel} className="text-xs underline text-muted-foreground hover:text-foreground/80">
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );

          default:
            return null;
        }
      })}

      {/* Usage info and checkpoint actions — shown on last turn only */}
      {(collatedUsage || turn.checkpointId) && (
        <div className="flex items-center justify-between gap-2">
          {/* Collated usage info (per-task) */}
          {collatedUsage && (() => {
            const cumulativeTokens = (collatedUsage.totalUsage?.totalTokens || collatedUsage.usage?.totalTokens || collatedUsage.totalTokens) || 0;
            const cumulativeCost = collatedUsage.totalCost ?? collatedUsage.cost ?? 0;
            const taskTokens = cumulativeTokens - (collatedUsage.taskTokenOffset || 0);
            const taskCost = cumulativeCost - (collatedUsage.taskCostOffset || 0);
            const startTime = collatedTaskStartTime || turn.taskStartTime;
            const durationMs = startTime && collatedUsage.timestamp
              ? collatedUsage.timestamp - startTime
              : 0;
            const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : 0;
            return (
              <div className="text-xs text-muted-foreground">
                Tokens: {taskTokens.toLocaleString()}
                {taskCost > 0 && ` • Cost: $${taskCost.toFixed(4)}`}
                {durationSec > 0 && ` • ${durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`}`}
              </div>
            );
          })()}

          {/* Checkpoint actions */}
          {turn.checkpointId && (
            <div className="flex items-center gap-1">
              {onRestore && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onRestore(turn.checkpointId!)}
                  className="h-6 px-2 text-xs"
                  title="Restore to this checkpoint"
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Restore
                </Button>
              )}
              {onRetry && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onRetry(turn.checkpointId!)}
                  className="h-6 px-2 text-xs"
                  title="Restore files and retry from this checkpoint"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Retry
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ToolDisplayProps {
  tool: ToolCall;
  isExpanded: boolean;
  onToggle: () => void;
}

function ToolDisplay({ tool, isExpanded, onToggle }: ToolDisplayProps) {
  const category = tool.name === 'shell' ? classifyShellCommand(tool.parameters?.cmd) : tool.name;
  return (
    <div
      className={`bg-muted/30 rounded-md transition-all ${
        tool.status === 'executing' ? 'ring-2 ring-blue-500/20 animate-pulse' : ''
      } p-1.5`}
    >
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1 overflow-hidden"
      >
        <div className="flex items-center gap-1.5 shrink-0">
          {toolIcons[category] || <ChevronRight className="h-3 w-3" />}
          <span className="text-xs font-mono">{category}</span>
        </div>

        {/* Tool-specific preview */}
        {tool.name === 'shell' && tool.parameters?.cmd && (
          <code className="text-xs text-muted-foreground truncate min-w-0">
            {Array.isArray(tool.parameters.cmd)
              ? tool.parameters.cmd.slice(1).join(' ')
              : String(tool.parameters.cmd)}
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
      </button>

      {/* Expanded view */}
      {isExpanded && (
        <div className="mt-2 space-y-2">
          {/* Parameters */}
          {tool.parameters && Object.keys(tool.parameters).length > 0 && (
            <div className="px-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Parameters
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
                Result
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
                Error
              </div>
              <pre className="text-xs bg-destructive/10 text-destructive p-2 rounded overflow-x-auto">
                {tool.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SyntheticErrorDisplayProps {
  content: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function SyntheticErrorDisplay({ content, isExpanded, onToggle }: SyntheticErrorDisplayProps) {
  return (
    <div className={`bg-amber-500/10 rounded-md transition-all ${isExpanded ? 'p-2' : 'p-1.5'}`}>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left hover:bg-amber-500/20 rounded px-1"
      >
        <div className="flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3 text-amber-600" />
          <span className="text-xs font-mono">Auto-correction</span>
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

interface ReasoningDisplayProps {
  content: string;
  isComplete: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

function ReasoningDisplay({ content, isComplete, isExpanded, onToggle }: ReasoningDisplayProps) {
  const lines = (content || '').split('\n').filter(l => l.trim());
  const headPreview = lines[0]?.substring(0, 60) || 'Reasoning...';
  const tailPreview = lines.length > 0 ? lines[lines.length - 1].slice(-120) : '';
  const isStreaming = !isComplete;
  const streamingLabel = tailPreview || 'Thinking...';

  return (
    <div className="bg-violet-500/10 rounded-md transition-all p-1.5">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left hover:bg-violet-500/20 rounded px-1"
      >
        <div className="flex items-center gap-1.5">
          {isStreaming ? (
            <Loader2 className="h-3 w-3 animate-spin text-violet-500" />
          ) : (
            <Brain className="h-3 w-3 text-violet-500" />
          )}
          <span className="text-xs font-mono">reasoning</span>
        </div>
        <code className="text-xs text-muted-foreground truncate flex-1">
          {isStreaming ? streamingLabel : headPreview}
        </code>
        <div className="ml-auto">
          <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {isExpanded && (
        <div className="mt-2 px-2">
          <div className="text-xs bg-muted/50 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">
            <MarkdownRenderer content={content || 'Thinking...'} />
          </div>
        </div>
      )}
    </div>
  );
}

interface PlanDisplayProps {
  content: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function PlanDisplay({ content, isExpanded, onToggle }: PlanDisplayProps) {
  // Extract first line for preview
  const lines = content.split('\n');
  const preview = lines[0]?.replace(/^\*\*|\*\*$/g, '').substring(0, 50) || 'Plan';

  return (
    <div className="bg-muted/30 rounded-md transition-all p-1.5">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1"
      >
        <div className="flex items-center gap-1.5">
          <ClipboardList className="h-3 w-3 text-orange-500" />
          <span className="text-xs font-mono">plan</span>
        </div>
        <code className="text-xs text-muted-foreground truncate flex-1">
          {preview}
        </code>
        <div className="ml-auto">
          <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

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

interface AgentDisplayProps {
  content: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function AgentDisplay({ content, isExpanded, onToggle }: AgentDisplayProps) {
  // Extract first line for preview
  const lines = content.split('\n');
  const preview = lines[0]?.replace(/^\*\*|\*\*$/g, '').replace(/^🤖\s*/, '').substring(0, 50) || 'Agent';

  return (
    <div className="bg-muted/30 rounded-md transition-all p-1.5">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1"
      >
        <div className="flex items-center gap-1.5">
          <Bot className="h-3 w-3 text-purple-500" />
          <span className="text-xs font-mono">agent</span>
        </div>
        <code className="text-xs text-muted-foreground truncate flex-1">
          {preview}
        </code>
        <div className="ml-auto">
          <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

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

interface ProgressDisplayProps {
  content: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function ProgressDisplay({ content, isExpanded, onToggle }: ProgressDisplayProps) {
  // Detect if this is a completion (✅) or in progress (🔄)
  const isCompleted = content.includes('✅');
  const preview = content.replace(/^[✅🔄]\s*/, '').substring(0, 50);

  return (
    <div className="bg-muted/30 rounded-md transition-all p-1.5">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1"
      >
        <div className="flex items-center gap-1.5">
          {isCompleted ? (
            <CheckCircle className="h-3 w-3 text-green-500" />
          ) : (
            <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
          )}
          <span className="text-xs font-mono">progress</span>
        </div>
        <code className="text-xs text-muted-foreground truncate flex-1">
          {preview}
        </code>
        <div className="ml-auto">
          <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

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
