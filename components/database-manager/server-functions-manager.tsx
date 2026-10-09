'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ServerFunction } from '@/lib/vfs/types';
import {
  Plus, Loader2, AlertCircle, Wrench, MoreVertical, Pencil, Trash2,
  ToggleLeft, ToggleRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ServerFunctionEditor } from './server-function-editor';
import { cn } from '@/lib/utils';
import type { ServerFunctionsDataProvider } from './data-providers';
import { apiFetch } from '@/lib/api/backend-status';

interface ServerFunctionsManagerProps {
  deploymentId?: string;
  dataProvider?: ServerFunctionsDataProvider;
  workspaceId?: string;
}

export function ServerFunctionsManager({ deploymentId, dataProvider, workspaceId }: ServerFunctionsManagerProps) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [functions, setFunctions] = useState<ServerFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingFunction, setEditingFunction] = useState<ServerFunction | null>(null);
  const [isCreating, setIsCreating] = useState(false);

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
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/server-functions`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || t('loadHelpersFailed'));
        }
        const data = await res.json();
        setFunctions(data.functions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadHelpersFailed'));
    } finally {
      setLoading(false);
    }
  };

  const toggleEnabled = async (fn: ServerFunction) => {
    try {
      if (dataProvider) {
        await dataProvider.toggle(fn.id, !fn.enabled);
      } else if (deploymentId) {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/server-functions/${fn.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !fn.enabled }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('updateHelperFailed'));
      } else {
        return;
      }
      await loadFunctions();
    } catch (err) {
      console.error('Failed to toggle server function:', err);
      toast.error(err instanceof Error ? err.message : t('updateHelperFailed'));
    }
  };

  const deleteFunction = async (fn: ServerFunction) => {
    if (!confirm(t('confirmDeleteHelper', { name: fn.name }))) return;

    try {
      if (dataProvider) {
        await dataProvider.remove(fn.id);
      } else if (deploymentId) {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/server-functions/${fn.id}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('deleteHelperFailed'));
      } else {
        return;
      }
      await loadFunctions();
    } catch (err) {
      console.error('Failed to delete server function:', err);
      toast.error(err instanceof Error ? err.message : t('deleteHelperFailed'));
    }
  };

  const handleSave = async (data: Partial<ServerFunction>) => {
    try {
      if (dataProvider) {
        await dataProvider.save(editingFunction?.id || null, data);
      } else if (!deploymentId) {
        throw new Error(t('noDeploymentId'));
      } else if (editingFunction) {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/server-functions/${editingFunction.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || t('updateHelperFailed'));
        }
      } else {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/server-functions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || t('createHelperFailed'));
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
        <h3 className="text-sm font-medium">{t('helpersTitle')}</h3>
        <Button size="sm" onClick={() => setIsCreating(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t('newHelper')}
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {functions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center border rounded-lg">
            <Wrench className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">{t('noHelpersYet')}</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              {t('noHelpersHint')}
            </p>
            <Button size="sm" onClick={() => setIsCreating(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('createHelper')}
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
                      <Wrench className="h-4 w-4 text-orange-500 shrink-0" />
                      <span className="font-mono font-medium truncate">{fn.name}</span>
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
                      <span className="font-mono truncate">server.{fn.name}(args)</span>
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

      {/* Server Function Editor Dialog */}
      {(isCreating || editingFunction) && (
        <ServerFunctionEditor
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
