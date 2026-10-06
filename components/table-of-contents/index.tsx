'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { TocItem } from '@/lib/hooks/use-table-of-contents';

interface TableOfContentsProps {
  items: TocItem[];
  activeId?: string;
  visibleIds?: string[];
  onItemClick?: (id: string) => void;
}

export function TableOfContents({ items, activeId, visibleIds = [], onItemClick }: TableOfContentsProps) {
  const t = useTranslations('docs');
  // Auto-scroll TOC to keep active item visible
  useEffect(() => {
    if (!activeId) return;

    // activeId is now the heading index as a string
    const activeElement = document.querySelector(`[data-toc-id="${activeId}"]`);
    if (activeElement) {
      activeElement.scrollIntoView({
        behavior: 'instant', // Use instant to avoid competing with content scroll
        block: 'nearest',
      });
    }
  }, [activeId]);

  if (items.length === 0) return null;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, item: TocItem) => {
    e.preventDefault();

    // Notify parent component about the click (using index as unique identifier)
    onItemClick?.(item.index.toString());

    // Use data-heading-index to target the specific heading
    const element = document.querySelector(`[data-heading-index="${item.index}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
      window.history.pushState(null, '', `#${item.id}`);
    }
  };

  return (
    <nav className="space-y-1">
      <p className="text-sm font-semibold mb-3 text-foreground">{t('onThisPage')}</p>
      <ul className="text-sm">
        {items.map((item) => (
          <li key={`${item.id}-${item.index}`}>
            <a
              href={`#${item.id}`}
              data-toc-id={item.index}
              onClick={(e) => handleClick(e, item)}
              className={cn(
                'block py-1 text-muted-foreground hover:text-foreground transition-colors',
                'border-l-2 pl-3',
                activeId === item.index.toString()
                  ? 'border-primary text-foreground font-medium'
                  : visibleIds.includes(item.index.toString())
                  ? 'border-blue-400/50 text-foreground/80'
                  : 'border-transparent'
              )}
            >
              {item.text}
            </a>
            {item.children && item.children.length > 0 && (
              <ul>
                {item.children.map((child) => (
                  <li key={`${child.id}-${child.index}`}>
                    <a
                      href={`#${child.id}`}
                      data-toc-id={child.index}
                      onClick={(e) => handleClick(e, child)}
                      className={cn(
                        'block py-1 text-xs text-muted-foreground hover:text-foreground transition-colors',
                        'border-l-2',
                        activeId === child.index.toString()
                          ? 'border-primary text-foreground font-medium'
                          : visibleIds.includes(child.index.toString())
                          ? 'border-blue-400/50 text-foreground/80'
                          : 'border-transparent'
                      )}
                      style={{ paddingLeft: 'calc(0.75rem * 1.67)' }}
                    >
                      {child.text}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
