'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PublishSettings, Project } from '@/lib/vfs/types';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { SettingRow } from '@/components/ui/setting-row';
import { Globe, AlertTriangle, FolderOpen, Link2, History } from 'lucide-react';
import type { SitesMode } from '@/lib/web/site-origin';

interface GeneralTabProps {
  settings: PublishSettings;
  onChange: (settings: PublishSettings) => void;
  projectId: string;
  deploymentId: string;
  /** Resolved by the server; the client must not derive it from slug + hostname. */
  publicUrl?: string;
  /** Whether built files are currently served. Publishing state is not a setting, so it is read-only here. */
  published?: boolean;
  projects?: Project[];
  onProjectChange?: (projectId: string) => void;
  /** Where sites live elsewhere, the studio's own path only redirects there, so it is not shown. */
  sitesMode?: SitesMode | null;
  /** The project behind the deployment no longer exists on the server. */
  projectMissing?: boolean;
}

export function GeneralTab({ settings, onChange, projectId, deploymentId, publicUrl: resolvedUrl, published, projects, onProjectChange, sitesMode, projectMissing }: GeneralTabProps) {
  const t = useTranslations('publishSettings');
  const tc = useTranslations('common');
  const td = useTranslations('deploymentDetail');
  const [originalProjectId] = useState(projectId);
  const handleChange = (field: keyof PublishSettings, value: PublishSettings[keyof PublishSettings]) => {
    onChange({
      ...settings,
      [field]: value,
    });
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const directUrl = `${origin}/deployments/${deploymentId}`;
  // The custom domain is applied live so the field previews as it is typed; everything else comes
  // from the server, which is the only side that knows whether slug subdomains are routed.
  const publicUrl = settings.customDomain
    ? `https://${settings.customDomain}`
    : resolvedUrl || directUrl;
  // Unknown until the hosting answer arrives; shown only once it says sites share this address.
  const showDirectPath = publicUrl !== directUrl && sitesMode === 'same-origin';

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <SectionHeader icon={Globe} title={t('publishingStatus')} />
        <SectionBody className="px-4 py-1">
          <SettingRow title={t('underConstruction')} description={t('underConstructionDesc')}>
            <Switch
              id="under-construction"
              checked={settings.underConstruction}
              onCheckedChange={(checked) => handleChange('underConstruction', checked)}
            />
          </SettingRow>
        </SectionBody>
      </Section>

      {projects && projects.length > 0 && onProjectChange && (
        <Section>
          <SectionHeader icon={FolderOpen} title={t('sourceProject')} />
          <SectionBody className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="project-select">{tc('labels.project')}</Label>
              {/* A deleted project is not among the options; an empty value shows the placeholder
                  instead of a blank control. */}
              <Select
                value={projects.some((project) => project.id === projectId) ? projectId : ''}
                onValueChange={onProjectChange}
              >
                <SelectTrigger id="project-select">
                  <SelectValue placeholder={t('selectProject')} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('sourceProjectHelp')}
              </p>
            </div>

            {projectMissing && projectId === originalProjectId && (
              <div className="flex items-start gap-3 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">{t('projectMissingTitle')}</p>
                  <p className="mt-1 text-muted-foreground">{t('projectMissingDetail')}</p>
                </div>
              </div>
            )}

            {projectId !== originalProjectId && (
              <div className="flex items-start gap-3 p-3 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                <div className="text-sm text-yellow-800 dark:text-yellow-200">
                  <p className="font-medium">{t('changingSourceWarning')}</p>
                  <p className="mt-1 text-yellow-700 dark:text-yellow-300">
                    {t('sourceChangeDetail')}
                  </p>
                </div>
              </div>
            )}
          </SectionBody>
        </Section>
      )}

      <Section>
        <SectionHeader icon={Link2} title={t('publicUrl')} />
        <SectionBody className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
              <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
              <code className="text-sm flex-1 break-all">{publicUrl}</code>
              <Badge variant={published ? 'default' : 'secondary'} className="ml-2 shrink-0">
                {published ? t('live') : t('notPublished')}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('publicUrlHelp')}
            </p>
          </div>

          {/* Show direct path when subdomain or custom domain is set */}
          {showDirectPath && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('directPath')}</Label>
              <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg border border-dashed">
                <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                <code className="text-xs flex-1 text-muted-foreground break-all">{directUrl}</code>
              </div>
            </div>
          )}
        </SectionBody>
      </Section>

      <Section>
        <SectionHeader icon={Globe} title={t('customDomain')} />
        <SectionBody className="space-y-2">
          <Label htmlFor="custom-domain">{t('domainName')}</Label>
          <Input
            id="custom-domain"
            type="text"
            placeholder="example.com"
            value={settings.customDomain || ''}
            onChange={(e) => handleChange('customDomain', e.target.value || undefined)}
          />
          <p className="text-xs text-muted-foreground">
            {t('customDomainHelp')}
          </p>
        </SectionBody>
      </Section>

      <Section>
        <SectionHeader icon={History} title={tc('labels.version')} />
        <SectionBody className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">{t('currentVersion')}</div>
              <div className="text-2xl font-semibold tabular-nums">{settings.settingsVersion}</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">{t('publishedVersion')}</div>
              <div className="text-2xl font-semibold tabular-nums">
                {settings.lastPublishedVersion !== null && settings.lastPublishedVersion !== undefined
                  ? settings.lastPublishedVersion
                  : '-'}
              </div>
            </div>
          </div>

          {settings.lastPublishedVersion !== undefined &&
            settings.settingsVersion > settings.lastPublishedVersion && (
              <div className="p-3 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="bg-yellow-100 dark:bg-yellow-900">
                    {td('pendingChanges')}
                  </Badge>
                  <span className="text-sm">
                    {t('unpublishedChanges')}
                  </span>
                </div>
              </div>
            )}
        </SectionBody>
      </Section>
    </div>
  );
}
