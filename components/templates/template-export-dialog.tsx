'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Project, LICENSE_OPTIONS } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { templateService, TemplateMetadata } from '@/lib/vfs/template-service';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { Info, FileBox } from 'lucide-react';

interface TemplateExportDialogProps {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TemplateExportDialog({
  project,
  open,
  onOpenChange,
}: TemplateExportDialogProps) {
  const t = useTranslations('templatesUi');
  const tc = useTranslations('common');
  const [exporting, setExporting] = useState(false);
  const [metadata, setMetadata] = useState<TemplateMetadata>({
    name: project?.name || '',
    description: project?.description || '',
    version: '1.0.0',
    author: '',
    authorUrl: '',
    license: 'personal',
    tags: [],
    thumbnail: undefined,
    previewImages: [],
    downloadUrl: ''
  });
  const [tagsInput, setTagsInput] = useState('');

  const handleExport = async () => {
    if (!project) return;

    // Validate required fields
    if (!metadata.name || metadata.name.length < 1 || metadata.name.length > 50) {
      toast.error(t('nameLength'));
      return;
    }

    if (!metadata.description || metadata.description.length < 10 || metadata.description.length > 500) {
      toast.error(t('descLength'));
      return;
    }

    if (!metadata.version || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
      toast.error(t('versionFormat'));
      return;
    }

    try {
      setExporting(true);

      // Parse tags
      const tags = tagsInput
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);

      const exportMetadata = {
        ...metadata,
        tags
      };

      // Save template to instance
      await templateService.saveProjectAsTemplate(
        vfs,
        project.id,
        exportMetadata
      );

      toast.success(t('created'));
      onOpenChange(false);

      // Reset form
      setMetadata({
        name: '',
        description: '',
        version: '1.0.0',
        author: '',
        authorUrl: '',
        license: 'personal',
        tags: [],
        thumbnail: undefined,
        previewImages: [],
        downloadUrl: ''
      });
      setTagsInput('');
    } catch (error) {
      logger.error('Failed to export template:', error);
      toast.error(error instanceof Error ? error.message : t('exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  // Update form when project changes
  React.useEffect(() => {
    if (project && open) {
      setMetadata(prev => ({
        ...prev,
        name: project.name,
        description: project.description || '',
        // Use project preview as default thumbnail if available
        thumbnail: project.previewImage || prev.thumbnail
      }));
    }
  }, [project, open]);

  const selectedLicense = LICENSE_OPTIONS.find(opt => opt.value === metadata.license);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('createTemplate')}</DialogTitle>
          <DialogDescription>
            {t('exportDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Preview Thumbnail */}
          {metadata.thumbnail && (
            <div className="space-y-2">
              <Label>{t('previewThumbnail')}</Label>
              <div className="w-full rounded-lg overflow-hidden bg-muted border">
                <img
                  src={metadata.thumbnail}
                  alt={t('previewAlt')}
                  className="w-full h-auto"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('previewCapturedNote')}
              </p>
            </div>
          )}

          {!metadata.thumbnail && (
            <div className="space-y-2">
              <Label>{t('previewThumbnail')}</Label>
              <div className="w-full h-48 rounded-lg bg-muted flex items-center justify-center border">
                <div className="text-center text-muted-foreground">
                  <FileBox className="h-12 w-12 mx-auto mb-2" />
                  <p className="text-sm">{t('noPreview')}</p>
                  <p className="text-xs">{t('saveToCapture')}</p>
                </div>
              </div>
            </div>
          )}

          {/* Name */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label htmlFor="template-name">
                {t('templateName')} <span className="text-destructive">*</span>
              </Label>
              <span className="text-xs text-muted-foreground">
                {metadata.name.length}/50
              </span>
            </div>
            <Input
              id="template-name"
              value={metadata.name}
              onChange={(e) => setMetadata({ ...metadata, name: e.target.value.slice(0, 50) })}
              placeholder={t('namePlaceholder')}
              maxLength={50}
              required
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label htmlFor="template-description">
                {tc('labels.description')} <span className="text-destructive">*</span>
              </Label>
              <span className="text-xs text-muted-foreground">
                {metadata.description.length}/500
              </span>
            </div>
            <Textarea
              id="template-description"
              value={metadata.description}
              onChange={(e) => setMetadata({ ...metadata, description: e.target.value.slice(0, 500) })}
              placeholder={t('descPlaceholder')}
              className="resize-none"
              rows={3}
              maxLength={500}
              required
            />
          </div>

          {/* Version */}
          <div className="space-y-2">
            <Label htmlFor="template-version">
              {tc('labels.version')} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="template-version"
              value={metadata.version}
              onChange={(e) => setMetadata({ ...metadata, version: e.target.value })}
              placeholder="1.0.0"
              pattern="^\d+\.\d+\.\d+$"
              required
            />
            <p className="text-xs text-muted-foreground">
              {t('versionHelp')}
            </p>
          </div>

          {/* Author */}
          <div className="space-y-2">
            <Label htmlFor="template-author">{tc('labels.author')}</Label>
            <Input
              id="template-author"
              value={metadata.author}
              onChange={(e) => setMetadata({ ...metadata, author: e.target.value.slice(0, 50) })}
              placeholder={t('authorPlaceholder')}
              maxLength={50}
            />
          </div>

          {/* Author URL */}
          <div className="space-y-2">
            <Label htmlFor="template-author-url">{t('authorUrl')}</Label>
            <Input
              id="template-author-url"
              type="url"
              value={metadata.authorUrl}
              onChange={(e) => setMetadata({ ...metadata, authorUrl: e.target.value })}
              placeholder="https://yourwebsite.com"
            />
          </div>

          {/* License */}
          <div className="space-y-2">
            <Label htmlFor="template-license">
              {t('license')} <span className="text-destructive">*</span>
            </Label>
            <Select
              value={metadata.license}
              onValueChange={(value) => setMetadata({ ...metadata, license: value })}
            >
              <SelectTrigger id="template-license">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LICENSE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedLicense && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-muted text-xs">
                <Info className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
                <p className="text-muted-foreground">{selectedLicense.description}</p>
              </div>
            )}
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <Label htmlFor="template-tags">{t('tags')}</Label>
            <Input
              id="template-tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder={t('tagsPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('tagsHelp')}
            </p>
          </div>

          {/* Marketplace URL */}
          <div className="space-y-2">
            <Label htmlFor="template-download-url">{t('marketplaceUrl')}</Label>
            <Input
              id="template-download-url"
              type="url"
              value={metadata.downloadUrl}
              onChange={(e) => setMetadata({ ...metadata, downloadUrl: e.target.value })}
              placeholder="https://example.com/templates/..."
            />
            <p className="text-xs text-muted-foreground">
              {t('marketplaceUrlHelp')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={exporting}>
            {tc('actions.cancel')}
          </Button>
          <Button onClick={handleExport} disabled={exporting}>
            {exporting ? tc('actions.creating') : t('createTemplateButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
