'use client';

/**
 * The import preview.
 *
 * The archive layer keeps read, analyze and apply apart so that a preview can be trusted: nothing
 * has been written by the time this dialog is on screen. Its whole job is to state what applying
 * *would* do, collect the decisions that change that, and only then call apply.
 *
 * This file owns the state machine — which phase is on screen, how a source becomes a plan, and
 * what confirming does. The shapes it draws live in `sections.tsx`, and what a resolution means
 * lives in `logic.ts`.
 *
 * Three things it is careful about:
 *
 * - **Nothing is replaced without being asked for.** A resolution the user never touched is
 *   keep-mine, so the destructive path is always one they chose.
 * - **Backend and settings are riskier than files, and say so.** The checkpoint an import takes
 *   snapshots files and directories only (checkpoint.ts), so replacing a function or a setting is
 *   not covered by it — nor by the archive, which does not hold the previous code. One confirm
 *   button cannot carry that distinction, so those sections state it in words.
 * - **Warnings never block.** `plan.errors` gate the confirm button; `plan.warnings` only speak.
 *   The Browser-mode one means "these import but will not run here", not "something broke"; the
 *   AI-instructions one is a decision rather than a remark, and is toned accordingly.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { logger } from '@/lib/utils';
import { vfs } from '@/lib/vfs';
import {
  analyzeImport,
  applyImport,
  folderToArchiveEntries,
  readZipArchive,
} from '@/lib/vfs/archive';
import type {
  ApplyResult,
  ArchiveEntry,
  ArchiveIssue,
  ImportPlan,
  ImportResolutions,
  ImportTarget,
} from '@/lib/vfs/archive';
import {
  canConfirm,
  confirmAction,
  emptyResolutions,
  nothingToDoCounts,
  planTallies,
  selectPhase,
  type PlanPhase,
} from './logic';
import { useImportCopy } from './copy';
import { useArchiveMessage } from '@/lib/i18n/use-archive-message';
import {
  AddedFilesFold,
  BackendSection,
  Banner,
  BlockedList,
  BlockedSection,
  DoneSummary,
  FileConflictsSection,
  LooseFilesBanner,
  NewProjectSection,
  SecretsBanner,
  SettingsSection,
  Tallies,
  UnchangedCounts,
  WarningBanners,
} from './sections';

/**
 * What the user handed the importer. A folder drop and a zip differ only in how they are read, so
 * they are normalized to `ArchiveEntry[]` before anything else looks at them.
 */
export type ImportDialogSource =
  | { kind: 'zip'; file: File }
  | { kind: 'folder'; name: string; files: Array<{ file: File; path: string }> };

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while nothing has been chosen. Analysis restarts whenever this identifies a new source. */
  source: ImportDialogSource | null;
  target: ImportTarget;
  /** The project being imported into, for the title. Ignored for a new project. */
  projectName?: string;
  /** Called once, after a successful apply, when the user dismisses the result. */
  onComplete?: (result: ApplyResult) => void;
  /**
   * Store the dropped zip in the project as an ordinary file, which is what a drop did before the
   * importer existed. Supplied by the File Explorer so the upload runs through its own path —
   * size limits, ancestor directories, the file tree refresh — rather than a second one here.
   *
   * Only offered for a zip going into an existing project: a new project containing nothing but a
   * zip is not a project. Absent for the gallery, where the button simply does not appear.
   */
  onKeepAsFile?: (file: File) => Promise<void> | void;
}

/**
 * `PlanPhase` covers what a plan decides; these four cover what reading and applying decide.
 * `unreadable` has to exist — `JSZip.loadAsync` throws on a corrupt or encrypted zip, and without
 * a phase for it the dialog sits on its spinner forever.
 */
type Phase = PlanPhase | 'analyzing' | 'unreadable' | 'applying' | 'done';

/** The format names, keyed as the plan reports them. */
function useFormatLabels(): Record<string, string> {
  const t = useTranslations('importDialog.formats');
  return React.useMemo(() => ({
    archive: t('archive'),
    'loose-files': t('looseFiles'),
    'osws-backup': t('oswsBackup'),
    'oswt-template': t('oswtTemplate'),
  }), [t]);
}

function sourceLabel(source: ImportDialogSource): string {
  return source.kind === 'zip' ? source.file.name : source.name;
}

/**
 * What identifies a source, so re-analysis is driven by the archive changing rather than by the
 * caller happening to rebuild the prop object on a render — which, with `source` itself as an
 * effect dependency, would re-analyse forever.
 *
 * The trade is deliberate, and worth knowing when wiring a surface up: two *different* folders
 * with the same name and the same number of files, chosen one after the other without the dialog
 * closing in between, will not trigger a re-analysis. Closing and reopening always does, and every
 * call site opens the dialog on selection, so the case does not arise in practice. This is not a
 * bug waiting to be found — it is this line choosing stability over identity.
 */
function sourceSignature(source: ImportDialogSource | null): string {
  if (!source) return '';
  if (source.kind === 'zip') {
    return `zip:${source.file.name}:${source.file.size}:${source.file.lastModified}`;
  }
  return `folder:${source.name}:${source.files.length}`;
}

/** The keys {@link titleFor} reads, named so a missing one is a type error and not English copy. */
type TitleKey =
  | 'isWorkspaceBackup'
  | 'isTemplate'
  | 'finished'
  | 'asNewProject'
  | 'intoProject'
  | 'intoThisProject';

/**
 * The heading for a phase. Takes its translator as an argument rather than reading one itself, so
 * it stays a plain function that can be called from the one place that renders it.
 *
 * The key type is the union above rather than `string`, so passing `useTranslations`' own `t` makes
 * `tsc` check that every key named here exists in the messages.
 */
export function titleFor(
  t: (key: TitleKey, values?: Record<string, string>) => string,
  phase: Phase,
  plan: ImportPlan | null,
  isNewProject: boolean,
  projectName?: string
): string {
  if (phase === 'wrong-format' && plan) {
    return plan.format === 'osws-backup' ? t('isWorkspaceBackup') : t('isTemplate');
  }
  // 'nothing-to-do' and 'blocked' keep the ordinary title: the banner carries the finding, and
  // repeating it in the heading would say the same thing twice in two sizes.
  if (phase === 'done') return t('finished');
  if (isNewProject) return t('asNewProject');
  return projectName ? t('intoProject', { name: projectName }) : t('intoThisProject');
}

export function ImportDialog({
  open,
  onOpenChange,
  source,
  target,
  projectName,
  onComplete,
  onKeepAsFile,
}: ImportDialogProps) {
  const t = useTranslations('importDialog');
  const formatLabels = useFormatLabels();
  const tc = useTranslations('common');
  const copy = useImportCopy();
  const archiveMessage = useArchiveMessage();
  const [phase, setPhase] = React.useState<Phase>('analyzing');
  const [plan, setPlan] = React.useState<ImportPlan | null>(null);
  const [entries, setEntries] = React.useState<ArchiveEntry[]>([]);
  const [resolutions, setResolutions] = React.useState<ImportResolutions>(emptyResolutions);
  // The error itself, not its text, so it is worded in the language the dialog is showing.
  const [readError, setReadError] = React.useState<unknown>(null);
  const [result, setResult] = React.useState<ApplyResult | null>(null);
  const [keepingAsFile, setKeepingAsFile] = React.useState(false);

  const sourceRef = React.useRef(source);
  sourceRef.current = source;
  const signature = sourceSignature(source);

  // The prop is an object literal at every call site; the effect keys off what is actually stable.
  const projectId = target.kind === 'existing-project' ? target.projectId : undefined;
  const resolvedTarget = React.useMemo<ImportTarget>(
    () => (projectId ? { kind: 'existing-project', projectId } : { kind: 'new-project' }),
    [projectId]
  );

  React.useEffect(() => {
    if (!open || !signature) return;
    let cancelled = false;

    setPhase('analyzing');
    setPlan(null);
    setEntries([]);
    setResult(null);
    setReadError(null);
    setKeepingAsFile(false);
    setResolutions(emptyResolutions());

    (async () => {
      try {
        await vfs.init();
        const current = sourceRef.current;
        if (!current) return;
        let read: { entries: ArchiveEntry[]; issues: ArchiveIssue[] };
        if (current.kind === 'zip') {
          // JSZip throws on a corrupt or encrypted zip, and the budget guards throw on an archive
          // built to exhaust the reader. Both land in the catch — without it the spinner never ends.
          read = await readZipArchive(current.file);
        } else {
          read = folderToArchiveEntries(current.files);
        }
        const next = await analyzeImport(vfs, read.entries, resolvedTarget, read.issues);
        if (cancelled) return;
        setEntries(read.entries);
        setPlan(next);
        setPhase(selectPhase(next));
      } catch (error) {
        if (cancelled) return;
        logger.error('Failed to read archive for import:', error);
        setReadError(error);
        setPhase('unreadable');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, signature, resolvedTarget]);

  const close = React.useCallback(() => {
    if (phase === 'applying') return;
    onOpenChange(false);
    if (result) onComplete?.(result);
  }, [phase, onOpenChange, onComplete, result]);

  const handleConfirm = React.useCallback(async () => {
    if (!plan) return;
    // The same guard the analyze effect has, for the same reason: a result belongs to the source it
    // was applied from, and writing it after the source has changed would report this import's
    // outcome over the next one's freshly reset state.
    const startedFrom = signature;
    const stillCurrent = () => sourceSignature(sourceRef.current) === startedFrom;
    setPhase('applying');
    // The pinned-toast counter, as the folder drop does it: one toast, updated in place.
    const toastId = toast.loading(t('importing'));
    try {
      const applied = await applyImport(
        vfs,
        plan,
        resolutions,
        entries,
        resolvedTarget,
        (done, total) => {
          toast.loading(t('importingProgress', { done, total }), { id: toastId });
        }
      );
      if (stillCurrent()) {
        setResult(applied);
        setPhase('done');
      }
      if (applied.failed.length > 0) {
        toast.error(t('importedWithFailures', { summary: copy.applied(applied.applied), count: applied.failed.length }), {
          id: toastId,
        });
      } else {
        toast.success(copy.applied(applied.applied), { id: toastId });
      }
    } catch (error) {
      logger.error('Import failed:', error);
      toast.error(archiveMessage(error), { id: toastId });
      if (stillCurrent()) setPhase('ready');
    }
  }, [plan, resolutions, entries, resolvedTarget, signature, t, copy, archiveMessage]);

  const handleKeepAsFile = React.useCallback(async () => {
    const current = sourceRef.current;
    if (!onKeepAsFile || current?.kind !== 'zip') return;
    setKeepingAsFile(true);
    try {
      await onKeepAsFile(current.file);
      onOpenChange(false);
    } catch (error) {
      logger.error('Failed to store the archive as a file:', error);
      toast.error(archiveMessage(error));
      setKeepingAsFile(false);
    }
  }, [onKeepAsFile, onOpenChange, archiveMessage]);

  const isNewProject = resolvedTarget.kind === 'new-project';

  /**
   * A zip that will not import as a project is exactly when someone wants it as a file, so this is
   * offered wherever the import has stalled or is optional — including `blocked` and
   * `wrong-format`, where it is the only useful thing left to do. `unreadable` is left out on
   * purpose: a zip that could not even be opened is not worth storing.
   */
  const canKeepAsFile =
    Boolean(onKeepAsFile) &&
    source?.kind === 'zip' &&
    !isNewProject &&
    (phase === 'ready' ||
      phase === 'nothing-to-do' ||
      phase === 'blocked' ||
      phase === 'wrong-format');

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90vh] flex flex-col gap-4"
        showCloseButton={phase !== 'applying'}
        onEscapeKeyDown={(event) => {
          if (phase === 'applying') event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (phase === 'applying') event.preventDefault();
        }}
      >
        <DialogHeader className="flex-none">
          <DialogTitle>{titleFor(t, phase, plan, isNewProject, projectName)}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {source && <span className="font-mono text-xs">{sourceLabel(source)}</span>}
              {plan && phase !== 'analyzing' && (
                <>
                  <span className="rounded-md border px-2 py-px text-xs">
                    {formatLabels[plan.format] ?? plan.format}
                  </span>
                  <span className="text-xs">
                    {t('entriesCount', { count: plan.totals.entries })} · {copy.size(plan.totals.bytes)}
                  </span>
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {/* A settings-only import counts nothing, and an empty tally row is still a row: its
            wrapper takes the container's gap and leaves a band of blank above the sections. */}
        {plan && phase === 'ready' && planTallies(plan, resolvedTarget).length > 0 && (
          <div className="flex-none">
            <Tallies plan={plan} target={resolvedTarget} />
          </div>
        )}

        {/* The only scrolling region — header, tallies and footer stay put. `-mx-1 px-1` keeps a
            focus ring from being clipped at the scroll edge. */}
        <div className="flex-1 min-h-0 -mx-1 overflow-y-auto px-1">
          {(phase === 'analyzing' || phase === 'applying') && (
            <div className="flex items-center justify-center gap-3 py-10 text-muted-foreground">
              <Spinner size={20} />
              <span className="text-sm">
                {phase === 'analyzing' ? t('readingArchive') : t('importing')}
              </span>
            </div>
          )}

          {phase === 'unreadable' && (
            <Banner tone="red" title={t('archiveUnreadable')}>
              {readError ? archiveMessage(readError) : t('unreadableFallback')}
            </Banner>
          )}

          {phase === 'wrong-format' && plan && (
            <Banner tone="red" title={t('notProjectArchive')}>
              {plan.errors[0] ? archiveMessage(plan.errors[0]) : t('wrongImporter')}
            </Banner>
          )}

          {phase === 'blocked' && plan && (
            <div className="flex flex-col gap-4">
              <Banner tone="red" title={t('nothingImportable')}>
                {t('blockedNote')}
              </Banner>
              <BlockedList issues={plan.errors} />
            </div>
          )}

          {/* Nothing to write because everything already matches — the opposite outcome to
              'blocked', and neutral. Errors, if any, are listed under it rather than framing it. */}
          {phase === 'nothing-to-do' && plan && (
            <div className="flex flex-col gap-4">
              <Banner tone="neutral" title={t('nothingToImport')}>
                {copy.nothingToDo(nothingToDoCounts(plan))}
              </Banner>
              {plan.errors.length > 0 && <BlockedSection issues={plan.errors} />}
            </div>
          )}

          {phase === 'done' && result && <DoneSummary result={result} />}

          {phase === 'ready' && plan && (
            <div className="flex flex-col gap-5">
              <WarningBanners warnings={plan.warnings} />

              {plan.format === 'loose-files' && <LooseFilesBanner isNewProject={isNewProject} />}

              {isNewProject && plan.manifest && <NewProjectSection manifest={plan.manifest} />}

              {plan.files.conflicts.length > 0 && (
                <FileConflictsSection
                  plan={plan}
                  resolutions={resolutions}
                  onChange={setResolutions}
                />
              )}

              {(plan.backend.added.length > 0 || plan.backend.conflicts.length > 0) && (
                <BackendSection plan={plan} resolutions={resolutions} onChange={setResolutions} />
              )}

              {(plan.backend.secretsAdded.length > 0 ||
                plan.backend.secretsMetadataChanged.length > 0) && <SecretsBanner plan={plan} />}

              {plan.settingChanges.length > 0 && (
                <SettingsSection plan={plan} resolutions={resolutions} onChange={setResolutions} />
              )}

              {plan.errors.length > 0 && <BlockedSection issues={plan.errors} />}

              {plan.files.added.length > 0 && (
                <AddedFilesFold
                  paths={plan.files.added}
                  label={isNewProject ? t('files') : t('newFiles')}
                />
              )}

              {(plan.files.unchanged.length > 0 || plan.backend.unchanged.length > 0) && (
                <UnchangedCounts plan={plan} />
              )}
            </div>
          )}
        </div>

        <DialogFooter className="-mx-6 flex-none items-stretch gap-2 border-t px-6 pt-4 sm:items-center">
          {phase === 'ready' && plan && plan.errors.length > 0 && (
            <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={resolutions.skipBlocked}
                onCheckedChange={(checked) =>
                  setResolutions((prev) => ({ ...prev, skipBlocked: checked === true }))
                }
              />
              {t('skipBlocked', { count: plan.errors.length })}
            </label>
          )}

          {(phase === 'unreadable' ||
            phase === 'blocked' ||
            phase === 'nothing-to-do' ||
            phase === 'wrong-format') && (
            <span className="flex-1 text-sm text-muted-foreground">
              {isNewProject ? t('noProjectCreated') : t('noChangesMade')}
            </span>
          )}

          {phase === 'done' && <span className="flex-1" />}

          {phase !== 'done' && (
            <Button
              variant="outline"
              onClick={close}
              disabled={phase === 'applying' || keepingAsFile}
            >
              {phase === 'ready' ? tc('actions.cancel') : tc('actions.close')}
            </Button>
          )}

          {canKeepAsFile && (
            <Button variant="outline" onClick={handleKeepAsFile} disabled={keepingAsFile}>
              {keepingAsFile ? t('addingFile') : t('addAsFileInstead')}
            </Button>
          )}

          {phase === 'ready' && plan && (
            <Button
              // The accent, not `destructive`. An import is a commitment, not a deletion, and the
              // label already states the damage ('Import · replace 4 files'); red beside the brand
              // orange read as a wrong shade rather than as a warning. What is genuinely
              // unrecoverable is called out in the sections where that choice is made.
              variant="accent"
              disabled={!canConfirm(plan, resolutions) || keepingAsFile}
              onClick={handleConfirm}
            >
              {copy.confirm(confirmAction(plan, resolutions, resolvedTarget))}
            </Button>
          )}

          {phase === 'done' && <Button onClick={close}>{tc('actions.done')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ImportDialog;
