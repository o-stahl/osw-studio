'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { CustomTemplate, LICENSE_OPTIONS } from '@/lib/vfs/types';
import type { BuiltInTemplateMetadata } from '@/lib/vfs/templates/registry';
import { getRuntimeBadge } from '@/lib/runtimes/registry';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash2, Plus, FileBox, Download, Link2, ExternalLink, MoreVertical, Server, Eye } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';

interface TemplateCardProps {
  template: CustomTemplate | BuiltInTemplateMetadata;
  onSelect: (template: CustomTemplate | BuiltInTemplateMetadata) => void;
  /** Opens the template in a preview. Absent for a template with no page to show. */
  onPreview?: (template: CustomTemplate | BuiltInTemplateMetadata) => void;
  onDelete?: (id: string) => void;
  onExport?: (template: CustomTemplate | BuiltInTemplateMetadata) => void;
  viewMode?: 'grid' | 'list';
}

export function TemplateCard({
  template,
  onSelect,
  onPreview,
  onDelete,
  onExport,
  viewMode = 'grid'
}: TemplateCardProps) {
  const tpx = useTranslations('projects');
  const tc = useTranslations('common');
  const t = useTranslations('templatesUi');
  const when = useLocalFormat();
  const isBuiltIn = 'isBuiltIn' in template && template.isBuiltIn;
  const customTemplate = !isBuiltIn ? template as CustomTemplate : null;
  const hasBackendFeatures = isBuiltIn
    ? !!(template as BuiltInTemplateMetadata).hasBackendFeatures
    : !!customTemplate?.backendFeatures;

  const getLicenseLabel = (licenseValue: string): string => {
    const license = LICENSE_OPTIONS.find(opt => opt.value === licenseValue);
    return license?.label || licenseValue;
  };

  const runtimeBadge = isBuiltIn && 'runtime' in template
    ? getRuntimeBadge((template as BuiltInTemplateMetadata).runtime)
    : null;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isBuiltIn || !onDelete) return;
    onDelete(template.id);
  };

  const handleExport = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onExport) onExport(template);
  };

  const formatDate = (date: Date | undefined) => (date ? when.relativeTime(date) : t('never'));

  // List view (horizontal row)
  if (viewMode === 'list') {
    return (
      <div
        className="border border-border rounded-lg p-4 bg-card"
      >
        <div className="flex items-center gap-4">
          {/* Thumbnail */}
          <div className="relative shrink-0">
            {customTemplate?.metadata.thumbnail ? (
              <div className="w-24 h-16 rounded-md overflow-hidden bg-muted">
                <img
                  src={customTemplate.metadata.thumbnail}
                  alt={template.name}
                  className="w-full h-full object-cover"
                />
              </div>
            ) : (
              <div className="w-24 h-16 rounded-md bg-muted flex items-center justify-center">
                <FileBox className="h-8 w-8 text-muted-foreground" />
              </div>
            )}
            {isBuiltIn && (
              <Tip label={t('builtIn')}>
                <div className="absolute top-1 right-1 bg-background/90 rounded-full p-1">
                  <Link2 className="h-3 w-3 text-muted-foreground" />
                </div>
              </Tip>
            )}
          </div>

          {/* Template Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Tip label={template.name} truncated>
                <h3 className="font-semibold text-base truncate">
                  {template.name}
                </h3>
              </Tip>
              {customTemplate && (
                <span className="text-xs text-muted-foreground shrink-0">
                  v{customTemplate.version}
                </span>
              )}
            </div>

            <Tip label={template.description} truncated>
              <p className="text-sm text-muted-foreground truncate mb-2">
                {template.description}
              </p>
            </Tip>

            {/* Metadata */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {runtimeBadge && (
                <Badge className={`text-xs px-1.5 py-0 h-auto ${runtimeBadge.className}`}>{runtimeBadge.label}</Badge>
              )}
              {hasBackendFeatures && (
                <Badge className="text-xs px-1.5 py-0 h-auto bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800">
                  <Server className="h-3 w-3 mr-0.5" />
                  {t('backend')}
                </Badge>
              )}
              {(customTemplate?.metadata.author || template.metadata?.author) && (
                <Tip label={customTemplate?.metadata.author || template.metadata?.author} truncated>
                  <span className="truncate max-w-[150px]">
                    by {customTemplate?.metadata.author || template.metadata?.author}
                  </span>
                </Tip>
              )}
              {customTemplate?.metadata.license && (
                <>
                  {customTemplate.metadata.author && <span>•</span>}
                  <Badge variant="secondary" className="text-xs px-1.5 py-0 h-auto">
                    {getLicenseLabel(customTemplate.metadata.license)}
                  </Badge>
                </>
              )}
              {customTemplate?.files && (
                <>
                  <span>•</span>
                  <span>{customTemplate.files.length} files</span>
                </>
              )}
              {(customTemplate?.metadata.tags || template.metadata?.tags) && (
                <>
                  <span>•</span>
                  {(customTemplate?.metadata.tags || template.metadata?.tags || []).slice(0, 2).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs px-1.5 py-0 h-auto">
                      {tag}
                    </Badge>
                  ))}
                  {(customTemplate?.metadata.tags || template.metadata?.tags || []).length > 2 && (
                    <Badge variant="outline" className="text-xs px-1.5 py-0 h-auto">
                      +{(customTemplate?.metadata.tags || template.metadata?.tags || []).length - 2}
                    </Badge>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Actions - Desktop */}
          <div className="hidden md:flex items-center gap-3 shrink-0">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatDate(customTemplate?.updatedAt || template.updatedAt)}
            </span>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tip label={t('tips.more', { name: template.name })} align="end">
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('tips.more', { name: template.name })}>
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </Tip>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onSelect(template)}>
                  <Plus className="mr-2 h-4 w-4" />
                  {tpx('createProject')}
                </DropdownMenuItem>
                {onPreview && (
                  <DropdownMenuItem onClick={() => onPreview(template)}>
                    <Eye className="mr-2 h-4 w-4" />
                    {tc('actions.preview')}
                  </DropdownMenuItem>
                )}
                {onExport && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleExport}>
                      <Download className="mr-2 h-4 w-4" />
                      {t('exportTemplate')}
                    </DropdownMenuItem>
                  </>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <Tip label={isBuiltIn ? t('cannotDeleteBuiltIn') : undefined}>
                      <div>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={handleDelete}
                          disabled={isBuiltIn}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {tc('actions.delete')}
                        </DropdownMenuItem>
                      </div>
                    </Tip>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Actions - Mobile */}
          <div className="md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tip label={t('tips.more', { name: template.name })} align="end">
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('tips.more', { name: template.name })}>
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </Tip>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onSelect(template)}>
                  <Plus className="mr-2 h-4 w-4" />
                  {tpx('createProject')}
                </DropdownMenuItem>
                {onPreview && (
                  <DropdownMenuItem onClick={() => onPreview(template)}>
                    <Eye className="mr-2 h-4 w-4" />
                    {tc('actions.preview')}
                  </DropdownMenuItem>
                )}
                {onExport && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleExport}>
                      <Download className="mr-2 h-4 w-4" />
                      {t('exportTemplate')}
                    </DropdownMenuItem>
                  </>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={handleDelete}
                      disabled={isBuiltIn}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {tc('actions.delete')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    );
  }

  // Grid view (vertical card)
  return (
    <div
      className="border border-border rounded-lg overflow-hidden bg-card group"
    >
      {/* Thumbnail */}
      <div className="relative">
        {customTemplate?.metadata.thumbnail ? (
          <div className="w-full aspect-video bg-muted">
            <img
              src={customTemplate.metadata.thumbnail}
              alt={template.name}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <div className="w-full aspect-video bg-muted flex items-center justify-center">
            <FileBox className="h-16 w-16 text-muted-foreground" />
          </div>
        )}
        {isBuiltIn && (
          <Tip label={t('builtIn')}>
            <div className="absolute top-2 right-2 bg-background/90 rounded-full p-1.5 shadow-sm">
              <Link2 className="h-4 w-4 text-muted-foreground" />
            </div>
          </Tip>
        )}
        {customTemplate?.metadata.downloadUrl && (
          <Tip label={t('viewOnMarketplace')}>
            <a
              href={customTemplate.metadata.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('viewOnMarketplace')}
              className="absolute top-2 left-2 bg-background/90 hover:bg-background rounded-full p-1.5 shadow-sm transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>
          </Tip>
        )}
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Tip label={template.name} truncated>
              <h3 className="font-semibold text-base truncate flex-1">
                {template.name}
              </h3>
            </Tip>
            {customTemplate && (
              <span className="text-xs text-muted-foreground shrink-0">
                v{customTemplate.version}
              </span>
            )}
          </div>
          <Tip label={template.description} truncated>
            <p className="text-sm text-muted-foreground line-clamp-2">
              {template.description}
            </p>
          </Tip>
        </div>

        {/* Metadata */}
        <div className="space-y-2">
          {(customTemplate?.metadata.author || template.metadata?.author) && (
            <div className="text-xs text-muted-foreground">
              {customTemplate?.metadata.authorUrl ? (
                <Tip label={t('tips.authorSite')}>
                  <a
                    href={customTemplate.metadata.authorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    by {customTemplate.metadata.author}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Tip>
              ) : (
                <span>by {customTemplate?.metadata.author || template.metadata?.author}</span>
              )}
            </div>
          )}

          {/* Tags */}
          {((customTemplate?.metadata.tags || template.metadata?.tags || []).length > 0 || (isBuiltIn && 'runtime' in template) || hasBackendFeatures) && (
            <div className="flex flex-wrap gap-1">
              {runtimeBadge && (
                <Badge className={`text-xs px-1.5 py-0.5 ${runtimeBadge.className}`}>{runtimeBadge.label}</Badge>
              )}
              {hasBackendFeatures && (
                <Badge className="text-xs px-1.5 py-0.5 bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800">
                  <Server className="h-3 w-3 mr-0.5" />
                  {t('backend')}
                </Badge>
              )}
              {(customTemplate?.metadata.tags || template.metadata?.tags || []).slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs px-1.5 py-0.5">
                  {tag}
                </Badge>
              ))}
              {(customTemplate?.metadata.tags || template.metadata?.tags || []).length > 3 && (
                <Badge variant="secondary" className="text-xs px-1.5 py-0.5">
                  +{(customTemplate?.metadata.tags || template.metadata?.tags || []).length - 3}
                </Badge>
              )}
            </div>
          )}

          {/* License and file count */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
            {customTemplate?.metadata.license && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 h-auto">
                {getLicenseLabel(customTemplate.metadata.license)}
              </Badge>
            )}
            {customTemplate?.files && (
              <>
                {customTemplate.metadata.license && <span>•</span>}
                <span>{customTemplate.files.length} files</span>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {formatDate(customTemplate?.updatedAt || template.updatedAt)}
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Tip label={t('tips.more', { name: template.name })} align="end">
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('tips.more', { name: template.name })}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </Tip>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onSelect(template)}>
                <Plus className="mr-2 h-4 w-4" />
                {tpx('createProject')}
              </DropdownMenuItem>
              {onPreview && (
                <DropdownMenuItem onClick={() => onPreview(template)}>
                  <Eye className="mr-2 h-4 w-4" />
                  {tc('actions.preview')}
                </DropdownMenuItem>
              )}
              {onExport && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleExport}>
                    <Download className="mr-2 h-4 w-4" />
                    {t('exportTemplate')}
                  </DropdownMenuItem>
                </>
              )}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <Tip label={isBuiltIn ? t('cannotDeleteBuiltIn') : undefined}>
                    <div>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={handleDelete}
                        disabled={isBuiltIn}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {tc('actions.delete')}
                      </DropdownMenuItem>
                    </div>
                  </Tip>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
