'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Project } from '@/lib/vfs/types';
import { getRuntimeBadge } from '@/lib/runtimes/registry';
import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SyncStatusBadge } from './sync-status-badge';
import { useProjectSyncState } from '@/lib/hooks/use-project-sync-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Trash2,
  Download,
  Package,
  Edit2,
  Check,
  X,
  Copy,
  Eye,
  FileCode,
  FileText,
  Image,
  MoreVertical,
  FolderOpen,
  HardDrive,
  DollarSign,
  FileBox,
  Server
} from 'lucide-react';
import { ThumbnailArea } from '@/components/ui/thumbnail-area';
import { captureProjectScreenshot } from '@/lib/utils/project-thumbnail';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

interface ProjectCardProps {
  project: Project;
  onSelect: (project: Project) => void;
  onDelete: (project: Project) => void;
  onExport: (project: Project) => void;
  onExportZip: (project: Project) => void;
  onDuplicate: (project: Project) => void;
  onPreview: (project: Project) => void;
  onUpdate: (project: Project) => void;
  onExportAsTemplate?: (project: Project) => void;
  onBackend?: (project: Project) => void;
  viewMode?: 'grid' | 'list';
  forceMenuOpen?: boolean;
  highlightExport?: boolean;
}

interface ProjectStats {
  fileCount: number;
  totalSize: number;
  fileTypes: Record<string, number>;
  formattedSize: string;
}

export const ProjectCard = React.memo(function ProjectCard({
  project,
  onSelect,
  onDelete,
  onExport,
  onExportZip,
  onDuplicate,
  onPreview,
  onUpdate,
  onExportAsTemplate,
  onBackend,
  viewMode = 'grid',
  forceMenuOpen = false,
  highlightExport = false,
}: ProjectCardProps) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const when = useLocalFormat();
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(project.name);
  const [editedDescription, setEditedDescription] = useState(project.description || '');
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    loadProjectStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const loadProjectStats = async () => {
    try {
      const projectStats = await vfs.getProjectStats(project.id);
      setStats(projectStats);
    } catch (error) {
      logger.error('Failed to load project stats:', error);
    } finally {
      setLoadingStats(false);
    }
  };

  const saveEdits = async () => {
    if (!editedName.trim()) {
      toast.error(t('nameEmpty'));
      setEditedName(project.name);
      setIsEditing(false);
      return;
    }

    if (editedName.length > 50) {
      toast.error(t('nameTooLong'));
      return;
    }

    if (editedDescription.length > 200) {
      toast.error(t('descTooLong'));
      return;
    }

    try {
      project.name = editedName.trim();
      project.description = editedDescription.trim() || undefined;
      await vfs.updateProject(project);
      // The name and description are stored server-side too. Nothing else on the gallery pushes,
      // so without this a rename left the project reading as "Local newer" forever.
      vfs.scheduleAutoSync(project.id);
      onUpdate(project);
      setIsEditing(false);
      toast.success(t('updated'));
    } catch (error) {
      logger.error('Failed to update project:', error);
      toast.error(t('updateFailed'));
      setEditedName(project.name);
      setEditedDescription(project.description || '');
    }
  };

  const cancelEdit = () => {
    setEditedName(project.name);
    setEditedDescription(project.description || '');
    setIsEditing(false);
  };

  useEffect(() => {
    if (forceMenuOpen) {
      setMenuOpen(true);
    } else {
      setMenuOpen(false);
    }
  }, [forceMenuOpen]);

  const handleMenuOpenChange = (open: boolean) => {
    if (forceMenuOpen) {
      setMenuOpen(true);
      return;
    }
    setMenuOpen(open);
  };

  // Get main file types for display (top 3)
  const getMainFileTypes = () => {
    if (!stats) return [];
    const entries = Object.entries(stats.fileTypes)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
    return entries;
  };

  // Get icon for file type
  const getFileTypeIcon = (ext: string) => {
    const lowerExt = ext.toLowerCase();
    if (['html', 'htm'].includes(lowerExt)) return <FileCode className="h-3 w-3" />;
    if (['css', 'scss', 'sass'].includes(lowerExt)) return <FileText className="h-3 w-3" />;
    if (['js', 'jsx', 'ts', 'tsx'].includes(lowerExt)) return <FileCode className="h-3 w-3" />;
    if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(lowerExt)) return <Image className="h-3 w-3" />;
    return <FileText className="h-3 w-3" />;
  };

  // Runtime badge display
  const runtime = project.settings?.runtime || 'handlebars';
  const runtimeBadge = getRuntimeBadge(runtime);
  // Server mode only: tells the user at a glance that a project has drifted from the server,
  // which previously required opening the Server Sync dialog to discover.
  const { statuses } = useProjectSyncState();
  const syncStatus = process.env.NEXT_PUBLIC_SERVER_MODE === 'true'
    ? statuses.get(project.id)
    : undefined;

  // Format cost display
  const formatCost = (cost?: number) => {
    if (!cost || cost === 0) return null;
    return when.number(cost, { style: 'currency', currency: 'USD' });
  };

  if (viewMode === 'list') {
    return (
      <div
        className={`group border border-border rounded-lg p-4 hover:shadow-md transition-all cursor-pointer hover:border-primary/50 ${highlightExport ? 'ring-2 ring-primary/70 animate-ring-opacity' : ''}`}
        style={{ background: `var(--card)` }}
        onClick={() => onSelect(project)}
      >
        <div className="flex items-start gap-4">
          {/* Preview Thumbnail */}
          <ThumbnailArea
            image={project.previewImage}
            onCapture={() => captureProjectScreenshot(project.id)}
            onImageChange={(img) => onUpdate({ ...project, previewImage: img, previewUpdatedAt: img ? new Date() : undefined })}
            size="sm"
          />

          {/* Content - 2 columns on desktop, stacked on mobile */}
          <div className="flex-1 min-w-0 flex flex-col md:flex-row md:gap-6">
            {/* Column 2: Primary info (Title, Description, Updated) */}
            <div className="flex-1 min-w-0 space-y-1">
              {isEditing ? (
                <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                  {/* Name input */}
                  <div>
                    <div className="flex items-center gap-2">
                      <Input
                        value={editedName}
                        onChange={(e) => setEditedName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            saveEdits();
                          }
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        className="h-7 text-sm font-semibold"
                        autoFocus
                        maxLength={50}
                        placeholder={t('nameLabel')}
                      />
                      <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={saveEdits}>
                        <Check className="h-3 w-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={cancelEdit}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">{editedName.length}/50</span>
                  </div>
                  {/* Description input */}
                  <div>
                    <Textarea
                      value={editedDescription}
                      onChange={(e) => setEditedDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      placeholder={t('addDescription')}
                      className="min-h-[60px] text-sm resize-none"
                      maxLength={200}
                    />
                    <span className="text-xs text-muted-foreground">{editedDescription.length}/200</span>
                  </div>
                </div>
              ) : (
                <>
                  {/* Title row */}
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold truncate">{project.name}</h3>
                    <Badge className={`text-xs px-1.5 py-0 h-auto shrink-0 ${runtimeBadge.className}`}>{runtimeBadge.label}</Badge>
                    {syncStatus && syncStatus !== 'synced' && (
                      <SyncStatusBadge status={syncStatus} showLabel={false} />
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsEditing(true);
                      }}
                    >
                      <Edit2 className="h-3 w-3" />
                    </Button>
                  </div>

                  {/* Description */}
                  {project.description && (
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {project.description}
                    </p>
                  )}

                  {/* Updated timestamp */}
                  <p className="text-xs text-muted-foreground">
                    {t('updatedAgo', { when: when.relativeTime(project.updatedAt) })}
                  </p>
                </>
              )}
            </div>

            {/* Column 3: Stats and File types */}
            <div className="space-y-2 mt-2 md:mt-0">
              {/* Stats - inline on desktop, horizontal on mobile */}
              {stats && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <FolderOpen className="h-4 w-4" />
                    {t('fileCount', { count: stats.fileCount })}
                  </span>
                  <span className="flex items-center gap-1">
                    <HardDrive className="h-4 w-4" />
                    {stats.formattedSize}
                  </span>
                  {project.costTracking?.totalCost && project.costTracking.totalCost > 0 && (
                    <span className="flex items-center gap-1">
                      <DollarSign className="h-4 w-4" />
                      {formatCost(project.costTracking.totalCost)}
                    </span>
                  )}
                </div>
              )}

              {/* File types */}
              {stats && getMainFileTypes().length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {getMainFileTypes().map(([ext, count]) => (
                    <div key={ext} className="flex items-center gap-1 text-muted-foreground">
                      {getFileTypeIcon(ext)}
                      <span>{ext.toUpperCase()} ({count})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 ml-4">
            <DropdownMenu open={forceMenuOpen ? true : menuOpen} onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger
                asChild
                onClick={(e) => e.stopPropagation()}
                data-tour-id={highlightExport ? 'project-actions-trigger' : undefined}
              >
                <Button size="icon" variant="ghost" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onPreview(project);
                }}>
                  <Eye className="mr-2 h-4 w-4" />
                  {t('menu.preview')}
                </DropdownMenuItem>
                {onBackend && (
                  <DropdownMenuItem onClick={(e) => {
                    e.stopPropagation();
                    onBackend(project);
                  }}>
                    <Server className="mr-2 h-4 w-4" />
                    {t('menu.backend')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate(project);
                }}>
                  <Copy className="mr-2 h-4 w-4" />
                  {t('menu.duplicate')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onExportZip(project);
                }}>
                  <Package className="mr-2 h-4 w-4" />
                  {t('menu.exportZip')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onExport(project);
                  }}
                  data-tour-id={highlightExport ? 'project-export-json' : undefined}
                >
                  <Download className="mr-2 h-4 w-4" />
                  {t('menu.exportJson')}
                </DropdownMenuItem>
                {onExportAsTemplate && (
                  <DropdownMenuItem onClick={(e) => {
                    e.stopPropagation();
                    onExportAsTemplate(project);
                  }}>
                    <FileBox className="mr-2 h-4 w-4" />
                    {t('menu.createTemplate')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(project);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {tc('actions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    );
  }

  // Grid view (default)
  return (
    <div
      className={`border border-border rounded-lg overflow-hidden hover:shadow-lg transition-all cursor-pointer hover:border-primary/50 group ${highlightExport ? 'ring-2 ring-primary/70 animate-ring-opacity' : ''}`}
      style={{ background: `var(--card)` }}
      onClick={() => onSelect(project)}
      data-tour-id="project-card"
    >
      {/* Preview Thumbnail */}
      <div className="relative">
        <ThumbnailArea
          image={project.previewImage}
          onCapture={() => captureProjectScreenshot(project.id)}
          onImageChange={(img) => onUpdate({ ...project, previewImage: img, previewUpdatedAt: img ? new Date() : undefined })}
          size="md"
        />
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
          <Badge className={`text-xs px-1.5 py-0.5 shadow-sm ${runtimeBadge.className}`}>{runtimeBadge.label}</Badge>
          {syncStatus && syncStatus !== 'synced' && (
            <SyncStatusBadge status={syncStatus} showLabel={false} className="shadow-sm" />
          )}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Header with name and actions */}
        <div className="flex justify-between items-start">
          {isEditing ? (
            <div className="flex-1" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <Input
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.shiftKey === false) {
                      e.preventDefault();
                      saveEdits();
                    }
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  className="h-8 text-sm font-semibold"
                  autoFocus
                  maxLength={50}
                />
                <Button size="icon" variant="ghost" className="h-5 w-5" onClick={saveEdits}>
                  <Check className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-5 w-5" onClick={cancelEdit}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <span className="text-xs text-muted-foreground mt-1">{editedName.length}/50</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-1">
              <h3 className="font-semibold text-lg truncate flex-1">{project.name}</h3>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(true);
                }}
              >
                <Edit2 className="h-3 w-3" />
              </Button>
            </div>
          )}
          
          <DropdownMenu open={forceMenuOpen ? true : menuOpen} onOpenChange={handleMenuOpenChange}>
            <DropdownMenuTrigger
              asChild
              onClick={(e) => e.stopPropagation()}
              data-tour-id={highlightExport ? 'project-actions-trigger' : undefined}
            >
              <Button size="icon" variant="ghost" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                onPreview(project);
              }}>
                <Eye className="mr-2 h-4 w-4" />
                {t('menu.preview')}
              </DropdownMenuItem>
              {onBackend && (
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onBackend(project);
                }}>
                  <Server className="mr-2 h-4 w-4" />
                  {t('menu.backend')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                onDuplicate(project);
              }}>
                <Copy className="mr-2 h-4 w-4" />
                {t('menu.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                onExportZip(project);
              }}>
                <Package className="mr-2 h-4 w-4" />
                {t('menu.exportZip')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onExport(project);
                }}
                data-tour-id={highlightExport ? 'project-export-json' : undefined}
              >
                <Download className="mr-2 h-4 w-4" />
                {t('menu.exportJson')}
              </DropdownMenuItem>
              {onExportAsTemplate && (
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onExportAsTemplate(project);
                }}>
                  <FileBox className="mr-2 h-4 w-4" />
                  {t('menu.createTemplate')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(project);
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {tc('actions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Description */}
        {isEditing ? (
          <div onClick={(e) => e.stopPropagation()}>
            <Textarea
              value={editedDescription}
              onChange={(e) => setEditedDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelEdit();
              }}
              placeholder={t('addDescription')}
              className="min-h-[60px] text-sm resize-none"
              maxLength={200}
            />
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-muted-foreground">{editedDescription.length}/200</span>
            </div>
          </div>
        ) : (
          <div className="min-h-[40px]">
            {project.description ? (
              <p className="text-sm text-muted-foreground line-clamp-2">
                {project.description}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground/50 italic">
                {t('noDescription')}
              </p>
            )}
          </div>
        )}

        {/* Stats */}
        {loadingStats ? (
          <div className="h-6 bg-muted animate-pulse rounded" />
        ) : stats && (
          <>
            <div className="flex items-center gap-3 text-sm text-muted-foreground pt-2 border-t">
              <span className="flex items-center gap-1">
                <FolderOpen className="h-4 w-4" />
                {t('fileCount', { count: stats.fileCount })}
              </span>
              <span className="flex items-center gap-1">
                <HardDrive className="h-4 w-4" />
                {stats.formattedSize}
              </span>
              {project.costTracking?.totalCost && project.costTracking.totalCost > 0 && (
                <span className="flex items-center gap-1">
                  <DollarSign className="h-4 w-4" />
                  {formatCost(project.costTracking.totalCost)}
                </span>
              )}
            </div>

            {/* File types */}
            {getMainFileTypes().length > 0 && (
              <div className="flex items-center gap-3 text-xs">
                {getMainFileTypes().map(([ext, count]) => (
                  <div key={ext} className="flex items-center gap-1 text-muted-foreground">
                    {getFileTypeIcon(ext)}
                    <span>{ext} ({count})</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Timestamps */}
        <div className="text-xs text-muted-foreground pt-2 border-t">
          <p>{t('updatedAgo', { when: when.relativeTime(project.updatedAt) })}</p>
        </div>
      </div>
    </div>
  );
});
