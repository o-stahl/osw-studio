'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, LogIn } from 'lucide-react';
import { ConnectionBadge } from '@/components/settings/connection-badge';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import {
  type CodexLoginInfo,
  startCodexLogin,
  completeCodexLogin,
  pollCodexLogin,
  disconnectCodex,
  checkCodexStatus,
} from '@/lib/auth/codex-auth';
import { track } from '@/lib/telemetry';

interface CodexAuthPanelProps {
  onAuthChange?: () => void;
}

export function CodexAuthPanel({ onAuthChange }: CodexAuthPanelProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { number } = useLocalFormat();
  const [isAuthenticated, setIsAuthenticated] = useState(() =>
    !!configManager.getCodexAuth()
  );
  const [login, setLogin] = useState<CodexLoginInfo | null>(null);
  const [redirectUrl, setRedirectUrl] = useState('');
  const [isCompletingRedirect, setIsCompletingRedirect] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const auth = configManager.getCodexAuth();

  const dispatchAuthEvent = useCallback((hasKey: boolean) => {
    onAuthChange?.();
    window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
      detail: { provider: 'openai-codex', hasKey }
    }));
  }, [onAuthChange]);

  // Reconcile localStorage vs HttpOnly cookie on mount
  useEffect(() => {
    let cancelled = false;

    async function reconcile() {
      try {
        const hasCookie = await checkCodexStatus();
        if (cancelled) return;

        const localAuth = configManager.getCodexAuth();

        if (localAuth && !hasCookie) {
          configManager.clearCodexAuth();
          if (!cancelled) {
            setIsAuthenticated(false);
            dispatchAuthEvent(false);
          }
        } else if (!localAuth && hasCookie) {
          await disconnectCodex();
          if (!cancelled) {
            setIsAuthenticated(false);
            dispatchAuthEvent(false);
          }
        }
      } catch {
        // Network error — leave state as-is
      }
    }

    reconcile();
    return () => { cancelled = true; };
  }, [dispatchAuthEvent]);

  const finishLogin = useCallback((auth: NonNullable<ReturnType<typeof configManager.getCodexAuth>>) => {
    configManager.setCodexAuth(auth);
    setIsAuthenticated(true);
    setLogin(null);
    setRedirectUrl('');
    setIsCompletingRedirect(false);
    setIsLoading(false);
    toast.success(t('codexConnected'));
    track('connection_added', { provider: 'openai-codex', method: 'oauth' });
    dispatchAuthEvent(true);
  }, [dispatchAuthEvent, t]);

  useEffect(() => {
    if (!login || login.manualCallback) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const auth = await pollCodexLogin();
        if (cancelled) return;
        if (!auth) {
          timer = setTimeout(poll, 1000);
          return;
        }

        finishLogin(auth);
      } catch (error) {
        if (cancelled) return;
        setLogin(null);
        setIsLoading(false);
        toast.error(error instanceof Error ? error.message : t('codexLoginFailed'));
      }
    };

    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login, finishLogin, t]);

  const handleLogin = async () => {
    setIsLoading(true);
    try {
      const nextLogin = await startCodexLogin();
      setLogin(nextLogin);
      setIsLoading(!nextLogin.manualCallback);
      window.open(nextLogin.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setIsLoading(false);
      toast.error(error instanceof Error ? error.message : t('codexStartFailed'));
    }
  };

  const handleManualCallback = async () => {
    setIsCompletingRedirect(true);
    try {
      finishLogin(await completeCodexLogin(redirectUrl.trim()));
    } catch (error) {
      setIsCompletingRedirect(false);
      toast.error(error instanceof Error ? error.message : t('codexCompleteFailed'));
    }
  };

  const handleCancelLogin = async () => {
    setLogin(null);
    setRedirectUrl('');
    setIsCompletingRedirect(false);
    setIsLoading(false);
    await disconnectCodex().catch(() => {});
  };

  const handleDisconnect = async () => {
    setIsLoading(true);
    try {
      await disconnectCodex();
      configManager.clearModelCache('openai-codex');
      setIsAuthenticated(false);
      toast.success(t('codexDisconnected'));
      track('connection_removed', { provider: 'openai-codex' });
      dispatchAuthEvent(false);
    } catch {
      toast.error(t('disconnectFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const expiryInfo = () => {
    if (!auth?.expires_at) return undefined;
    const diff = auth.expires_at - Math.floor(Date.now() / 1000);
    if (diff <= 0) return t('codexExpired');
    const mins = Math.floor(diff / 60);
    const minutes = (n: number) => number(n, { style: 'unit', unit: 'minute', unitDisplay: 'narrow' });
    const duration = mins < 60
      ? minutes(mins)
      : `${number(Math.floor(mins / 60), { style: 'unit', unit: 'hour', unitDisplay: 'narrow' })} ${minutes(mins % 60)}`;
    return t('codexExpiresIn', { duration });
  };

  if (isAuthenticated && auth) {
    return (
      <div className="space-y-3">
        <ConnectionBadge
          method="ChatGPT"
          extra={auth.user_email}
          info={expiryInfo()}
          onDisconnect={handleDisconnect}
          disconnecting={isLoading}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Label>{t('codexTitle')}</Label>
      <p className="text-xs text-muted-foreground">
        {t('codexIntro')}
      </p>

      {!login && (
        <div className="p-3 border rounded-md bg-muted/50 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">{t('codexRemoteTitle')}</p>
          <p>
            {t('codexRemoteBody')}
          </p>
        </div>
      )}

      {login ? (
        <div className="p-3 border rounded-md bg-muted/50 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('codexRedirectHelp')}
          </p>
          {!login.manualCallback && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('codexWaiting')}
            </div>
          )}
          <Label htmlFor="codex-redirect-url" className="text-xs">{t('redirectUrl')}</Label>
          <Input
            id="codex-redirect-url"
            value={redirectUrl}
            onChange={(event) => setRedirectUrl(event.target.value)}
            placeholder="http://localhost:1455/auth/callback?code=…"
            disabled={isCompletingRedirect}
          />
          <Button
            className="w-full"
            onClick={handleManualCallback}
            disabled={isCompletingRedirect || !redirectUrl.trim()}
          >
            {isCompletingRedirect && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('codexCompleteSignIn')}
          </Button>
          <div className="text-center">
            <Button size="sm" variant="ghost" onClick={handleCancelLogin}>{tc('actions.cancel')}</Button>
          </div>
        </div>
      ) : (
        <Button onClick={handleLogin} disabled={isLoading} className="w-full gap-2">
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {t('codexSignIn')}
        </Button>
      )}
    </div>
  );
}
