'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Play, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { SchemaViewer } from '@/components/database-manager/schema-viewer';
import { SqlEditor } from '@/components/database-manager/sql-editor';
import { getProjectSchema, setProjectSchema } from '@/lib/vfs/project-schema';

interface SchemaEditorProps {
  projectId: string;
  enabled: boolean;
  onSchemaChange?: (schema: string) => void;
  workspaceId?: string;
}

type SubTab = 'tables' | 'sql' | 'ddl';

export function SchemaEditor({ projectId, enabled, onSchemaChange, workspaceId }: SchemaEditorProps) {
  const t = useTranslations('backend');
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('tables');
  const [ddl, setDdl] = useState('');
  const [applying, setApplying] = useState(false);
  const [schemaKey, setSchemaKey] = useState(0);
  const autoAppliedRef = useRef<string | null>(null);

  const schemaEndpoint = `${apiBase}/projects/${projectId}/database/schema`;
  const queryEndpoint = `${apiBase}/projects/${projectId}/database/query`;

  // Auto-apply: if localStorage has schema DDL but the project database has no tables,
  // apply the DDL automatically. This self-heals when the initial application during
  // project creation failed (e.g., project not yet synced to SQLite, server restart).
  useEffect(() => {
    if (!enabled) return;
    // Only auto-apply once per projectId
    if (autoAppliedRef.current === projectId) return;

    const tryAutoApply = async () => {
      try {
        const storedSchema = await getProjectSchema(projectId);
        if (!storedSchema) return;

        // Check if database already has tables
        const schemaRes = await fetch(schemaEndpoint);
        if (!schemaRes.ok) return;
        const schemaData = await schemaRes.json();
        if (schemaData.tables && schemaData.tables.length > 0) {
          autoAppliedRef.current = projectId;
          return; // Already has tables, nothing to do
        }

        // Database is empty but the project has DDL — apply it
        const res = await fetch(queryEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: storedSchema }),
        });

        if (res.ok) {
          autoAppliedRef.current = projectId;
          setSchemaKey(prev => prev + 1);
        }
      } catch {
        // Non-fatal — user can manually apply via DDL tab
      }
    };

    tryAutoApply();
  }, [enabled, projectId, schemaEndpoint, queryEndpoint]);

  const applyDDL = useCallback(async () => {
    if (!ddl.trim()) return;

    setApplying(true);
    try {
      const res = await fetch(queryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: ddl.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('applyDdlFailed'));
        return;
      }

      toast.success(t('ddlApplied'));

      // Append to the project's stored schema so the AI server context stays in sync
      const existing = await getProjectSchema(projectId);
      const updated = existing ? `${existing}\n\n${ddl.trim()}` : ddl.trim();
      await setProjectSchema(projectId, updated);
      onSchemaChange?.(updated);

      // Refresh SchemaViewer
      setSchemaKey(prev => prev + 1);
      setDdl('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('applyDdlFailed'));
    } finally {
      setApplying(false);
    }
  }, [ddl, queryEndpoint, projectId, onSchemaChange, t]);

  if (!enabled) {
    return null;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Sub-tab buttons */}
      <div className="flex items-center gap-1 mb-3 border-b pb-2">
        {(['tables', 'sql', 'ddl'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveSubTab(tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeSubTab === tab
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            {tab === 'tables' ? t('tablesTab') : tab === 'sql' ? 'SQL' : 'DDL'}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 min-h-0">
        {activeSubTab === 'tables' && (
          <SchemaViewer
            key={schemaKey}
            schemaEndpoint={schemaEndpoint}
            showSystemTablesToggle={false}
          />
        )}

        {activeSubTab === 'sql' && (
          <SqlEditor queryEndpoint={queryEndpoint} />
        )}

        {activeSubTab === 'ddl' && (
          <div className="h-full flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium">{t('applyDdl')}</h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('ddlHint')}
                </p>
              </div>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={applyDDL}
                disabled={applying || !ddl.trim()}
              >
                {applying ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                {t('apply')}
              </Button>
            </div>
            <textarea
              data-schema-editor
              className="flex-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground"
              placeholder={`-- Create or modify tables\nCREATE TABLE IF NOT EXISTS example (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);`}
              value={ddl}
              onChange={(e) => setDdl(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}
