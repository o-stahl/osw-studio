'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { ScheduledFunction, EdgeFunction } from '@/lib/vfs/types';
import {
  Plus, Loader2, AlertCircle, Clock, MoreVertical, Pencil, Trash2,
  ToggleLeft, ToggleRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScheduledFunctionEditor } from './scheduled-function-editor';
import { cn } from '@/lib/utils';
import type { ScheduledFunctionsDataProvider } from './data-providers';
import { apiFetch } from '@/lib/api/backend-status';

interface ScheduledFunctionsManagerProps {
  deploymentId?: string;
  dataProvider?: ScheduledFunctionsDataProvider;
  workspaceId?: string;
}

export function ScheduledFunctionsManager({ deploymentId, dataProvider, workspaceId }: ScheduledFunctionsManagerProps) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const tt = useTranslations('tooltips');
  const { dateTime } = useLocalFormat();
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [scheduledFunctions, setScheduledFunctions] = useState<ScheduledFunction[]>([]);
  const [edgeFunctions, setEdgeFunctions] = useState<EdgeFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingFunction, setEditingFunction] = useState<ScheduledFunction | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadFunctions();
  }, [deploymentId, dataProvider]);

  const loadFunctions = async () => {
    try {
      setLoading(true);
      setError(null);
      if (dataProvider) {
        const [sched, fns] = await Promise.all([
          dataProvider.listScheduled(),
          dataProvider.listEdgeFunctions(),
        ]);
        setScheduledFunctions(sched);
        setEdgeFunctions(fns);
      } else if (deploymentId) {
        const [schedRes, fnRes] = await Promise.all([
          apiFetch(`${apiBase}/admin/deployments/${deploymentId}/scheduled-functions`),
          apiFetch(`${apiBase}/admin/deployments/${deploymentId}/functions`),
        ]);
        if (!schedRes.ok) {
          const data = await schedRes.json();
          throw new Error(data.error || t('loadSchedulesFailed'));
        }
        if (!fnRes.ok) {
          const data = await fnRes.json();
          throw new Error(data.error || t('loadEdgeFunctionsFailed'));
        }
        const schedData = await schedRes.json();
        const fnData = await fnRes.json();
        setScheduledFunctions(schedData.scheduledFunctions);
        setEdgeFunctions(fnData.functions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadSchedulesFailed'));
    } finally {
      setLoading(false);
    }
  };

  const toggleEnabled = async (fn: ScheduledFunction) => {
    try {
      if (dataProvider) {
        await dataProvider.toggle(fn.id, !fn.enabled);
      } else if (deploymentId) {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/scheduled-functions/${fn.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !fn.enabled }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('updateScheduleFailed'));
      } else {
        return;
      }
      await loadFunctions();
    } catch (err) {
      console.error('Failed to toggle scheduled function:', err);
      toast.error(err instanceof Error ? err.message : t('updateScheduleFailed'));
    }
  };

  const deleteFunction = async (fn: ScheduledFunction) => {
    if (!confirm(t('confirmDeleteSchedule', { name: fn.name }))) return;

    try {
      if (dataProvider) {
        await dataProvider.remove(fn.id);
      } else if (deploymentId) {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/scheduled-functions/${fn.id}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('deleteScheduleFailed'));
      } else {
        return;
      }
      await loadFunctions();
    } catch (err) {
      console.error('Failed to delete scheduled function:', err);
      toast.error(err instanceof Error ? err.message : t('deleteScheduleFailed'));
    }
  };

  const handleSave = async (data: Partial<ScheduledFunction>) => {
    try {
      if (dataProvider) {
        await dataProvider.save(editingFunction?.id || null, data);
      } else if (!deploymentId) {
        throw new Error(t('noDeploymentId'));
      } else if (editingFunction) {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/scheduled-functions/${editingFunction.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || t('updateScheduleFailed'));
        }
      } else {
        const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/scheduled-functions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || t('createScheduleFailed'));
        }
      }

      setEditingFunction(null);
      setIsCreating(false);
      await loadFunctions();
    } catch (err) {
      throw err;
    }
  };

  const getEdgeFunctionName = (functionId: string) => {
    const fn = edgeFunctions.find(f => f.id === functionId);
    return fn?.name || tc('labels.unknown');
  };

  const formatDate = (date: Date | string | undefined) => {
    if (!date) return tc('labels.notAvailable');
    return dateTime(date, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
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
        <h3 className="text-sm font-medium">{tt('scheduledFunctions')}</h3>
        <Button size="sm" onClick={() => setIsCreating(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t('newSchedule')}
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {scheduledFunctions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center border rounded-lg">
            <Clock className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">{t('noSchedulesYet')}</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              {t('noSchedulesHint')}
            </p>
            <Button size="sm" onClick={() => setIsCreating(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('schedCreate')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {scheduledFunctions.map(fn => (
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
                      <Clock className="h-4 w-4 text-orange-500 shrink-0" />
                      <span className="font-mono font-medium truncate">{fn.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-600 shrink-0">
                        {fn.cronExpression}
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
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
                      <span className="shrink-0">
                        {t('functionLabel')} <span className="font-mono">{getEdgeFunctionName(fn.functionId)}</span>
                      </span>
                      <span className="shrink-0">{t('nextLabel')} {formatDate(fn.nextRunAt)}</span>
                      {fn.lastStatus && (
                        <span className={cn(
                          "shrink-0",
                          fn.lastStatus === 'success' ? "text-green-600" : "text-red-600"
                        )}>
                          {t('lastRun', { status: fn.lastStatus })}
                          {fn.lastRunAt && ` (${formatDate(fn.lastRunAt)})`}
                        </span>
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

      {(isCreating || editingFunction) && (
        <ScheduledFunctionEditor
          scheduledFunction={editingFunction}
          edgeFunctions={edgeFunctions}
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
