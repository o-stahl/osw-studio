'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ScheduledFunction, EdgeFunction } from '@/lib/vfs/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, AlertCircle, Info } from 'lucide-react';

interface ScheduledFunctionEditorProps {
  scheduledFunction: ScheduledFunction | null;
  edgeFunctions: EdgeFunction[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<ScheduledFunction>) => Promise<void>;
}

export function ScheduledFunctionEditor({
  scheduledFunction: fn,
  edgeFunctions,
  isOpen,
  onClose,
  onSave,
}: ScheduledFunctionEditorProps) {
  const t = useTranslations('backend');
  const tc = useTranslations('common');
  const [name, setName] = useState(fn?.name || '');
  const [functionId, setFunctionId] = useState(fn?.functionId || '');
  const [cronExpression, setCronExpression] = useState(fn?.cronExpression || '');
  const [timezone, setTimezone] = useState(fn?.timezone || 'UTC');
  const [description, setDescription] = useState(fn?.description || '');
  const [config, setConfig] = useState(fn?.config ? JSON.stringify(fn.config, null, 2) : '{}');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(fn?.name || '');
      setFunctionId(fn?.functionId || '');
      setCronExpression(fn?.cronExpression || '');
      setTimezone(fn?.timezone || 'UTC');
      setDescription(fn?.description || '');
      setConfig(fn?.config ? JSON.stringify(fn.config, null, 2) : '{}');
      setError(null);
    }
  }, [fn, isOpen]);

  const handleSave = async () => {
    setError(null);

    if (!name.trim()) {
      setError(t('validation.nameRequired'));
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
      setError(t('validation.slugName'));
      return;
    }
    if (!functionId) {
      setError(t('validation.edgeFunctionRequired'));
      return;
    }
    if (!cronExpression.trim()) {
      setError(t('validation.cronRequired'));
      return;
    }

    let parsedConfig: Record<string, unknown> = {};
    if (config.trim()) {
      try {
        const parsed = JSON.parse(config);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setError(t('validation.configObject'));
          return;
        }
        parsedConfig = parsed;
      } catch {
        setError(t('validation.configJson'));
        return;
      }
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        functionId,
        cronExpression: cronExpression.trim(),
        timezone: timezone.trim() || 'UTC',
        description: description.trim() || undefined,
        config: parsedConfig,
        enabled: fn?.enabled ?? true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveScheduleFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {fn ? t('schedEdit') : t('schedCreate')}
          </DialogTitle>
          <DialogDescription>
            {t('schedDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="sched-name">{tc('labels.name')}</Label>
            <Input
              id="sched-name"
              value={name}
              onChange={e => setName(e.target.value.toLowerCase())}
              placeholder="daily-report"
              disabled={!!fn}
            />
          </div>

          {/* Edge Function */}
          <div className="space-y-2">
            <Label htmlFor="sched-function">{t('edgeFunction')}</Label>
            <Select value={functionId} onValueChange={setFunctionId}>
              <SelectTrigger>
                <SelectValue placeholder={t('selectFunction')} />
              </SelectTrigger>
              <SelectContent>
                {edgeFunctions.map(ef => (
                  <SelectItem key={ef.id} value={ef.id}>
                    {ef.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {edgeFunctions.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('noEdgeFunctionsHint')}
              </p>
            )}
          </div>

          {/* Cron Expression */}
          <div className="space-y-2">
            <Label htmlFor="sched-cron">{t('cronExpression')}</Label>
            <Input
              id="sched-cron"
              value={cronExpression}
              onChange={e => setCronExpression(e.target.value)}
              placeholder="0 8 * * *"
              className="font-mono"
            />
          </div>

          {/* Timezone */}
          <div className="space-y-2">
            <Label htmlFor="sched-tz">{t('timezone')}</Label>
            <Input
              id="sched-tz"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              placeholder="UTC"
            />
            <p className="text-xs text-muted-foreground">
              {t('timezoneHelp')}
            </p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="sched-desc">{tc('labels.descriptionOptional')}</Label>
            <Input
              id="sched-desc"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('schedDescPlaceholder')}
            />
          </div>

          {/* Config */}
          <div className="space-y-2">
            <Label htmlFor="sched-config">{t('configJson')}</Label>
            <Textarea
              id="sched-config"
              value={config}
              onChange={e => setConfig(e.target.value)}
              placeholder="{}"
              className="font-mono text-sm h-20"
            />
            <p className="text-xs text-muted-foreground">
              {t('configHelp')}
            </p>
          </div>

          {/* Cron Reference */}
          <div className="bg-muted/30 border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4" />
              {t('cronPatterns')} <span className="font-normal text-muted-foreground">{t('cronMinInterval')}</span>
            </div>
            <div className="grid gap-1 text-xs font-mono">
              <div><span className="text-muted-foreground">*/5 * * * *</span>  {t('cronEvery5')}</div>
              <div><span className="text-muted-foreground">0 * * * *</span>    {t('cronHourly')}</div>
              <div><span className="text-muted-foreground">0 8 * * *</span>    {t('cronDaily8')}</div>
              <div><span className="text-muted-foreground">0 0 * * 1</span>    {t('cronMondayMidnight')}</div>
              <div><span className="text-muted-foreground">0 0 1 * *</span>    {t('cronFirstOfMonth')}</div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {tc('actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {tc('actions.saving')}
              </>
            ) : (
              fn ? tc('actions.saveChanges') : t('schedCreate')
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
