'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TreeNode } from '@/lib/preview/types';

/**
 * The last segment of a source path, which is what the badge shows.
 *
 * The full path is the row's `title`: `/partials/nav.hbs` in a 240px panel wraps or truncates to
 * something unreadable, and the thing the user is scanning for is which *file* a row came from.
 * A path that ends in a separator (or is one) has no basename to show, so it falls back to itself
 * rather than rendering an empty badge.
 */
export function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  const name = cut === -1 ? path : path.slice(cut + 1);
  return name || path;
}

/**
 * The badge's tooltip: the full path, plus the offset when the serializer captured one.
 *
 * The offset is a UTF-16 code-unit index into the file rather than a line number — `data-osw-src`
 * carries what the compiler knew — so it is labelled as an offset rather than shown as `:120`,
 * which reads as a line and is not one.
 */
export function sourceTitle(node: Pick<TreeNode, 'file' | 'line'>): string | undefined {
  if (!node.file) return undefined;
  return node.line === undefined ? node.file : `${node.file} (offset ${node.line})`;
}

/**
 * The class fragment shown after the tag name.
 *
 * Capped at two: the panel is a narrow column and a utility-class stack is a hundred characters of
 * noise that pushes the source badge off the row. The overflow is counted, not dropped silently.
 */
export function formatClassName(className: string | undefined): string {
  if (!className) return '';
  const classes = className.trim().split(/\s+/).filter(Boolean);
  if (classes.length === 0) return '';
  const shown = classes.slice(0, 2).map(c => `.${c}`).join('');
  return classes.length > 2 ? `${shown} +${classes.length - 2}` : shown;
}

export interface ElementsTreeRowProps {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onToggle: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
  onHover: (nodeId: string) => void;
}

/**
 * One row of the Elements tree. Presentational: it holds no expansion state and sends no messages,
 * following the file explorer's split where the panel owns `expanded` and the row only reports the
 * gesture.
 */
export function ElementsTreeRow({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
  onHover,
}: ElementsTreeRowProps) {
  const t = useTranslations('elementsPanel');
  const classFragment = formatClassName(node.className);

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 pr-2 py-1 rounded-md cursor-pointer transition-colors',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onMouseEnter={() => onHover(node.id)}
      onClick={() => onSelect(node.id)}
    >
      {node.hasChildren ? (
        <button
          type="button"
          className="h-4 w-4 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={expanded ? t('collapse', { tag: node.tag }) : t('expand', { tag: node.tag })}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}

      <span className="text-xs font-mono truncate">
        <span className="text-foreground">{node.tag}</span>
        {classFragment && <span className="text-muted-foreground">{classFragment}</span>}
      </span>

      <span className="flex-1" />

      {node.instances > 1 && (
        <span
          className="text-[10px] px-1 rounded shrink-0 bg-amber-500/15 text-amber-600 dark:text-amber-400"
          title={t('sharedSource', { count: node.instances })}
        >
          ×{node.instances}
        </span>
      )}

      {node.file && (
        <span
          className="text-[10px] text-muted-foreground shrink-0 max-w-[40%] truncate"
          title={sourceTitle(node)}
        >
          {basename(node.file)}
        </span>
      )}
    </div>
  );
}
