'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { ConnectionBadge } from '@/components/settings/connection-badge';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import { validateApiKey } from '@/lib/llm/llm-client';
import { whoAmI } from '@huggingface/hub';
import { checkHFCapabilities, loginHF } from '@/lib/auth/hf-auth';
import { HF_BILLING_URL } from '@/lib/constants/links';
import type { HFCapabilities } from '@/lib/auth/hf-auth';
import { track } from '@/lib/telemetry';

interface HFAuthPanelProps {
  onAuthChange?: () => void;
}

export function HFAuthPanel({ onAuthChange }: HFAuthPanelProps) {
  const t = useTranslations('settings');
  const tcn = useTranslations('connections');
  const tch = useTranslations('chat');
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [oauthUsername, setOauthUsername] = useState<string>();
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(() => !!configManager.getHFAuth());
  const capabilitiesRef = useRef<HFCapabilities | null>(null);

  const dispatchAuthEvent = useCallback((hasKey: boolean) => {
    onAuthChange?.();
    window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
      detail: { provider: 'huggingface', hasKey }
    }));
  }, [onAuthChange]);

  // Check OAuth capabilities on mount, sync stored auth state
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Check stored auth (may have been set by app-level OAuth handler)
      const hfAuth = configManager.getHFAuth();
      if (hfAuth) {
        setIsConnected(true);
        if (hfAuth.username) setOauthUsername(hfAuth.username);
      }

      // Fetch capabilities
      try {
        const capabilities = await checkHFCapabilities();
        if (cancelled) return;
        capabilitiesRef.current = capabilities;
        setOauthAvailable(capabilities.oauthAvailable);
      } catch {
        // Network error — leave state as-is
      }
    }

    init();

    // Listen for auth changes from app-level OAuth handler
    const handleAuthUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.provider === 'huggingface') {
        const hfAuth = configManager.getHFAuth();
        setIsConnected(detail.hasKey);
        if (hfAuth?.username) setOauthUsername(hfAuth.username);
      }
    };
    window.addEventListener('apiKeyUpdated', handleAuthUpdate);

    return () => {
      cancelled = true;
      window.removeEventListener('apiKeyUpdated', handleAuthUpdate);
    };
  }, []);

  const handleOAuthLogin = async () => {
    // Fetch capabilities if we don't have them yet
    let caps = capabilitiesRef.current;
    if (!caps) {
      try {
        caps = await checkHFCapabilities();
        capabilitiesRef.current = caps;
      } catch {
        toast.error(t('connectFailed'));
        return;
      }
    }

    if (!caps.clientId) {
      toast.error(t('oauthNotConfigured'));
      return;
    }

    await loginHF(caps.clientId, caps.scopes);
  };

  const handleConnect = async () => {
    const key = tokenInput.trim();
    if (!key) {
      toast.error(t('tokenRequired'));
      return;
    }
    setIsConnecting(true);
    try {
      const isValid = await validateApiKey(key, 'huggingface');
      if (isValid) {
        // Capture the username so token-paste connections can also deploy to a Space
        // (which needs <username>/<slug>). Best-effort: connection still succeeds if this fails.
        let username: string | undefined;
        try {
          const me = await whoAmI({ accessToken: key });
          username = me?.name;
        } catch { /* leave undefined */ }
        configManager.setHFAuth({ access_token: key, username });
        setIsConnected(true);
        setTokenInput('');
        toast.success(t('hfConnected'));
        track('connection_added', { provider: 'huggingface', method: 'key' });
        dispatchAuthEvent(true);
      } else {
        toast.error(t('hfInvalidToken'));
      }
    } catch {
      toast.error(t('validateTokenFailed'));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setIsLoading(true);
    try {
      configManager.clearHFAuth();
      configManager.clearModelCache('huggingface');
      setIsConnected(false);
      setOauthUsername(undefined);
      setTokenInput('');
      toast.success(t('hfDisconnected'));
      track('connection_removed', { provider: 'huggingface' });
      dispatchAuthEvent(false);
    } catch {
      toast.error(t('disconnectFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  // --- Connected state (OAuth or validated API key) ---
  if (isConnected) {
    return (
      <div className="space-y-3">
        <ConnectionBadge
          method={oauthUsername ? 'OAuth' : tcn('apiKey')}
          extra={oauthUsername}
          info={
            <>
              {t.rich('hfCredits', {
                link: (chunks) => (
                  <a
                    href={HF_BILLING_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-0.5"
                  >
                    {chunks} <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ),
              })}
            </>
          }
          onDisconnect={handleDisconnect}
          disconnecting={isLoading}
        />
      </div>
    );
  }

  // --- Unauthenticated state ---
  return (
    <div className="space-y-3">
      <Label>{t('hfTitle')}</Label>
      <p className="text-xs text-muted-foreground">
        {t('hfIntro')}
      </p>

      {/* OAuth button — only on HF Spaces */}
      {oauthAvailable && (
        <>
          <Button
            onClick={handleOAuthLogin}
            className="w-full gap-2"
            variant="outline"
          >
            {tch('signInWithHF')}
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                {t('hfOrToken')}
              </span>
            </div>
          </div>
        </>
      )}

      {/* API key input — always available */}
      <div>
        <Label htmlFor="hf-token" className="text-xs">{t('accessToken')}</Label>
        <div className="flex gap-2 mt-1.5">
          <div className="relative flex-1">
            <Input
              id="hf-token"
              type={showToken ? 'text' : 'password'}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && tokenInput.trim()) handleConnect(); }}
              placeholder="hf_..."
              className="pr-10"
              disabled={isConnecting}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => setShowToken(!showToken)}
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <Button
            onClick={handleConnect}
            disabled={isConnecting || !tokenInput.trim()}
            size="sm"
          >
            {isConnecting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                {tcn('connecting')}
              </>
            ) : (
              tcn('connect')
            )}
          </Button>
        </div>
      </div>

      <div className="p-3 border rounded-md bg-muted/50 text-xs text-muted-foreground space-y-2">
        <p className="font-medium">{t('hfHowTo')}</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>
            {t.rich('hfGoTo', {
              link: (chunks) => (
                <a
                  href="https://huggingface.co/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  {chunks} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ),
            })}
          </li>
          <li>{t('hfCreateToken')}</li>
          <li>{t('pasteToken')}</li>
        </ol>
        {!oauthAvailable && (
          <p className="text-muted-foreground/70 mt-1">
            {t('hfOAuthNote')}
          </p>
        )}
      </div>
    </div>
  );
}
