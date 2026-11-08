'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tip } from '@/components/ui/tooltip';

interface ChipsBlockProps {
  options: string[];
  onSelect: (value: string) => void;
  disabled?: boolean;
  /**
   * The option that was answered with, when the conversation shows it. A pick held only here is
   * lost whenever the block mounts again.
   */
  picked?: string | null;
}

export function ChipsBlock({ options, onSelect, disabled, picked }: ChipsBlockProps) {
  const t = useTranslations('chat');
  const [clicked, setClicked] = useState<string | null>(null);
  const selected = picked ?? clicked;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {options.map((option) => {
        const isSelected = selected === option;
        const isDimmed = selected !== null && !isSelected;
        return (
          <Tip key={option} label={selected || disabled ? undefined : t('tips.answer')}>
          <button
            onClick={() => {
              if (!selected && !disabled) {
                setClicked(option);
                onSelect(option);
              }
            }}
            disabled={!!selected || disabled}
            className={`text-xs px-3 py-1.5 rounded border transition-all ${
              isSelected
                ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                : isDimmed
                  ? 'border-border text-muted-foreground/30 cursor-default'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 cursor-pointer'
            }`}
          >
            {option}
            {isSelected && <span className="ml-1.5 text-[10px] opacity-60">✓</span>}
          </button>
          </Tip>
        );
      })}
    </div>
  );
}
