'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { useCheckpointLabel } from '@/lib/i18n/use-checkpoint-label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { History, RotateCcw, MessageSquare, Inbox, Pin, Lock, Loader2, MoreHorizontal, Pencil, Trash2, ListChecks, CheckCheck, Check } from 'lucide-react';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { checkpointManager, CheckpointMetadata, savesLimit, unpinnedLimit } from '@/lib/vfs/checkpoint';
import type { CheckpointChanges } from '@/lib/vfs/checkpoint-changes';
import { Tip } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import type { DebugEvent } from '@/lib/stores/types';
import { toast } from 'sonner';

interface CheckpointPanelProps {
  projectId: string;
  events: DebugEvent[];
  /** The project's last save, which Discard Changes goes back to. */
  savedCheckpointId?: string | null;
  onRestore: (checkpointId: string, description?: string) => void;
  onScrollToTurn: (checkpointId: string) => void;
  onClose?: () => void;
  refreshKey?: number;
}

export function CheckpointPanel({
  projectId,
  events,
  savedCheckpointId,
  onRestore,
  onScrollToTurn,
  onClose,
  refreshKey
}: CheckpointPanelProps) {
  const tw = useTranslations('workspace');
  const ta = useTranslations('common.actions');
  const when = useLocalFormat();
  const tcp = useTranslations('checkpoints');
  const checkpointLabel = useCheckpointLabel();
  const [checkpoints, setCheckpoints] = useState<CheckpointMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const workspaceReady = useWorkspaceStore(s => s.workspaceReady);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  /** Checkpoints chosen in Select mode; null outside it. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [confirmingMany, setConfirmingMany] = useState(false);

  const MB = 1024 * 1024;
  const formatSize = (bytes: number) => bytes >= MB
    ? when.number(bytes / MB, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
    : when.number(Math.max(1, Math.round(bytes / 1024)), { style: 'unit', unit: 'kilobyte' });
  const changeText = (c: CheckpointChanges | undefined) => {
    if (!c) return null;
    if (c.files === 0) return tcp('noChanges');
    return c.added || c.removed ? tcp('changes', { files: c.files, added: c.added, removed: c.removed }) : tcp('changedFiles', { files: c.files });
  };

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

  const reload = async () => setCheckpoints(await checkpointManager.getCheckpoints(projectId));

  /**
   * The checkpoint the files came from and what has changed since, read again whenever the list
   * changes or a file does. Its row says Current while nothing has, and what changed once it has.
   */
  const [base, setBase] = useState<{ id: string; changes: CheckpointChanges } | null>(null);
  useEffect(() => {
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const compare = () => {
      const run = ++latest;
      checkpointManager.compareWithFiles(projectId)
        .then((result) => { if (run === latest) setBase(result); })
        .catch(() => { if (run === latest) setBase(null); });
    };
    const onFilesChanged = () => {
      clearTimeout(timer);
      timer = setTimeout(compare, 600);
    };
    compare();
    window.addEventListener('filesChanged', onFilesChanged);
    return () => {
      latest = -1;
      clearTimeout(timer);
      window.removeEventListener('filesChanged', onFilesChanged);
    };
  }, [projectId, checkpoints]);

  /**
   * Pinned by the person. An earlier Save pinned the current save until the next one; that pin is
   * not theirs, and the next save takes it off.
   */
  const kept = (cp: CheckpointMetadata) =>
    !!cp.pinned && (cp.pinnedBy === 'user' || cp.id !== savedCheckpointId);
  /** Pinned, or the latest save, which is always kept and so reads as pinned. */
  const held = (cp: CheckpointMetadata) => cp.id === savedCheckpointId || kept(cp);
  /**
   * What the lock on the latest save says. Before the first Save, Discard Changes goes back to the
   * checkpoint made when the project was opened, which is locked too but is no save.
   */
  const lockText = (cp: CheckpointMetadata) => cp.kind === 'manual'
    ? { tip: tcp('tips.currentSave'), label: tcp('latestSave') }
    : { tip: tcp('tips.untilFirstSave'), label: tcp('startPoint') };

  const handleTogglePin = async (cp: CheckpointMetadata) => {
    const unpinning = kept(cp);
    const success = unpinning
      ? await checkpointManager.unpinCheckpoint(cp.id)
      : await checkpointManager.pinCheckpoint(cp.id);

    if (success) {
      await reload();
      toast.success(unpinning ? tw('checkpointUnpinned') : tw('checkpointPinned'));
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { id, name } = renaming;
    setRenaming(null);
    if (!name.trim() || name.trim() === checkpoints.find(c => c.id === id)?.description) return;
    if (await checkpointManager.renameCheckpoint(id, name)) {
      await reload();
      toast.success(tcp('renamed'));
    } else {
      toast.error(tcp('changeFailed'));
    }
  };

  const handleDelete = async (id: string) => {
    setConfirmingDelete(null);
    if (await checkpointManager.deleteCheckpoint(id)) {
      await reload();
      // Undo and Redo step through this list; they re-read it on this.
      useWorkspaceStore.getState().incrementCheckpointRefresh();
      toast.success(tcp('deleted'));
    } else {
      toast.error(tcp('changeFailed'));
    }
  };

  const stopSelecting = () => { setSelected(null); setConfirmingMany(false); };

  const toggleSelected = (id: string) => setSelected((current) => {
    const next = new Set(current ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleDeleteSelected = async () => {
    // A checkpoint picked and then pruned by a run meanwhile is already gone.
    const ids = [...(selected ?? [])].filter(id => checkpoints.some(cp => cp.id === id));
    stopSelecting();
    let deleted = 0;
    for (const id of ids) if (await checkpointManager.deleteCheckpoint(id)) deleted++;
    await reload();
    useWorkspaceStore.getState().incrementCheckpointRefresh();
    if (deleted) toast.success(tcp('deletedMany', { count: deleted }));
    if (deleted < ids.length) toast.error(tcp('changeFailed'));
  };

  const totalSize = checkpoints.reduce((sum, cp) => sum + (cp.size ?? 0), 0);
  const keptCount = checkpoints.filter(held).length;

  // Pinned ones and the latest save first, each group newest first as listed.
  const sorted = [...checkpoints.filter(held), ...checkpoints.filter(cp => !held(cp))];

  const selectable = (cp: CheckpointMetadata) => cp.id !== savedCheckpointId;
  const selectAllUnpinned = () => setSelected(new Set(checkpoints.filter(cp => !kept(cp) && selectable(cp)).map(cp => cp.id)));
  const actionButton = 'h-5 w-5 p-0 text-muted-foreground hover:text-foreground';

  return (
    <PanelContainer>
      <PanelHeader
        icon={History}
        title={tw('tabs.checkpoints')}
        color="var(--button-checkpoint-active)"
        onClose={onClose}
        panelKey="checkpoints"
        actions={selected ? [
          { id: 'all-unpinned', icon: CheckCheck, label: tcp('allUnpinned'), tip: tcp('tips.allUnpinned'), labelled: true, onSelect: selectAllUnpinned },
          {
            id: 'delete-selected', icon: Trash2, label: ta('delete'), labelled: true, destructive: true,
            disabled: selected.size === 0, onSelect: () => setConfirmingMany(true),
          },
          { id: 'select', icon: ListChecks, label: ta('done'), labelled: true, onSelect: stopSelecting },
        ] : [{
          id: 'select', icon: ListChecks, label: tcp('select'), tip: tcp('tips.select'), labelled: true,
          disabled: checkpoints.length === 0,
          onSelect: () => setSelected(new Set()),
        }]}
      >
        {selected && (
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{tcp('selected', { count: selected.size })}</span>
        )}
      </PanelHeader>

      {selected && confirmingMany && (
        <div className="px-3 py-1.5 border-b border-border flex items-center gap-1" role="alert">
          <span className="text-[10px] text-foreground/80 mr-auto">{tcp('deleteManyConfirm', { count: selected.size })}</span>
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={() => setConfirmingMany(false)}>
            {ta('cancel')}
          </Button>
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive" onClick={() => { void handleDeleteSelected(); }}>
            {ta('delete')}
          </Button>
        </div>
      )}

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
              const isBase = base?.id === cp.id;
              const unchanged = isBase && base.changes.files === 0;
              const hasLinkedTurn = linkedCheckpointIds.has(cp.id);
              const line = changeText(cp.changes);
              const pinLabel = kept(cp) ? tw('unpin') : tw('pin');
              // In Select mode a row is one control: a click anywhere on it picks it.
              const picking = selected && selectable(cp);

              return (
                <div
                  key={cp.id}
                  className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    held(cp)
                      ? 'border-amber-500/30 bg-amber-500/5'
                      : isBase
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border/60 bg-card'
                  } ${picking ? 'cursor-pointer hover:bg-muted/30' : ''}`}
                  onClick={picking ? () => toggleSelected(cp.id) : undefined}
                >
                  {/* Badge or checkbox, the name, the size and the age */}
                  <div className="flex items-center gap-1.5 min-w-0">
                    {selected ? (
                      selectable(cp) ? (
                        <Checkbox
                          aria-label={checkpointLabel(cp)}
                          className="h-3.5 w-3.5"
                          checked={selected.has(cp.id)}
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={() => toggleSelected(cp.id)}
                        />
                      ) : (
                        <Tip label={tcp('tips.deleteSave')} align="start">
                          <span><Checkbox disabled aria-label={checkpointLabel(cp)} className="h-3.5 w-3.5" /></span>
                        </Tip>
                      )
                    ) : cp.id === savedCheckpointId && cp.kind === 'manual' ? (
                      <Tip label={tcp('tips.currentSave')}>
                        <Badge variant="default" className="text-[9px] px-1.5 py-0 h-4 leading-none">
                          {tcp('kindManual')}
                        </Badge>
                      </Tip>
                    ) : kept(cp) ? (
                      <Tip label={tcp('tips.pinned')}>
                        <Badge className="text-[9px] px-1.5 py-0 h-4 leading-none bg-amber-500/20 text-amber-500 border-amber-500/30 hover:bg-amber-500/30">
                          <Pin className="h-2.5 w-2.5 mr-0.5" />
                          {tcp('pinned')}
                        </Badge>
                      </Tip>
                    ) : (
                      <Tip label={cp.kind === 'manual' ? tcp('tips.manual') : cp.id === savedCheckpointId ? tcp('tips.untilFirstSave') : tcp('tips.auto')}>
                        <Badge
                          variant={cp.kind === 'manual' ? 'default' : 'secondary'}
                          className="text-[9px] px-1.5 py-0 h-4 leading-none"
                        >
                          {cp.kind === 'manual' ? tcp('kindManual') : tcp('kindAuto')}
                        </Badge>
                      </Tip>
                    )}
                    {renaming?.id === cp.id ? (
                      <Input
                        autoFocus
                        aria-label={tcp('namePlaceholder')}
                        placeholder={tcp('namePlaceholder')}
                        value={renaming.name}
                        maxLength={120}
                        className="h-5 text-[11px] px-1.5 flex-1 min-w-0"
                        onChange={(e) => setRenaming({ id: cp.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                          if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                        }}
                        onBlur={() => { void commitRename(); }}
                      />
                    ) : (
                      <Tip label={checkpointLabel(cp)} align="start" truncated>
                        <p className="text-[11px] text-foreground/80 truncate leading-snug flex-1 min-w-0">
                          {checkpointLabel(cp)}
                        </p>
                      </Tip>
                    )}
                    <Tip
                      label={[cp.size !== undefined ? tcp('tips.size') : null, when.dateTime(cp.timestamp, { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · ')}
                      align="end"
                    >
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap tabular-nums">
                        {cp.size !== undefined && <>{formatSize(cp.size)} · </>}
                        {when.recent(cp.timestamp)}
                      </span>
                    </Tip>
                  </div>

                  {/* What changed, and the row's actions */}
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-1 h-5">
                    {line && (
                      <Tip label={tcp('tips.changes')} align="start">
                        <span className="truncate tabular-nums">{line}</span>
                      </Tip>
                    )}
                    {!selected && <div className="flex items-center gap-0.5 ml-auto shrink-0">
                      {hasLinkedTurn && (
                        <Tip label={tcp('tips.jump')}>
                          <Button variant="ghost" size="sm" aria-label={tw('jump')} className={actionButton} onClick={() => onScrollToTurn(cp.id)}>
                            <MessageSquare className="h-3 w-3" />
                          </Button>
                        </Tip>
                      )}
                      {cp.id === savedCheckpointId ? (
                        <Tip label={lockText(cp).tip}>
                          <span role="img" aria-label={lockText(cp).label} className="inline-flex items-center justify-center h-5 w-5 text-amber-500">
                            <Lock className="h-3 w-3" />
                          </span>
                        </Tip>
                      ) : (
                        <Tip label={cp.kind === 'manual'
                          ? (kept(cp) ? tcp('tips.unpinSave', { count: savesLimit() }) : tcp('tips.pinSave', { count: savesLimit() }))
                          : (kept(cp) ? tcp('tips.unpin', { count: unpinnedLimit() }) : tcp('tips.pin', { count: unpinnedLimit() }))}>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={pinLabel}
                            className={`h-5 w-5 p-0 ${kept(cp) ? 'text-amber-500' : 'text-muted-foreground hover:text-foreground'}`}
                            onClick={() => handleTogglePin(cp)}
                          >
                            <Pin className="h-3 w-3" />
                          </Button>
                        </Tip>
                      )}
                      {/* Not modal: a modal menu traps focus while it closes and takes it from the name field. */}
                      <DropdownMenu modal={false}>
                        <Tip label={tcp('more')}>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" aria-label={tcp('more')} className={actionButton}>
                              <MoreHorizontal className="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                        </Tip>
                        <DropdownMenuContent align="end" className="min-w-[8rem]">
                          <DropdownMenuItem onSelect={() => setRenaming({ id: cp.id, name: cp.label ? '' : cp.description })}>
                            <Pencil className="h-3.5 w-3.5" />{ta('rename')}
                          </DropdownMenuItem>
                          {cp.id === savedCheckpointId ? (
                            <Tip label={tcp('tips.deleteSave')} align="start">
                              <div><DropdownMenuItem disabled><Trash2 className="h-3.5 w-3.5" />{ta('delete')}</DropdownMenuItem></div>
                            </Tip>
                          ) : (
                            <DropdownMenuItem onSelect={() => setConfirmingDelete(cp.id)}>
                              <Trash2 className="h-3.5 w-3.5" />{ta('delete')}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {unchanged ? (
                        <Tip label={tcp('tips.current')} align="end">
                          <span className="inline-flex items-center gap-0.5 h-5 px-1.5 text-[10px] font-medium text-primary">
                            <Check className="h-3 w-3" />
                            {tcp('current')}
                          </span>
                        </Tip>
                      ) : (
                        <Tip label={tcp('tips.restore')} align="end">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                            onClick={() => onRestore(cp.id, checkpointLabel(cp))}
                          >
                            <RotateCcw className="h-3 w-3 mr-0.5" />
                            {tw('restore')}
                          </Button>
                        </Tip>
                      )}
                    </div>}
                  </div>

                  {isBase && !unchanged && (
                    <Tip label={tcp('tips.editedSince')} align="start">
                      <p className="text-[10px] text-primary tabular-nums truncate mt-1">
                        {tcp('editedSince', { changes: changeText(base.changes) ?? '' })}
                      </p>
                    </Tip>
                  )}

                  {confirmingDelete === cp.id && (
                    <div className="flex items-center gap-1 mt-1.5" role="alert">
                      <span className="text-[10px] text-foreground/80 mr-auto">{tcp('deleteConfirm')}</span>
                      <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={() => setConfirmingDelete(null)}>
                        {ta('cancel')}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive" onClick={() => { void handleDelete(cp.id); }}>
                        {ta('delete')}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sorted.length > 0 && (
        <div className="px-3 py-2 border-t border-border space-y-0.5">
          <p className="text-[10px] text-muted-foreground text-center tabular-nums">
            {tcp('summary', { count: checkpoints.length, kept: keptCount, size: formatSize(totalSize) })}
          </p>
          <p className="text-[10px] text-muted-foreground/50 text-center">{tw('checkpointStorageNote')}</p>
        </div>
      )}
    </PanelContainer>
  );
}
