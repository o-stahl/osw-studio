'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { StudioApp } from '@/components/studio-app';
import { SignInRelay } from '@/components/sign-in-relay';
import { isRelayedReturn } from '@/lib/auth/provider-sign-in';
import { REPO_URL } from '@/lib/constants/links';
import { writeWorkspaceCookie } from '@/lib/web/workspace-cookie';

/**
 * Root page
 *
 * Browser mode: Renders the StudioApp (single-page app)
 * Server mode (desktop): Bootstraps workspace, sets cookie, redirects
 * Server mode (web): Redirects to /admin/projects (middleware handles workspace routing)
 */
export default function Home() {
  const tc = useTranslations('common');
  const tb = useTranslations('boot');
  const router = useRouter();
  // The server's own words when it sent some, else the status: worded at render, in the UI's language.
  const [bootError, setBootError] = useState<{ message?: string; status?: number } | null>(null);
  const [bootDetail, setBootDetail] = useState<string | null>(null);
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const isDesktop = process.env.NEXT_PUBLIC_DESKTOP === 'true';
  // The HuggingFace Space's popup coming back from a provider sign-in finishes it and shows only that;
  // it is decided before paint, since only the browser holds the pending sign-in, and nothing
  // mounts until it is, so the studio does not start its boot work inside that popup.
  const [relay, setRelay] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (!isServerMode) setRelay(isRelayedReturn());
  }, [isServerMode]);

  useEffect(() => {
    if (!isServerMode) return;

    if (isDesktop) {
      // Always bootstrap — desktop-init is idempotent and validates that the
      // workspace actually exists. Trusting the cookie alone routed users into
      // a dead workspace when the database was lost (e.g. during an update),
      // with no way to recover.
      fetch('/api/auth/desktop-init', { method: 'POST' })
        .then(async r => {
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.workspaceId) {
            writeWorkspaceCookie(data.workspaceId);
            // The query carries a provider sign-in's return, which the workspace page finishes.
            router.replace(`/w/${data.workspaceId}/projects${window.location.search}`);
          } else {
            setBootError({ message: data.error, status: r.status });
            if (data.detail) setBootDetail(data.detail);
          }
        })
        .catch((err) => {
          setBootError({});
          if (err instanceof Error) setBootDetail(err.message);
        });
    } else {
      router.replace(`/admin/projects${window.location.search}`);
    }
  }, [isServerMode, isDesktop, router]);

  if (isServerMode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
        {bootError ? (
          <div className="max-w-lg px-8 text-zinc-400 space-y-3">
            <p className="text-zinc-200 font-semibold">{tb('couldNotInit')}</p>
            <p className="text-sm">
              {bootError.message
                ?? (bootError.status !== undefined ? tb('initFailed', { status: bootError.status }) : tb('requestFailed'))}
            </p>
            {bootDetail && (
              <pre className="text-xs bg-zinc-900 text-zinc-400 p-3 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                {bootDetail}
              </pre>
            )}
            <p className="text-sm">
              {tb.rich('reportHint', {
                link: (chunks) => (
                  <a className="underline" href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">
                    {chunks}
                  </a>
                ),
              })}
            </p>
          </div>
        ) : (
          <p className="text-zinc-400">{tc('loading')}</p>
        )}
      </div>
    );
  }

  if (relay === null) return null;
  return relay ? <SignInRelay /> : <StudioApp />;
}
