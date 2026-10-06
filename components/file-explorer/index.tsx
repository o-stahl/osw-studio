'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useArchiveMessage } from '@/lib/i18n/use-archive-message';
import { VirtualFile, Project, FILE_SIZE_LIMITS, getFileTypeFromPath } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { collectEntryFiles } from '@/lib/vfs/archive/read-folder';
import { uploadFileToProject, type UploadFileOptions, type UploadOutcome } from '@/lib/vfs/upload-file';
import { logger, cn } from '@/lib/utils';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FolderTree,
  Upload,
  Download,
  Import,
  FileArchive,
  Image,
  Video,
  Eye,
  EyeOff,
  Server,
  BookOpen,
  Home,
  ScrollText,
  Play,
} from 'lucide-react';
import { PanelHeader } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { ImportDialog, type ImportDialogSource } from '@/components/import-dialog';
import { pickFolderSource } from '@/components/import-dialog/pick';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

interface FileExplorerProps {
  projectId: string;
  onFileSelect?: (file: VirtualFile) => void;
  onClose?: () => void;
  entryPoint?: string;
  onSetEntryPoint?: (path: string) => void;
  onAddPromptFile?: () => void;
  /** vfs.updateProject fires no event; this callback syncs the workspace store after an import changes runtime or entry point. */
  onProjectUpdate?: (project: Project) => void;
}

interface FileTreeItem {
  path: string;
  name: string;
  type: 'file' | 'directory';
  children?: FileTreeItem[];
}

export function FileExplorer({ projectId, onFileSelect, onClose, entryPoint, onSetEntryPoint, onAddPromptFile, onProjectUpdate }: FileExplorerProps) {
  const t = useTranslations('fileExplorer');
  const tc = useTranslations('common');
  const archiveMessage = useArchiveMessage();
  const tw = useTranslations('workspace');
  const tp = useTranslations('projects');
  const [files, setFiles] = useState<VirtualFile[]>([]);
  const [fileTree, setFileTree] = useState<FileTreeItem[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['/']));
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [draggedItem, setDraggedItem] = useState<FileTreeItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(true);
  const [hiddenFileCount, setHiddenFileCount] = useState(0);
  const [hiddenFolderCount, setHiddenFolderCount] = useState(0);
  const [promptDismissed, setPromptDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(`osw-prompt-dismissed-${projectId}`) === 'true';
  });
  const [importSource, setImportSource] = useState<ImportDialogSource | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const loadFilesVersionRef = useRef(0);

  // A fresh object every time, so the dialog re-analyses whenever the user picks something new.
  const openImport = useCallback((source: ImportDialogSource) => {
    setImportSource(source);
    setImportOpen(true);
  }, []);

  // Check if a path is a transient/read-only path (skills or server context)
  const isTransientPath = (path: string): boolean => {
    return path.startsWith('/.skills/') || path.startsWith('/.server/') ||
           path === '/.skills' || path === '/.server';
  };

  // Check if a path is a server context path
  const isServerContextPath = (path: string): boolean => {
    return path.startsWith('/.server/') || path === '/.server';
  };

  // Check if a path is a skills path
  const isSkillsPath = (path: string): boolean => {
    return path.startsWith('/.skills/') || path === '/.skills';
  };

  // Check if a path is a generated file (bundle.js, bundle.css)
  const isGeneratedPath = (path: string): boolean => {
    return vfs.isGeneratedPath(path);
  };

  const loadFiles = useCallback(async () => {
    const version = ++loadFilesVersionRef.current;
    try {
      await vfs.init();
      // Get regular files and directories
      const allItems = await vfs.getAllFilesAndDirectories(projectId);

      // Add truly transient files (/.server/, /.skills/) if showHidden is true
      // Adapter-stored dot files (/.PROMPT.md, /.renderer/) are already in allItems
      if (showHidden) {
        const transientFiles = await vfs.listDirectory(projectId, '/', { includeTransient: true });
        const existingPaths = new Set(allItems.map(item => item.path));
        const transientOnly = transientFiles.filter(f =>
          f.path.startsWith('/.') && !existingPaths.has(f.path)
        );

        // Get enabled skills to filter /.skills/ folder
        const { skillsService } = await import('@/lib/vfs/skills');
        const enabledSkills = await skillsService.getEnabledSkills();
        const enabledSkillPaths = new Set(enabledSkills.map(s => `/.skills/${s.id}.md`));

        // Filter transient files: include all non-skill files, but only enabled skills
        const filteredTransient = transientOnly.filter(file => {
          // If it's in /.skills/, only include if it's enabled
          if (file.path.startsWith('/.skills/')) {
            return enabledSkillPaths.has(file.path);
          }
          // Include all other transient files
          return true;
        });

        allItems.push(...filteredTransient);
      }

      // Count hidden items (dot-prefixed at root level) — always, regardless of showHidden
      // Include transient items (e.g. .skills/, .server/) in the count even when not shown
      let countItems = allItems;
      if (!showHidden) {
        const transientFiles = await vfs.listDirectory(projectId, '/', { includeTransient: true });
        const existingPaths = new Set(allItems.map(item => item.path));
        const transientDot = transientFiles.filter(f => f.path.startsWith('/.') && !existingPaths.has(f.path));
        countItems = [...allItems, ...transientDot];
      }
      let hFiles = 0;
      const hFolders = new Set<string>();
      for (const item of countItems) {
        const firstSeg = item.path.split('/').filter(Boolean)[0];
        if (!firstSeg?.startsWith('.')) continue;
        if (item.type === 'directory') {
          hFolders.add(item.path);
        } else {
          const segments = item.path.split('/').filter(Boolean);
          if (segments.length === 1) {
            hFiles++;
          } else {
            hFolders.add('/' + firstSeg);
          }
        }
      }

      // Include generated files (bundle.js, bundle.css) — always visible
      const generatedFiles = vfs.getGeneratedFiles();
      const knownPaths = new Set(allItems.map(item => item.path));
      for (const gf of generatedFiles) {
        if (!knownPaths.has(gf.path)) {
          allItems.push(gf);
        }
      }

      // Only update state if this is still the latest call
      if (version !== loadFilesVersionRef.current) return;

      setHiddenFileCount(hFiles);
      setHiddenFolderCount(hFolders.size);
      const projectFiles = allItems.filter(item => item.type !== 'directory') as VirtualFile[];
      setFiles(projectFiles);
      setFileTree(buildFileTree(allItems, showHidden));
    } catch (error) {
      logger.error('Failed to load files:', error);
    }
  }, [projectId, showHidden]);

  useEffect(() => {
    loadFiles();
    
    const handleFilesChanged = () => {
      loadFiles();
    };
    
    window.addEventListener('filesChanged', handleFilesChanged);
    
    return () => {
      window.removeEventListener('filesChanged', handleFilesChanged);
    };
  }, [projectId, loadFiles]);

  // Only the import dialog's title uses this, so a failed read costs the name and nothing else —
  // the dialog says 'this project' instead. getProject throws rather than returning null.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await vfs.init();
        const project = await vfs.getProject(projectId);
        if (!cancelled) setProjectName(project.name);
      } catch (error) {
        logger.error('Failed to read the project name:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const buildFileTree = (items: Array<VirtualFile | { path: string; name: string; type: 'directory' }>, includeHidden: boolean): FileTreeItem[] => {
    // Filter out hidden files/directories unless includeHidden is true
    const filteredItems = includeHidden ? items : items.filter(item => !item.path.startsWith('/.'));

    const tree: FileTreeItem[] = [];
    const dirMap = new Map<string, FileTreeItem>();

    filteredItems.forEach(item => {
      if (item.type === 'directory') {
        const parts = item.path.split('/').filter(Boolean);
        const dirItem: FileTreeItem = {
          path: item.path,
          name: item.name || parts[parts.length - 1] || 'unnamed',
          type: 'directory',
          children: []
        };
        dirMap.set(item.path, dirItem);
      }
    });

    filteredItems.forEach(item => {
      if (item.type !== 'directory') {
        const parts = item.path.split('/').filter(Boolean);
        let currentPath = '';
        
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath = currentPath + '/' + parts[i];
          
          if (!dirMap.has(currentPath)) {
            const dir: FileTreeItem = {
              path: currentPath,
              name: parts[i],
              type: 'directory',
              children: []
            };
            dirMap.set(currentPath, dir);
          }
        }
      }
    });

    dirMap.forEach((dir, path) => {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 1) {
        tree.push(dir);
      } else {
        const parentPath = '/' + parts.slice(0, -1).join('/');
        const parent = dirMap.get(parentPath);
        if (parent && parent.children) {
          parent.children.push(dir);
        }
      }
    });

    filteredItems.forEach(item => {
      if (item.type !== 'directory') {
        const file = item as VirtualFile;
        const parts = file.path.split('/').filter(Boolean);
        const fileItem: FileTreeItem = {
          path: file.path,
          name: file.name,
          type: 'file'
        };

        if (parts.length === 1) {
          tree.push(fileItem);
        } else {
          const dirPath = '/' + parts.slice(0, -1).join('/');
          const dir = dirMap.get(dirPath);
          if (dir) {
            dir.children?.push(fileItem);
          }
        }
      }
    });

    const sortItems = (items: FileTreeItem[]) => {
      items.sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name);
        }
        return a.type === 'directory' ? -1 : 1;
      });
      items.forEach(item => {
        if (item.children) {
          sortItems(item.children);
        }
      });
    };

    sortItems(tree);
    return tree;
  };

  const toggleDirectory = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleFileClick = async (item: FileTreeItem) => {
    if (item.type === 'directory') {
      toggleDirectory(item.path);
    } else {
      const file = files.find(f => f.path === item.path);
      if (file && onFileSelect) {
        onFileSelect(file);
      }
    }
  };

  const handleCreateFile = async (dirPath: string = '/') => {
    const fileName = prompt('Enter file name:');
    if (!fileName) return;

    const filePath = dirPath === '/' ? `/${fileName}` : `${dirPath}/${fileName}`;
    
    try {
      await vfs.createFile(projectId, filePath, '');
      await loadFiles();
    } catch (error) {
      logger.error('Failed to create file:', error);
    }
  };

  const handleCreateDirectory = async (parentPath: string = '/') => {
    const dirName = prompt('Enter directory name:');
    if (!dirName) return;

    const dirPath = parentPath === '/' ? `/${dirName}` : `${parentPath}/${dirName}`;
    
    try {
      await vfs.createDirectory(projectId, dirPath);
      await loadFiles();
    } catch (error) {
      logger.error('Failed to create directory:', error);
    }
  };

  const handleDownloadProject = async () => {
    const toastId = toast.loading(t('preparingDownload'));

    try {
      const { exportProjectArchive } = await import('@/lib/vfs/archive/export');
      const project = await vfs.getProject(projectId);
      const { blob, warnings } = await exportProjectArchive(vfs, projectId);

      const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
      const date = new Date().toISOString().split('T')[0];

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-${date}.zip`;
      // Firefox ignores click() on a detached anchor
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (warnings.length > 0) {
        // Each warning names what was left out and why. Held longer because there is something to read.
        logger.warn('Archive export warnings:', warnings);
        toast.warning(
          t('downloadedWithOmissions', { count: warnings.length }),
          {
            id: toastId,
            description: warnings.map((warning) => archiveMessage(warning)).join('\n\n'),
            duration: 15000,
          }
        );
      } else {
        toast.success(t('downloaded'), { id: toastId });
      }
    } catch (error) {
      logger.error('Failed to download project:', error);
      toast.error(t('downloadFailed'), { id: toastId });
    }
  };

  const handleDelete = async (path: string, type: 'file' | 'directory') => {
    if (!confirm(t('confirmDelete', { type, path }))) return;

    try {
      if (type === 'file') {
        await vfs.deleteFile(projectId, path);
      } else {
        await vfs.deleteDirectory(projectId, path);
      }
      await loadFiles();
    } catch (error) {
      logger.error(`Failed to delete ${type}:`, error);
    }
  };

  const handleRename = async (oldPath: string, itemType: 'file' | 'directory') => {
    if (!newName) return;

    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    try {
      if (itemType === 'directory') {
        await vfs.renameDirectory(projectId, oldPath, newPath);
      } else {
        await vfs.renameFile(projectId, oldPath, newPath);
      }
      await loadFiles();
      setRenamingPath(null);
      setNewName('');
    } catch (error) {
      logger.error(`Failed to rename ${itemType}:`, error);
    }
  };

  const handleFileDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const items = Array.from(e.dataTransfer.items);
      const collected: Array<{ file: File; path: string }> = [];
      let hasFolder = false;

      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = (item as any).webkitGetAsEntry?.();
        if (entry?.isDirectory) {
          hasFolder = true;
          const sub = await collectEntryFiles(entry, '/');
          collected.push(...sub);
        } else if (entry?.isFile) {
          const sub = await collectEntryFiles(entry, '/');
          collected.push(...sub);
        } else {
          // Fallback for browsers without entry API.
          const file = item.getAsFile();
          if (file) collected.push({ file, path: `/${file.name}` });
        }
      }

      // A dropped zip is an archive to import, not a file to keep.
      if (!hasFolder && collected.length === 1 && /\.zip$/i.test(collected[0].file.name)) {
        openImport({ kind: 'zip', file: collected[0].file });
        return;
      }

      if (hasFolder) {
        // Pre-compute unique directories so progress totals are known upfront.
        const dirPaths = new Set<string>();
        for (const { path } of collected) {
          const parts = path.split('/').filter(Boolean);
          parts.pop(); // drop file name
          let acc = '';
          for (const p of parts) {
            acc += '/' + p;
            dirPaths.add(acc);
          }
        }
        // Sort shallowest-first so parents exist before children when we create them.
        const sortedDirs = [...dirPaths].sort((a, b) => a.split('/').length - b.split('/').length);
        const totalDirs = sortedDirs.length;
        const totalFiles = collected.length;

        const renderProgress = (filesDone: number, dirsDone: number) =>
          `Uploading ${filesDone}/${totalFiles} files · ${dirsDone}/${totalDirs} folders`;

        const toastId = toast.loading(renderProgress(0, 0));

        // Create directories first — fast but gives the progress bar something
        // to move on even when all files are in one deep folder.
        let dirsDone = 0;
        for (const dirPath of sortedDirs) {
          try {
            await vfs.createDirectory(projectId, dirPath);
          } catch (err) {
            logger.error('Failed to create directory during folder upload:', dirPath, err);
          }
          dirsDone++;
          toast.loading(renderProgress(0, dirsDone), { id: toastId });
        }

        // Then stream files. skipReload avoids a file-tree refetch per file;
        // preview debounces filesChanged itself (150ms), so we don't spam it.
        let uploaded = 0;
        let skipped = 0;
        let failed = 0;
        for (const { file, path } of collected) {
          const result = await uploadFile(file, undefined, {
            explicitPath: path,
            silent: true,
            skipReload: true,
          });
          if (result === 'ok') uploaded++;
          else if (result === 'too-large') skipped++;
          else failed++;
          toast.loading(renderProgress(uploaded + skipped + failed, dirsDone), { id: toastId });
        }

        // Single refresh at the end.
        await loadFiles();

        const parts: string[] = [];
        if (uploaded) parts.push(t('uploadedFiles', { count: uploaded }));
        if (totalDirs) parts.push(t('uploadedFolders', { count: totalDirs }));
        if (skipped) parts.push(t('uploadSkipped', { count: skipped }));
        if (failed) parts.push(t('uploadFailedCount', { count: failed }));
        if (uploaded === 0 && failed === 0 && skipped === 0) {
          toast.error(t('noSupportedFiles'), { id: toastId });
        } else if (failed > 0) {
          toast.error(t('uploadedSummary', { parts: parts.join(' · ') }), { id: toastId });
        } else {
          toast.success(t('uploadedSummary', { parts: parts.join(' · ') }), { id: toastId });
        }
      } else {
        for (const { file, path } of collected) {
          await uploadFile(file, undefined, { explicitPath: path });
        }
      }
    } finally {
      setIsDraggingOver(false);
    }
  };

  /** uploadFileToProject, bound to this project and tree's refresh. */
  const uploadFile = async (
    file: File,
    targetDir: string | undefined,
    options?: UploadFileOptions
  ): Promise<UploadOutcome> =>
    uploadFileToProject(projectId, file, targetDir, { ...options, onReload: loadFiles });

  /** Re-reads the project row after import and hands it up so the workspace store stays current. */
  const handleImportComplete = async () => {
    await loadFiles();
    try {
      const project = await vfs.getProject(projectId);
      setProjectName(project.name);
      onProjectUpdate?.(project);
    } catch (error) {
      // The import itself succeeded; only the settings hand-off did not.
      logger.error('Failed to re-read the project after an import:', error);
    }
  };

  /** Reports the upload outcome to the import dialog. Quiet, to avoid double toasts. */
  const handleKeepArchiveAsFile = async (file: File) => {
    const outcome = await uploadFile(file, '/', { quiet: true });
    if (outcome === 'ok') return;
    if (outcome === 'too-large') {
      const limitMb = Math.round(FILE_SIZE_LIMITS[getFileTypeFromPath(file.name)] / 1024 / 1024);
      throw new Error(t('tooLargeAsFile', { name: file.name, limit: limitMb }));
    }
    if (outcome === 'cancelled') {
      throw new Error(t('alreadyExistsKept', { name: file.name }));
    }
    throw new Error(t('couldNotAddAsFile', { name: file.name }));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDraggingOver(false);
    }
  };

  const handleItemDragStart = (e: React.DragEvent, item: FileTreeItem) => {
    e.stopPropagation();
    setDraggedItem(item);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleItemDragEnd = () => {
    setDraggedItem(null);
    setDropTarget(null);
  };

  const handleItemDragOver = (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (draggedItem && targetPath !== draggedItem.path) {
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(targetPath);
    }
  };

  const handleItemDrop = async (e: React.DragEvent, targetItem: FileTreeItem | null) => {
    // Nothing is being dragged from inside the tree, so this is a drop from the desktop. Let it
    // bubble to the panel's own handler, which uploads at the root (or opens the importer for a
    // zip). Calling preventDefault/stopPropagation before this check swallowed such a drop
    // entirely whenever it landed on a folder row: no upload, no import, no message.
    if (!draggedItem) {
      setDropTarget(null);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (targetItem && draggedItem.path === targetItem.path) {
      setDropTarget(null);
      return;
    }

    const targetDir = targetItem ? (targetItem.type === 'directory' ? targetItem.path : '/') : '/';
    
    if (draggedItem.type === 'directory') {
      const draggedDirPath = draggedItem.path.endsWith('/') ? draggedItem.path : draggedItem.path + '/';
      const targetDirPath = targetDir.endsWith('/') ? targetDir : targetDir + '/';
      
      if (targetDirPath.startsWith(draggedDirPath)) {
        toast.error(t('cannotMoveIntoItself'));
        setDropTarget(null);
        return;
      }
    }

    const fileName = draggedItem.name;
    const newPath = targetDir === '/' ? `/${fileName}` : `${targetDir}/${fileName}`;

    try {
      if (draggedItem.type === 'directory') {
        await vfs.moveDirectory(projectId, draggedItem.path, newPath);
      } else {
        await vfs.moveFile(projectId, draggedItem.path, newPath);
      }
      await loadFiles();
      toast.success(t('movedTo', { name: draggedItem.name, target: targetDir === '/' ? t('rootFolder') : targetDir }));
    } catch (error: any) {
      logger.error('Failed to move item:', error);
      toast.error(t('moveFailed', { message: error.message }));
    }
    
    setDropTarget(null);
  };

  const renderTreeItem = (item: FileTreeItem, level: number = 0) => {
    const isExpanded = expandedDirs.has(item.path);
    const isRenaming = renamingPath === item.path;
    const isDropTarget = dropTarget === item.path;
    const isTransient = isTransientPath(item.path);
    const isGenerated = isGeneratedPath(item.path);
    const isServerContext = isServerContextPath(item.path);
    const isSkills = isSkillsPath(item.path);
    const isHiddenDotFile = !isTransient && !isGenerated && (item.name.startsWith('.') || item.path.startsWith('/.'));
    const isReadOnly = isTransient || isGenerated;

    // Get the appropriate folder icon for special directories
    const getFolderIcon = (expanded: boolean) => {
      if (isServerContext) {
        return <Server className="w-4 h-4 text-orange-500" />;
      }
      if (isSkills) {
        return <BookOpen className="w-4 h-4 text-purple-500" />;
      }
      return expanded ? (
        <FolderOpen className="w-4 h-4 text-blue-500" />
      ) : (
        <Folder className="w-4 h-4 text-blue-500" />
      );
    };

    return (
      <div
        key={item.path}
        draggable={!isRenaming && !isReadOnly}
        onDragStart={(e) => !isReadOnly && handleItemDragStart(e, item)}
        onDragEnd={handleItemDragEnd}
        onDragOver={(e) => item.type === 'directory' && !isReadOnly && handleItemDragOver(e, item.path)}
        onDrop={(e) => item.type === 'directory' && !isReadOnly && handleItemDrop(e, item)}
      >
        <ContextMenu>
          <ContextMenuTrigger>
            <div
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 hover:bg-accent hover:text-accent-foreground cursor-pointer rounded-md transition-colors',
              isDropTarget && item.type === 'directory' && 'bg-blue-500/20 border border-blue-500',
              draggedItem?.path === item.path && 'opacity-50',
              (isTransient || isGenerated || isHiddenDotFile) && 'opacity-75',
              'group'
            )}
            style={{ paddingLeft: `${level * 16 + 8}px` }}
            onClick={() => handleFileClick(item)}
          >
            {item.type === 'directory' ? (
              <>
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                )}
                {getFolderIcon(isExpanded)}
              </>
            ) : (
              <>
                <span className="w-4" />
                {(() => {
                  const effectiveEntryPoint = entryPoint || '/index.html';
                  if (item.path === effectiveEntryPoint) {
                    return <Home className="w-4 h-4 text-emerald-500" />;
                  }
                  if (item.name === '.PROMPT.md') {
                    return <ScrollText className="w-4 h-4 text-amber-500" />;
                  }
                  const fileType = getFileTypeFromPath(item.path);
                  if (fileType === 'image') {
                    return <Image className="w-4 h-4 text-green-500" />;
                  } else if (fileType === 'video') {
                    return <Video className="w-4 h-4 text-purple-500" />;
                  } else {
                    return <File className="w-4 h-4 text-muted-foreground" />;
                  }
                })()}
              </>
            )}
            {isRenaming ? (
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onBlur={() => handleRename(item.path, item.type)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleRename(item.path, item.type);
                  } else if (e.key === 'Escape') {
                    setRenamingPath(null);
                    setNewName('');
                  }
                }}
                className="h-5 text-sm"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className={cn("text-sm flex-1", (isTransient || isGenerated || isHiddenDotFile) && "italic text-muted-foreground")}>
                {item.name}
                {isTransient && <span className="text-xs text-muted-foreground ml-1">{t('readOnly')}</span>}
                {isGenerated && <span className="text-xs text-muted-foreground ml-1">{t('generated')}</span>}
                {item.path === (entryPoint || '/index.html') && <span className="text-xs text-emerald-500 ml-1">{t('entry')}</span>}
                {item.name === '.PROMPT.md' && <span className="text-xs text-amber-500 ml-1">{t('aiPrompt')}</span>}
              </span>
            )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
          {/* Only show edit options for non-read-only paths */}
          {!isReadOnly && (
            <>
              {item.type === 'directory' && (
                <>
                  <ContextMenuItem onClick={() => handleCreateFile(item.path)}>
                    <File className="mr-2 h-4 w-4" />
                    {t('newFile')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleCreateDirectory(item.path)}>
                    <Folder className="mr-2 h-4 w-4" />
                    {t('newFolder')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => fileInputRef.current?.click()}>
                    <Upload className="mr-2 h-4 w-4" />
                    {t('uploadFiles')}
                  </ContextMenuItem>
                </>
              )}
              {item.type === 'file' && onSetEntryPoint && item.path !== (entryPoint || '/index.html') && (
                <ContextMenuItem onClick={() => onSetEntryPoint(item.path)}>
                  <Home className="mr-2 h-4 w-4" />
                  {t('setAsEntryPoint')}
                </ContextMenuItem>
              )}
              {item.type === 'file' && (item.path.endsWith('.py') || item.path.endsWith('.lua')) && (
                <ContextMenuItem onClick={() => {
                  window.dispatchEvent(new CustomEvent('runInConsole', { detail: { path: item.path } }));
                }}>
                  <Play className="mr-2 h-4 w-4" />
                  {t('runInConsole')}
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => {
                setRenamingPath(item.path);
                setNewName(item.name);
              }}>
                {t('rename')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleDelete(item.path, item.type)}
                className="text-destructive"
              >
                {tc('actions.delete')}
              </ContextMenuItem>
            </>
          )}
          {/* For transient files, show a read-only indicator */}
          {isTransient && (
            <ContextMenuItem disabled>
              <Eye className="mr-2 h-4 w-4" />
              {t('readOnlyKind', { kind: isServerContext ? 'server' : 'skill' })}
            </ContextMenuItem>
          )}
          {/* For generated files, show a generated indicator */}
          {isGenerated && (
            <ContextMenuItem disabled>
              <Eye className="mr-2 h-4 w-4" />
              {t('generatedOutput')}
            </ContextMenuItem>
          )}
          </ContextMenuContent>
        </ContextMenu>
        {item.type === 'directory' && isExpanded && item.children && (
          <div>
            {item.children.map(child => renderTreeItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div 
      className="h-full flex flex-col"
      onDrop={handleFileDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          for (const file of files) {
            await uploadFile(file, '/');
          }
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }}
      />
      <input
        ref={importInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared first so picking the same file twice still fires a change event.
          if (importInputRef.current) {
            importInputRef.current.value = '';
          }
          if (file) openImport({ kind: 'zip', file });
        }}
      />
      <PanelHeader
        icon={FolderTree}
        title={tw('tabs.fileExplorer')}
        color="var(--button-files-active)"
        onClose={onClose}
        panelKey="files"
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:w-5 md:px-0 md:border-0 md:bg-transparent md:rounded-md"
              onClick={() => fileInputRef.current?.click()}
              title={t('uploadFiles')}
            >
              <Upload className="h-2.5 w-2.5 md:h-3 md:w-3" />
              <span className="text-xs md:hidden">{t('upload')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:w-5 md:px-0 md:border-0 md:bg-transparent md:rounded-md"
              onClick={() => handleCreateFile('/')}
              title={t('newFile')}
            >
              <File className="h-2.5 w-2.5 md:h-3 md:w-3" />
              <span className="text-xs md:hidden">{t('newFile')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:w-5 md:px-0 md:border-0 md:bg-transparent md:rounded-md"
              onClick={() => handleCreateDirectory('/')}
              title={t('newFolder')}
            >
              <Folder className="h-2.5 w-2.5 md:h-3 md:w-3" />
              <span className="text-xs md:hidden">{t('newFolder')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:w-5 md:px-0 md:border-0 md:bg-transparent md:rounded-md"
              onClick={handleDownloadProject}
              title={t('downloadProject')}
            >
              <Download className="h-2.5 w-2.5 md:h-3 md:w-3" />
              <span className="text-xs md:hidden">{tc('actions.download')}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:w-5 md:px-0 md:border-0 md:bg-transparent md:rounded-md"
                  title={t('importIntoProject')}
                >
                  <Import className="h-2.5 w-2.5 md:h-3 md:w-3" />
                  <span className="text-xs md:hidden">{tc('actions.import')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => importInputRef.current?.click()}>
                  <FileArchive className="h-4 w-4 mr-2" />
                  {tp('fromFile')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => pickFolderSource(openImport)}>
                  <FolderOpen className="h-4 w-4 mr-2" />
                  {tp('fromFolder')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div 
            className={cn(
              "flex-1 overflow-y-auto p-3 space-y-0.5 relative",
              isDraggingOver && "bg-blue-500/10"
            )}
            onDragOver={(e) => {
              if (draggedItem) {
                e.preventDefault();
                e.stopPropagation();
                setDropTarget('/');
              }
            }}
            onDrop={(e) => {
              if (draggedItem) {
                handleItemDrop(e, null);
              }
            }}
          >
            {isDraggingOver && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="bg-blue-500/20 border-2 border-dashed border-blue-500 rounded-lg p-8">
                  <Upload className="h-12 w-12 text-blue-500 mx-auto mb-2" />
                  <p className="text-sm text-blue-600">{t('dropFiles')}</p>
                </div>
              </div>
            )}
            {fileTree.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-8">
                <div className="text-center space-y-3">
                  <Folder className="h-12 w-12 mx-auto opacity-50 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="text-base font-medium text-foreground">{t('noFiles')}</p>
                    <p className="text-sm text-muted-foreground">{t('createFirstFile')}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="contents">
                {fileTree.map(item => renderTreeItem(item))}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => handleCreateFile('/')}>
            <File className="mr-2 h-4 w-4" />
            {t('newFile')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleCreateDirectory('/')}>
            <Folder className="mr-2 h-4 w-4" />
            {t('newFolder')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            {t('uploadFiles')}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleDownloadProject}>
            <Download className="mr-2 h-4 w-4" />
            {t('downloadProject')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => importInputRef.current?.click()}>
            <Import className="mr-2 h-4 w-4" />
            {t('importFromFile')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => pickFolderSource(openImport)}>
            <Import className="mr-2 h-4 w-4" />
            {t('importFromFolder')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
            {showHidden ? t('hideHiddenFiles') : t('showHiddenFiles')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {/* Missing .PROMPT.md notification */}
      {onAddPromptFile && !promptDismissed && files.length > 0 && !files.some(f => f.path === '/.PROMPT.md') && (
        <div className="mx-2 mb-2 p-2 rounded-md border border-amber-500/30 bg-amber-500/5 text-xs">
          <p className="text-amber-600 dark:text-amber-400 mb-1.5">{t('noPromptFound')}</p>
          <p className="text-muted-foreground mb-2">{t('addDefaultPrompt')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs px-2"
              onClick={onAddPromptFile}
            >
              {tc('actions.add')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs px-2"
              onClick={() => {
                setPromptDismissed(true);
                localStorage.setItem(`osw-prompt-dismissed-${projectId}`, 'true');
              }}
            >
              {tc('actions.dismiss')}
            </Button>
          </div>
        </div>
      )}

      {/* Hidden files bar */}
      {(hiddenFileCount > 0 || hiddenFolderCount > 0) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setShowHidden(!showHidden)}
              className="shrink-0 w-full flex items-center gap-1.5 px-3 py-1.5 border-t border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              {showHidden ? (
                <><EyeOff className="h-3 w-3 shrink-0" />{t('hideHidden')}</>
              ) : (
                <><Eye className="h-3 w-3 shrink-0" />{(() => {
                  const parts: string[] = [];
                  if (hiddenFileCount > 0) parts.push(t('hiddenFiles', { count: hiddenFileCount }));
                  if (hiddenFolderCount > 0) parts.push(t('hiddenFolders', { count: hiddenFolderCount }));
                  return t('hiddenSummary', { parts: parts.join(', ') });
                })()}</>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[240px] text-xs">
            {t('dotFilesNote')}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Imports into the project this explorer is showing — the only path that can overwrite. */}
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        source={importSource}
        target={{ kind: 'existing-project', projectId }}
        projectName={projectName || undefined}
        onComplete={handleImportComplete}
        // Dropping a zip opens the preview, so the escape hatch has to be offered there too —
        // otherwise keeping it as a plain asset means closing this and going via Upload files.
        onKeepAsFile={handleKeepArchiveAsFile}
      />
    </div>
  );
}
