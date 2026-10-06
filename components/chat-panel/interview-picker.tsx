import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Search, ClipboardList, ArrowRight, Plus, Settings2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { filterInterviewTemplates } from '@/lib/interview/templates';
import type { InterviewTemplate } from '@/lib/interview/types';

interface InterviewPickerProps {
  templates: InterviewTemplate[];
  onStart: (template: InterviewTemplate) => void;
  disabled?: boolean;
  onNew?: () => void;
  onManage?: () => void;
}

export function InterviewPicker({ templates, onStart, disabled, onNew, onManage }: InterviewPickerProps) {
  const t = useTranslations('chat');
  const tc = useTranslations('common');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => filterInterviewTemplates(templates, query), [templates, query]);
  const selected = selectedId ? filtered.find((tpl) => tpl.id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-blue-500">
        <ClipboardList className="h-4 w-4" />
        <span>{t('startInterview')}</span>
        <div className="ml-auto flex items-center gap-1">
          {onManage && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-muted-foreground gap-1"
              onClick={onManage}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t('manageInterviews')}
            </Button>
          )}
          {onNew && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-muted-foreground gap-1"
              onClick={onNew}
            >
              <Plus className="h-3.5 w-3.5" />
              {tc('actions.new')}
            </Button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchTemplates')}
          className="h-8 pl-8 text-xs"
        />
      </div>

      <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">{t('noTemplatesMatch', { query })}</div>
        ) : (
          filtered.map((tpl) => {
            const isSelected = tpl.id === selectedId;
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setSelectedId(tpl.id)}
                onDoubleClick={() => !disabled && onStart(tpl)}
                className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                  isSelected
                    ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500'
                    : 'border-border bg-card hover:bg-muted/50'
                }`}
              >
                <div className="text-xs font-medium text-foreground">{tpl.title}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{tpl.description}</div>
                {tpl.artifacts[0] && (
                  <div className="text-[11px] text-blue-500/80 mt-1 font-mono truncate">→ {tpl.artifacts[0].path}</div>
                )}
              </button>
            );
          })
        )}
      </div>

      <Button
        size="sm"
        disabled={!selected || disabled}
        onClick={() => selected && onStart(selected)}
        className="bg-blue-500 hover:bg-blue-600 text-white gap-1.5"
      >
        <ArrowRight className="h-3.5 w-3.5" />
        {t('startInterviewButton')}
      </Button>
    </div>
  );
}
