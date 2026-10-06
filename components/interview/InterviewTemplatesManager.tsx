'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InterviewTemplatesPanel } from './InterviewTemplatesPanel';

interface InterviewTemplatesManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: 'list' | 'create';
  onChanged?: () => void;
}

export function InterviewTemplatesManager({
  open,
  onOpenChange,
  initialMode = 'list',
  onChanged,
}: InterviewTemplatesManagerProps) {
  const t = useTranslations('interviews');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] sm:max-w-[85vw] lg:max-w-[70vw] xl:max-w-[900px] h-[90vh] p-0 overflow-hidden">
        {/* sr-only title so Radix has an accessible name in every mode */}
        <DialogHeader className="sr-only">
          <DialogTitle>{t('templates')}</DialogTitle>
        </DialogHeader>
        {open && <InterviewTemplatesPanel initialMode={initialMode} onChanged={onChanged} />}
      </DialogContent>
    </Dialog>
  );
}
