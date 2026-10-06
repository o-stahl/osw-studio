'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { FunctionLog } from '@/lib/vfs/types';
import {
  Loader2, AlertCircle, RefreshCw, Trash2, CheckCircle2, XCircle,
  Clock, ArrowRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface LogsViewerProps {
  deploymentId: string;
  workspaceId?: string;
}

interface EnrichedLog extends FunctionLog {
  functionName?: string;
}

export function LogsViewer({ deploymentId, workspaceId }: LogsViewerProps) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const { dateTime, number } = useLocalFormat();
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [logs, setLogs] = useState<EnrichedLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLogs();
  }, [deploymentId]);

  const loadLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${apiBase}/admin/deployments/${deploymentId}/database/logs?limit=200`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('loadLogsFailed'));
      }
      const data = await res.json();
      setLogs(data.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadLogsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!confirm(t('confirmClearLogs'))) return;

    try {
      const res = await fetch(`${apiBase}/admin/deployments/${deploymentId}/database/logs`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to clear logs');
      await loadLogs();
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  const formatDate = (date: Date | string) => dateTime(date, { dateStyle: 'short', timeStyle: 'medium' });

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
        <Button variant="outline" onClick={loadLogs}>
          {tc('actions.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">{t('executionLogs')}</h3>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={loadLogs}>
            <RefreshCw className="h-4 w-4 mr-1" />
            {tc('actions.refresh')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearLogs}
            disabled={logs.length === 0}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {tc('actions.clear')}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto border rounded-lg">
        {logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center">
            <Clock className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">{t('noExecutionLogs')}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('logsHint')}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="text-left p-3 font-medium">{t('status')}</th>
                <th className="text-left p-3 font-medium">{t('function')}</th>
                <th className="text-left p-3 font-medium">{t('method')}</th>
                <th className="text-left p-3 font-medium">{t('path')}</th>
                <th className="text-left p-3 font-medium">{t('duration')}</th>
                <th className="text-left p-3 font-medium">{t('time')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-t hover:bg-muted/30">
                  <td className="p-3">
                    {log.statusCode >= 200 && log.statusCode < 300 ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : log.statusCode >= 400 ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <ArrowRight className="h-4 w-4 text-yellow-500" />
                    )}
                  </td>
                  <td className="p-3 font-mono">
                    {log.functionName || log.functionId.slice(0, 8)}
                  </td>
                  <td className="p-3">
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded",
                      log.method === 'GET' ? "bg-green-500/20 text-green-600" :
                      log.method === 'POST' ? "bg-blue-500/20 text-blue-600" :
                      log.method === 'PUT' ? "bg-yellow-500/20 text-yellow-600" :
                      log.method === 'DELETE' ? "bg-red-500/20 text-red-600" :
                      "bg-muted text-muted-foreground"
                    )}>
                      {log.method}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs text-muted-foreground">
                    {log.path}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {number(log.durationMs, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' })}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {formatDate(log.timestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
