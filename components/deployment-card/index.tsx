'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Deployment, Project } from '@/lib/vfs/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Globe,
  Settings,
  ExternalLink,
  Copy,
  RefreshCw,
  EyeOff,
  Trash2,
  MoreVertical,
  AlertCircle,
  Construction,
  Folder,
  BarChart3,
  Pencil,
  Loader2,
  FileBox,
} from 'lucide-react';
import { ThumbnailArea } from '@/components/ui/thumbnail-area';
import { captureDeploymentScreenshot } from '@/lib/utils/deployment-thumbnail';
import { ReviewBadge } from '@/components/ui/review-badge';

interface DeploymentCardProps {
  deployment: Deployment;
  project?: Project;
  isPublishing?: boolean;
  onClick?: (deployment: Deployment, section?: string) => void;
  onViewAnalytics: (deployment: Deployment) => void;
  onEditProject: (deployment: Deployment) => void;
  onPublish: (deploymentId: string) => void;
  onUnpublish: (deploymentId: string) => void;
  onDelete: (deploymentId: string) => void;
  onExportAsTemplate?: (deployment: Deployment) => void;
  onThumbnailChange?: (deploymentId: string, image: string | undefined) => void;
}

export function DeploymentCard({
  deployment,
  project,
  isPublishing = false,
  onClick,
  onViewAnalytics,
  onEditProject,
  onPublish,
  onUnpublish,
  onDelete,
  onExportAsTemplate,
  onThumbnailChange,
}: DeploymentCardProps) {
  const td = useTranslations('deployments');
  const when = useLocalFormat();
  const tc = useTranslations('common');
  const tdd = useTranslations('deploymentDetail');
  // Determine status
  const isPublished = deployment.lastPublishedVersion !== null && deployment.lastPublishedVersion !== undefined;
  const hasPendingChanges = isPublished && Number(deployment.settingsVersion) > Number(deployment.lastPublishedVersion);

  // Resolved by the server, which is the only side that knows whether the static proxy routes
  // slug subdomains. Deriving it here from `slug` produced a dead https://{slug}.localhost.
  const publicUrl = deployment.publicUrl || `${window.location.origin}/deployments/${deployment.id}`;

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(publicUrl);
  };

  const handleViewLive = () => {
    window.open(publicUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="border rounded-lg overflow-hidden hover:shadow-lg transition-shadow bg-card">
      {/* Preview Image */}
      <div className="aspect-video bg-muted relative">
        <ThumbnailArea
          image={deployment.previewImage || project?.previewImage}
          onCapture={isPublished ? async () => {
            return captureDeploymentScreenshot(publicUrl);
          } : undefined}
          onImageChange={(img) => onThumbnailChange?.(deployment.id, img)}
          size="md"
        />

        {/* Publishing spinner overlay */}
        {isPublishing && (
          <div className="absolute inset-0 bg-background/60 flex items-center justify-center z-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Status Badge Overlay */}
        <div className="absolute top-2 right-2 flex gap-2">
          {deployment.underConstruction && isPublished && (
            <Badge variant="outline" className="bg-orange-100 dark:bg-orange-950 border-orange-300 dark:border-orange-800">
              <Construction className="h-3 w-3 mr-1" />
              {tdd('underConstruction')}
            </Badge>
          )}
          {hasPendingChanges && (
            <Badge variant="outline" className="bg-yellow-100 dark:bg-yellow-950 border-yellow-300 dark:border-yellow-800">
              <AlertCircle className="h-3 w-3 mr-1" />
              {tdd('pendingChanges')}
            </Badge>
          )}
          <ReviewBadge
            count={deployment.openReviewThreads ?? 0}
            className="bg-amber-100 dark:bg-amber-950 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400"
            onClick={onClick ? (e) => { e.stopPropagation(); onClick(deployment, 'review'); } : undefined}
          />
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* Title and Description */}
        <div className="mb-3">
          <h3 className="font-semibold text-lg truncate mb-1">{deployment.name}</h3>
          {project && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Folder className="h-3 w-3" />
              <span className="truncate">{project.name}</span>
            </div>
          )}
        </div>

        {/* URL */}
        {isPublished && (
          <div className="flex items-center gap-2 mb-3 p-2 bg-muted rounded-md text-xs">
            <Globe className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <span className="flex-1 truncate">{publicUrl}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={handleCopyUrl}
              title={tc('actions.copyUrl')}
            >
              <Copy className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={handleViewLive}
              title={td('viewLive')}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* Metadata */}
        <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground">
          <div>
            {td('versionLabel', { version: deployment.settingsVersion })}
            {deployment.lastPublishedVersion && (
              <> / {deployment.lastPublishedVersion}</>
            )}
          </div>
          {deployment.publishedAt && (
            <div>
              {td('publishedAgo', { when: when.relativeTime(deployment.publishedAt) })}
            </div>
          )}
        </div>

        {/* Stats Badges */}
        <div className="flex flex-wrap gap-2 mb-4">
          {deployment.headScripts.filter(s => s.enabled).length +
            deployment.bodyScripts.filter(s => s.enabled).length >
            0 && (
            <Badge variant="secondary" className="text-xs">
              {deployment.headScripts.filter(s => s.enabled).length +
                deployment.bodyScripts.filter(s => s.enabled).length}{' '}
              Script
              {deployment.headScripts.filter(s => s.enabled).length +
                deployment.bodyScripts.filter(s => s.enabled).length !==
                1 && 's'}
            </Badge>
          )}
          {deployment.cdnLinks.filter(c => c.enabled).length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {deployment.cdnLinks.filter(c => c.enabled).length} CDN Resource
              {deployment.cdnLinks.filter(c => c.enabled).length !== 1 && 's'}
            </Badge>
          )}
          {deployment.analytics.enabled && (
            <Badge variant="secondary" className="text-xs">
              {tdd('nav.analytics')}
            </Badge>
          )}
          {(deployment.seo.title || deployment.seo.description) && (
            <Badge variant="secondary" className="text-xs">
              {td('seoConfigured')}
            </Badge>
          )}
          {deployment.compliance.enabled && (
            <Badge variant="secondary" className="text-xs">
              {tdd('nav.compliance')}
            </Badge>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onClick?.(deployment)}
          >
            <Settings className="h-4 w-4 mr-2" />
            {td('editDeployment')}
          </Button>

          <Button
            variant={hasPendingChanges || !isPublished ? undefined : 'outline'}
            size="sm"
            className="min-w-0 flex-1"
            onClick={() => onPublish(deployment.id)}
            disabled={isPublishing}
          >
            <RefreshCw className={`h-4 w-4 mr-2 shrink-0 ${isPublishing ? 'animate-spin' : ''}`} />
            <span className="truncate">
              {isPublishing
                ? tdd('publishing')
                : hasPendingChanges
                  ? tdd('publishChanges')
                  : isPublished
                    ? tc('actions.republish')
                    : tc('actions.publish')}
            </span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEditProject(deployment)}>
                <Pencil className="h-4 w-4 mr-2" />
                {td('editProject')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {deployment.analytics.enabled && deployment.analytics.provider === 'builtin' && (
                <DropdownMenuItem onClick={() => onViewAnalytics(deployment)}>
                  <BarChart3 className="h-4 w-4 mr-2" />
                  {td('viewAnalytics')}
                </DropdownMenuItem>
              )}
              {isPublished && (
                <DropdownMenuItem onClick={handleCopyUrl}>
                  <Copy className="h-4 w-4 mr-2" />
                  {tc('actions.copyUrl')}
                </DropdownMenuItem>
              )}
              {onExportAsTemplate && (
                <DropdownMenuItem onClick={() => onExportAsTemplate(deployment)}>
                  <FileBox className="h-4 w-4 mr-2" />
                  {td('exportAsTemplate')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {isPublished && (
                <DropdownMenuItem onClick={() => onUnpublish(deployment.id)}>
                  <EyeOff className="h-4 w-4 mr-2" />
                  {tc('actions.unpublish')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => onDelete(deployment.id)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {td('deleteDeployment')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
