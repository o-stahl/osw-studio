'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Loader2, AlertTriangle, Plus, Minus, RefreshCw, Key,
  Code2, Wrench, Clock,
} from 'lucide-react';
import { apiFetch } from '@/lib/api/backend-status';

interface SwapDiff {
  edgeFunctions: { added: string[]; removed: string[]; changed: string[] };
  serverFunctions: { added: string[]; removed: string[]; changed: string[] };
  secrets: { added: string[]; removed: string[]; overlapping: string[] };
  scheduledFunctions: { added: string[]; removed: string[]; changed: string[] };
  hasConflicts: boolean;
}

interface ProjectSwapDialogProps {
  isOpen: boolean;
  onClose: () => void;
  deploymentId: string;
  deploymentName: string;
  currentProjectId: string;
  newProjectId: string;
  newProjectName: string;
  onSwapComplete: () => void;
  workspaceId?: string;
}

export function ProjectSwapDialog({
  isOpen,
  onClose,
  deploymentId,
  deploymentName,
  currentProjectId,
  newProjectId,
  newProjectName,
  onSwapComplete,
  workspaceId,
}: ProjectSwapDialogProps) {
  const tb = useTranslations('backend');
  const tc = useTranslations('common');
  const tid = useTranslations('importDialog');
  const tt = useTranslations('tooltips');
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [diff, setDiff] = useState<SwapDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);

  useEffect(() => {
    if (isOpen && newProjectId !== currentProjectId) {
      loadDiff();
    }
  }, [isOpen, deploymentId, newProjectId]);

  const loadDiff = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiFetch(
        `${apiBase}/deployments/${deploymentId}/swap-project?projectId=${encodeURIComponent(newProjectId)}`
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || tb('analyzeSwapFailed'));
      }
      const data = await res.json();
      setDiff(data.diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : tb('analyzeSwapFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSwap = async () => {
    try {
      setSwapping(true);
      setError(null);
      const res = await apiFetch(`${apiBase}/deployments/${deploymentId}/swap-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: newProjectId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || tb('swapFailed'));
      }
      onSwapComplete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tb('swapFailed'));
    } finally {
      setSwapping(false);
    }
  };

  const isEmpty = diff && !diff.hasConflicts &&
    diff.edgeFunctions.added.length === 0 &&
    diff.serverFunctions.added.length === 0 &&
    diff.secrets.added.length === 0 &&
    diff.scheduledFunctions.added.length === 0;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tb('swapTitle')}</DialogTitle>
          <DialogDescription>
            {tb('swapDesc', { deployment: deploymentName, project: newProjectName })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">{tb('analyzingChanges')}</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {diff && !loading && (
            <div className="space-y-4">
              {isEmpty && (
                <p className="text-sm text-muted-foreground">
                  {tb('noBackendChanges')}
                </p>
              )}

              {/* Edge Functions diff */}
              <DiffSection
                icon={<Code2 className="h-4 w-4" />}
                title={tb('edgeFunctions')}
                added={diff.edgeFunctions.added}
                removed={diff.edgeFunctions.removed}
                changed={diff.edgeFunctions.changed}
              />

              {/* Server Functions diff */}
              <DiffSection
                icon={<Wrench className="h-4 w-4" />}
                title={tid('serverFunctions')}
                added={diff.serverFunctions.added}
                removed={diff.serverFunctions.removed}
                changed={diff.serverFunctions.changed}
              />

              {/* Secrets diff */}
              {(diff.secrets.added.length > 0 || diff.secrets.removed.length > 0 || diff.secrets.overlapping.length > 0) && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Key className="h-4 w-4" />
                    {tb('secretsTitle')}
                  </div>
                  <div className="pl-6 space-y-1 text-sm">
                    {diff.secrets.added.map(name => (
                      <div key={name} className="flex items-center gap-1 text-green-600">
                        <Plus className="h-3 w-3" /> {name}
                      </div>
                    ))}
                    {diff.secrets.removed.map(name => (
                      <div key={name} className="flex items-center gap-1 text-red-600">
                        <Minus className="h-3 w-3" /> {name}
                      </div>
                    ))}
                    {diff.secrets.overlapping.map(name => (
                      <div key={name} className="flex items-center gap-1 text-yellow-600">
                        <RefreshCw className="h-3 w-3" /> {name} (values will be replaced)
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Scheduled Functions diff */}
              <DiffSection
                icon={<Clock className="h-4 w-4" />}
                title={tt('scheduledFunctions')}
                added={diff.scheduledFunctions.added}
                removed={diff.scheduledFunctions.removed}
                changed={diff.scheduledFunctions.changed}
              />

              {diff.hasConflicts && (
                <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                  <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-yellow-800 dark:text-yellow-200">
                    {tb('swapConflictWarning')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={swapping}>
            {tc('actions.cancel')}
          </Button>
          <Button
            onClick={handleSwap}
            disabled={loading || swapping || !!error}
            variant={diff?.hasConflicts ? 'destructive' : 'default'}
          >
            {swapping ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {tb('swapping')}
              </>
            ) : (
              tb('swapAndRepublish')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiffSection({
  icon,
  title,
  added,
  removed,
  changed,
}: {
  icon: React.ReactNode;
  title: string;
  added: string[];
  removed: string[];
  changed: string[];
}) {
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      <div className="pl-6 space-y-1 text-sm">
        {added.map(name => (
          <div key={name} className="flex items-center gap-1 text-green-600">
            <Plus className="h-3 w-3" /> {name}
          </div>
        ))}
        {removed.map(name => (
          <div key={name} className="flex items-center gap-1 text-red-600">
            <Minus className="h-3 w-3" /> {name}
          </div>
        ))}
        {changed.map(name => (
          <div key={name} className="flex items-center gap-1 text-yellow-600">
            <RefreshCw className="h-3 w-3" /> {name}
          </div>
        ))}
      </div>
    </div>
  );
}
