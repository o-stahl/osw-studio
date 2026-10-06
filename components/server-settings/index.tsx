'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Deployment } from '@/lib/vfs/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DatabaseManager } from '@/components/database-manager';

interface ServerSettingsModalProps {
  deployment: Deployment;
  isOpen: boolean;
  onClose: () => void;
  workspaceId?: string;
}

export function ServerSettingsModal({ deployment, isOpen, onClose, workspaceId }: ServerSettingsModalProps) {
  const t = useTranslations('backend');
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-4xl h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('serverSettingsTitle')}</DialogTitle>
          <DialogDescription>
            {t('serverSettingsDesc', { name: deployment.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          <DatabaseManager deploymentId={deployment.id} workspaceId={workspaceId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
