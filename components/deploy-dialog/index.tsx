'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Globe, Cloud, FileArchive, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { vfs } from '@/lib/vfs';
import { configManager } from '@/lib/config/storage';
import { detectDeploymentType } from '@/lib/telemetry/config';
import { demoAccountUrl } from '@/lib/demo';
import { checkHFCapabilities, loginHF } from '@/lib/auth/hf-auth';
import { HFSpaceTarget } from './hf-space-target';
import { requestDeploymentFor } from '@/lib/deployments/pending-create';
import { Tip } from '@/components/ui/tooltip';

interface DeployDialogProps {
  open: boolean;
  projectId: string;
  onOpenChange: (o: boolean) => void;
}

type Target = 'hf' | 'osws' | 'zip';

const DEPLOY_DOC = '/?doc=deploying-sites';

export function DeployDialog({ open, projectId, onOpenChange }: DeployDialogProps) {
  const tc = useTranslations('common');
  const tChat = useTranslations('chat');
  const tt = useTranslations('tooltips');
  const t = useTranslations('deployDialog');
  const tw = useTranslations('workspace');
  const tDemo = useTranslations('demo');
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const isHFSpace = detectDeploymentType() === 'hf_space';
  // On the hosted demo, publishing is what an account on the hosted service is for.
  const demoSignInUrl = demoAccountUrl('login');
  const hfConnected = !!configManager.getHFAuth()?.access_token;

  // ZIP export is always available (works in every mode and for every runtime), so it's the
  // universal fallback default; prefer a managed target where one is usable.
  const [target, setTarget] = useState<Target>(
    isServerMode ? 'osws' : hfConnected ? 'hf' : 'zip',
  );
  const [zipExporting, setZipExporting] = useState(false);

  const close = () => onOpenChange(false);

  async function handleDownloadZip() {
    setZipExporting(true);
    try {
      await vfs.init();
      const proj = await vfs.getProject(projectId);
      const blob = await vfs.exportProjectAsZip(projectId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(proj?.name || 'project').replace(/\s+/g, '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('zipExportFailed'));
    } finally {
      setZipExporting(false);
    }
  }

  // Enable path for the HuggingFace target when not connected.
  async function connectHuggingFace() {
    if (isHFSpace) {
      try {
        sessionStorage.setItem('hf_oauth_return_project', projectId);
        sessionStorage.setItem('hf_oauth_resume_deploy', projectId);
      } catch {}
      const caps = await checkHFCapabilities();
      if (caps.oauthAvailable && caps.clientId) {
        await loginHF(caps.clientId, caps.scopes);
        return;
      }
    }
    // Off an HF Space (or no OAuth configured): send them to Settings to paste a token.
    window.dispatchEvent(new CustomEvent('nav-to-view', { detail: { view: 'settings' } }));
    close();
  }

  const goToDeployments = () => {
    // Carry the project across. Without it Deployments opens on a list and the deployment has to be
    // pointed at a project by hand, which is how a deployment ends up serving one you did not mean.
    requestDeploymentFor(projectId);
    window.dispatchEvent(new CustomEvent('nav-to-view', { detail: { view: 'deployments' } }));
    close();
  };

  const learnMore = () => window.open(DEPLOY_DOC, '_blank', 'noopener,noreferrer');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{tw('deploy')}</DialogTitle>
          <DialogDescription>{t('chooseWhere')}</DialogDescription>
        </DialogHeader>

        {/* Target picker */}
        <div className="grid gap-2 py-2">
          {/* HuggingFace Space */}
          <TargetRow
            icon={<Globe className="h-4 w-4" />}
            title="Hugging Face Space"
            subtitle={t('hfSpaceDesc')}
            enabled={hfConnected}
            selected={target === 'hf'}
            onSelect={() => setTarget('hf')}
            onLearnMore={learnMore}
            disabledContent={
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('connectHfToDeploy')}
                </span>
                <Tip label={isHFSpace ? t('tips.signIn') : t('tips.connect')}>
                  <Button size="sm" variant="outline" onClick={connectHuggingFace}>
                    {isHFSpace ? tChat('signInWithHF') : t('connectInSettings')}
                  </Button>
                </Tip>
              </div>
            }
          />

          {/* OSW Studio instance */}
          <TargetRow
            icon={<Cloud className="h-4 w-4" />}
            title="Open Source Web Studio"
            subtitle={demoSignInUrl ? tDemo('publishSubtitle') : tt('publishHere')}
            enabled={isServerMode}
            selected={target === 'osws'}
            onSelect={() => setTarget('osws')}
            onLearnMore={learnMore}
            disabledContent={
              demoSignInUrl ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{tDemo('publishHere')}</span>
                  <Tip label={t('tips.newTab')}>
                    <Button asChild size="sm" variant="outline">
                      <a href={demoSignInUrl} target="_blank" rel="noopener">{tDemo('signIn')}</a>
                    </Button>
                  </Tip>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">{t('availableInServerMode')}</span>
              )
            }
          />

          {/* ZIP export — always available, every runtime */}
          <TargetRow
            icon={<FileArchive className="h-4 w-4" />}
            title={t('downloadZip')}
            subtitle={tt('exportAnywhere')}
            enabled
            selected={target === 'zip'}
            onSelect={() => setTarget('zip')}
            onLearnMore={learnMore}
            disabledContent={null}
          />
        </div>

        {/* Selected target body */}
        {target === 'hf' && hfConnected ? (
          <HFSpaceTarget projectId={projectId} onClose={close} />
        ) : target === 'osws' && isServerMode ? (
          <>
            <div className="py-4 text-sm text-muted-foreground">
              {t('oswsExplain')}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {tc('actions.cancel')}
              </Button>
              <Tip label={t('tips.createDeployment')}>
                <Button onClick={goToDeployments}>{t('createDeployment')}</Button>
              </Tip>
            </DialogFooter>
          </>
        ) : target === 'zip' ? (
          <>
            <div className="py-4 text-sm text-muted-foreground">
              {t('zipExplain')}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {tc('actions.cancel')}
              </Button>
              <Tip label={zipExporting ? undefined : t('tips.zip')}>
                <Button onClick={handleDownloadZip} disabled={zipExporting}>
                  {zipExporting ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('exporting')}</>
                  ) : (
                    t('downloadZipButton')
                  )}
                </Button>
              </Tip>
            </DialogFooter>
          </>
        ) : (
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {tc('actions.close')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TargetRow({
  icon,
  title,
  subtitle,
  enabled,
  selected,
  onSelect,
  onLearnMore,
  disabledContent,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  enabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onLearnMore: () => void;
  disabledContent: React.ReactNode;
}) {
  const t = useTranslations('deployDialog');
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        !enabled
          ? 'border-border bg-muted/30'
          : selected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border hover:bg-accent/50 cursor-pointer'
      }`}
      onClick={enabled && !selected ? onSelect : undefined}
      role={enabled ? 'button' : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className={`flex items-center gap-2 text-sm font-medium ${enabled ? '' : 'text-muted-foreground'}`}>
          {icon}
          {title}
        </div>
        <Tip label={t('tips.learnMore')}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLearnMore();
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('learnMore')} <ExternalLink className="h-3 w-3" />
          </button>
        </Tip>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      {!enabled && <div className="mt-2">{disabledContent}</div>}
    </div>
  );
}
