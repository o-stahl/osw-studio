'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PublishSettings, SeoConfig } from '@/lib/vfs/types';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { ImageIcon, Search, X } from 'lucide-react';

interface SeoTabProps {
  settings: PublishSettings;
  onChange: (settings: PublishSettings) => void;
}

export function SeoTab({ settings, onChange }: SeoTabProps) {
  const t = useTranslations('publishSettings');
  const te = useTranslations('editor');
  const tc = useTranslations('common');
  const [keywords, setKeywords] = useState('');
  // The URL that failed to load, so a different one is tried again.
  const [failedOgImage, setFailedOgImage] = useState<string | null>(null);

  const handleSeoChange = (field: keyof SeoConfig, value: any) => {
    onChange({
      ...settings,
      seo: {
        ...settings.seo,
        [field]: value,
      },
    });
  };

  const handleAddKeyword = () => {
    if (!keywords.trim()) return;

    const currentKeywords = settings.seo.keywords || [];
    const newKeywords = keywords
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k && !currentKeywords.includes(k));

    if (newKeywords.length > 0) {
      handleSeoChange('keywords', [...currentKeywords, ...newKeywords]);
      setKeywords('');
    }
  };

  const handleRemoveKeyword = (keyword: string) => {
    const currentKeywords = settings.seo.keywords || [];
    handleSeoChange(
      'keywords',
      currentKeywords.filter((k) => k !== keyword)
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Basic Meta Tags */}
      <Section>
        <SectionHeader title={t('basicMeta')} />
        <SectionBody className="space-y-4">

        <p className="text-xs text-muted-foreground">
          {t('seoDefaultsHint')}
        </p>

        <div className="space-y-2">
          <Label htmlFor="seo-title">{t('metaTitle')}</Label>
          <Input
            id="seo-title"
            placeholder={t('metaTitlePlaceholder')}
            value={settings.seo.title || ''}
            onChange={(e) => handleSeoChange('title', e.target.value || undefined)}
          />
          <p className="text-xs text-muted-foreground">
            {t('recommendedChars', { range: '50–60' })}
            {settings.seo.title && (
              <span className="ml-2">
                {t('charCount', { count: settings.seo.title.length })}
              </span>
            )}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="seo-description">{t('metaDescription')}</Label>
          <Textarea
            id="seo-description"
            placeholder={t('metaDescriptionPlaceholder')}
            rows={3}
            value={settings.seo.description || ''}
            onChange={(e) =>
              handleSeoChange('description', e.target.value || undefined)
            }
          />
          <p className="text-xs text-muted-foreground">
            {t('recommendedChars', { range: '150–160' })}
            {settings.seo.description && (
              <span className="ml-2">
                {t('charCount', { count: settings.seo.description.length })}
              </span>
            )}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="seo-keywords">{t('keywords')}</Label>
          <div className="flex gap-2">
            <Input
              id="seo-keywords"
              placeholder={t('keywordsPlaceholder')}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddKeyword();
                }
              }}
            />
            <Button type="button" onClick={handleAddKeyword} variant="outline">
              {tc('actions.add')}
            </Button>
          </div>
          {settings.seo.keywords && settings.seo.keywords.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {settings.seo.keywords.map((keyword) => (
                <Badge key={keyword} variant="secondary" className="gap-1">
                  {keyword}
                  <button
                    onClick={() => handleRemoveKeyword(keyword)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="seo-canonical">{t('canonicalUrl')}</Label>
          <Input
            id="seo-canonical"
            type="url"
            placeholder="https://example.com/page"
            value={settings.seo.canonical || ''}
            onChange={(e) =>
              handleSeoChange('canonical', e.target.value || undefined)
            }
          />
          <p className="text-xs text-muted-foreground">
            {t('canonicalHelp')}
          </p>
        </div>
        </SectionBody>
      </Section>

      {/* Open Graph */}
      <Section>
        <SectionHeader title={t('openGraph')} />
        <SectionBody className="space-y-4">

        <div className="space-y-2">
          <Label htmlFor="og-title">{t('ogTitle')}</Label>
          <Input
            id="og-title"
            placeholder={t('ogTitlePlaceholder')}
            value={settings.seo.ogTitle || ''}
            onChange={(e) => handleSeoChange('ogTitle', e.target.value || undefined)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="og-description">{t('ogDescription')}</Label>
          <Textarea
            id="og-description"
            placeholder={t('ogDescriptionPlaceholder')}
            rows={2}
            value={settings.seo.ogDescription || ''}
            onChange={(e) =>
              handleSeoChange('ogDescription', e.target.value || undefined)
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="og-image">{t('ogImageUrl')}</Label>
          <Input
            id="og-image"
            type="url"
            placeholder="https://example.com/image.jpg"
            value={settings.seo.ogImage || ''}
            onChange={(e) => handleSeoChange('ogImage', e.target.value || undefined)}
          />
          <p className="text-xs text-muted-foreground">
            {t('ogImageHelp')}
          </p>
        </div>

        {settings.seo.ogImage && (
          <div className="p-4 border rounded-lg">
            <p className="text-sm font-medium mb-2">{te('imagePreview')}</p>
            <div className="relative aspect-video bg-muted rounded flex items-center justify-center overflow-hidden">
              {failedOgImage === settings.seo.ogImage ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <ImageIcon className="h-8 w-8" />
                  <span>{t('imageLoadFailed')}</span>
                </div>
              ) : (
                <img
                  src={settings.seo.ogImage}
                  alt={t('ogImageAlt')}
                  className="object-cover w-full h-full"
                  onError={() => setFailedOgImage(settings.seo.ogImage ?? null)}
                />
              )}
            </div>
          </div>
        )}
        </SectionBody>
      </Section>

      {/* Twitter Card */}
      <Section>
        <SectionHeader title={t('twitterCard')} />
        <SectionBody className="space-y-4">

        <div className="space-y-2">
          <Label htmlFor="twitter-card">{t('cardType')}</Label>
          <Select
            value={settings.seo.twitterCard || 'summary_large_image'}
            onValueChange={(value: 'summary' | 'summary_large_image') =>
              handleSeoChange('twitterCard', value)
            }
          >
            <SelectTrigger id="twitter-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="summary">{t('summary')}</SelectItem>
              <SelectItem value="summary_large_image">
                {t('summaryLargeImage')}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('twitterCardHelp')}
          </p>
        </div>
        </SectionBody>
      </Section>

      {/* Preview */}
      <Section>
        <SectionHeader title={t('searchPreview')} />
        <SectionBody className="space-y-4">

        <div className="p-4 border rounded-lg bg-muted/50">
          <div className="flex gap-2 mb-2">
            <Search className="h-5 w-5 text-blue-600" />
            <div className="flex-1">
              <div className="text-sm text-blue-600 mb-1">
                https://your-domain.com
              </div>
              <h3 className="text-lg text-blue-800 dark:text-blue-400 font-medium mb-1">
                {settings.seo.title || settings.seo.ogTitle || t('deploymentTitlePlaceholder')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {settings.seo.description ||
                  settings.seo.ogDescription ||
                  t('previewDescFallback')}
              </p>
            </div>
          </div>
        </div>
        </SectionBody>
      </Section>

      {/* Social Share Preview */}
      {(settings.seo.ogTitle || settings.seo.ogImage) && (
        <Section>
          <SectionHeader title={t('socialPreview')} />
          <SectionBody className="space-y-4">

          <div className="p-4 border rounded-lg bg-muted/50">
            <div className="space-y-2">
              {settings.seo.ogImage && (
                <div className="aspect-video bg-muted rounded overflow-hidden">
                  <img
                    src={settings.seo.ogImage}
                    alt={t('socialPreviewAlt')}
                    className="object-cover w-full h-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              )}
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  your-domain.com
                </div>
                <h4 className="font-semibold">
                  {settings.seo.ogTitle || settings.seo.title || t('deploymentTitlePlaceholder')}
                </h4>
                <p className="text-sm text-muted-foreground">
                  {settings.seo.ogDescription ||
                    settings.seo.description ||
                    t('previewDescShort')}
                </p>
              </div>
            </div>
          </div>
          </SectionBody>
        </Section>
      )}
    </div>
  );
}
