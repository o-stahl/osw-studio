'use client';

/**
 * The import preview's shared visual vocabulary.
 *
 * These are the shapes every section is built from — nothing here knows what an import plan is.
 * Split out of `sections.tsx` so that file reads as one section per screenful, and so the grammar
 * below is stated once:
 *
 * - The resolution control is the tab idiom from `components/ui/tabs.tsx` — a `bg-muted` track
 *   with the active option lifted on `bg-background` and a small shadow. No accent fill: a column
 *   of these would be a column of competing accents.
 * - Rows are `flex items-center gap-3 p-2 rounded-md hover:bg-muted/50`, matching `SyncItemRow`.
 * - Status colour is `bg-{colour}-500/10` with `text-{colour}-600 dark:text-{colour}-400`,
 *   matching `SyncStatusBadge`. Green added, orange conflicting, grey unchanged, red blocked.
 * - Banners are `p-3 bg-{colour}-500/10 border border-{colour}-500/30 rounded-lg`, matching
 *   `sync-dialog.tsx`. Three tones, in the same grammar as the status colours: neutral for a
 *   remark, orange for a decision worth stopping on, red for a refusal.
 * - Section headings pin to the top of the scroll area, because an apply-to-all governing two
 *   hundred rows cannot scroll out of reach of the rows it governs.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { useArchiveMessage } from '@/lib/i18n/use-archive-message';
import { AlertTriangle, ArrowLeftRight, ChevronDown, Info, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ArchiveIssue, FileResolution, SettingResolution } from '@/lib/vfs/archive';
import { splitPath } from './logic';

/** The resolution choices' labels, in the interface language. */
export function useFileOptionLabels(): Record<FileResolution, string> {
  const t = useTranslations('importDialog.fileOptions');
  return { 'keep-mine': t('keepMine'), replace: t('replace'), 'keep-both': t('keepBoth') };
}

export const ALL_FILE_OPTIONS: FileResolution[] = ['keep-mine', 'replace', 'keep-both'];

/** Two options, not three: a project has exactly one runtime, so there is no 'keep both'. */
export const SETTING_OPTIONS: SettingResolution[] = ['keep-current', 'use-archive'];
export function useSettingOptionLabels(): Record<SettingResolution, string> {
  const t = useTranslations('importDialog.settingOptions');
  return { 'keep-current': t('keepCurrent'), 'use-archive': t('useArchive') };
}

export type BannerTone = 'red' | 'orange' | 'neutral';

const BANNER_FRAME: Record<BannerTone, string> = {
  red: 'border-red-500/30 bg-red-500/10',
  orange: 'border-orange-500/30 bg-orange-500/10',
  neutral: 'border-border bg-muted/60',
};

const BANNER_GLYPH: Record<BannerTone, string> = {
  red: 'text-red-500',
  orange: 'text-orange-600 dark:text-orange-400',
  neutral: 'text-muted-foreground',
};

const BANNER_TITLE: Record<BannerTone, string> = {
  red: 'text-red-600 dark:text-red-400',
  orange: 'text-orange-600 dark:text-orange-400',
  neutral: '',
};

export function Banner({
  tone,
  title,
  icon: Icon,
  children,
}: {
  tone: BannerTone;
  title: string;
  icon?: typeof Info;
  children: React.ReactNode;
}) {
  const Glyph = Icon ?? (tone === 'neutral' ? Info : AlertTriangle);
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-3', BANNER_FRAME[tone])}>
      <Glyph className={cn('mt-0.5 w-4 h-4 shrink-0', BANNER_GLYPH[tone])} />
      <div className="min-w-0 text-sm">
        <p className={cn('font-medium', BANNER_TITLE[tone])}>{title}</p>
        <div className="mt-1 text-[13px] text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function Section({
  title,
  count,
  control,
  children,
}: {
  title: string;
  count?: string;
  control?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-2 bg-background px-2 py-1.5">
        <span className="text-[13px] font-medium text-muted-foreground">{title}</span>
        {count && <span className="text-xs tabular-nums text-muted-foreground/70">{count}</span>}
        {control && <span className="ml-auto">{control}</span>}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  ariaLabel,
  value,
  options,
  labels,
  onChange,
}: {
  ariaLabel: string;
  /** Undefined when a bulk control's rows disagree — no option reads as active. */
  value: T | undefined;
  options: T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 rounded-md bg-muted p-0.5"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'cursor-pointer whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium transition-all',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === option
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {labels[option]}
        </button>
      ))}
    </span>
  );
}

/** The apply-to-all, on the heading: the same job as a full-width bar in no extra height. */
export function ApplyToAll({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FileResolution | undefined;
  onChange: (value: FileResolution) => void;
}) {
  const t = useTranslations('importDialog');
  const fileOptionLabels = useFileOptionLabels();
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {t('allLabel')}
      <Segmented
        ariaLabel={label}
        value={value}
        options={ALL_FILE_OPTIONS}
        labels={fileOptionLabels}
        onChange={onChange}
      />
    </span>
  );
}

/**
 * One decision per line. The control already states the outcome, so the row adds only what the
 * control cannot say: which thing, and — where it is true — that yours is newer.
 *
 * At phone width the control drops to a second line rather than being squeezed. Three labelled
 * options do not survive sharing a narrow line with a path, hence the explicit `order-*`: the
 * chevron finishes line one, and the control wraps beneath, indented to align with the path.
 */
export function ResolutionRow({
  label,
  meta,
  chip,
  rename,
  control,
  detail,
  onToggleDetail,
  detailOpen,
}: {
  label: React.ReactNode;
  meta?: string;
  chip?: React.ReactNode;
  rename?: string;
  control: React.ReactNode;
  detail?: React.ReactNode;
  onToggleDetail?: () => void;
  detailOpen?: boolean;
}) {
  const t = useTranslations('importDialog');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md p-2 transition-colors hover:bg-muted/50">
        <ArrowLeftRight className="order-1 w-3.5 h-3.5 shrink-0 text-orange-600 dark:text-orange-400" />
        <span className="order-2 min-w-0 break-all">{label}</span>
        {meta && <span className="order-3 text-xs text-muted-foreground">{meta}</span>}
        {chip && <span className="order-3">{chip}</span>}
        {rename && (
          <span className="order-3 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
            → {rename}
          </span>
        )}
        <span className="order-4 flex-1" />
        {onToggleDetail && (
          <button
            type="button"
            aria-expanded={detailOpen}
            onClick={onToggleDetail}
            className="order-5 shrink-0 cursor-pointer rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:order-7"
          >
            <ChevronDown
              className={cn('w-3.5 h-3.5 transition-transform', detailOpen && 'rotate-180')}
            />
            <span className="sr-only">{t('compareVersions')}</span>
          </button>
        )}
        <span className="order-6 basis-full sm:hidden" />
        <span className="order-7 ml-[26px] sm:order-6 sm:ml-0">{control}</span>
      </div>
      {detailOpen && detail && (
        <div className="flex flex-wrap items-baseline gap-2 px-2 pb-1.5 pl-[34px] text-xs tabular-nums text-muted-foreground">
          {detail}
        </div>
      )}
    </div>
  );
}

/** Directory dimmed, filename not — a column of paths is scanned by name, not read from the left. */
export function PathLabel({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="font-mono text-xs">
      <span className="text-muted-foreground/70">{dir}</span>
      {name}
    </span>
  );
}

export function AddedRow({ path, label }: { path?: string; label?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted/50">
      <Plus className="w-3.5 h-3.5 shrink-0 text-green-600 dark:text-green-400" />
      {path ? <PathLabel path={path} /> : label}
    </div>
  );
}

export function BlockedList({ issues }: { issues: ArchiveIssue[] }) {
  const archiveMessage = useArchiveMessage();
  return (
    <div className="flex flex-col gap-0.5">
      {issues.map((issue, index) => (
        <div
          key={`${issue.path ?? 'archive'}-${index}`}
          className="flex items-start gap-3 rounded-md p-2 transition-colors hover:bg-muted/50"
        >
          <AlertTriangle className="mt-0.5 w-3.5 h-3.5 shrink-0 text-red-600 dark:text-red-400" />
          <div className="min-w-0 text-[13px] text-muted-foreground">
            {issue.path && (
              <span className="block break-all font-mono text-[13px] text-foreground">
                {issue.path}
              </span>
            )}
            {archiveMessage(issue)}
          </div>
        </div>
      ))}
    </div>
  );
}
