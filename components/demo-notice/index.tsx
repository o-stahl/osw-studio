'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Monitor, X } from 'lucide-react';

import { getBackendStatus, subscribeBackendStatus } from '@/lib/api/backend-status';
import { getMcpActivity, subscribeMcpActivity } from '@/lib/api/mcp-activity';
import { DEMO_NOTICE_COOKIE } from '@/lib/demo';
import { Tip } from '@/components/ui/tooltip';

/**
 * Tells a visitor to the hosted demo where their projects are kept, and where the hosted service is
 * when they want them on a server. Whether to show it at all is decided on the server
 * (`./slot.tsx`); dismissing it writes the cookie that ends it. Like the language offer, it gives
 * way to the urgent top bars and stays off the routes that are not the studio.
 */
export function DemoNotice({ signInUrl, signUpUrl }: { signInUrl: string; signUpUrl: string }) {
  const t = useTranslations('demo');
  const tc = useTranslations('common');
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [urgentBanner, setUrgentBanner] = useState(false);
  const [dismissed, setDismissed] = useState(false);

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

  const barRef = useRef<HTMLDivElement>(null);
  // The bridge page lives in a hidden frame inside a hosted workspace; it is not the demo itself.
  const excluded = ['/mcp', '/admin', '/review', '/deployments', '/demo-bridge'].some((prefix) => pathname.startsWith(prefix));
  const visible = mounted && !dismissed && !urgentBanner && !excluded;

  // The bar takes room instead of covering the top of the studio (the workspace header and its Deploy
  // button are up there): the page and its full-height containers leave `--app-top-offset` for it.
  useEffect(() => {
    const root = document.documentElement;
    const bar = barRef.current;
    if (!visible || !bar) {
      root.style.removeProperty('--app-top-offset');
      return;
    }
    const measure = () => root.style.setProperty('--app-top-offset', `${bar.offsetHeight}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--app-top-offset');
    };
  }, [visible]);

  const dismiss = () => {
    document.cookie = `${DEMO_NOTICE_COOKIE}=dismissed; path=/; max-age=31536000; samesite=lax`;
    setDismissed(true);
  };

  if (!visible) return null;

  return (
    <div
      ref={barRef}
      role="status"
      className="fixed top-0 inset-x-0 z-[59] flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm bg-background border-b border-primary/30 shadow-md"
    >
      <span className="flex items-start gap-2 min-w-0">
        <Monitor className="h-4 w-4 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        {/* A phone gets the short version: the bar takes room from the studio, so it stays small. */}
        <span className="sm:hidden">{t('noticeShort')}</span>
        <span className="hidden sm:inline">{t('notice')}</span>
      </span>
      <span className="flex items-center gap-2">
        {/* A new tab: the demo, and the project open in it, stay where they are. */}
        <Tip label={t('tips.signUp')} side="bottom">
          <a
            href={signUpUrl}
            target="_blank"
            rel="noopener"
            className="rounded bg-primary/15 px-2 py-0.5 text-primary hover:bg-primary/25 transition-colors"
          >
            {t('signUp')}
          </a>
        </Tip>
        <Tip label={t('tips.signIn')} side="bottom">
          <a
            href={signInUrl}
            target="_blank"
            rel="noopener"
            className="rounded border border-border px-2 py-0.5 hover:bg-muted transition-colors"
          >
            {t('signIn')}
          </a>
        </Tip>
        <Tip label={t('tips.dismiss')} side="bottom">
          <button
            type="button"
            onClick={dismiss}
            className="ml-1 p-0.5 rounded hover:bg-muted transition-colors"
            aria-label={tc('actions.dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </span>
    </div>
  );
}
