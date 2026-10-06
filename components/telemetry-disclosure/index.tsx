'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { setTelemetryOptIn, track } from '@/lib/telemetry';
import { getDisclosureLines } from '@/lib/telemetry/events';

interface TelemetryDisclosureProps {
  open: boolean;
  onDismiss: () => void;
}

// Bump when the collected-events list changes, so the Details badge signals
// there is something new to review. Year and month (0-based) are all the badge shows.
const DISCLOSURE_UPDATED: [year: number, month: number] = [2026, 8];

export function TelemetryDisclosure({ open, onDismiss }: TelemetryDisclosureProps) {
  const t = useTranslations('telemetry');
  const { dateTime } = useLocalFormat();
  // Mid-month in local time, so no time zone can move it into a neighbouring month.
  const updated = dateTime(new Date(DISCLOSURE_UPDATED[0], DISCLOSURE_UPDATED[1], 15), { month: 'long', year: 'numeric' });
  // Which "what will be collected" category is expanded; only one at a time.
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  const handleDisable = () => {
    setTelemetryOptIn(false);
    onDismiss();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onDismiss(); }}>
      <DialogContent
        className="sm:max-w-md max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('intro')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm text-muted-foreground leading-relaxed overflow-y-auto min-h-0 -mx-1 px-1">
          <p className="text-sm">
            {t.rich('builtWith', {
              link: (chunks) => (
                <a
                  href="https://github.com/o-stahl/osw-analytics"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded bg-primary/15 px-1 py-0.5 text-primary no-underline hover:bg-primary/25"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>

          <Collapsible>
            <div className="rounded-lg bg-muted/50">
              <CollapsibleTrigger className="flex items-center gap-1.5 w-full p-3 text-xs text-foreground hover:text-foreground transition-colors group">
                <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                {t('details')}
                <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t('updated', { date: updated })}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-4 pb-4 space-y-3 text-sm text-muted-foreground">
                  <div>
                    <p className="text-[13px] font-semibold text-foreground mb-1.5">{t.rich('notCollected', {
                      em: (chunks) => <span className="text-primary uppercase">{chunks}</span>,
                    })}</p>
                    <ul className="list-disc pl-5 space-y-0.5">
                      <li>{t('prompts')}</li>
                      <li>{t('code')}</li>
                      <li>{t('keys')}</li>
                      <li>{t('completions')}</li>
                      <li>{t('errors')}</li>
                      <li>{t('identify')}</li>
                    </ul>
                  </div>

                  <div>
                    <p className="text-[13px] font-semibold text-foreground mb-1.5">{t('collected')}</p>
                    <div className="divide-y divide-border/60 rounded-md border border-border/60">
                      {getDisclosureLines().map(group => (
                        <Collapsible
                          key={group.id}
                          open={openCategory === group.id}
                          onOpenChange={(o) => setOpenCategory(o ? group.id : null)}
                        >
                          <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2.5 py-2 text-xs font-medium text-foreground/80 hover:text-foreground transition-colors group">
                            <ChevronDown className="h-3 w-3 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                            <span>{t(`categories.${group.id}`)}</span>
                            <span className="ml-auto text-muted-foreground">{group.lines.length}</span>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <ul className="list-disc pl-7 pr-3 pb-2 space-y-0.5">
                              {group.lines.map(line => <li key={line}>{t(`lines.${line}`)}</li>)}
                            </ul>
                          </CollapsibleContent>
                        </Collapsible>
                      ))}
                    </div>
                    <p className="mt-2">{t('randomId')}</p>
                  </div>
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between gap-2">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={handleDisable}>
            {t('disable')}
          </Button>
          <Button variant="accent" onClick={() => { track('telemetry_accepted'); onDismiss(); }}>
            {t('gotIt')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
