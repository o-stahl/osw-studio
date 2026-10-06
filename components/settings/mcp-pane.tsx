'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plug, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { SettingRow } from '@/components/ui/setting-row';
import { logger } from '@/lib/utils';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

/**
 * The MCP clients this account has authorised, and revoking one.
 *
 * A grant is a bearer token held by software outside the studio that can read and write a
 * workspace's files, run the agent and publish deployments. It lives until it is revoked, so
 * there has to be somewhere to see what holds one and cut it off.
 *
 * `MCP_ENABLED` is server-only and has no public twin, so whether the connector exists is
 * discovered by asking: the endpoint 404s when it is off, which this renders as an off state
 * rather than an error.
 */

interface Grant {
  id: string;
  clientName: string;
  workspaceId: string;
  scopes: string[];
  createdAt: string | number;
  lastUsedAt: string | number | null;
  recentActivity?: Array<{ tool: string; target: string | null; refused: boolean; at: string }>;
}

type Load =
  | { state: 'loading' }
  | { state: 'disabled' }
  | { state: 'error'; message: string }
  | { state: 'ready'; grants: Grant[] };

/** The keys {@link when} reads, so a missing one is a type error rather than English copy. */
type WhenKey = 'never' | 'unknownTime';

export function when(
  t: (key: WhenKey) => string,
  dateTime: (value: Date) => string,
  value: string | number | null | undefined,
): string {
  if (!value) return t('never');
  const date = new Date(typeof value === 'number' ? value : String(value));
  if (Number.isNaN(date.getTime())) return t('unknownTime');
  return dateTime(date);
}

export function McpPane({ workspaceId }: { workspaceId?: string }) {
  const tt = useTranslations('tooltips');
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { dateTime } = useLocalFormat();
  const formatWhen = (value: Date) => dateTime(value, { dateStyle: 'medium', timeStyle: 'short' });
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [names, setNames] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/mcp/grants');
      if (response.status === 404) {
        setLoad({ state: 'disabled' });
        return;
      }
      if (!response.ok) {
        setLoad({ state: 'error', message: t('mcpLoadFailed', { status: response.status }) });
        return;
      }
      const data = await response.json();
      setLoad({ state: 'ready', grants: Array.isArray(data.grants) ? data.grants : [] });
    } catch (error) {
      logger.error('[ConnectedAgents] Failed to load grants:', error);
      setLoad({ state: 'error', message: t('mcpLoadError') });
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Grants carry a workspace id; the list reads better with the name the consent screen showed.
  useEffect(() => {
    if (load.state !== 'ready' || load.grants.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/workspaces');
        if (!response.ok) return;
        const data = await response.json();
        const list = Array.isArray(data.workspaces) ? data.workspaces : data;
        if (!Array.isArray(list) || cancelled) return;
        const map: Record<string, string> = {};
        for (const w of list) if (w?.id && w?.name) map[w.id] = w.name;
        setNames(map);
      } catch {
        // The id is a usable fallback, so a failure here is not worth surfacing.
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  const revoke = async (grant: Grant) => {
    setRevoking(grant.id);
    try {
      const response = await fetch(`/api/mcp/grants?id=${encodeURIComponent(grant.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      toast.success(t('disconnectedClient', { name: grant.clientName }));
      setConfirming(null);
      await refresh();
    } catch (error) {
      logger.error('[ConnectedAgents] Failed to revoke grant:', error);
      toast.error(t('mcpDisconnectFailed'));
    } finally {
      setRevoking(null);
    }
  };

  const endpoint = typeof window !== 'undefined' ? `${window.location.origin}/api/mcp` : '/api/mcp';
  const docsHref = workspaceId ? `/w/${workspaceId}/docs?doc=mcp-server` : '/admin/docs?doc=mcp-server';

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <>
    <Section>
      <SectionHeader icon={Plug} title="MCP" />
      <SectionBody>
        <p className="text-xs text-muted-foreground pt-3">
          {t.rich('mcpIntro', {
            code: chunks => (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{chunks}</code>
            ),
            link: chunks => (
              <a href={docsHref} className="underline underline-offset-2">{chunks}</a>
            ),
          })}
        </p>
        {load.state !== 'disabled' && (
          <SettingRow
            title={tt('endpoint')}
            description={t('mcpEndpointDesc')}
          >
            <span className="flex items-center gap-1 min-w-0">
              <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{endpoint}</code>
              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => void copyEndpoint()} aria-label={t('copyEndpointAria')}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </span>
          </SettingRow>
        )}
      </SectionBody>
    </Section>

    <Section>
      <SectionHeader icon={Plug} title={tt('clients')} />
      <SectionBody>
        <p className="text-xs text-muted-foreground pt-3">
          {t('mcpClientsHint')}
        </p>

        {load.state === 'loading' && (
          <p className="text-sm text-muted-foreground py-3">{tc('loading')}</p>
        )}

        {load.state === 'disabled' && (
          <p className="text-sm text-muted-foreground py-3">
            {t('mcpDisabled')}
          </p>
        )}

        {load.state === 'error' && (
          <div className="flex items-center gap-3 py-3">
            <p className="text-sm text-muted-foreground flex-1">{load.message}</p>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>{tc('actions.retry')}</Button>
          </div>
        )}

        {load.state === 'ready' && load.grants.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Plug className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('noMcpClients')}</p>
            <p className="text-xs text-muted-foreground">
              {t('mcpRegisterHint')}
            </p>
          </div>
        )}

        {load.state === 'ready' && load.grants.map((grant) => (
          <SettingRow
            key={grant.id}
            title={grant.clientName || t('unnamedClient')}
            description={
              <span className="flex flex-col gap-1">
                <span>
                  {t('grantMeta', {
                    workspace: names[grant.workspaceId] ?? grant.workspaceId,
                    added: when(t, formatWhen, grant.createdAt),
                    used: when(t, formatWhen, grant.lastUsedAt),
                  })}
                </span>
                <span className="flex flex-wrap gap-1">
                  {grant.scopes.length === 0
                    ? <span className="text-xs">{t('noScopes')}</span>
                    : grant.scopes.map((scope) => (
                        <Badge key={scope} variant="secondary" className="text-[11px] px-1.5 py-0">
                          {scope}
                        </Badge>
                      ))}
                </span>
                {/* What it did, not just that it was here: a connector that only ever reads and one
                    that publishes deployments look identical from a date alone. */}
                {grant.recentActivity && grant.recentActivity.length > 0 && (
                  <span className="flex flex-col gap-0.5 pt-1 text-[11px] text-muted-foreground">
                    <span className="uppercase tracking-wider">{t('recentCalls')}</span>
                    {grant.recentActivity.slice(0, 5).map((call, i) => (
                      <span key={`${call.at}-${i}`} className="font-mono">
                        {when(t, formatWhen, call.at)} · {call.tool}
                        {call.target ? ` · ${call.target}` : ''}
                        {call.refused ? ` · ${t('refusedSuffix')}` : ''}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            }
          >
            {confirming === grant.id ? (
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={revoking === grant.id}
                  onClick={() => void revoke(grant)}
                >
                  {revoking === grant.id ? t('disconnecting') : t('confirm')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  {tc('actions.cancel')}
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirming(grant.id)}>
                {tc('actions.disconnect')}
              </Button>
            )}
          </SettingRow>
        ))}
      </SectionBody>
    </Section>
    </>
  );
}
