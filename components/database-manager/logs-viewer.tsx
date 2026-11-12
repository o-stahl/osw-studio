'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { FunctionLog, FUNCTION_LOG_LEVELS, type FunctionLogLevel } from '@/lib/vfs/types';
import {
  Loader2, AlertCircle, RefreshCw, Trash2, CheckCircle2, XCircle,
  Clock, ArrowRight, ChevronRight, ChevronDown
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api/backend-status';

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
  const [level, setLevel] = useState<FunctionLogLevel | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const levelTips: Record<FunctionLogLevel, string> = {
    all: t('tips.logAll'),
    errors: t('tips.logErrors'),
    off: t('tips.logOff'),
  };

  useEffect(() => {
    loadLogs();
  }, [deploymentId]);

  const loadLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/database/logs?limit=200`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('loadLogsFailed'));
      }
      const data = await res.json();
      setLogs(data.logs);
      setLevel(data.level ?? null);
      setCap(typeof data.cap === 'number' ? data.cap : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadLogsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!confirm(t('confirmClearLogs'))) return;

    try {
      const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/database/logs`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('clearLogsFailed'));
      await loadLogs();
    } catch (err) {
      console.error('Failed to clear logs:', err);
      toast.error(err instanceof Error ? err.message : t('clearLogsFailed'));
    }
  };

  // Saved at once: the invocation route reads the level on every call. One change at a time, so a
  // refused change puts back the level the server still has.
  const savingLevel = useRef(false);
  const changeLevel = async (next: FunctionLogLevel) => {
    if (savingLevel.current) return;
    savingLevel.current = true;
    const previous = level;
    setLevel(next);
    try {
      const res = await apiFetch(`${apiBase}/admin/deployments/${deploymentId}/database/logs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('saveLogLevelFailed'));
    } catch (err) {
      setLevel(previous);
      toast.error(err instanceof Error ? err.message : t('saveLogLevelFailed'));
    } finally {
      savingLevel.current = false;
    }
  };

  const toggleOpened = (id: number) => {
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="text-sm font-medium">{t('executionLogs')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {level && (
            <ToggleGroup
              type="single"
              value={level}
              onValueChange={(value) => value && value !== level && void changeLevel(value as FunctionLogLevel)}
              aria-label={t('logLevelLabel')}
            >
              {FUNCTION_LOG_LEVELS.map((option) => (
                <Tip key={option} label={levelTips[option]} wrap>
                  <ToggleGroupItem value={option} size="sm" className="text-xs">
                    {t(`logLevel.${option}`)}
                  </ToggleGroupItem>
                </Tip>
              ))}
            </ToggleGroup>
          )}
          <Tip label={t('tips.refreshLogs')}>
            <Button variant="ghost" size="sm" onClick={loadLogs}>
              <RefreshCw className="h-4 w-4 mr-1" />
              {tc('actions.refresh')}
            </Button>
          </Tip>
          <Tip label={logs.length === 0 ? t('tips.noLogs') : t('tips.clearLogs')} align="end">
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
          </Tip>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-3">{cap !== null ? t('logsKept', { count: cap }) : '\u00a0'}</p>

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
                <th className="w-8 p-3" aria-hidden />
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
                <React.Fragment key={log.id}>
                <tr className="border-t hover:bg-muted/30">
                  <td className="p-3 pr-0 align-middle">
                    {log.error && (
                      <Tip label={opened.has(log.id) ? t('tips.hideError') : t('tips.showError')}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-expanded={opened.has(log.id)}
                          aria-label={opened.has(log.id) ? t('tips.hideError') : t('tips.showError')}
                          onClick={() => toggleOpened(log.id)}
                        >
                          {opened.has(log.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </Button>
                      </Tip>
                    )}
                  </td>
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
                {log.error && opened.has(log.id) && (
                  <tr className="bg-muted/20">
                    <td />
                    <td colSpan={6} className="px-3 pb-3 pt-0">
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-destructive">{log.error}</pre>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
