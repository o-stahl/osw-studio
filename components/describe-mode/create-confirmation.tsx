'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Loader2, FolderPlus } from 'lucide-react';

interface CreateConfirmationProps {
  name: string;
  onConfirm: () => void;
  onDecline: () => void;
  creating?: boolean;
}

export function CreateConfirmation({ name, onConfirm, onDecline, creating }: CreateConfirmationProps) {
  const tpx = useTranslations('projects');
  const tc = useTranslations('common');
  const tdx = useTranslations('describe');
  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
          <FolderPlus className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <Tip label={tdx('readyToCreate', { name })} align="start" truncated>
            <p className="text-sm font-medium truncate">{tdx('readyToCreate', { name })}</p>
          </Tip>
          <p className="text-xs text-muted-foreground">{tdx('canStillChange')}</p>
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={onDecline}
          disabled={creating}
        >
          {tdx('notYet')}
        </Button>
        <Tip label={creating ? undefined : tdx('tips.create')} align="end">
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={creating}
          >
            {creating ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />{tc('actions.creating')}</>
            ) : (
              tpx('create')
            )}
          </Button>
        </Tip>
      </div>
    </div>
  );
}
