'use client';

import { useTranslations } from 'next-intl';
import { useState, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { ChevronDown, Building2, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';

interface WorkspaceInfo {
  id: string;
  name: string;
  owner_id: string;
  role: string;
}

interface WorkspaceSwitcherProps {
  workspaceId?: string;
}

export function WorkspaceSwitcher({ workspaceId }: WorkspaceSwitcherProps) {
  const tc = useTranslations('common');
  const ta = useTranslations('admin');
  // Read cached name from localStorage after mount (avoids hydration mismatch)
  const [cachedName, setCachedName] = useState<string | null>(null);
  useEffect(() => {
    try {
      const name = localStorage.getItem('osw-workspace-name');
      if (name) setCachedName(name);
    } catch {}
  }, []);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    Promise.all([
      fetch('/api/workspaces').then(res => res.ok ? res.json() : null),
      fetch('/api/auth/me').then(res => res.ok ? res.json() : null),
    ])
      .then(([wsData, authData]) => {
        if (wsData?.workspaces) {
          setWorkspaces(wsData.workspaces);
          // Update cached name from fresh data
          const current = wsData.workspaces.find((w: WorkspaceInfo) => w.id === workspaceId);
          if (current) {
            try { localStorage.setItem('osw-workspace-name', current.name); } catch {}
          }
        }
        if (authData?.user?.isAdmin) setIsAdmin(true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const currentWorkspace = workspaces.find(w => w.id === workspaceId);

  const handleSwitch = (newWorkspaceId: string) => {
    const viewMatch = pathname?.match(/\/w\/[^/]+\/(.+)/);
    const currentView = viewMatch?.[1] || 'projects';
    document.cookie = `osw_workspace=${newWorkspaceId};path=/;max-age=${60 * 60 * 24 * 365}`;
    const ws = workspaces.find(w => w.id === newWorkspaceId);
    if (ws) {
      try { localStorage.setItem('osw-workspace-name', ws.name); } catch {}
    }
    router.push(`/w/${newWorkspaceId}/${currentView}`);
  };

  // While loading, show cached name if available (prevents flash)
  if (loading) {
    if (!cachedName) return null;
    return (
      <div className="border-b border-border/50">
        <Button variant="ghost" className="w-full justify-start gap-2 px-3 py-2.5 h-auto rounded-none" disabled>
          <Building2 className="h-4 w-4 text-foreground shrink-0" />
          <span className="truncate font-medium text-sm text-foreground">{cachedName}</span>
          <ChevronDown className="h-3 w-3 ml-auto text-muted-foreground shrink-0" />
        </Button>
      </div>
    );
  }

  if (workspaces.length === 0) return null;

  // Always show as dropdown — single workspace gets manage option, multiple gets switcher
  return (
    <div className="border-b border-border/50">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="w-full justify-start gap-2 px-3 py-2.5 h-auto rounded-none hover:bg-accent/50">
            <Building2 className="h-4 w-4 text-foreground shrink-0" />
            <span className="truncate font-medium text-sm text-foreground">
              {currentWorkspace?.name || cachedName || workspaces[0]?.name || tc('labels.workspace')}
            </span>
            <ChevronDown className="h-3 w-3 ml-auto text-muted-foreground shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {workspaces.map(ws => (
            <DropdownMenuItem
              key={ws.id}
              onClick={() => handleSwitch(ws.id)}
              className={ws.id === workspaceId ? 'bg-accent' : ''}
            >
              <div className="flex items-center gap-2 w-full min-w-0">
                <span className="truncate flex-1">{ws.name}</span>
                <Badge variant="outline" className="text-[10px] shrink-0">{ws.role}</Badge>
              </div>
            </DropdownMenuItem>
          ))}
          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push('/admin/workspaces')}>
                <Settings className="h-3.5 w-3.5 mr-2" />
                {ta('manageWorkspaces')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
