'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { configManager } from '@/lib/config/storage';
import { validateApiKey as checkApiKey } from '@/lib/llm/llm-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Eye, EyeOff, Check, X, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/model-selector';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ProviderId } from '@/lib/llm/providers/types';
import { getOfferableProviders, getProvider } from '@/lib/llm/providers/registry';
import { CodexAuthPanel } from '@/components/settings/codex-auth-panel';
import { HFAuthPanel } from '@/components/settings/hf-auth-panel';
import { ConnectionBadge } from '@/components/settings/connection-badge';
import { OllamaPreflight } from '@/components/settings/ollama-preflight';
import { LocalContextLength } from '@/components/settings/local-context-length';
import { checkHFCapabilities } from '@/lib/auth/hf-auth';
import { track } from '@/lib/telemetry';

interface ModelSettingsPanelProps {
  onClose?: () => void;
  onModelChange?: (modelId: string) => void;
  showJudgeModel?: boolean;
  onJudgeModelChange?: (modelId: string) => void;
}

export function ModelSettingsPanel({ onClose, onModelChange, showJudgeModel, onJudgeModelChange }: ModelSettingsPanelProps) {
  const t = useTranslations('settings');
  const tcn = useTranslations('connections');
  const tc = useTranslations('common');
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(() =>
    configManager.getSelectedProvider()
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [validatingKey, setValidatingKey] = useState(false);
  const [keyValid, setKeyValid] = useState<boolean | null>(null);
  const [currentApiKey, setCurrentApiKey] = useState('');
  const [apiKeyStored, setApiKeyStored] = useState(() => {
    const p = configManager.getSelectedProvider();
    return getProvider(p).apiKeyRequired ? !!configManager.getProviderApiKey(p) : false;
  });
  const [codexAvailable, setCodexAvailable] = useState(true);
  const [useSeparateChatModel, setUseSeparateChatModel] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(`osw-studio-use-separate-chat-model-${configManager.getSelectedProvider()}`);
      return stored === 'true';
    }
    return false;
  });
  const [compactionEnabled, setCompactionEnabled] = useState<boolean>(() => {
    return configManager.isCompactionEnabled(configManager.getSelectedProvider());
  });
  const [compactionLimit, setCompactionLimit] = useState<string>(() => {
    const savedLimit = configManager.getCompactionLimit(configManager.getSelectedProvider());
    return savedLimit ? String(savedLimit) : '';
  });

  // Check if Codex is available (blocked on HF Spaces — HttpOnly cookies don't work)
  useEffect(() => {
    checkHFCapabilities().then(caps => {
      setCodexAvailable(caps.codexAvailable);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // Update API key when provider changes
    const key = configManager.getProviderApiKey(selectedProvider) || '';
    setCurrentApiKey(key);
    setKeyValid(null); // Reset validation
    const providerCfg = getProvider(selectedProvider);
    setApiKeyStored(providerCfg.apiKeyRequired ? !!key : false);

    // Load separate chat model setting for this provider
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(`osw-studio-use-separate-chat-model-${selectedProvider}`);
      setUseSeparateChatModel(stored === 'true');
    }

    // Load compaction settings for this provider
    setCompactionEnabled(configManager.isCompactionEnabled(selectedProvider));
    const savedLimit = configManager.getCompactionLimit(selectedProvider);
    setCompactionLimit(savedLimit ? String(savedLimit) : '');
  }, [selectedProvider]);

  // Persist separate chat model setting
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`osw-studio-use-separate-chat-model-${selectedProvider}`, String(useSeparateChatModel));
    }
  }, [useSeparateChatModel, selectedProvider]);

  const handleProviderChange = (provider: ProviderId) => {
    setSelectedProvider(provider);
    configManager.setSelectedProvider(provider);
    track('provider_selected', { provider, has_api_key: !!configManager.getProviderApiKey(provider) });
  };

  const handleApiKeyChange = (key: string) => {
    setCurrentApiKey(key);
    configManager.setProviderApiKey(selectedProvider, key);
    setKeyValid(null);
    configManager.clearModelCache(selectedProvider);
    window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
      detail: { provider: selectedProvider, hasKey: !!key }
    }));
  };

  const validateApiKey = async () => {
    if (!currentApiKey) {
      toast.error(t('apiKeyRequired'));
      return;
    }

    setValidatingKey(true);
    try {
      const isValid = await checkApiKey(currentApiKey, selectedProvider);
      setKeyValid(isValid);
      
      if (isValid) {
        toast.success(t('apiKeyValid'));
      } else {
        toast.error(t('apiKeyInvalid'));
      }
    } catch {
      setKeyValid(false);
      toast.error(t('apiKeyValidateFailed'));
    } finally {
      setValidatingKey(false);
    }
  };

  const handleConnect = async () => {
    const key = currentApiKey.trim();
    if (!key) {
      toast.error(t('apiKeyRequired'));
      return;
    }
    setValidatingKey(true);
    try {
      const isValid = await checkApiKey(key, selectedProvider);
      if (isValid) {
        configManager.setProviderApiKey(selectedProvider, key);
        configManager.clearModelCache(selectedProvider);
        setApiKeyStored(true);
        setCurrentApiKey('');
        setKeyValid(null);
        toast.success(t('apiKeyConnected'));
        window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
          detail: { provider: selectedProvider, hasKey: true }
        }));
      } else {
        toast.error(t('apiKeyInvalidRetry'));
      }
    } catch {
      toast.error(t('apiKeyValidateFailed'));
    } finally {
      setValidatingKey(false);
    }
  };

  const handleApiKeyDisconnect = () => {
    configManager.setProviderApiKey(selectedProvider, '');
    configManager.clearModelCache(selectedProvider);
    setApiKeyStored(false);
    setCurrentApiKey('');
    setKeyValid(null);
    toast.success(t('disconnectedFrom', { provider: getProvider(selectedProvider).name }));
    window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
      detail: { provider: selectedProvider, hasKey: false }
    }));
  };

  const providerConfig = getProvider(selectedProvider);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0">
        <h3 className="font-semibold text-base tracking-tight">{t('modelSettings')}</h3>
        <p className="text-muted-foreground text-xs mt-1">
          {t('modelSettingsDesc')}
        </p>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto mt-5 space-y-5">

      {/* Provider Selection */}
      <div>
        <Label htmlFor="provider" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('provider')}</Label>
        <Select value={selectedProvider} onValueChange={handleProviderChange}>
          <SelectTrigger id="provider" className="mt-2 !h-fit w-full">
            <SelectValue placeholder={t('selectProvider')}>
              {selectedProvider && (
                <div className="flex flex-col text-left">
                  <span className="font-medium">{providerConfig.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {providerConfig.description}
                  </span>
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-[400px]">
            {getOfferableProviders()
              .filter(p => codexAvailable || p.id !== 'openai-codex')
              .map(provider => (
              <SelectItem key={provider.id} value={provider.id} className="py-2.5">
                <div className="flex flex-col">
                  <span className="font-medium">{provider.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {provider.description}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Auth: OAuth panel for Codex/HF, API key for others */}
      {providerConfig.usesOAuth ? (
        selectedProvider === 'huggingface' ? (
          <HFAuthPanel onAuthChange={() => {
            window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
              detail: { provider: selectedProvider, hasKey: !!configManager.getProviderApiKey(selectedProvider) }
            }));
          }} />
        ) : (
          <CodexAuthPanel onAuthChange={() => {
            window.dispatchEvent(new CustomEvent('apiKeyUpdated', {
              detail: { provider: selectedProvider, hasKey: !!configManager.getProviderApiKey(selectedProvider) }
            }));
          }} />
        )
      ) : providerConfig.apiKeyRequired ? (
        apiKeyStored ? (
          <ConnectionBadge
            method={tcn('apiKey')}
            extra={(() => { const k = configManager.getProviderApiKey(selectedProvider); return k ? `···${k.slice(-4)}` : undefined; })()}
            info={providerConfig.apiKeyHelpUrl && (
              <a
                href={providerConfig.apiKeyHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                {t('manageOn', { provider: providerConfig.name })} <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            onDisconnect={handleApiKeyDisconnect}
          />
        ) : (
          <div>
            <Label htmlFor="api-key">{t('providerApiKey', { provider: providerConfig.name })}</Label>
            <div className="flex gap-2 mt-2">
              <div className="relative flex-1">
                <Input
                  id="api-key"
                  type={showApiKey ? "text" : "password"}
                  value={currentApiKey}
                  onChange={(e) => { setCurrentApiKey(e.target.value); setKeyValid(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && currentApiKey.trim()) handleConnect(); }}
                  placeholder={providerConfig.apiKeyPlaceholder || tcn('apiKeyPlaceholder')}
                  className="pr-10"
                  data-tour-id="provider-key-input"
                  disabled={validatingKey}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-1 top-1 h-7 w-7"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                onClick={handleConnect}
                disabled={validatingKey || !currentApiKey.trim()}
                size="sm"
              >
                {validatingKey ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    {tcn('connecting')}
                  </>
                ) : (
                  tcn('connect')
                )}
              </Button>
            </div>
            {providerConfig.apiKeyHelpUrl && (
              <p className="text-sm text-muted-foreground mt-2">
                {t.rich('getApiKeyFrom', {
                  provider: providerConfig.name,
                  link: (chunks) => (
                    <a
                      href={providerConfig.apiKeyHelpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      {chunks} <ExternalLink className="h-3 w-3" />
                    </a>
                  ),
                })}
              </p>
            )}
          </div>
        )
      ) : providerConfig.isLocal ? (
        <div>
          <Label htmlFor="api-key">
            {providerConfig.name} API Key
            <span className="text-muted-foreground text-xs ml-1">(optional)</span>
          </Label>
          <div className="flex gap-2 mt-2">
            <div className="relative flex-1">
              <Input
                id="api-key"
                type={showApiKey ? "text" : "password"}
                value={currentApiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                placeholder={providerConfig.apiKeyPlaceholder || tcn('apiKeyPlaceholder')}
                className="pr-10"
                data-tour-id="provider-key-input"
              />
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <Button
              onClick={validateApiKey}
              disabled={validatingKey || !currentApiKey}
              size="sm"
            >
              {validatingKey ? t('validating') : t('validate')}
            </Button>
            {keyValid !== null && (
              <div className="flex items-center">
                {keyValid ? (
                  <Check className="h-5 w-5 text-green-500" />
                ) : (
                  <X className="h-5 w-5 text-red-500" />
                )}
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            {t('apiKeyOptionalFor', { provider: providerConfig.name })}
          </p>
        </div>
      ) : null}

      {!providerConfig.apiKeyRequired && providerConfig.isLocal && (
        <div className="text-sm text-muted-foreground p-3 border rounded-md bg-muted/50">
          <p className="font-medium mb-1">{t('localProvider')}</p>
          <p>{t('ensureRunning', { provider: providerConfig.name })}</p>
          <p>{t('defaultEndpoint')} <code className="text-xs">{providerConfig.baseUrl}</code></p>
          <div className="mt-2"><LocalContextLength providerId={selectedProvider} /></div>
          {selectedProvider === 'ollama' && (
            <OllamaPreflight />
          )}
          {selectedProvider === 'lmstudio' && (
            <div className="mt-2 text-xs">
              <p className="font-medium">{t('toolUseSupport')}</p>
              <p>• {t('lmStudioLoadModel')}</p>
              <p>• {t('lmStudioStartServer')}</p>
              <p>• {t('lmStudioAutoDiscover')}</p>
            </div>
          )}
        </div>
      )}

      {/* Divider */}
      <hr className="border-border" />

      {/* Code Model */}
      <div>
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('codeModel')}</Label>
        <div className="mt-2">
          <ModelSelector
            provider={selectedProvider}
            mode="inline"
            autoFocus={apiKeyStored || (!providerConfig.apiKeyRequired && !providerConfig.usesOAuth)}
            onChange={(modelId) => {
              if (typeof window !== 'undefined') {
                localStorage.setItem(`osw-studio-code-model-${selectedProvider}`, modelId);
              }
              if (!useSeparateChatModel) {
                onModelChange?.(modelId);
              }
            }}
            className="space-y-2"
          />
        </div>
      </div>

      {/* Separate Chat Model Toggle — hidden in judge mode */}
      {!showJudgeModel && (
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">{t('differentChatModel')}</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('chatModelHint')}
            </p>
          </div>
          <Switch
            id="separate-chat-model"
            checked={useSeparateChatModel}
            onCheckedChange={(checked) => setUseSeparateChatModel(checked)}
          />
        </div>
      )}

      {/* Chat Model (conditional) — hidden in judge mode */}
      {!showJudgeModel && useSeparateChatModel && (
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('chatModel')}</Label>
          <div className="mt-2">
            <ModelSelector
              provider={selectedProvider}
              mode="inline"
              onChange={(modelId) => {
                if (typeof window !== 'undefined') {
                  localStorage.setItem(`osw-studio-chat-model-${selectedProvider}`, modelId);
                }
                onModelChange?.(modelId);
              }}
              className="space-y-2"
            />
          </div>
        </div>
      )}

      {/* Judge Model — shown only in benchmark mode */}
      {showJudgeModel && (
        <>
          <hr className="border-border" />
          <div>
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('judgeModel')} <span className="normal-case font-normal">{tc('labels.optionalParen')}</span>
            </Label>
            <p className="text-xs text-muted-foreground mt-1 mb-2">
              {t('judgeModelDesc')}
            </p>
            <ModelSelector
              provider={selectedProvider}
              mode="inline"
              skipGlobalSync
              onChange={(modelId) => onJudgeModelChange?.(modelId)}
              className="space-y-2"
            />
          </div>
        </>
      )}

      {/* Auto-Compaction */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{t('autoCompact')}</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('autoCompactDesc')}
          </p>
        </div>
        <Switch
          id="compaction-enabled"
          checked={compactionEnabled}
          onCheckedChange={(checked) => {
            setCompactionEnabled(checked);
            configManager.setCompactionEnabled(selectedProvider, checked);
          }}
        />
      </div>

      {compactionEnabled && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('compactionLimitLabel')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('compactionLimitHelp')}
          </p>
          <input
            type="number"
            value={compactionLimit}
            onChange={(e) => {
              const val = e.target.value;
              setCompactionLimit(val);
              const num = parseInt(val, 10);
              configManager.setCompactionLimit(
                selectedProvider,
                isNaN(num) || num <= 0 ? undefined : num
              );
            }}
            placeholder={t('compactionLimitPlaceholder')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            min={1}
          />
        </div>
      )}

      </div>{/* end scrollable content */}

      {/* Footer */}
      {onClose && (
        <div className="shrink-0 flex justify-end pt-4 border-t mt-4">
          <Button onClick={onClose} size="sm">
            {tc('actions.done')}
          </Button>
        </div>
      )}
    </div>
  );
}
