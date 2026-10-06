'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useBlockCatalog, useBlockCategories } from '@/lib/i18n/use-block-catalog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight, Info, X } from 'lucide-react';
import { SEMANTIC_BLOCKS, BLOCK_CATEGORIES, getBlockById } from '@/lib/semantic-blocks/registry';
import { BlockCard } from './block-card';
import type { SemanticBlock } from '@/lib/semantic-blocks/types';

interface PalettePanelProps {
  onDragStart: (block: SemanticBlock) => void;
  onClose: () => void;
  collapsed?: boolean;
}

export function PalettePanel({ onDragStart, onClose, collapsed = false }: PalettePanelProps) {
  const tt = useTranslations('tooltips');
  const t = useTranslations('semanticBlocks');
  const [search, setSearch] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const blockCopy = useBlockCatalog();
  const categoryLabels = useBlockCategories();

  // Palette copy is translated here, so the cards below keep reading `block.name` and the search
  // matches what the person actually sees.
  const localisedBlocks = useMemo(
    () => SEMANTIC_BLOCKS.map((b) => {
      const copy = blockCopy[b.id];
      return copy ? { ...b, name: copy.name, description: copy.description } : b;
    }),
    [blockCopy],
  );

  const filteredBlocks = useMemo(() => {
    if (!search.trim()) return localisedBlocks;
    const q = search.toLowerCase();
    return localisedBlocks.filter(
      b => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q)
    );
  }, [search, localisedBlocks]);

  // The cards carry translated copy; the drop marker and the agent need the English registry entry.
  const handleBlockDragStart = useCallback(
    (block: SemanticBlock) => onDragStart(getBlockById(block.id) ?? block),
    [onDragStart],
  );

  const toggleCategory = useCallback((cat: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  return (
    <div
      className="absolute left-0 top-4 z-20 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground backdrop-blur-sm shadow-lg flex flex-col max-h-[calc(55%-2rem)] w-[500px] max-w-full"
      style={collapsed ? { display: 'none' } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="px-3 pt-2.5 pb-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t('panelTitle')}</h3>
          <span className="text-[11px] text-muted-foreground flex-1 truncate">{t('dragHint')}</span>
          <button
            onClick={() => setShowInfo(!showInfo)}
            className="flex-shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            title={showInfo ? t('hideInfo') : t('whatAreBlocks')}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 flex-shrink-0"
            onClick={onClose}
            title={tt('closePalette')}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
        {showInfo && (
          <p className="text-[10px] text-muted-foreground mt-1.5 leading-snug">
            {t('infoParagraph')}
          </p>
        )}
        <Input
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-7 text-xs mt-2"
        />
      </div>

      {/* Block list */}
      <div className="overflow-y-auto flex-1 px-2 py-1.5">
        {BLOCK_CATEGORIES.map(category => {
          const blocks = filteredBlocks.filter(b => b.category === category);
          if (blocks.length === 0) return null;
          const isCollapsed = collapsedCategories.has(category);

          return (
            <div key={category} className="mb-1">
              <button
                onClick={() => toggleCategory(category)}
                className="flex items-center gap-1 w-full px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
              >
                {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {categoryLabels[category] ?? category}
                <span className="text-muted-foreground/50 ml-auto">{blocks.length}</span>
              </button>
              {!isCollapsed && (
                <div className="grid grid-cols-2 gap-1 pl-1">
                  {blocks.map(block => (
                    <BlockCard key={block.id} block={block} onDragStart={handleBlockDragStart} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {filteredBlocks.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-4">{t('noMatch', { query: search })}</div>
        )}
      </div>
    </div>
  );
}
