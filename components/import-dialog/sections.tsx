'use client';

/**
 * One component per section of the import preview.
 *
 * Each takes what it needs from a plan and, where there is a decision to make, the current
 * resolutions and a way to report a change; none reads storage, keeps state that outlives a
 * disclosure triangle, or decides anything. What a resolution *means* lives in `logic.ts`; the
 * shapes these are built from live in `primitives.tsx`.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ChevronRight, Info, Lock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { backendResolutionKey } from '@/lib/vfs/archive';
import type {
  ApplyResult,
  ArchiveIssue,
  FileResolution,
  ImportPlan,
  ImportResolutions,
  ImportTarget,
  ProjectManifest,
  SettingChange,
  SettingResolution,
} from '@/lib/vfs/archive';
import {
  applyToAllBackend,
  applyToAllFiles,
  backendResolutionOf,
  fileOptionsFor,
  fileResolutionOf,
  formatSettingValue,
  planTallies,
  settingResolutionOf,
  sharedBackendResolution,
  sharedFileResolution,
  splitPath,
  type BackendKind,
  type TallyTone,
} from './logic';
import { useImportCopy } from './copy';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { useArchiveMessage } from '@/lib/i18n/use-archive-message';
import {
  AddedRow,
  ALL_FILE_OPTIONS,
  ApplyToAll,
  Banner,
  BlockedList,
  PathLabel,
  ResolutionRow,
  Section,
  Segmented,
  SETTING_OPTIONS,
  useFileOptionLabels,
  useSettingOptionLabels,
} from './primitives';

export { Banner, BlockedList } from './primitives';

const TALLY_TONES: Record<TallyTone, string> = {
  added: 'bg-green-500/10 text-green-600 dark:text-green-400',
  conflicting: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  unchanged: 'bg-gray-500/10 text-gray-600 dark:text-gray-400',
  blocked: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

export type ResolutionPatch = (previous: ImportResolutions) => ImportResolutions;

/* -------------------------------------------------------------------------------------------- */
/* Sections                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** The at-a-glance answer. Sits above the scroll region, so it is never scrolled away from. */
export function Tallies({ plan, target }: { plan: ImportPlan; target: ImportTarget }) {
  const t = useTranslations('importDialog.tally');
  const { number } = useLocalFormat();
  return (
    <div className="flex flex-wrap gap-1.5">
      {planTallies(plan, target).map((tally) => (
        <span
          key={`${tally.tone}-${tally.label}`}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            TALLY_TONES[tally.tone]
          )}
        >
          <span className="font-semibold tabular-nums">{number(tally.count)}</span>
          {t(tally.label, { count: tally.count })}
        </span>
      ))}
    </div>
  );
}

/**
 * Warnings. None of them block — `plan.errors` do that — but they are not all the same weight.
 *
 * `ai-instructions` is the one a user is deciding something by: accepting it changes how the agent
 * behaves on this project, not what the project contains. It gets the orange treatment the
 * conflicting rows use, so it is not skimmed past as a remark. Still not red: nothing is refused
 * and nothing is stopped.
 *
 * The Browser-mode one uses `Lock` to match the existing "Server Mode Required" screen, so the two
 * read as one fact stated twice rather than as two different problems.
 */
export function WarningBanners({ warnings }: { warnings: ArchiveIssue[] }) {
  const archiveMessage = useArchiveMessage();
  const t = useTranslations('importDialog');
  const titles: Partial<Record<ArchiveIssue['code'], string>> = {
    'server-mode-required': t('warnServerMode'),
    'ai-instructions': t('warnAiInstructions'),
  };
  return (
    <>
      {warnings.map((warning, index) => (
        <Banner
          key={`${warning.code}-${index}`}
          tone={warning.code === 'ai-instructions' ? 'orange' : 'neutral'}
          icon={
            warning.code === 'server-mode-required'
              ? Lock
              : warning.code === 'ai-instructions'
                ? undefined
                : Info
          }
          title={titles[warning.code] ?? t('note')}
        >
          {archiveMessage(warning)}
        </Banner>
      ))}
    </>
  );
}

/** A folder of HTML from somewhere else is a real thing to want; it just says what it cannot know. */
export function LooseFilesBanner({ isNewProject }: { isNewProject: boolean }) {
  const t = useTranslations('importDialog');
  return (
    <Banner tone="neutral" title={t('filesNotArchive')}>
      {t.rich(isNewProject ? 'looseFilesNew' : 'looseFilesExisting', {
        code: chunks => <code className="font-mono text-xs">{chunks}</code>,
      })}
    </Banner>
  );
}

export function NewProjectSection({ manifest }: { manifest: ProjectManifest }) {
  const t = useTranslations('importDialog');
  const tc = useTranslations('common');
  return (
    <Section title={t('willBeCreated')}>
      <PlainRow label={tc('labels.name')} value={manifest.name} />
      {manifest.runtime && (
        <PlainRow label={tc('labels.runtime')} value={formatSettingValue('runtime', manifest.runtime) ?? t('notSet')} />
      )}
      {manifest.entryPoint && <PlainRow label={tc('labels.entryPoint')} value={manifest.entryPoint} />}
    </Section>
  );
}

function PlainRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted/50">
      <span className="text-sm font-medium">{label}</span>
      <span className="flex-1" />
      <span className="text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

export function FileConflictsSection({
  plan,
  resolutions,
  onChange,
}: {
  plan: ImportPlan;
  resolutions: ImportResolutions;
  onChange: (patch: ResolutionPatch) => void;
}) {
  const t = useTranslations('importDialog');
  return (
    <Section
      title={t('alreadyExist')}
      count={`${plan.files.conflicts.length}`}
      control={
        <ApplyToAll
          label={t('allFileConflicts')}
          value={sharedFileResolution(plan, resolutions)}
          onChange={(next) =>
            onChange((prev) => ({ ...prev, files: applyToAllFiles(plan, next) }))
          }
        />
      }
    >
      {plan.files.conflicts.map((conflict) => (
        <FileConflictRow
          key={conflict.path}
          conflict={conflict}
          value={fileResolutionOf(resolutions, conflict.path)}
          onChange={(next) =>
            onChange((prev) => ({ ...prev, files: { ...prev.files, [conflict.path]: next } }))
          }
        />
      ))}
    </Section>
  );
}

function FileConflictRow({
  conflict,
  value,
  onChange,
}: {
  conflict: ImportPlan['files']['conflicts'][number];
  value: FileResolution;
  onChange: (value: FileResolution) => void;
}) {
  const t = useTranslations('importDialog');
  const fileOptionLabels = useFileOptionLabels();
  const copy = useImportCopy();
  const { recent } = useLocalFormat();
  const when = (date: Date | undefined) => (date ? recent(date) : t('unknownTime'));
  const [open, setOpen] = React.useState(false);
  const renamed = value === 'keep-both' ? conflict.keepBothPath : undefined;

  return (
    <ResolutionRow
      label={<PathLabel path={conflict.path} />}
      chip={
        conflict.currentIsNewer ? (
          <span className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-px text-[11px] font-medium text-orange-600 dark:text-orange-400">
            {t('yoursIsNewer')}
          </span>
        ) : undefined
      }
      rename={renamed ? splitPath(renamed).name : undefined}
      control={
        <Segmented
          ariaLabel={t('resolutionFor', { path: conflict.path })}
          value={value}
          // Two options when no renamed candidate fits the 200-character path limit. A third
          // option that cannot be carried out is worse than two that can.
          options={fileOptionsFor(conflict)}
          labels={fileOptionLabels}
          onChange={onChange}
        />
      }
      detailOpen={open}
      onToggleDetail={() => setOpen((prev) => !prev)}
      detail={
        <>
          <span className={cn(conflict.currentIsNewer && 'font-medium text-foreground')}>
            {t('yoursMeta', { size: copy.size(conflict.currentSize), when: when(conflict.currentUpdatedAt) })}
          </span>
          <span className="text-muted-foreground/70">{t('versus')}</span>
          <span className={cn(!conflict.currentIsNewer && 'font-medium text-foreground')}>
            {t('archiveMeta', { size: copy.size(conflict.incomingSize), when: when(conflict.incomingUpdatedAt) })}
          </span>
        </>
      }
    />
  );
}

/** A server function's kind, method or schedule, and whether it is disabled, as one line. */
export function describeBackendRecord(
  t: (key: `backendKind.${BackendKind}` | 'helper' | 'disabledTag') => string,
  record: { kind: BackendKind; detail: string; disabled?: true },
): string {
  // `detail` is a method or a schedule; a helper has neither, and the archive does not word either.
  return [t(`backendKind.${record.kind}`), record.detail || t('helper'), record.disabled && t('disabledTag')].filter(Boolean).join(' · ');
}

/** The server-functions section's count: how many are new and how many already exist. */
export function backendCountLabel(
  t: (key: 'countNew' | 'countExists', values: { count: number }) => string,
  plan: ImportPlan,
): string {
  const parts: string[] = [];
  if (plan.backend.added.length > 0) parts.push(t('countNew', { count: plan.backend.added.length }));
  if (plan.backend.conflicts.length > 0) parts.push(t('countExists', { count: plan.backend.conflicts.length }));
  return parts.join(' · ');
}

/**
 * Server functions.
 *
 * Carries its own warning rather than leaning on the confirm button: the checkpoint an import
 * takes snapshots files and directories only, so replacing a function is categorically riskier
 * than replacing a file and the one shared button cannot say two different things.
 */
export function BackendSection({
  plan,
  resolutions,
  onChange,
}: {
  plan: ImportPlan;
  resolutions: ImportResolutions;
  onChange: (patch: ResolutionPatch) => void;
}) {
  const t = useTranslations('importDialog');
  const fileOptionLabels = useFileOptionLabels();
  const kind = (k: BackendKind) => t(`backendKind.${k}`);
  const describe = (record: { kind: BackendKind; detail: string; disabled?: true }) => describeBackendRecord(t, record);

  return (
    <Section
      title={t('serverFunctions')}
      count={backendCountLabel(t, plan)}
      control={
        plan.backend.conflicts.length > 0 ? (
          <ApplyToAll
            label={t('allFunctionConflicts')}
            value={sharedBackendResolution(plan, resolutions)}
            onChange={(next) =>
              onChange((prev) => ({ ...prev, backend: applyToAllBackend(plan, next) }))
            }
          />
        ) : undefined
      }
    >
      {plan.backend.conflicts.length > 0 && (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          {t('replaceFunctionWarning')}
        </p>
      )}
      {plan.backend.added.map((record) => (
        <AddedRow
          key={backendResolutionKey(record.kind, record.name)}
          label={
            <>
              <span className="font-mono text-xs">{record.name}</span>
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground">
                {describe(record)}
              </span>
            </>
          }
        />
      ))}
      {plan.backend.conflicts.map((conflict) => {
        const value = backendResolutionOf(resolutions, conflict.kind, conflict.name);
        const key = backendResolutionKey(conflict.kind, conflict.name);
        return (
          <ResolutionRow
            key={key}
            label={<span className="font-mono text-xs">{conflict.name}</span>}
            meta={describe(conflict)}
            rename={value === 'keep-both' ? conflict.keepBothName : undefined}
            control={
              <Segmented
                ariaLabel={t('resolutionForFunction', { kind: kind(conflict.kind), name: conflict.name })}
                value={value}
                options={ALL_FILE_OPTIONS}
                labels={fileOptionLabels}
                // Keyed by kind and name: an edge function and a schedule share one name grammar,
                // so 'nightly' alone would have one decision quietly governing both.
                onChange={(next) =>
                  onChange((prev) => ({ ...prev, backend: { ...prev.backend, [key]: next } }))
                }
              />
            }
          />
        );
      })}
    </Section>
  );
}

/**
 * An archive never carries secret values. Saying so here heads off a site failing at runtime.
 *
 * The changed-description half is a remark, not a promise: a secret the project already has is
 * left exactly as it is, description included. Nothing in the dialog offers a choice about that,
 * so the banner does not claim one was made.
 */
export function SecretsBanner({ plan }: { plan: ImportPlan }) {
  const t = useTranslations('importDialog');
  const added = plan.backend.secretsAdded;
  const changed = plan.backend.secretsMetadataChanged;
  return (
    <Banner
      tone="neutral"
      title={
        added.length > 0
          ? t('secretsWillBeEmpty', { count: added.length })
          : t('secretsLeftAlone')
      }
    >
      {added.length > 0 && (
        <>{t('secretsNamed', { count: added.length, names: added.join(', ') })}</>
      )}
      {changed.length > 0 && (
        <span className="mt-1 block">
          {t('secretsChanged', { count: changed.length, names: changed.join(', ') })}
        </span>
      )}
    </Banner>
  );
}

/** Two options, and the same no-undo warning the backend section carries, for the same reason. */
export function SettingsSection({
  plan,
  resolutions,
  onChange,
}: {
  plan: ImportPlan;
  resolutions: ImportResolutions;
  onChange: (patch: ResolutionPatch) => void;
}) {
  const t = useTranslations('importDialog');
  const settingOptionLabels = useSettingOptionLabels();
  const shown = (key: SettingChange['key'], value: string | undefined) => formatSettingValue(key, value) ?? t('notSet');
  const setSetting = (key: SettingChange['key'], next: SettingResolution) =>
    onChange((prev) => ({ ...prev, settings: { ...prev.settings, [key]: next } }));

  return (
    <Section title={t('projectSettings')} count={t('countDiffer', { count: plan.settingChanges.length })}>
      <p className="px-2 pb-1 text-xs text-muted-foreground">
        {t('changeSettingWarning')}
      </p>
      {plan.settingChanges.map((change) => (
        <ResolutionRow
          key={change.key}
          label={<span className="text-sm font-medium">{t(`settingLabels.${change.key}`)}</span>}
          meta={`${shown(change.key, change.from)} → ${shown(change.key, change.to)}`}
          control={
            <Segmented
              ariaLabel={t('resolutionFor', { path: t(`settingLabels.${change.key}`) })}
              value={settingResolutionOf(resolutions, change.key)}
              options={SETTING_OPTIONS}
              labels={settingOptionLabels}
              onChange={(next) => setSetting(change.key, next)}
            />
          }
        />
      ))}
    </Section>
  );
}

export function BlockedSection({ issues }: { issues: ArchiveIssue[] }) {
  const t = useTranslations('importDialog');
  return (
    <Section title={t('cantBeImported')} count={`${issues.length}`}>
      <BlockedList issues={issues} />
    </Section>
  );
}

/** `added` is worth inspecting, so it folds open. */
export function AddedFilesFold({ paths, label }: { paths: string[]; label: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2.5 rounded-md p-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/50">
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
        )}
        {label}
        <span className="tabular-nums text-muted-foreground/70">{paths.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 pt-1">
          {paths.map((path) => (
            <AddedRow key={path} path={path} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Counts, never lists, and with no disclosure to suggest otherwise.
 *
 * Re-importing your own export makes everything unchanged, and a screenful of rows nobody can act
 * on is the wrong answer to "nothing to do".
 */
export function UnchangedCounts({ plan }: { plan: ImportPlan }) {
  const t = useTranslations('importDialog');
  const files = plan.files.unchanged.length;
  const backend = plan.backend.unchanged.length;
  return (
    <div className="flex flex-col gap-1 px-2 text-xs text-muted-foreground">
      {files > 0 && (
        <span>
          {t('identicalFiles', { count: files })}
        </span>
      )}
      {backend > 0 && (
        <span>
          {t('identicalFunctions', { count: backend })}
        </span>
      )}
    </div>
  );
}

/**
 * What the import actually did.
 *
 * States the limit of the undo alongside the good news, because 'a checkpoint was taken' reads as
 * a fuller promise than it is — and names the mechanism that restores *this* checkpoint. Not
 * 'Discard changes': that restores the checkpoint taken when the project was opened
 * (workspace/index.tsx), which would throw away everything since, import included.
 */
export function DoneSummary({ result }: { result: ApplyResult }) {
  const t = useTranslations('importDialog');
  const copy = useImportCopy();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Check className="mt-0.5 w-4 h-4 shrink-0 text-green-600 dark:text-green-400" />
        <div className="text-sm">
          <p className="font-medium">{copy.applied(result.applied)}</p>
          {result.checkpointId && (
            <p className="mt-1 text-muted-foreground">
              {t('checkpointNote')}
            </p>
          )}
        </div>
      </div>
      {result.failed.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium text-muted-foreground">
            {t('couldNotWrite', { count: result.failed.length })}
          </p>
          <BlockedList
            issues={result.failed.map((failure) => ({
              path: failure.path,
              code: 'validation-failed' as const,
              message: failure.message,
              text: failure.text,
            }))}
          />
        </div>
      )}
    </div>
  );
}
