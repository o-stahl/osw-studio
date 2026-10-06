'use client';

import React, { useState, useEffect, useCallback } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { Play, Loader2, AlertCircle, CheckCircle2, History, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { cn } from '@/lib/utils';

interface SqlEditorProps {
  deploymentId?: string;
  queryEndpoint?: string;
  workspaceId?: string;
}

interface QueryResult {
  success: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowsAffected?: number;
  error?: string;
  executionTime?: number;
}

const HISTORY_KEY = 'osw-sql-history';
const MAX_HISTORY = 20;

export function SqlEditor({ deploymentId, queryEndpoint, workspaceId }: SqlEditorProps) {
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [sql, setSql] = useState('SELECT * FROM ');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const { resolvedTheme } = useTheme();
  const t = useTranslations('backend.sql');
  const { number } = useLocalFormat();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Load history from localStorage
    const savedHistory = localStorage.getItem(HISTORY_KEY);
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch {
        // Ignore invalid JSON
      }
    }
  }, []);

  const saveToHistory = useCallback((query: string) => {
    setHistory(prev => {
      const newHistory = [query, ...prev.filter(q => q !== query)].slice(0, MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));
      return newHistory;
    });
  }, []);

  const executeQuery = useCallback(async () => {
    if (!sql.trim()) return;

    setExecuting(true);
    setResult(null);
    const startTime = Date.now();

    try {
      const endpoint = queryEndpoint || `${apiBase}/admin/deployments/${deploymentId}/database/query`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sql.trim() }),
      });

      const data = await res.json();
      const executionTime = Date.now() - startTime;

      if (!res.ok) {
        setResult({
          success: false,
          error: data.error || t('queryFailed'),
          executionTime,
        });
      } else {
        setResult({
          success: true,
          columns: data.columns,
          rows: data.rows,
          rowsAffected: data.rowsAffected,
          executionTime,
        });
        saveToHistory(sql.trim());
      }
    } catch (err) {
      setResult({
        success: false,
        error: err instanceof Error ? err.message : t('queryFailed'),
        executionTime: Date.now() - startTime,
      });
    } finally {
      setExecuting(false);
    }
  }, [sql, deploymentId, saveToHistory, t]);

  // Handle keyboard shortcut
  const handleEditorMount = useCallback((editor: unknown) => {
    const monacoEditor = editor as { addCommand: (keybinding: number, handler: () => void) => void };
    // Cmd/Ctrl + Enter to execute
    monacoEditor.addCommand(2048 | 3, () => { // KeyMod.CtrlCmd | KeyCode.Enter
      executeQuery();
    });
  }, [executeQuery]);

  if (!mounted) {
    return <div className="h-full flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>;
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Editor Section */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              onClick={executeQuery}
              disabled={executing || !sql.trim()}
              size="sm"
            >
              {executing ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              {t('execute')}
            </Button>
            <span className="text-xs text-muted-foreground">
              Ctrl/Cmd + Enter
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowHistory(!showHistory)}
          >
            <History className="h-4 w-4 mr-1" />
            {t('history')}
          </Button>
        </div>

        {/* History dropdown */}
        {showHistory && history.length > 0 && (
          <div className="border rounded-lg bg-background shadow-lg max-h-40 overflow-auto">
            {history.map((query, i) => (
              <button
                key={i}
                onClick={() => {
                  setSql(query);
                  setShowHistory(false);
                }}
                className="w-full text-left px-3 py-2 text-sm font-mono hover:bg-muted border-b last:border-0 truncate"
              >
                {query}
              </button>
            ))}
          </div>
        )}

        <div className="h-32 border rounded-lg overflow-hidden">
          <MonacoEditor
            language="sql"
            theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
            value={sql}
            onChange={value => setSql(value || '')}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'off',
              folding: false,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
            }}
          />
        </div>
      </div>

      {/* Results Section */}
      <div className="flex-1 overflow-hidden border rounded-lg">
        {result === null ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            {t('emptyResult')}
          </div>
        ) : result.success ? (
          <div className="h-full flex flex-col">
            {/* Status bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b text-sm">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              {result.rows && result.rows.length > 0 ? (
                <span>{t('rows', { count: result.rows.length })}</span>
              ) : result.rowsAffected !== undefined && result.rowsAffected > 0 ? (
                <span>{t('rowsAffected', { count: result.rowsAffected })}</span>
              ) : (
                <span>{t('success')}</span>
              )}
              <span className="text-muted-foreground">({number(result.executionTime ?? 0, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' })})</span>
            </div>

            {/* Results table */}
            {result.columns && result.columns.length > 0 && result.rows ? (
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      {result.columns.map((col, i) => (
                        <th key={i} className="text-left p-2 font-medium border-r last:border-0">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="border-t hover:bg-muted/30">
                        {row.map((cell, j) => (
                          <td key={j} className="p-2 font-mono text-xs border-r last:border-0 max-w-xs truncate">
                            {cell === null ? (
                              <span className="text-muted-foreground italic">NULL</span>
                            ) : typeof cell === 'object' ? (
                              JSON.stringify(cell)
                            ) : (
                              String(cell)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 p-4">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <p className="text-sm text-destructive font-medium">{t('error')}</p>
            <p className="text-sm text-muted-foreground text-center max-w-md">
              {result.error}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
