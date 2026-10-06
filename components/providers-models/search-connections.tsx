'use client';

import React, { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Plus,
  ChevronRight,
  Eye,
  EyeOff,
  MoreVertical,
  Pencil,
  Unplug,
  CircleCheck,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { configManager } from '@/lib/config/storage';
import type { WebSearchProviderId as SearchProviderId } from '@/lib/web-search/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Drawer } from './drawer';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

interface SearchProviderMeta {
  id: SearchProviderId;
  name: string;
  auth: 'none' | 'key' | 'url';
  /** Message key of an optional reliability caveat shown in the picker and on the active card. */
  warn?: 'searchWarnDuckduckgo';
}

const SEARCH_PROVIDERS: SearchProviderMeta[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', auth: 'none', warn: 'searchWarnDuckduckgo' },
  { id: 'tavily', name: 'Tavily', auth: 'key' },
  { id: 'firecrawl', name: 'Firecrawl', auth: 'key' },
  { id: 'brave', name: 'Brave', auth: 'key' },
  { id: 'searxng', name: 'SearXNG', auth: 'url' },
];

function getMeta(id: SearchProviderId): SearchProviderMeta {
  return SEARCH_PROVIDERS.find((p) => p.id === id)!;
}

/** True when a provider is connected. Read inside effects/handlers only. */
function isSearchConnected(id: SearchProviderId): boolean {
  if (id === 'duckduckgo') return configManager.getWebSearchProvider() === id;
  if (id === 'searxng') return !!configManager.getSearxngUrl();
  return !!configManager.getWebSearchKey(id);
}

/** Masked credential shown on a connected card, when applicable. */
function searchCred(id: SearchProviderId): string {
  if (id === 'duckduckgo') return '';
  if (id === 'searxng') return configManager.getSearxngUrl() ?? '';
  const key = configManager.getWebSearchKey(id);
  return key ? `···${key.slice(-4)}` : '';
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface SearchConnectionCardProps {
  id: SearchProviderId;
  cred: string;
  active: boolean;
  onSetActive: () => void;
  onEdit: () => void;
  onDisconnect: () => void;
}

function SearchConnectionCard({ id, cred, active, onSetActive, onEdit, onDisconnect }: SearchConnectionCardProps) {
  const tc = useTranslations('common');
  const tcn = useTranslations('connections');
  const meta = getMeta(id);
  return (
    <div className="flex items-center gap-3 bg-card border border-border rounded-md px-4 py-3">
      {/* Icon / initials */}
      <div className="w-[36px] h-[36px] rounded-md bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        {meta.name.slice(0, 2).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{meta.name}</div>
        {cred && (
          <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{cred}</div>
        )}
        {meta.warn && (
          <div
            className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500 mt-0.5"
            title={tcn(meta.warn)}
          >
            <TriangleAlert className="h-3 w-3 flex-shrink-0" />
            <span>{tcn('searchBestEffort')}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        {active && (
          <>
            <div className="h-1.5 w-1.5 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
            <span className="text-xs font-semibold text-green-500 mr-1">{tc('labels.active')}</span>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" title={tc('labels.connectionOptions')}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!active && (
              <DropdownMenuItem onSelect={onSetActive}>
                <CircleCheck className="h-4 w-4" />
                {tcn('setAsActive')}
              </DropdownMenuItem>
            )}
            {meta.auth !== 'none' && (
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="h-4 w-4" />
                {tc('actions.edit')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onDisconnect} className="text-destructive focus:text-destructive">
              <Unplug className="h-4 w-4" />
              {tcn('disconnect')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Choose body
// ---------------------------------------------------------------------------

function ChooseBody({ onChoose }: { onChoose: (id: SearchProviderId) => void }) {
  const t = useTranslations('connections');
  return (
    <div className="px-[18px] py-4 space-y-1">
      {SEARCH_PROVIDERS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onChoose(p.id)}
          className={cn(
            'w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-colors',
            'hover:bg-muted border border-transparent hover:border-border',
            'cursor-pointer'
          )}
        >
          <div className="w-[34px] h-[34px] rounded-sm bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
            {p.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{p.name}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{t(`searchHelp.${p.id}`)}</div>
            {p.warn && (
              <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500 mt-1.5">
                <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>{t(p.warn)}</span>
              </div>
            )}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configure body
// ---------------------------------------------------------------------------

interface ConfigureBodyProps {
  id: SearchProviderId;
  onSaved: () => void;
  onBack: () => void;
}

function ConfigureBody({ id, onSaved, onBack }: ConfigureBodyProps) {
  const tsx = useTranslations('settings');
  const tc = useTranslations('common');
  const t = useTranslations('connections');
  const meta = getMeta(id);
  const [value, setValue] = useState(() =>
    id === 'searxng'
      ? configManager.getSearxngUrl() ?? ''
      : id === 'duckduckgo' ? '' : configManager.getWebSearchKey(id) ?? ''
  );
  const [showKey, setShowKey] = useState(false);

  const handleSave = () => {
    const trimmed = value.trim();
    if (meta.auth !== 'none' && !trimmed) return;
    if (id === 'searxng') {
      configManager.setSearxngUrl(trimmed);
    } else if (id !== 'duckduckgo') {
      configManager.setWebSearchKey(id, trimmed);
    }
    // First connected provider becomes the active one.
    if (!configManager.getWebSearchProvider()) {
      configManager.setWebSearchProvider(id);
    }
    toast.success(t('saved'));
    onSaved();
  };

  return (
    <div className="px-[18px] py-4 space-y-4">
      <p className="text-xs text-muted-foreground">{t(`searchHelp.${id}`)}</p>

      {meta.auth === 'key' ? (
        <div>
          <Label htmlFor="search-key">{tsx('providerApiKey', { provider: meta.name })}</Label>
          <div className="flex gap-2 mt-2">
            <div className="relative flex-1">
              <Input
                id="search-key"
                type={showKey ? 'text' : 'password'}
                value={value}
                onChange={(e) => { setValue(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) handleSave(); }}
                placeholder={t('apiKeyPlaceholder')}
                className="pr-10"
              />
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      ) : meta.auth === 'url' ? (
        <div>
          <Label htmlFor="search-url">{t('searxngUrl')}</Label>
          <div className="flex gap-2 mt-2">
            <Input
              id="search-url"
              type="text"
              value={value}
              onChange={(e) => { setValue(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) handleSave(); }}
              placeholder="https://searxng.example.com"
              className="flex-1"
            />
          </div>
        </div>
      ) : (
        <p className="text-sm">{t('noSetupRequired')}</p>
      )}

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          {tc('actions.back')}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={meta.auth !== 'none' && !value.trim()}>
          {tc('actions.save')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

type SearchDrawerMode = 'choose' | 'configure' | null;

export function SearchConnectionsSection() {
  const tc = useTranslations('common');
  const t = useTranslations('connections');
  // Bumped after connect/disconnect to re-evaluate configManager. Value unused.
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((v) => v + 1), []);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<SearchDrawerMode>(null);
  const [selectedId, setSelectedId] = useState<SearchProviderId | null>(null);

  const openChoose = () => {
    setSelectedId(null);
    setDrawerMode('choose');
    setDrawerOpen(true);
  };

  const openConfigure = (id: SearchProviderId) => {
    setSelectedId(id);
    setDrawerMode('configure');
    setDrawerOpen(true);
  };

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setDrawerMode(null);
    setSelectedId(null);
  }, []);

  const handleSetActive = (id: SearchProviderId) => {
    configManager.setWebSearchProvider(id);
    refresh();
  };

  const handleDisconnect = (id: SearchProviderId) => {
    const meta = getMeta(id);
    if (id === 'searxng') {
      configManager.setSearxngUrl('');
    } else if (id !== 'duckduckgo') {
      configManager.setWebSearchKey(id, '');
    }
    // If the disconnected provider was active, reassign to another connected one.
    if (configManager.getWebSearchProvider() === id) {
      const next = SEARCH_PROVIDERS.find((p) => p.id !== id && isSearchConnected(p.id));
      configManager.setWebSearchProvider(next ? next.id : null);
    }
    toast.success(t('disconnectedFrom', { name: meta.name }));
    refresh();
  };

  // configManager reads live here only because a render was triggered by refresh()
  // (or the parent mounting on the client); the Drawer/Radix modal is client-only.
  const connected = SEARCH_PROVIDERS.filter((p) => isSearchConnected(p.id));
  const activeId = configManager.getWebSearchProvider();

  let drawerLabel: string | undefined;
  let drawerTitle: string | undefined;
  let drawerScope: string | undefined;

  if (drawerMode === 'choose') {
    drawerLabel = t('addSearchProvider');
    drawerTitle = t('addSearchProvider');
    drawerScope = t('searchPickProvider');
  } else if (drawerMode === 'configure' && selectedId) {
    drawerLabel = `← ${tc('actions.back')}`;
    drawerTitle = getMeta(selectedId).name;
    drawerScope = getMeta(selectedId).auth === 'url' ? t('searchScopeUrl') : t('searchScopeKey');
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('search')}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t('searchProvidersHint')}
          </p>
        </div>
        <Button variant="default" size="sm" className="gap-1.5 shrink-0" onClick={openChoose}>
          <Plus className="h-3.5 w-3.5" />
          {t('addSearchProvider')}
        </Button>
      </div>

      {connected.length === 0 ? (
        <p className="text-sm text-muted-foreground py-1 pl-1">{t('noneYet')}</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {connected.map((p) => (
            <SearchConnectionCard
              key={p.id}
              id={p.id}
              cred={searchCred(p.id)}
              active={activeId === p.id}
              onSetActive={() => handleSetActive(p.id)}
              onEdit={() => openConfigure(p.id)}
              onDisconnect={() => handleDisconnect(p.id)}
            />
          ))}
        </div>
      )}

      <Drawer
        open={drawerOpen}
        mode={drawerMode === 'choose' ? 'connect-choose' : 'connect-config'}
        label={drawerLabel}
        onLabelClick={drawerMode === 'configure' ? () => {
          setSelectedId(null);
          setDrawerMode('choose');
        } : undefined}
        title={drawerTitle}
        scope={drawerScope}
        onClose={closeDrawer}
      >
        {drawerMode === 'choose' && (
          <ChooseBody
            onChoose={(id) => {
              if (getMeta(id).auth === 'none') {
                configManager.setWebSearchProvider(id);
                toast.success(t('isActive', { name: getMeta(id).name }));
                refresh();
                closeDrawer();
                return;
              }
              setSelectedId(id);
              setDrawerMode('configure');
            }}
          />
        )}

        {drawerMode === 'configure' && selectedId && (
          <ConfigureBody
            key={selectedId}
            id={selectedId}
            onSaved={() => {
              refresh();
              closeDrawer();
            }}
            onBack={() => {
              setSelectedId(null);
              setDrawerMode('choose');
            }}
          />
        )}
      </Drawer>
    </div>
  );
}
