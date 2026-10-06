'use client';

import { useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Languages, X } from 'lucide-react';
import { toast } from 'sonner';

import { getBackendStatus, subscribeBackendStatus } from '@/lib/api/backend-status';
import { getMcpActivity, subscribeMcpActivity } from '@/lib/api/mcp-activity';
import { setLocale } from '@/lib/i18n/actions';
import { defaultLocale } from '@/lib/i18n/config';
import type { OfferLocale } from '@/lib/i18n/config';
import type { OfferStrings } from '@/lib/i18n/offer';

/**
 * Offers a first-time visitor the language their browser prefers. Never switches on its own: both
 * answers write the cookie, so the offer is made once and then never again.
 *
 * Whether to offer at all is decided on the server, from the absent cookie and Accept-Language.
 * What is left here is where not to show it. The root layout has no pathname and the spec keeps
 * i18n out of the middleware, so the excluded routes are matched client-side, and the card waits
 * for mount so those routes never flash it.
 */
export function LanguageOffer({
  locale,
  strings,
  declineLabel,
}: {
  locale: OfferLocale;
  strings: OfferStrings;
  declineLabel: string;
}) {
  const t = useTranslations('settings');
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [urgentBanner, setUrgentBanner] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const read = () => {
      const status = getBackendStatus();
      setUrgentBanner(status.backendDown || status.authExpired || getMcpActivity() !== null);
    };
    read();
    const unsubscribes = [subscribeBackendStatus(read), subscribeMcpActivity(read)];
    return () => unsubscribes.forEach((off) => off());
  }, []);

  const answer = (chosen: OfferLocale | typeof defaultLocale) => {
    startTransition(async () => {
      try {
        await setLocale(chosen);
      } catch {
        toast.error(t('languageChangeFailed'));
        return;
      }
      // A refresh rather than a reload, so the open project and editor contents survive.
      router.refresh();
    });
  };

  if (!mounted) return null;
  // The consent screen is a decision surface of its own, and the sign-in pages are not the studio.
  if (['/mcp', '/admin', '/review', '/deployments'].some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }
  // The same yielding the other top bars do among themselves: this is the least urgent of the three.
  if (urgentBanner) return null;

  return (
    <div
      role="status"
      className="fixed top-0 inset-x-0 z-[59] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-sm bg-background border-b border-primary/30 shadow-md"
    >
      <Languages className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span>{strings.message}</span>
      <button
        type="button"
        onClick={() => answer(locale)}
        disabled={pending}
        className="rounded bg-primary/15 px-2 py-0.5 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
      >
        {strings.accept}
      </button>
      <button
        type="button"
        onClick={() => answer(defaultLocale)}
        disabled={pending}
        className="rounded border border-border px-2 py-0.5 hover:bg-muted transition-colors disabled:opacity-50"
      >
        {declineLabel}
      </button>
      <span className="text-xs text-muted-foreground">{strings.note}</span>
      <button
        type="button"
        onClick={() => answer(defaultLocale)}
        disabled={pending}
        className="ml-1 p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-50"
        aria-label={declineLabel}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
