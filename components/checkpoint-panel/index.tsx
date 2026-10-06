'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { useCheckpointLabel } from '@/lib/i18n/use-checkpoint-label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { History, RotateCcw, ArrowRight, Inbox, Pin, PinOff, Loader2 } from 'lucide-react';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { checkpointManager, CheckpointMetadata } from '@/lib/vfs/checkpoint';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import type { DebugEvent } from '@/lib/stores/types';
import { toast } from 'sonner';

interface CheckpointPanelProps {
  projectId: string;
  events: DebugEvent[];
  currentCheckpointId?: string;
  onRestore: (checkpointId: string, description?: string) => void;
  onScrollToTurn: (checkpointId: string) => void;
  onClose?: () => void;
  refreshKey?: number;
}

export function CheckpointPanel({
  projectId,
  events,
  currentCheckpointId,
  onRestore,
  onScrollToTurn,
  onClose,
  refreshKey
}: CheckpointPanelProps) {
  const tw = useTranslations('workspace');
  const when = useLocalFormat();
  const tcp = useTranslations('checkpoints');
  const checkpointLabel = useCheckpointLabel();
  const [checkpoints, setCheckpoints] = useState<CheckpointMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const workspaceReady = useWorkspaceStore(s => s.workspaceReady);

  // Build set of checkpoint IDs that have linked turns in the current session
  const linkedCheckpointIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.event === 'checkpoint_created' && event.data?.checkpointId) {
        ids.add(event.data.checkpointId);
      }
    }
    return ids;
  }, [events]);

  // Load checkpoints on mount and when events change (new checkpoints may have been created)
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const cps = await checkpointManager.getCheckpoints(projectId);
      if (!cancelled) {
        setCheckpoints(cps);
        setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [projectId, events.length, refreshKey]);

  const handleTogglePin = async (cp: CheckpointMetadata) => {
    const success = cp.pinned
      ? await checkpointManager.unpinCheckpoint(cp.id)
      : await checkpointManager.pinCheckpoint(cp.id);

    if (success) {
      const updated = await checkpointManager.getCheckpoints(projectId);
      setCheckpoints(updated);
      toast.success(cp.pinned ? tw('checkpointUnpinned') : tw('checkpointPinned'));
    }
  };

  // Sort: pinned first (by timestamp desc), then unpinned (by timestamp desc)
  const sorted = useMemo(() => {
    const pinned = checkpoints.filter(cp => cp.pinned);
    const unpinned = checkpoints.filter(cp => !cp.pinned);
    return [...pinned, ...unpinned];
  }, [checkpoints]);

  return (
    <PanelContainer>
      <PanelHeader icon={History} title={tw('tabs.checkpoints')} color="var(--button-checkpoint-active)" onClose={onClose} panelKey="checkpoints" />

      {/* Checkpoint list */}
      <div className="flex-1 overflow-y-auto">
        {loading || !workspaceReady ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-4">
            <Loader2 className="h-5 w-5 animate-spin opacity-40" />
            <span className="text-xs">{tw('loadingCheckpoints')}</span>
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-4">
            <Inbox className="h-8 w-8 opacity-40" />
            <span className="text-xs text-center">{tw('noCheckpoints')}</span>
          </div>
        ) : (
          <div className="p-2 space-y-1.5">
            {sorted.map((cp) => {
              const isCurrent = cp.id === currentCheckpointId;
              const hasLinkedTurn = linkedCheckpointIds.has(cp.id);

              return (
                <div
                  key={cp.id}
                  className={`rounded-md border px-2.5 py-2 text-xs transition-colors ${
                    cp.pinned
                      ? 'border-amber-500/30 bg-amber-500/5'
                      : isCurrent
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border/60 bg-card hover:bg-muted/30'
                  }`}
                >
                  {/* Top row: badge + timestamp */}
                  <div className="flex items-center gap-1.5 mb-1">
                    {cp.pinned ? (
                      <Badge className="text-[9px] px-1.5 py-0 h-4 leading-none bg-amber-500/20 text-amber-500 border-amber-500/30 hover:bg-amber-500/30">
                        <Pin className="h-2.5 w-2.5 mr-0.5" />
                        {tcp('pinned')}
                      </Badge>
                    ) : (
                      <Badge
                        variant={cp.kind === 'manual' ? 'default' : 'secondary'}
                        className="text-[9px] px-1.5 py-0 h-4 leading-none"
                      >
                        {cp.kind === 'manual' ? tcp('kindManual') : tcp('kindAuto')}
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">
                      {when.relativeTime(cp.timestamp)}
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-[11px] text-foreground/80 truncate leading-snug mb-1.5">
                    {checkpointLabel(cp)}
                  </p>

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    {hasLinkedTurn && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => onScrollToTurn(cp.id)}
                      >
                        <ArrowRight className="h-3 w-3 mr-0.5" />
                        {tw('jump')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => handleTogglePin(cp)}
                      title={cp.pinned ? tw('unpinCheckpoint') : tw('pinCheckpoint')}
                    >
                      {cp.pinned ? (
                        <><PinOff className="h-3 w-3 mr-0.5" />{tw('unpin')}</>
                      ) : (
                        <><Pin className="h-3 w-3 mr-0.5" />{tw('pin')}</>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground ml-auto"
                      onClick={() => onRestore(cp.id, checkpointLabel(cp))}
                    >
                      <RotateCcw className="h-3 w-3 mr-0.5" />
                      {tw('restore')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sorted.length > 0 && (
        <div className="px-3 py-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground/50 text-center">{tw('checkpointStorageNote')}</p>
        </div>
      )}
    </PanelContainer>
  );
}
