'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/lib/api/backend-status';
import { hostedDemoOrigin } from '@/lib/demo';
import { openDemoBridge, type DemoBridge, type DemoProjectList } from '@/lib/demo-bridge/client';
import { arrivedForDemoImport, settleDemoOffer } from '@/lib/demo-bridge/offer';
import type { DemoProjectSummary } from '@/lib/demo-bridge/protocol';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { fetchSyncStatus, invalidateSyncStatusCache, reconcileProjectsToServer, setAutoSyncWorkspaceId } from '@/lib/vfs/auto-sync';
import { vfs } from '@/lib/vfs';
import { getSyncManager } from '@/lib/vfs/sync-manager';
import { calculateItemSyncStatus } from '@/lib/vfs/sync-types';

/**
 * Bringing the projects a visitor made in the hosted demo into their workspace
 * (`lib/demo-bridge`). `DemoImportOffer` asks on its own on each landing the gateway marks, until the
 * account has dealt with the offer; the projects page's Import menu opens the same dialog by hand.
 */

type Stage =
  | { name: 'loading' }
  | { name: 'choose'; projects: DemoProjectSummary[] }
  | { name: 'empty' }
  /** Every project the demo has is already in this workspace. */
  | { name: 'allHere' }
  /** The demo has projects this page cannot read (Safari): the user exports and imports them. */
  | { name: 'unreachable'; count: number }
  | { name: 'importing' }
  /** The demo sent the projects, but this browser would not store them. */
  | { name: 'notAdded' }
  | { name: 'done'; imported: string[]; failed: number }
  | { name: 'removing' }
  /** Imported, but the demo kept its copies. */
  | { name: 'notRemoved' }
  | { name: 'error' };

/** What to show for the demo's list. Projects this workspace already has are not offered again. */
function stageFor({ projects, unreachable }: DemoProjectList, here: Set<string> = new Set()): Stage {
  const fresh = projects.filter((project) => !here.has(project.id));
  return fresh.length > 0 ? { name: 'choose', projects: fresh }
    : projects.length > 0 ? { name: 'allHere' }
      : unreachable > 0 ? { name: 'unreachable', count: unreachable }
        : { name: 'empty' };
}

/**
 * The workspace's projects, on the server or in this browser. Bringing the demo's copy of one again
 * would overwrite this browser's copy with the demo's.
 */
async function projectsHere(): Promise<Set<string>> {
  const [local, status] = await Promise.all([vfs.listProjects().catch(() => []), fetchSyncStatus()]);
  return new Set([
    ...local.map((project) => project.id),
    ...((status?.projects ?? []) as Array<{ id: string }>).map((project) => project.id),
  ]);
}

/** The bridge's limit for opening and for each answer in the offer: two of them fit the first run's wait. */
const OFFER_BRIDGE_TIMEOUT_MS = 6_000;

/** The gateway stops offering the import once the user has brought projects or said no. */
async function markHandled(workspaceId: string): Promise<void> {
  try {
    await apiFetch(`/api/w/${workspaceId}/demo-import`, { method: 'POST' });
  } catch {
    // Asked again at the next sign-in; nothing is lost.
  }
}

/**
 * Whether this browser's copy of a project reached the server whole. The server lists a project from
 * its first batch on; a push stamps the local copy only once the last one has landed.
 */
async function pushedInFull(projectId: string): Promise<boolean> {
  try {
    const project = await vfs.getProject(projectId);
    return !!project
      && calculateItemSyncStatus(project.updatedAt, project.serverUpdatedAt ?? null, project.lastSyncedAt ?? null) === 'synced';
  } catch {
    return false;
  }
}

/**
 * A project's backend features (edge and server functions, secrets, schedules), which the file sync
 * does not carry, taken to the server. True when it has none or they arrived.
 */
async function pushBackendFeatures(projectId: string, workspaceId: string): Promise<boolean> {
  try {
    const adapter = await vfs.getStorageAdapter();
    const features = {
      edgeFunctions: adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [],
      serverFunctions: adapter.listServerFunctions ? await adapter.listServerFunctions(projectId) : [],
      secrets: adapter.listSecrets ? await adapter.listSecrets(projectId) : [],
      scheduledFunctions: adapter.listScheduledFunctions ? await adapter.listScheduledFunctions(projectId) : [],
    };
    if (Object.values(features).every((list) => list.length === 0)) return true;
    return (await getSyncManager(workspaceId).pushBackendFeatures(projectId, features)).success;
  } catch {
    return false;
  }
}

/** Server projects and how many more the plan allows (Infinity without a limit). */
async function workspaceRoom(): Promise<{ count: number; remaining: number } | null> {
  const status = await fetchSyncStatus();
  if (!status) return null;
  const count = status.quota?.projects?.used ?? (status.projects ?? []).length;
  const max = status.quota?.projects?.max;
  return { count, remaining: typeof max === 'number' ? Math.max(0, max - count) : Infinity };
}

export function DemoImportDialog({
  open,
  onOpenChange,
  workspaceId,
  demoOrigin,
  mode,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  demoOrigin: string;
  /** `offer`: asked on arrival, with a "No thanks" that ends the offer. `manual`: from the Import menu. */
  mode: 'offer' | 'manual';
  /** A bridge already open, and what it listed (the offer opens it to see whether to ask at all). */
  initial?: { bridge: DemoBridge } & DemoProjectList;
}) {
  const t = useTranslations('demoImport');
  const tProjects = useTranslations('projects');
  const tCommon = useTranslations('common');
  const when = useLocalFormat();
  const [bridge, setBridge] = useState<DemoBridge | null>(initial?.bridge ?? null);
  const [stage, setStage] = useState<Stage>(initial ? stageFor(initial) : { name: 'loading' });
  // How many more projects the plan allows, null until the server has said.
  const [remaining, setRemaining] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAutoSyncWorkspaceId(workspaceId);
    void workspaceRoom().then((room) => {
      // Unknown room (the server did not answer): nothing is held back here.
      if (!cancelled) setRemaining(room ? room.remaining : Infinity);
    });
    if (initial) {
      void projectsHere().then((here) => { if (!cancelled) setStage(stageFor(initial, here)); });
      return () => { cancelled = true; };
    }
    let opened: DemoBridge | null = null;
    (async () => {
      try {
        opened = await openDemoBridge(demoOrigin);
        if (cancelled) return opened.close();
        setBridge(opened);
        const list = await opened.list();
        const here = await projectsHere();
        if (!cancelled) setStage(stageFor(list, here));
      } catch {
        if (!cancelled) setStage({ name: 'error' });
      }
    })();
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [open, workspaceId, demoOrigin, initial]);

  // Once both are known, everything is chosen up front when it fits; otherwise the user picks.
  const projects = stage.name === 'choose' ? stage.projects : null;
  useEffect(() => {
    if (!projects || remaining === null) return;
    setSelected(new Set(projects.length <= remaining ? projects.map((project) => project.id) : []));
  }, [projects, remaining]);

  const finish = useCallback((reload: boolean) => {
    bridge?.close();
    onOpenChange(false);
    // The projects list reads this browser's copy, which the import wrote straight into.
    if (reload) window.location.reload();
  }, [bridge, onOpenChange]);

  const decline = async () => {
    await markHandled(workspaceId);
    finish(false);
  };

  // Told how to bring them by hand: in the offer, that settles it, as an import or a no would.
  const acknowledge = async () => {
    if (mode === 'offer') await markHandled(workspaceId);
    finish(false);
  };

  const importChosen = async () => {
    if (!bridge) return;
    const ids = Array.from(selected);
    setStage({ name: 'importing' });
    let backup: Blob;
    try {
      backup = await bridge.exportProjects(ids);
    } catch {
      setStage({ name: 'error' });
      return;
    }
    try {
      const { BackupService } = await import('@/lib/vfs/backup-service');
      await BackupService.importAllData(new File([backup], 'demo.osws'), { mode: 'merge' });
    } catch {
      setStage({ name: 'notAdded' });
      return;
    }
    try {
      invalidateSyncStatusCache();
      await reconcileProjectsToServer(workspaceId);
      invalidateSyncStatusCache();
      const status = await fetchSyncStatus();
      const onServer = new Set<string>((status?.projects ?? []).map((project: { id: string }) => project.id));
      // On the server only once its files and its backend features both arrived: until then the
      // demo's copy is the only complete one.
      const whole = await Promise.all(ids.map(async (id) => onServer.has(id) && (await pushedInFull(id)) && (await pushBackendFeatures(id, workspaceId))));
      const imported = ids.filter((_, i) => whole[i]);
      // Nothing reached the server: the offer stays open for the next sign-in.
      if (imported.length > 0) await markHandled(workspaceId);
      setStage({ name: 'done', imported, failed: ids.length - imported.length });
    } catch {
      // In this browser, and still in the demo: saved nowhere else.
      setStage({ name: 'done', imported: [], failed: ids.length });
    }
  };

  const removeFromDemo = async (ids: string[]) => {
    setStage({ name: 'removing' });
    try {
      await bridge?.deleteProjects(ids);
    } catch {
      setStage({ name: 'notRemoved' });
      return;
    }
    finish(true);
  };

  const tooMany = remaining !== null && selected.size > remaining;
  const toggle = (id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const close = (next: boolean) => {
    if (next) return;
    if (stage.name === 'importing' || stage.name === 'removing') return;
    finish(stage.name === 'done' || stage.name === 'notRemoved');
  };

  const body = useMemo(() => {
    switch (stage.name) {
      case 'loading':
      case 'importing':
      case 'removing':
        return (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner size={16} />
            {t(stage.name)}
          </div>
        );
      case 'empty':
      case 'allHere':
        return <p className="py-4 text-sm text-muted-foreground">{t(stage.name)}</p>;
      case 'error':
        return <p className="py-4 text-sm text-muted-foreground">{t('failed')}</p>;
      case 'notAdded':
      case 'notRemoved':
        return <p className="py-4 text-sm text-muted-foreground">{t(stage.name)}</p>;
      case 'unreachable':
        return (
          <div className="space-y-2 py-2 text-sm">
            <p>{t('unreachable', { count: stage.count })}</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>{t('unreachableExport', { exportJson: tProjects('menu.exportJson') })}</li>
              <li>{t('unreachableImport', { import: tCommon('actions.import'), fromFile: tProjects('fromFile') })}</li>
            </ol>
          </div>
        );
      case 'done':
        return (
          <div className="space-y-2 py-2 text-sm">
            <p>{t('imported', { count: stage.imported.length })}</p>
            {stage.failed > 0 && <p className="text-muted-foreground">{t('notSaved', { count: stage.failed })}</p>}
            {stage.imported.length > 0 && <p className="text-muted-foreground">{t('keepQuestion')}</p>}
          </div>
        );
      case 'choose':
        return (
          <div className="space-y-3 py-2">
            {remaining !== null && Number.isFinite(remaining) && (
              <p className="text-xs text-muted-foreground">
                {remaining > 0 ? t('room', { count: remaining }) : t('noRoom')}
              </p>
            )}
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {stage.projects.map((project) => (
                <li key={project.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 hover:bg-accent/50">
                    <Checkbox
                      checked={selected.has(project.id)}
                      onCheckedChange={(on) => toggle(project.id, on === true)}
                      aria-label={project.name}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{project.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t('projectMeta', { files: project.fileCount, when: when.recent(new Date(project.updatedAt)) })}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        );
    }
  }, [stage, remaining, selected, t, tProjects, tCommon, when]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-primary" aria-hidden="true" />
            {mode === 'offer' ? t('offerTitle') : t('manualTitle')}
          </DialogTitle>
          <DialogDescription>{mode === 'offer' ? t('offerDescription') : t('manualDescription')}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          {stage.name === 'choose' && (
            <>
              <Button variant="outline" onClick={mode === 'offer' ? decline : () => finish(false)}>
                {mode === 'offer' ? t('noThanks') : t('cancel')}
              </Button>
              <Button variant="accent" onClick={importChosen} disabled={selected.size === 0 || tooMany}>
                {t('import', { count: selected.size })}
              </Button>
            </>
          )}
          {stage.name === 'done' && stage.imported.length > 0 && (
            <>
              <Button variant="outline" onClick={() => removeFromDemo(stage.imported)}>{t('remove')}</Button>
              <Button variant="accent" onClick={() => finish(true)}>{t('keep')}</Button>
            </>
          )}
          {stage.name === 'unreachable' && (
            <>
              <Button variant="outline" onClick={acknowledge}>{t('close')}</Button>
              <Button variant="accent" asChild>
                <a
                  href={demoOrigin}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => { if (mode === 'offer') void markHandled(workspaceId); }}
                >
                  {t('openDemo')}
                </a>
              </Button>
            </>
          )}
          {((stage.name === 'done' && stage.imported.length === 0) || ['empty', 'allHere', 'error', 'notAdded', 'notRemoved'].includes(stage.name)) && (
            <Button variant="outline" onClick={() => finish(stage.name === 'done' || stage.name === 'notRemoved')}>{t('close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks once, on the landing the gateway marks with `?demo_import=1` (it does until the account has
 * dealt with the offer), and only the workspace's `owner`, only into an empty workspace, and only
 * when the demo in this browser has projects. Ordinary loads never open the bridge. The gateway marks
 * an invited member's landing too: they are asked nothing, and the first run hears so at once.
 */
export function DemoImportOffer({ workspaceId, owner }: { workspaceId: string; owner: boolean }) {
  const [offer, setOffer] = useState<({ bridge: DemoBridge; demoOrigin: string } & DemoProjectList) | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const demoOrigin = hostedDemoOrigin();
    const url = new URL(window.location.href);
    // `arrivedForDemoImport` remembers the mark for the first run (lib/demo-bridge/offer.ts).
    if (!demoOrigin || !arrivedForDemoImport() || url.searchParams.get('demo_import') !== '1') return;
    // Consumed once: a reload, or a link copied from the address bar, does not ask again. So the
    // run is one-off and checks `mounted`, not a cleanup flag: Strict Mode's second run finds the
    // mark gone, and a flag set by the first cleanup would leave nobody to ask.
    url.searchParams.delete('demo_import');
    window.history.replaceState(window.history.state, '', url);
    if (!owner) {
      settleDemoOffer('none');
      return;
    }

    let bridge: DemoBridge | null = null;
    (async () => {
      setAutoSyncWorkspaceId(workspaceId);
      const room = await workspaceRoom();
      if (!room || room.count > 0 || !mounted.current) {
        settleDemoOffer('none');
        return;
      }
      // Quick enough to answer before the first run stops waiting for it (lib/demo-bridge/offer.ts).
      bridge = await openDemoBridge(demoOrigin, { timeoutMs: OFFER_BRIDGE_TIMEOUT_MS });
      const list = await bridge.list();
      if (!mounted.current || (list.projects.length === 0 && list.unreachable === 0)) {
        bridge.close();
        settleDemoOffer('none');
        return;
      }
      // Too late: the first visit went ahead without the offer.
      if (!settleDemoOffer('offered')) {
        bridge.close();
        return;
      }
      setOffer({ bridge, demoOrigin, ...list });
    })().catch(() => {
      bridge?.close();
      settleDemoOffer('none');
    });
  }, [workspaceId, owner]);

  // Leaving with the offer still open takes its hidden frame along (closing twice is harmless).
  useEffect(() => () => offer?.bridge.close(), [offer]);

  if (!offer) return null;
  return (
    <DemoImportDialog
      open
      onOpenChange={(open) => { if (!open) setOffer(null); }}
      workspaceId={workspaceId}
      demoOrigin={offer.demoOrigin}
      mode="offer"
      initial={offer}
    />
  );
}
