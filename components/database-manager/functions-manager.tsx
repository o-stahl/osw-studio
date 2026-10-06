'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { EdgeFunction } from '@/lib/vfs/types';
import {
  Plus, Loader2, AlertCircle, Code2, MoreVertical, Pencil, Trash2,
  ToggleLeft, ToggleRight, Copy, ExternalLink, CheckCircle2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FunctionEditor } from './function-editor';
import { cn } from '@/lib/utils';
import type { FunctionsDataProvider } from './data-providers';

interface FunctionsManagerProps {
  deploymentId?: string;
  dataProvider?: FunctionsDataProvider;
  hideRuntimeFeatures?: boolean;
  workspaceId?: string;
}

export function FunctionsManager({ deploymentId, dataProvider, hideRuntimeFeatures, workspaceId }: FunctionsManagerProps) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [functions, setFunctions] = useState<EdgeFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingFunction, setEditingFunction] = useState<EdgeFunction | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  useEffect(() => {
    loadFunctions();
  }, [deploymentId, dataProvider]);

  const loadFunctions = async () => {
    try {
      setLoading(true);
      setError(null);
      if (dataProvider) {
        setFunctions(await dataProvider.list());
      } else if (deploymentId) {
        const res = await fetch(`${apiBase}/admin/deployments/${deploymentId}/functions`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || t('loadFunctionsFailed'));
        }
        const data = await res.json();
        setFunctions(data.functions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFunctionsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const toggleEnabled = async (fn: EdgeFunction) => {
    try {
      if (dataProvider) {
        await dataProvider.toggle(fn.id, !fn.enabled);
      } else if (deploymentId) {
        const res = await fetch(`${apiBase}/admin/deployments/${deploymentId}/functions/${fn.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !fn.enabled }),
        });
        if (!res.ok) throw new Error('Failed to update function');
      } else {
        return;
      }
      await loadFunctions();
    } catch (err) {
      console.error('Failed to toggle function:', err);
    }
  };

  const deleteFunction = async (fn: EdgeFunction) => {
    if (!confirm(t('confirmDeleteFunction', { name: fn.name }))) return;

    try {
      if (dataProvider) {
        await dataProvider.remove(fn.id);
      } else if (deploymentId) {
        const res = await fetch(`${apiBase}/admin/deployments/${deploymentId}/functions/${fn.id}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error('Failed to delete function');
      } else {
        return;
      }
      await loadFunctions();
    } catch (err) {
      console.error('Failed to delete function:', err);
    }
  };

  const copyUrl = (fn: EdgeFunction) => {
    if (!deploymentId) return;
    const url = `${window.location.origin}${apiBase}/deployments/${deploymentId}/functions/${fn.name}`;
    navigator.clipboard.writeText(url);
    setCopiedUrl(fn.id);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const handleSave = async (data: Partial<EdgeFunction>) => {
    try {
      if (dataProvider) {
        await dataProvider.save(editingFunction?.id || null, data);
      } else if (!deploymentId) {
        throw new Error(t('noDeploymentId'));
      } else if (editingFunction) {
        const res = await fetch(`${apiBase}/admin/deployments/${deploymentId}/functions/${editingFunction.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || t('updateFunctionFailed'));
        }
      } else {
        const res = await fetch(`${apiBase}/admin/deployments/${deploymentId}/functions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || t('createFunctionFailed'));
        }
      }

      setEditingFunction(null);
      setIsCreating(false);
      await loadFunctions();
    } catch (err) {
      throw err;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={loadFunctions}>
          {tc('actions.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">{t('edgeFunctions')}</h3>
        <Button size="sm" onClick={() => setIsCreating(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t('newFunction')}
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {functions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center border rounded-lg">
            <Code2 className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">{t('noEdgeFunctions')}</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              {t('createFirstEndpoint')}
            </p>
            <Button size="sm" onClick={() => setIsCreating(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('createFunction')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {functions.map(fn => (
              <div
                key={fn.id}
                className={cn(
                  "border rounded-lg p-4 transition-colors",
                  !fn.enabled && "opacity-60 bg-muted/30"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Code2 className="h-4 w-4 text-blue-500 shrink-0" />
                      <span className="font-mono font-medium truncate">{fn.name}</span>
                      <span className={cn(
                        "text-xs px-1.5 py-0.5 rounded shrink-0",
                        fn.method === 'ANY' ? "bg-purple-500/20 text-purple-600" :
                        fn.method === 'GET' ? "bg-green-500/20 text-green-600" :
                        fn.method === 'POST' ? "bg-blue-500/20 text-blue-600" :
                        fn.method === 'PUT' ? "bg-yellow-500/20 text-yellow-600" :
                        "bg-red-500/20 text-red-600"
                      )}>
                        {fn.method}
                      </span>
                      {!fn.enabled && (
                        <span className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0">{t('disabledBadge')}</span>
                      )}
                    </div>
                    {fn.description && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">
                        {fn.description}
                      </p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span className="shrink-0">{t('timeoutValue', { seconds: fn.timeoutMs / 1000 })}</span>
                      {!hideRuntimeFeatures && deploymentId && (
                        <button
                          onClick={() => copyUrl(fn)}
                          className="flex items-center gap-1 hover:text-foreground transition-colors shrink-0"
                        >
                          {copiedUrl === fn.id ? (
                            <>
                              <CheckCircle2 className="h-3 w-3 text-green-500" />
                              {tc('labels.copied')}
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              {tc('actions.copyUrl')}
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditingFunction(fn)}>
                        <Pencil className="h-4 w-4 mr-2" />
                        {tc('actions.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggleEnabled(fn)}>
                        {fn.enabled ? (
                          <>
                            <ToggleLeft className="h-4 w-4 mr-2" />
                            {tc('actions.disable')}
                          </>
                        ) : (
                          <>
                            <ToggleRight className="h-4 w-4 mr-2" />
                            {tc('actions.enable')}
                          </>
                        )}
                      </DropdownMenuItem>
                      {!hideRuntimeFeatures && deploymentId && (
                        <DropdownMenuItem
                          onClick={() => window.open(`${apiBase}/deployments/${deploymentId}/functions/${fn.name}`, '_blank')}
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          {t('openInBrowser')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => deleteFunction(fn)}
                        className="text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {tc('actions.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Function Editor Dialog */}
      {(isCreating || editingFunction) && (
        <FunctionEditor
          deploymentId={deploymentId || ''}
          function={editingFunction}
          isOpen={true}
          onClose={() => {
            setIsCreating(false);
            setEditingFunction(null);
          }}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
