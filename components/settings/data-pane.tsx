'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Download, Upload, Info, Database } from 'lucide-react';
import { BackupService, type BackupImportStage } from '@/lib/vfs/backup-service';
import { track } from '@/lib/telemetry';
import { configManager } from '@/lib/config/storage';
import { AboutModal } from '@/components/about-modal';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { SettingRow } from '@/components/ui/setting-row';

export function DataPane() {
  const tc = useTranslations('common');
  const tp = useTranslations('projects');
  const t = useTranslations('settings');
  const tn = useTranslations('nav');
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStage, setImportStage] = useState<BackupImportStage | 'checking' | null>(null);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);

  const handleExportData = async () => {
    try {
      setIsExporting(true);
      await BackupService.exportAllData();
      toast.success(t('dataExported'));
      track('project_export', { format: 'osws' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('exportFailedFallback'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportData = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.osws';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        setIsImporting(true);
        setImportProgress(0);
        setImportStage('checking');

        const validation = await BackupService.validateBackupFile(file);
        if (!validation.valid) {
          toast.error(t('invalidBackup', { reason: validation.reason ?? '' }));
          return;
        }

        const shouldReplace = confirm(
          t('importConfirm', { count: validation.metadata?.projectCount || 0 })
        );

        await BackupService.importAllData(file, {
          mode: shouldReplace ? 'replace' : 'merge',
          onProgress: (progress, stage) => {
            setImportProgress(progress);
            setImportStage(stage);
          }
        });

        toast.success(t('dataImported'));
        track('project_import', { format: 'osws' });
        setTimeout(() => window.location.reload(), 1000);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('importFailedFallback'));
      } finally {
        setIsImporting(false);
        setImportProgress(0);
        setImportStage(null);
      }
    };
    input.click();
  };

  const clearSettings = () => {
    if (confirm(t('clearAllConfirm'))) {
      configManager.clearSettings();
      toast.success(t('settingsCleared'));
    }
  };

  return (
    <>
      <Section>
        <SectionHeader icon={Database} title={tn('settings.data')} />
        <SectionBody className="px-4 py-1">
          <SettingRow
            title={t('exportAll')}
            description={t('exportDesc')}
          >
            <Button variant="outline" size="sm" onClick={handleExportData} disabled={isExporting}>
              <Download className="h-4 w-4" />
              {isExporting ? t('exporting') : tc('actions.export')}
            </Button>
          </SettingRow>

          <SettingRow title={t('importData')} description={t('importDesc')}>
            <Button variant="outline" size="sm" onClick={handleImportData} disabled={isImporting}>
              <Upload className="h-4 w-4" />
              {isImporting ? t('importing') : tc('actions.import')}
            </Button>
          </SettingRow>

          {isImporting && (
            <div className="space-y-2 py-3 border-t border-border">
              <div className="flex justify-between text-xs">
                <span>{importStage && t(`importStage.${importStage}`)}</span>
                <span>{importProgress}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${importProgress}%` }}
                />
              </div>
            </div>
          )}
        </SectionBody>
      </Section>

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={clearSettings}
        >
          {t('clearAll')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAboutModalOpen(true)}>
          <Info className="mr-1.5 h-3.5 w-3.5" />
          {tp('about')}
        </Button>
      </div>

      <AboutModal open={aboutModalOpen} onOpenChange={setAboutModalOpen} />
    </>
  );
}
