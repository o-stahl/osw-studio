'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { PublishSettings, ComplianceConfig } from '@/lib/vfs/types';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { SettingRow } from '@/components/ui/setting-row';
import { Shield, Info, Cookie } from 'lucide-react';

interface ComplianceTabProps {
  settings: PublishSettings;
  onChange: (settings: PublishSettings) => void;
}

export function ComplianceTab({ settings, onChange }: ComplianceTabProps) {
  const t = useTranslations('publishSettings');
  const tp = useTranslations('preview');
  const tw = useTranslations('workspace');
  const handleComplianceChange = (
    field: keyof ComplianceConfig,
    value: any
  ) => {
    onChange({
      ...settings,
      compliance: {
        ...settings.compliance,
        [field]: value,
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <SectionHeader icon={Cookie} title={t('consentBanner')} />
        <SectionBody className="px-4 py-1">
          <SettingRow
            title={t('enableConsentBanner')}
            description={t('compliance.bannerHint')}
          >
            <Switch
              id="compliance-enabled"
              checked={settings.compliance.enabled}
              onCheckedChange={(checked) =>
                handleComplianceChange('enabled', checked)
              }
            />
          </SettingRow>
        </SectionBody>
      </Section>

      {settings.compliance.enabled && (
        <>
          {/* Banner Configuration */}
          <Section>
            <SectionHeader title={t('bannerConfiguration')} />
            <SectionBody className="space-y-4">

            {/* Banner Position */}
            <div className="space-y-2">
              <Label htmlFor="banner-position">{t('bannerPosition')}</Label>
              <Select
                value={settings.compliance.bannerPosition}
                onValueChange={(value) =>
                  handleComplianceChange('bannerPosition', value)
                }
              >
                <SelectTrigger id="banner-position">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top">{t('top')}</SelectItem>
                  <SelectItem value="bottom">{t('bottom')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Banner Style */}
            <div className="space-y-2">
              <Label htmlFor="banner-style">{t('bannerStyle')}</Label>
              <Select
                value={settings.compliance.bannerStyle}
                onValueChange={(value) =>
                  handleComplianceChange('bannerStyle', value)
                }
              >
                <SelectTrigger id="banner-style">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bar">{t('fullWidthBar')}</SelectItem>
                  <SelectItem value="modal">{t('centeredModal')}</SelectItem>
                  <SelectItem value="corner">{t('bottomRightCorner')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Banner Message */}
            <div className="space-y-2">
              <Label htmlFor="banner-message">{t('bannerMessage')}</Label>
              <Textarea
                id="banner-message"
                placeholder={t('bannerMessagePlaceholder')}
                rows={3}
                value={settings.compliance.message}
                onChange={(e) =>
                  handleComplianceChange('message', e.target.value)
                }
                maxLength={500}
              />
              <p className="text-xs text-muted-foreground">
                {settings.compliance.message.length}/500 characters
              </p>
            </div>

            {/* Button Texts */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="accept-text">{t('acceptButtonText')}</Label>
                <Input
                  id="accept-text"
                  placeholder={t('acceptPlaceholder')}
                  value={settings.compliance.acceptButtonText}
                  onChange={(e) =>
                    handleComplianceChange('acceptButtonText', e.target.value)
                  }
                  maxLength={50}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="decline-text">{t('declineButtonText')}</Label>
                <Input
                  id="decline-text"
                  placeholder={t('declinePlaceholder')}
                  value={settings.compliance.declineButtonText}
                  onChange={(e) =>
                    handleComplianceChange('declineButtonText', e.target.value)
                  }
                  maxLength={50}
                />
              </div>
            </div>

            {/* Policy Links */}
            <div className="space-y-4">
              <div>
                <h4 className="font-semibold mb-2">{t('policyLinks')}</h4>
                <p className="text-sm text-muted-foreground mb-4">
                  {t('compliance.policyLinksHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="privacy-policy-url">{t('privacyPolicyUrl')}</Label>
                <Input
                  id="privacy-policy-url"
                  type="url"
                  placeholder="https://example.com/privacy"
                  value={settings.compliance.privacyPolicyUrl || ''}
                  onChange={(e) =>
                    handleComplianceChange('privacyPolicyUrl', e.target.value)
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="cookie-policy-url">{t('cookiePolicyUrl')}</Label>
                <Input
                  id="cookie-policy-url"
                  type="url"
                  placeholder="https://example.com/cookies"
                  value={settings.compliance.cookiePolicyUrl || ''}
                  onChange={(e) =>
                    handleComplianceChange('cookiePolicyUrl', e.target.value)
                  }
                />
              </div>
            </div>
            </SectionBody>
          </Section>

          {/* Compliance Mode */}
          <Section>
            <SectionHeader title={t('complianceMode')} />
            <SectionBody className="space-y-4">

            <div className="space-y-2">
              <Label htmlFor="compliance-mode">{t('mode')}</Label>
              <Select
                value={settings.compliance.mode}
                onValueChange={(value) =>
                  handleComplianceChange('mode', value)
                }
              >
                <SelectTrigger id="compliance-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opt-in">{t('optIn')}</SelectItem>
                  <SelectItem value="opt-out">{t('optOut')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {settings.compliance.mode === 'opt-in'
                  ? t('compliance.optInHint')
                  : t('compliance.optOutHint')}
              </p>
            </div>

            {/* Block Analytics Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="space-y-1 flex-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor="block-analytics" className="text-base">
                    {t('compliance.blockAnalytics')}
                  </Label>
                  <Cookie className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('compliance.blockAnalyticsHint')}
                </p>
              </div>
              <Switch
                id="block-analytics"
                checked={settings.compliance.blockAnalytics}
                onCheckedChange={(checked) =>
                  handleComplianceChange('blockAnalytics', checked)
                }
              />
            </div>

            {settings.compliance.mode === 'opt-in' && (
              <div className="p-4 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
                <div className="flex gap-3">
                  <Shield className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <h4 className="font-semibold text-blue-900 dark:text-blue-100">
                      {t('compliance.gdprTitle')}
                    </h4>
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      {t('compliance.gdprBody')}
                    </p>
                  </div>
                </div>
              </div>
            )}
            </SectionBody>
          </Section>

          {/* Preview Info */}
          <Section>
            <SectionHeader title={tw('tabs.preview')} />
            <SectionBody className="space-y-4">

            <div className="p-4 bg-muted rounded-lg border">
              <div className="flex gap-3">
                <Info className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">{tp('livePreview')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('compliance.previewBody')}
                  </p>
                </div>
              </div>
            </div>
            </SectionBody>
          </Section>
        </>
      )}
    </div>
  );
}
