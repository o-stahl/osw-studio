'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { configManager } from '@/lib/config/storage';
import { DISCLOSURE_SETTLED_EVENT, isDisclosurePending } from '@/lib/telemetry/disclosure-state';

function TourOfferCard({ onCreate, onStart, onClose }: {
  onCreate?: () => void;
  onStart: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('nav.tourOffer');
  // The app's dialog shape (`DialogContent`: border, radius, shadow) on the sidebar's surface (`bg-card`).
  return (
    <div role="status" className="relative grid w-[380px] max-w-[calc(100vw-32px)] gap-4 rounded-lg border bg-card p-6 text-card-foreground shadow-2xl">
      <div className="flex flex-col gap-2 pr-6">
        <p className="text-lg leading-none font-semibold">{t('title')}</p>
        <p className="text-sm text-muted-foreground">{onCreate ? t('descriptionWithCreate') : t('description')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {onCreate && <Button onClick={onCreate}>{t('create')}</Button>}
        <Button onClick={onStart}>{t('start')}</Button>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('dismiss')}
        className="absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * Offers the guided tour once per browser, on the first visit: a notice the person can take or
 * leave, never a tour that starts by itself. `createProject`, when given, adds a way straight into
 * a new project. The tour shows studio features, so the simple view is not offered it.
 *
 * It waits for the analytics disclosure to be answered, so the two do not arrive on top of each
 * other, and then for the page to settle, so it is not lost among the first load's notices.
 */
export function useTourOffer(startTour: () => void, enabled: boolean, createProject?: () => void): void {
  useEffect(() => {
    if (!enabled || configManager.hasOfferedTour()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offer = () => {
      timer = setTimeout(() => {
        if (configManager.hasOfferedTour()) return;
        configManager.setTourOffered();
        toast.custom((id) => (
          <TourOfferCard
            onCreate={createProject ? () => { toast.dismiss(id); createProject(); } : undefined}
            onStart={() => { toast.dismiss(id); startTour(); }}
            onClose={() => toast.dismiss(id)}
          />
        ), { duration: Infinity });
      }, 1500);
    };
    if (!isDisclosurePending()) {
      offer();
      return () => clearTimeout(timer);
    }
    const onSettled = () => offer();
    window.addEventListener(DISCLOSURE_SETTLED_EVENT, onSettled, { once: true });
    return () => {
      window.removeEventListener(DISCLOSURE_SETTLED_EVENT, onSettled);
      clearTimeout(timer);
    };
  }, [enabled, startTour, createProject]);
}
