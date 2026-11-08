'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
// Use package.json version as fallback when env var is not provided
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - JSON import for version string
import pkg from '../../package.json';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import { Badge } from '@/components/ui/badge';
import { Tip } from '@/components/ui/tooltip';
import { Github, ExternalLink, Globe, MessagesSquare } from 'lucide-react';
import { DEMO_URL, DISCUSSIONS_URL, REPO_URL } from '@/lib/constants/links';

interface AboutModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AboutModal({ open, onOpenChange }: AboutModalProps) {
  const tc = useTranslations('common');
  const t = useTranslations('about');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <div className="flex items-center gap-4 mb-2">
            <Logo width={64} height={64} />
            <div>
              <DialogTitle className="text-2xl">Open Source Web Studio</DialogTitle>
              <DialogDescription className="text-base">
                {t('tagline')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 overflow-y-auto max-h-[60vh] pr-4">
          <section>
            <div className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed space-y-3">
              <p>
                {t('intro1')}
              </p>
              
              <p>
                {t('intro2')}
              </p>

              <p>
                {t('shareInvite')}
              </p>
            </div>
          </section>

          <section>
            <h3 className="font-semibold text-lg mb-3">{t('linksCommunity')}</h3>
            <div className="flex flex-col gap-2">
              <Tip label={t('tips.discussions')} align="start">
                <a
                  href={DISCUSSIONS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <MessagesSquare className="h-4 w-4" />
                  {t('discussions')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Tip>
              <Tip label={t('tips.repo')} align="start">
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <Github className="h-4 w-4" />
                  {t('githubRepo')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Tip>
              <Tip label={t('tips.demo')} align="start">
                <a
                  href={DEMO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <Globe className="h-4 w-4" />
                  {t('liveDemo')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Tip>
            </div>
          </section>
        </div>

        <div className="flex justify-between items-center pt-4 border-t">
          <Badge variant="secondary" className="text-xs">
            v{process.env.NEXT_PUBLIC_APP_VERSION || pkg.version}
          </Badge>
          <Button onClick={() => onOpenChange(false)}>
            {tc('actions.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
