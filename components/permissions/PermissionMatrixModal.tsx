'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslations } from 'next-intl';
import { PermissionMatrix } from './PermissionMatrix';

interface PermissionMatrixModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onModeChange?: () => void;
}

export function PermissionMatrixModal({
  open,
  onOpenChange,
  onModeChange,
}: PermissionMatrixModalProps) {
  const t = useTranslations('permissions');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="lg:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('customizeTitle')}</DialogTitle>
        </DialogHeader>
        <PermissionMatrix onModeChange={onModeChange} />
      </DialogContent>
    </Dialog>
  );
}
