'use client';

import React, { useEffect, useState } from 'react';
import { Deployment } from '@/lib/vfs/types';
import { Server, Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/components/providers/locale-provider';

interface DeploymentSelectorProps {
  projectId: string;
  selectedDeploymentId: string | null;
  onDeploymentChange: (deploymentId: string | null, deploymentName: string | null) => void;
  className?: string;
  workspaceId?: string;
}

export function DeploymentSelector({
  projectId,
  selectedDeploymentId,
  onDeploymentChange,
  className,
  workspaceId,
}: DeploymentSelectorProps) {
  const { t } = useTranslation();
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch deployments for this project
  useEffect(() => {
    const fetchDeployments = async () => {
      // Only fetch in server mode
      if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const response = await fetch(`${apiBase}/projects/${projectId}/deployments`);
        if (!response.ok) {
          throw new Error('Failed to fetch deployments');
        }

        const data = await response.json();
        setDeployments(data.deployments || []);

        // Auto-select first deployment if only one exists and nothing is selected
        if (data.deployments?.length === 1 && !selectedDeploymentId) {
          const deployment = data.deployments[0];
          if (deployment.databaseEnabled) {
            onDeploymentChange(deployment.id, deployment.name);
          }
        }
      } catch {
        // Expected in browser mode or when project hasn't been synced to server yet
        // Don't show error — deployments are optional
      } finally {
        setLoading(false);
      }
    };

    fetchDeployments();
  }, [projectId]); // Only refetch when project changes

  // Don't render in browser mode
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    return null;
  }

  // Don't render if no deployments with database enabled
  const databaseEnabledDeployments = deployments.filter(s => s.databaseEnabled);
  if (!loading && databaseEnabledDeployments.length === 0) {
    return null;
  }

  if (loading) {
    return (
      <div className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}>
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading deployments...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex items-center gap-2 text-sm text-destructive', className)}>
        <Server className="h-4 w-4" />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Select
        value={selectedDeploymentId || 'none'}
        onValueChange={(value) => {
          if (value === 'none') {
            onDeploymentChange(null, null);
          } else {
            const deployment = deployments.find(s => s.id === value);
            onDeploymentChange(value, deployment?.name || null);
          }
        }}
      >
        <SelectTrigger size="sm" className="w-[180px] h-8">
          <SelectValue placeholder={t.common.noDeployment} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">
            <span className="text-muted-foreground">{t.common.noDeployment}</span>
          </SelectItem>
          {databaseEnabledDeployments.map((deployment) => (
            <SelectItem key={deployment.id} value={deployment.id}>
              <div className="flex items-center gap-2">
                <Server className="h-3.5 w-3.5" />
                <span>{deployment.name}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
