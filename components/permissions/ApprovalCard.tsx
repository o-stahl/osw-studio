'use client';

import { Shield } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';

export function ApprovalCard() {
  const tc = useTranslations('common');
  const tp = useTranslations('permissions');
  const tq = useTranslations('quickEdit');
  const pendingApproval = useWorkspaceStore((s) => s.pendingApproval);
  const resolveApproval = useWorkspaceStore((s) => s.resolveApproval);

  if (!pendingApproval) return null;

  const { req } = pendingApproval;

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm p-3 mb-2 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Shield className="h-4 w-4 text-muted-foreground" />
        {req.capabilityLabel}
      </div>
      <pre className="font-mono text-xs bg-muted rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">
        {req.command}
      </pre>
      <p className="text-xs text-muted-foreground">
        {tp('approvalPrompt')}
      </p>
      <div className="flex items-center gap-2">
        <Tip label={tp('tips.allowOnce')}>
          <Button size="sm" onClick={() => resolveApproval('once')}>
            {tp('allowOnce')}
          </Button>
        </Tip>
        <Tip label={tq('tips.allow')}>
          <Button size="sm" onClick={() => resolveApproval('always')}>
            {tp('alwaysAllow')}
          </Button>
        </Tip>
        <Tip label={tq('tips.dont')}>
          <Button variant="outline" size="sm" onClick={() => resolveApproval('deny')}>
            {tc('actions.deny')}
          </Button>
        </Tip>
      </div>
    </div>
  );
}
