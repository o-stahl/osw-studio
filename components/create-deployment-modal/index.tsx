'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Project } from '@/lib/vfs/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CreateDeploymentModalProps {
  projects: Project[];
  /** Preselects the project when the dialog is opened from Deploy in the workspace. */
  initialProjectId?: string;
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: { projectId: string; name: string; slug?: string }) => Promise<void>;
}

export function CreateDeploymentModal({
  projects,
  initialProjectId,
  isOpen,
  onClose,
  onCreate,
}: CreateDeploymentModalProps) {
  const t = useTranslations('deployments');
  const tc = useTranslations('common');
  const tp = useTranslations('publishSettings');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!projectId || !name) {
      setError(t('create.required'));
      return;
    }

    setIsCreating(true);
    setError('');

    try {
      await onCreate({
        projectId,
        name,
        slug: slug || undefined,
      });

      // Reset form
      setProjectId('');
      setName('');
      setSlug('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('createFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    if (!isCreating) {
      setProjectId('');
      setName('');
      setSlug('');
      setError('');
      onClose();
    }
  };

  // Auto-generate deployment name from selected project
  const handleProjectChange = (value: string) => {
    setProjectId(value);
    if (!name) {
      const project = projects.find(p => p.id === value);
      if (project) {
        setName(project.name);
      }
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
          <DialogDescription>
            {t('create.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Project Selection */}
          <div className="grid gap-2">
            <Label htmlFor="project">{tc('labels.project')}</Label>
            <Select value={projectId} onValueChange={handleProjectChange}>
              <SelectTrigger id="project">
                <SelectValue placeholder={tp('selectProject')} />
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
              {t('create.projectHint')}
            </p>
          </div>

          {/* Deployment Name */}
          <div className="grid gap-2">
            <Label htmlFor="name">{t('create.name')}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('create.namePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('create.nameHint')}
            </p>
          </div>

          {/* Slug (Optional) */}
          <div className="grid gap-2">
            <Label htmlFor="slug">{t('create.slug')}</Label>
            <Input
              id="slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-awesome-deployment" // i18n-ignore: a slug is an ASCII identifier
            />
            <p className="text-xs text-muted-foreground">
              {t('create.slugHint')}
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isCreating}>
            {tc('actions.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={isCreating || !projectId || !name}>
            {isCreating ? tc('actions.creating') : t('create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
