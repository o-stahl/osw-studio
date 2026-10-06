'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTemplateIntents } from '@/lib/i18n/use-template-intents';
import { useTemplateCatalog, type TemplateCopy } from '@/lib/i18n/use-template-catalog';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Eye, Search, Server, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { BUILT_IN_TEMPLATES } from '@/lib/vfs/templates/registry';
import {
  TEMPLATE_INTENTS,
  UNCATEGORIZED_DESCRIPTION,
  UNCATEGORIZED_LABEL,
} from '@/lib/vfs/templates/intents';
import { getRuntimeConfig, getRuntimeBadge } from '@/lib/runtimes/registry';
import { configManager } from '@/lib/config/storage';
import { templatePreviewUnavailableReason } from '@/lib/vfs/templates/preview-project';
import { TemplatePreviewDialog } from './template-preview-dialog';
import type { CustomTemplate, ProjectRuntime, TemplateIntent } from '@/lib/vfs/types';

/**
 * Browse every template in one list and pick one.
 *
 * Project creation used to ask for a runtime first and then offer only the templates belonging to
 * it, which meant knowing what "Handlebars" or "Preact" implied before seeing what you could build.
 * Here the template is the choice and the runtime follows from it.
 *
 * Templates are grouped by what someone is setting out to make, under sticky headings that collapse
 * and stay collapsed between visits, the same shape the model picker uses for providers. Grouping
 * rather than filtering because the answer to "what do you want to build" is usually visible at a
 * glance, and a filter chip hides the other four answers behind a click; collapsing is the same
 * ability under the user's control instead, one section at a time and only when they ask. An empty
 * group is simply not drawn, so a category can be introduced before anything uses it.
 *
 * The list stays table-like on purpose: one row per template, details (including the thumbnail, if
 * the template has one) only on expand. A visual grid would not survive a few hundred templates.
 */

/** A built-in or custom template flattened to what the list needs. */
interface BrowsableTemplate {
  /** Selection value: a built-in id, or `custom:<id>`. */
  value: string;
  name: string;
  description: string;
  runtime: ProjectRuntime;
  /** Undefined for imported templates, which do not declare one. */
  intent?: TemplateIntent;
  isBuiltIn: boolean;
  tags: string[];
  author?: string;
  license?: string;
  thumbnail?: string;
  hasBackendFeatures: boolean;
}

/** Custom templates predate the runtime field; those without one are Handlebars. */
const LEGACY_CUSTOM_RUNTIME: ProjectRuntime = 'handlebars';

/**
 * Whether a custom template provisions anything. Built-ins declare `hasBackendFeatures` instead,
 * because their features travel with the files rather than the metadata this list is built from.
 */
function hasBackendFeatures(features: unknown): boolean {
  if (!features || typeof features !== 'object') return false;
  return Object.values(features as Record<string, unknown>).some(
    (v) => v === true || (Array.isArray(v) && v.length > 0)
  );
}

export function toBrowsableTemplates(
  customTemplates: CustomTemplate[],
  // Built-in copy, translated. A plain function cannot call a hook, so the caller passes it; an
  // absent entry keeps the registry's own English.
  copy: Record<string, TemplateCopy> = {},
): BrowsableTemplate[] {
  const builtIns: BrowsableTemplate[] = BUILT_IN_TEMPLATES.map((t) => ({
    value: t.id,
    name: copy[t.id]?.name ?? t.name,
    description: copy[t.id]?.description ?? t.description,
    runtime: t.runtime,
    intent: t.metadata?.intent,
    isBuiltIn: true,
    tags: t.metadata?.tags ?? [],
    author: t.metadata?.author,
    license: t.metadata?.license,
    hasBackendFeatures: t.hasBackendFeatures ?? false,
  }));

  const custom: BrowsableTemplate[] = customTemplates.map((t) => ({
    value: `custom:${t.id}`,
    name: t.name,
    description: t.description,
    runtime: t.runtime || LEGACY_CUSTOM_RUNTIME,
    intent: t.metadata?.intent,
    isBuiltIn: false,
    tags: t.metadata?.tags ?? [],
    author: t.metadata?.author,
    license: t.metadata?.license,
    thumbnail: t.metadata?.thumbnail,
    hasBackendFeatures: hasBackendFeatures(t.backendFeatures),
  }));

  return [...builtIns, ...custom];
}

/** One heading and the templates under it. */
export interface TemplateGroup {
  key: string;
  label: string;
  description: string;
  templates: BrowsableTemplate[];
}

/**
 * Splits the list into its headed sections, in the order the sections are declared.
 *
 * Empty sections are dropped rather than rendered empty, which is what lets a category exist before
 * any template uses it, and what keeps a search that matches two templates from drawing five
 * headings. Templates with no intent fall to the end under their own heading rather than being
 * sorted into a category their author never chose.
 */
export function groupByIntent(templates: BrowsableTemplate[]): TemplateGroup[] {
  const groups: TemplateGroup[] = [];

  for (const intent of TEMPLATE_INTENTS) {
    const matching = templates.filter((t) => t.intent === intent.id);
    if (matching.length === 0) continue;
    groups.push({
      key: intent.id,
      label: intent.label,
      description: intent.description,
      templates: matching,
    });
  }

  const declared = new Set(TEMPLATE_INTENTS.map((intent) => intent.id));
  const rest = templates.filter((t) => !t.intent || !declared.has(t.intent));
  if (rest.length > 0) {
    groups.push({
      key: 'uncategorized',
      label: UNCATEGORIZED_LABEL,
      description: UNCATEGORIZED_DESCRIPTION,
      templates: rest,
    });
  }

  return groups;
}

/** The runtime a template will give the project. */
export function runtimeForTemplate(
  value: string,
  customTemplates: CustomTemplate[]
): ProjectRuntime {
  if (value.startsWith('custom:')) {
    const id = value.slice('custom:'.length);
    return customTemplates.find((t) => t.id === id)?.runtime || LEGACY_CUSTOM_RUNTIME;
  }
  return BUILT_IN_TEMPLATES.find((t) => t.id === value)?.runtime || 'static';
}

function runtimeLabel(runtime: ProjectRuntime): string {
  return getRuntimeConfig(runtime).label;
}

/** Something this environment cannot do with a template, said before the project exists. */
export interface TemplateSupportNote {
  /**
   * Which limit this is. The wording lives in `templatesUi.supportNotes.<kind>` rather than here, so
   * the note can be translated and so callers and tests tell notes apart without reading them.
   */
  kind: 'project-kit' | 'terminal-runtime' | 'server-mode';
  /** A docs page that explains the limit, offered as a link after the detail. */
  doc?: { id: string };
}

/**
 * What this environment cannot do with a template.
 *
 * Derived from the runtime and the intent rather than declared per template, so a template added
 * later is covered without anyone remembering to mark it. Returns null when everything the
 * template offers works here, which is the common case.
 *
 * None of these stop a project being created. They are the things someone would otherwise find out
 * after building on it, which is the expensive time to learn them.
 */
export function templateSupportNote(
  template: Pick<BrowsableTemplate, 'runtime' | 'intent' | 'hasBackendFeatures'>,
  serverMode: boolean
): TemplateSupportNote | null {
  if (template.intent === 'project-kit') {
    return { kind: 'project-kit' };
  }

  if (getRuntimeConfig(template.runtime).previewMode === 'terminal') {
    return { kind: 'terminal-runtime' };
  }

  if (template.hasBackendFeatures && !serverMode) {
    // Provisioning is not gated on the mode, so the functions, secrets and schema really are
    // written into the project here and really do come back out of a download. What Browser mode
    // cannot do is run them, which is the part the note's wording says before anything is built.
    return { kind: 'server-mode', doc: { id: 'server-mode' } };
  }

  return null;
}

interface TemplateBrowserPanelProps {
  customTemplates: CustomTemplate[];
  /** Currently applied selection, so returning here starts where the user left off. */
  value: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  /** Reports the highlighted row so the dialog header can show it before it is applied. */
  onPendingChange?: (value: string) => void;
  /** Server mode only: used to route to template management. */
  workspaceId?: string;
}

/**
 * Fills the create dialog when it switches to template mode. Sized by its parent, which supplies
 * the header and back button — the same shape the Describe view uses.
 */
export function TemplateBrowserPanel({
  customTemplates,
  value,
  onConfirm,
  onCancel,
  onPendingChange,
  workspaceId,
}: TemplateBrowserPanelProps) {
  const t = useTranslations('templatesUi');
  const tc = useTranslations('common');
  const tIntents = useTranslations('templatesUi.intents');
  const intentCopy = useTemplateIntents();
  const tNotes = useTranslations('templatesUi.supportNotes');
  // Keyed by the note's kind, so a new kind with no wording fails `tsc` here.
  const noteCopy = useMemo<Record<TemplateSupportNote['kind'], { summary: string; detail: string; docLabel?: string }>>(() => ({
    'project-kit': { summary: tNotes('project-kit.summary'), detail: tNotes('project-kit.detail') },
    'terminal-runtime': { summary: tNotes('terminal-runtime.summary'), detail: tNotes('terminal-runtime.detail') },
    'server-mode': {
      summary: tNotes('server-mode.summary'),
      detail: tNotes('server-mode.detail'),
      docLabel: tNotes('server-mode.docLabel'),
    },
  }), [tNotes]);
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // Which sections are closed, remembered between visits: someone who never builds a website
  // should not have to scroll past that section every time they start a project. Before anyone has
  // said, the intents decide, which starts Starter closed.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const stored = configManager.getCollapsedTemplateGroups();
    if (stored) return new Set(stored);
    return new Set(TEMPLATE_INTENTS.filter((i) => i.collapsedByDefault).map((i) => i.id));
  });
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  /**
   * Persists the whole set whenever it changes, rather than from inside the updater above: React
   * may run an updater more than once, and a write belongs outside a function that has to be pure.
   *
   * Storing the whole set is deliberate. Writing one section at a time would drop the ones closed
   * by default that nobody has touched. Skipping the first render is also deliberate: storage
   * distinguishes "never said" from "opened everything", and persisting on mount would turn the
   * former into the latter before the reader had done anything.
   */
  const collapsedPersisted = useRef(false);
  useEffect(() => {
    if (!collapsedPersisted.current) {
      collapsedPersisted.current = true;
      return;
    }
    configManager.setCollapsedTemplateGroups([...collapsedGroups]);
  }, [collapsedGroups]);
  // Confirming is what applies the choice, so the pending pick is local until then.
  const [pending, setPending] = useState(value);

  // Which template is being previewed. Separate from the pending pick: looking at one is not
  // choosing it, and someone comparing two should not have their selection moved by the second.
  const [previewing, setPreviewing] = useState<BrowsableTemplate | null>(null);

  const select = (next: string) => {
    setPending(next);
    onPendingChange?.(next);
  };

  /**
   * Server mode routes per workspace, falling back to the legacy /admin path that middleware
   * redirects to the default workspace. Browser mode keeps the view in React state, so it listens
   * for `nav-to-view` instead — the same way the other dialogs leave for another view.
   *
   * Keyed off the mode rather than whether a workspace id was passed: server mode without one is
   * a real case, and treating it as browser mode would dispatch an event nothing listens for.
   */
  const goToTemplates = () => {
    if (process.env.NEXT_PUBLIC_SERVER_MODE === 'true') {
      router.push(workspaceId ? `/w/${workspaceId}/templates` : '/admin/templates');
      return;
    }
    window.dispatchEvent(new CustomEvent('nav-to-view', { detail: { view: 'templates' } }));
  };

  /**
   * Same split as goToTemplates. Browser mode reads `?doc=` on the root and switches the view, so
   * the query string is the whole navigation there; server mode has a route per workspace.
   */
  const goToDoc = (docId: string) => {
    if (process.env.NEXT_PUBLIC_SERVER_MODE === 'true') {
      router.push(
        workspaceId ? `/w/${workspaceId}/docs?doc=${docId}` : `/admin/docs?doc=${docId}`
      );
      return;
    }
    router.push(`/?doc=${docId}`);
  };

  const templateCopy = useTemplateCatalog();
  const all = useMemo(() => toBrowsableTemplates(customTemplates, templateCopy), [customTemplates, templateCopy]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((t) => (
      t.name.toLowerCase().includes(q)
      || t.description.toLowerCase().includes(q)
      || t.tags.some((tag) => tag.toLowerCase().includes(q))
      // The runtime is no longer a filter, so searching "svelte" has to be what finds a Svelte
      // template. Kept over a runtime dropdown: it costs one word and no extra control.
      || runtimeLabel(t.runtime).toLowerCase().includes(q)
    ));
  }, [all, query]);

  const groups = useMemo(() => groupByIntent(visible), [visible]);

  const pendingTemplate = all.find((t) => t.value === pending);
  const supportNote = pendingTemplate
    ? templateSupportNote(pendingTemplate, process.env.NEXT_PUBLIC_SERVER_MODE === 'true')
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <div className="px-4 py-3 shrink-0 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            className="pl-9"
            aria-label={t('search')}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 px-4 text-center">
            {t('noMatchQuoted', { query })}
          </p>
        ) : (
          groups.map((group) => {
            // A search overrides collapse: a section hiding the only match would read as though
            // the template were gone. Collapsing while searching is also not something anyone
            // asked for, so the stored state is left alone and simply not applied.
            const collapsed = !query.trim() && collapsedGroups.has(group.key);
            return (
              <section key={group.key} aria-labelledby={`template-group-${group.key}`}>
                {/* Sticky so the heading stays readable while scrolling a long section, the same
                    way the model picker keeps a provider visible over its models. */}
                {/* The background sits on the sticky box itself, not on the button inside it: a
                    transparent sticky header lets the row scrolling under it show through. */}
                <h3
                  id={`template-group-${group.key}`}
                  className="sticky top-0 z-10 bg-muted border-b border-border"
                >
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!collapsed}
                    aria-controls={`template-group-list-${group.key}`}
                    className="flex w-full px-4 py-1.5 hover:bg-muted/80 transition-colors items-baseline justify-between gap-2 text-left cursor-pointer"
                  >
                    <span className="flex items-baseline gap-1 shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                      {collapsed ? (
                        <ChevronRight className="w-3 h-3 shrink-0 self-center" />
                      ) : (
                        <ChevronDown className="w-3 h-3 shrink-0 self-center" />
                      )}
                      {intentCopy(group.key, group).label}
                      <span className="tabular-nums font-normal text-muted-foreground/70">
                        {group.templates.length}
                      </span>
                      {/* Says where the current pick is when its row is hidden. Without this, a
                          closed section is the one place the highlighted row cannot be seen, and
                          the footer names a template with nothing on screen to match it to. */}
                      {collapsed && group.templates.some((t) => t.value === pending) && (
                        <span className="font-normal normal-case tracking-normal text-foreground/80">
                          {tIntents('oneSelected')}
                        </span>
                      )}
                    </span>
                    {/* The description is what the section is for, so it gives way to the count
                        once the section is closed and the rows can no longer speak for it. */}
                    <span className="text-[10px] text-muted-foreground/80 truncate hidden sm:block">
                      {intentCopy(group.key, group).description}
                    </span>
                  </button>
                </h3>
                <ul
                  id={`template-group-list-${group.key}`}
                  className="divide-y divide-border/60"
                  hidden={collapsed}
                >
                  {group.templates.map((template) => (
                    <TemplateRow
                      key={template.value}
                      template={template}
                      selected={pending === template.value}
                      expanded={expanded === template.value}
                      onSelect={() => select(template.value)}
                      onPreview={() => setPreviewing(template)}
                      onToggleExpand={() =>
                        setExpanded((prev) => (prev === template.value ? null : template.value))
                      }
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      <div className="border-t border-border shrink-0">
        {supportNote && (
          <div
            role="status"
            className="flex gap-2.5 px-4 pt-3 text-xs text-muted-foreground"
          >
            <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" aria-hidden />
            <p>
              <span className="font-medium text-foreground">{noteCopy[supportNote.kind].summary}.</span>{' '}
              {noteCopy[supportNote.kind].detail}
              {supportNote.doc && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => goToDoc(supportNote.doc!.id)}
                    className="underline underline-offset-2 hover:text-foreground cursor-pointer"
                  >
                    {noteCopy[supportNote.kind].docLabel}
                  </button>
                </>
              )}
            </p>
          </div>
        )}
        <div className="px-4 py-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={goToTemplates}>
            {t('manageTemplates')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onCancel}>
              {tc('actions.cancel')}
            </Button>
            {/* "Select", not "Use": this only chooses the template. The project is created by the
                dialog this returns to, and calling both steps "use" made the first look final. */}
            <Button
              disabled={!pendingTemplate}
              onClick={() => pendingTemplate && onConfirm(pendingTemplate.value)}
            >
              {pendingTemplate ? t('selectNamed', { name: pendingTemplate.name }) : t('selectNone')}
            </Button>
          </div>
        </div>
      </div>

      <TemplatePreviewDialog
        value={previewing?.value ?? null}
        name={previewing?.name ?? ''}
        runtime={previewing?.runtime ?? 'static'}
        customTemplates={customTemplates}
        onClose={() => setPreviewing(null)}
      />
    </div>
  );
}


function TemplateRow({
  template,
  selected,
  expanded,
  onSelect,
  onPreview,
  onToggleExpand,
}: {
  template: BrowsableTemplate;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onToggleExpand: () => void;
}) {
  const t = useTranslations('templatesUi');
  const tc = useTranslations('common');
  const runtimeBadge = getRuntimeBadge(template.runtime);
  // Terminal runtimes have no page to show. The button stays in place and explains itself rather
  // than disappearing, so the row does not change shape from one template to the next.
  const noPreviewReason = templatePreviewUnavailableReason(template.runtime);
  const noPreview = noPreviewReason ? t(`previewUnavailable.${noPreviewReason}`) : null;

  return (
    <li className={cn('px-4', selected && 'bg-primary/10')}>
      <div className="flex items-center gap-2 py-2.5">
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={onToggleExpand}
          aria-pressed={selected}
          className="flex-1 min-w-0 text-left flex items-center gap-3"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={cn('truncate text-sm', selected ? 'font-semibold' : 'font-medium')}>
                {template.name}
              </span>
              {!template.isBuiltIn && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-auto shrink-0">
                  {tc('labels.custom')}
                </Badge>
              )}
              {template.hasBackendFeatures && (
                <Server
                  className="w-3.5 h-3.5 text-muted-foreground shrink-0"
                  aria-label={t('includesBackend')}
                />
              )}
            </span>
            {/* Expanded rows show the description in full. */}
            <span
              className={cn(
                'block text-xs text-muted-foreground mt-0.5',
                expanded ? 'whitespace-normal' : 'truncate'
              )}
            >
              {template.description}
            </span>
          </span>
          <Badge
            className={cn(
              'text-[10px] px-1.5 py-0 h-auto shrink-0 hidden sm:inline-flex',
              runtimeBadge.className
            )}
          >
            {runtimeBadge.label}
          </Badge>
        </button>
        <button
          type="button"
          onClick={onPreview}
          disabled={!!noPreview}
          title={noPreview ?? t('previewNamed', { name: template.name })}
          aria-label={noPreview ?? t('previewNamed', { name: template.name })}
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
        >
          <Eye className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={expanded ? t('hideDetailsFor', { name: template.name }) : t('showDetailsFor', { name: template.name })}
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"
        >
          {/* Down rather than right: the row itself is the select control, and a chevron pointing
              at it reads as "go here" rather than as the thing that opens the details below. */}
          <ChevronDown className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>

      {expanded && (
        <div className="pb-3 pr-8 space-y-3">
          {template.thumbnail && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={template.thumbnail}
              alt=""
              className="rounded-md border border-border/60 max-h-40 w-auto"
            />
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{tc('labels.runtime')}</dt>
            <dd>{runtimeLabel(template.runtime)}</dd>
            {template.author && (
              <>
                <dt className="text-muted-foreground">{tc('labels.author')}</dt>
                <dd>{template.author}</dd>
              </>
            )}
            {template.license && (
              <>
                <dt className="text-muted-foreground">{t('license')}</dt>
                <dd>{template.license}</dd>
              </>
            )}
            {template.hasBackendFeatures && (
              <>
                <dt className="text-muted-foreground">{t('includes')}</dt>
                <dd>{t('backendFeatures')}</dd>
              </>
            )}
          </dl>
          {template.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {template.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-auto">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
