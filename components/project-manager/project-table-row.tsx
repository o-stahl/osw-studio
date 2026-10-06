'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Project } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { getRuntimeBadge } from '@/lib/runtimes/registry';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical, Trash2, Download, FileArchive, Copy, Settings, FileBox, Pencil, Eye, Wand2 } from 'lucide-react';
import { ThumbnailArea } from '@/components/ui/thumbnail-area';
import { captureProjectScreenshot } from '@/lib/utils/project-thumbnail';
import { logger } from '@/lib/utils';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

interface ProjectTableRowProps {
  project: Project;
  onSelect: (project: Project) => void;
  onDelete: (project: Project) => void;
  onExport: (project: Project) => void;
  onExportZip: (project: Project) => void;
  onDuplicate: (project: Project) => void;
  onPreview: (project: Project) => void;
  onExportAsTemplate?: (project: Project) => void;
  onBackend?: (project: Project) => void;
  /** Absent outside server mode, where quick edit has no route to open. */
  onQuickEdit?: (project: Project) => void;
  onUpdate: (project: Project) => void;
  /** True when the row hid its inline actions, so the menu offers them instead. */
  compactRows?: boolean;
}

interface ProjectStats {
  fileCount: number;
  totalSize: number;
  formattedSize: string;
}

export const ProjectTableRow = React.memo(function ProjectTableRow({
  project,
  onSelect,
  onDelete,
  onExport,
  onExportZip,
  onDuplicate,
  onPreview,
  onExportAsTemplate,
  onBackend,
  onQuickEdit,
  onUpdate,
  compactRows,
}: ProjectTableRowProps) {
  const tc = useTranslations('common');
  const tp = useTranslations('projects');
  const when = useLocalFormat();
  const [stats, setStats] = useState<ProjectStats | null>(null);

  useEffect(() => {
    vfs.getProjectStats(project.id)
      .then(setStats)
      .catch(e => logger.error('Failed to load project stats:', e));
  }, [project.id]);

  const runtime = project.settings?.runtime || 'handlebars';
  const runtimeBadge = getRuntimeBadge(runtime);
  const cost = project.costTracking?.totalCost;
  const formattedCost = cost && cost > 0 ? when.number(cost, { style: 'currency', currency: 'USD' }) : null;

  return (
    <tr className="border-b border-border/50 hover:bg-muted/50 cursor-pointer h-[44px]" onClick={() => onSelect(project)}>
      <td className="p-[4px_10px] align-middle">
        <ThumbnailArea
          size="xs"
          image={project.previewImage}
          onCapture={() => captureProjectScreenshot(project.id)}
          onImageChange={(img) => onUpdate({ ...project, previewImage: img, previewUpdatedAt: img ? new Date() : undefined })}
        />
      </td>
      <td className="w-full p-[4px_10px] text-[13px] align-middle overflow-hidden" style={{ maxWidth: 0 }}>
        <div className="min-w-0">
          <span className="block font-medium text-foreground text-[13px] truncate">{project.name}</span>
          {project.description && (
            <span className="block text-[11px] text-muted-foreground truncate">{project.description}</span>
          )}
        </div>
      </td>
      <td className="p-[4px_10px] align-middle whitespace-nowrap">
        <Badge className={`text-[11px] px-[7px] py-[1px] h-auto rounded-full ${runtimeBadge.className}`}>{runtimeBadge.label}</Badge>
      </td>
      <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap font-mono tabular-nums">
        {stats?.fileCount ?? '—'}
      </td>
      <td className="p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap font-mono tabular-nums">
        {stats?.formattedSize ?? '—'}
      </td>
      <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap font-mono tabular-nums">
        {formattedCost ?? '—'}
      </td>
      <td className="p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap overflow-hidden text-ellipsis">
        {when.age(project.updatedAt)}
      </td>
      <td className="p-[4px_10px] align-middle whitespace-nowrap text-right" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          <Button variant="outline" size="xs" className="@max-3xl:hidden" onClick={() => onSelect(project)}>
            <Pencil className="w-3 h-3" />{tc('actions.edit')}
          </Button>
          <Button variant="outline" size="xs" className="@max-3xl:hidden" onClick={() => onPreview(project)}>{tc('actions.preview')}</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" className="px-1"><MoreVertical className="w-3.5 h-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Edit and Preview hide from the row at COMPACT_ROW_WIDTH and appear here instead. */}
              {compactRows && (
                <>
                  <DropdownMenuItem onClick={() => onSelect(project)}>
                    <Pencil className="w-4 h-4 mr-2" />{tc('actions.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onPreview(project)}>
                    <Eye className="w-4 h-4 mr-2" />{tp('menu.preview')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {onQuickEdit && (
                <>
                  <DropdownMenuItem onClick={() => onQuickEdit(project)}>
                    <Wand2 className="w-4 h-4 mr-2" />{tp('menu.quickEdit')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={() => onExportZip(project)}>
                <FileArchive className="w-4 h-4 mr-2" />{tp('menu.exportZipShort')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport(project)}>
                <Download className="w-4 h-4 mr-2" />{tp('menu.exportOsws')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(project)}>
                <Copy className="w-4 h-4 mr-2" />{tp('menu.duplicate')}
              </DropdownMenuItem>
              {onExportAsTemplate && (
                <DropdownMenuItem onClick={() => onExportAsTemplate(project)}>
                  <FileBox className="w-4 h-4 mr-2" />{tp('menu.exportAsTemplate')}
                </DropdownMenuItem>
              )}
              {onBackend && (
                <DropdownMenuItem onClick={() => onBackend(project)}>
                  <Settings className="w-4 h-4 mr-2" />{tp('menu.backendFeatures')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onDelete(project)} className="text-destructive focus:text-destructive">
                <Trash2 className="w-4 h-4 mr-2" />{tc('actions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
});
