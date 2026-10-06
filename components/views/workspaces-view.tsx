'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { getLoginUrl } from '@/lib/config/storage';
import {
  Building2,
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  Pencil,
  ChevronRight,
  ChevronDown,
  UserPlus,
  UserMinus,
  FolderOpen,
  Globe,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { PageShell, PageHeader, PageBody } from '@/components/ui/page-shell';
import { useRoleLabel } from './role-label';

interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  joinedAt: string;
}

interface WorkspaceProject {
  id: string;
  name: string;
  updatedAt: string;
}

interface WorkspaceDeployment {
  id: string;
  slug: string | null;
  customDomain: string | null;
}

interface WorkspaceInfo {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string | null;
  maxProjects: number;
  maxDeployments: number;
  maxStorageMb: number;
  memberCount: number;
  projectCount: number;
  deploymentCount: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceDetail extends WorkspaceInfo {
  members: WorkspaceMember[];
  projects: WorkspaceProject[];
  deployments: WorkspaceDeployment[];
}

export function WorkspacesView() {
  const t = useTranslations('admin');
  const roleLabel = useRoleLabel();
  const { dateTime } = useLocalFormat();
  const tc = useTranslations('common');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [saving, setSaving] = useState(false);

  // Edit dialog
  const [editWorkspace, setEditWorkspace] = useState<WorkspaceInfo | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editForm, setEditForm] = useState({
    name: '',
    maxProjects: 3,
    maxDeployments: 1,
    maxStorageMb: 100,
  });

  // Create dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    ownerEmail: '',
  });

  // Expand / member detail
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Add member dialog
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false);
  const [addMemberForm, setAddMemberForm] = useState({ email: '', role: 'editor' });
  const [addingMember, setAddingMember] = useState(false);

  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';

  useEffect(() => {
    loadWorkspaces();
  }, []);

  const loadWorkspaces = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/workspaces');
      if (res.status === 401) {
        window.location.href = getLoginUrl();
        return;
      }
      if (!res.ok) throw new Error('Failed to load workspaces');
      const data = await res.json();
      setWorkspaces(data.workspaces);
    } catch (err) {
      logger.error('[WorkspacesView] Failed to load workspaces:', err);
      toast.error(t('loadWorkspacesFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenEdit = (ws: WorkspaceInfo) => {
    setEditWorkspace(ws);
    setEditForm({
      name: ws.name,
      maxProjects: ws.maxProjects,
      maxDeployments: ws.maxDeployments,
      maxStorageMb: ws.maxStorageMb,
    });
    setShowEditDialog(true);
  };

  const handleSaveEdit = async () => {
    if (!editWorkspace) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/workspaces/${editWorkspace.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name || undefined,
          maxProjects: editForm.maxProjects,
          maxDeployments: editForm.maxDeployments,
          maxStorageMb: editForm.maxStorageMb,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('updateWorkspaceFailed'));
      }
      toast.success(t('workspaceUpdated'));
      setShowEditDialog(false);
      setEditWorkspace(null);
      await loadWorkspaces();
      if (expandedId === editWorkspace.id) {
        await loadDetail(editWorkspace.id);
      }
    } catch (err) {
      logger.error('[WorkspacesView] Failed to update workspace:', err);
      toast.error(err instanceof Error ? err.message : t('updateWorkspaceFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!createForm.name || !createForm.ownerEmail) {
      toast.error(t('workspaceNameOwnerRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createForm.name,
          ownerEmail: createForm.ownerEmail,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('createWorkspaceFailed'));
      }
      toast.success(t('workspaceCreated'));
      setShowCreateDialog(false);
      setCreateForm({ name: '', ownerEmail: '' });
      await loadWorkspaces();
    } catch (err) {
      logger.error('[WorkspacesView] Failed to create workspace:', err);
      toast.error(err instanceof Error ? err.message : t('createWorkspaceFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ws: WorkspaceInfo) => {
    if (!confirm(t('confirmDeleteWorkspace', { name: ws.name }))) return;
    try {
      const res = await fetch(`/api/admin/workspaces/${ws.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('deleteWorkspaceFailed'));
      }
      toast.success(t('workspaceDeleted'));
      if (expandedId === ws.id) {
        setExpandedId(null);
        setWorkspaceDetail(null);
      }
      await loadWorkspaces();
    } catch (err) {
      logger.error('[WorkspacesView] Failed to delete workspace:', err);
      toast.error(err instanceof Error ? err.message : t('deleteWorkspaceFailed'));
    }
  };

  const loadDetail = async (wsId: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/admin/workspaces/${wsId}`);
      if (!res.ok) throw new Error('Failed to load workspace details');
      const data = await res.json();
      setWorkspaceDetail(data);
    } catch (err) {
      logger.error('[WorkspacesView] Failed to load workspace details:', err);
      toast.error(t('loadWorkspaceDetailsFailed'));
      setExpandedId(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleToggleExpand = async (wsId: string) => {
    if (expandedId === wsId) {
      setExpandedId(null);
      setWorkspaceDetail(null);
      return;
    }
    setExpandedId(wsId);
    await loadDetail(wsId);
  };

  const handleAddMember = async () => {
    if (!expandedId || !addMemberForm.email) {
      toast.error(t('emailRequired'));
      return;
    }
    setAddingMember(true);
    try {
      const res = await fetch(`/api/admin/workspaces/${expandedId}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: addMemberForm.email, role: addMemberForm.role }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('addMemberFailed'));
      }
      toast.success(t('memberAdded'));
      setShowAddMemberDialog(false);
      setAddMemberForm({ email: '', role: 'editor' });
      await loadDetail(expandedId);
      await loadWorkspaces();
    } catch (err) {
      logger.error('[WorkspacesView] Failed to add member:', err);
      toast.error(err instanceof Error ? err.message : t('addMemberFailed'));
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemoveMember = async (wsId: string, userId: string, memberEmail: string) => {
    if (!confirm(t('confirmRemoveMember', { email: memberEmail }))) return;
    try {
      const res = await fetch(`/api/admin/workspaces/${wsId}/access`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('removeMemberFailed'));
      }
      toast.success(t('memberRemoved'));
      await loadDetail(wsId);
      await loadWorkspaces();
    } catch (err) {
      logger.error('[WorkspacesView] Failed to remove member:', err);
      toast.error(err instanceof Error ? err.message : t('removeMemberFailed'));
    }
  };

  const filteredWorkspaces = useMemo(() => {
    if (!searchQuery) return workspaces;
    const query = searchQuery.toLowerCase();
    return workspaces.filter(
      ws =>
        ws.name.toLowerCase().includes(query) ||
        ws.ownerEmail?.toLowerCase().includes(query)
    );
  }, [workspaces, searchQuery]);

  const formatDate = (dateStr: string) => {
    try {
      return dateTime(dateStr, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const roleBadgeVariant = (role: string): 'default' | 'secondary' | 'outline' => {
    switch (role) {
      case 'owner': return 'default';
      case 'editor': return 'secondary';
      default: return 'outline';
    }
  };

  if (!isServerMode) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p>{t('workspacesServerOnly')}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Spinner size={48} color="#f97316" className="mx-auto" />
          <p className="mt-4">{t('loadingWorkspaces')}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageShell>
        <PageHeader title={tc('terms.workspaces')}>
          <div className="flex items-center shrink-0">
            <Button onClick={() => setShowCreateDialog(true)} size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              <span>{t('newWorkspace')}</span>
            </Button>
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('searchWorkspaces')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </PageHeader>

        {/* Workspace List */}
        <PageBody fill>
            {filteredWorkspaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Building2 className="h-16 w-16 text-muted-foreground mb-4" />
                {workspaces.length === 0 ? (
                  <>
                    <h2 className="text-xl font-semibold mb-2">{t('noWorkspacesYet')}</h2>
                    <p className="text-muted-foreground mb-4 max-w-md">
                      {t('firstWorkspaceHint')}
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="text-xl font-semibold mb-2">{t('noWorkspacesFound')}</h2>
                    <p className="text-muted-foreground mb-4 max-w-md">
                      {t('tryAdjustingSearch')}
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="@container flex-1 min-h-0 overflow-auto border rounded-lg">
                <table className="w-full table-auto border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="bg-muted p-[6px_10px] border-b select-none"></th>
                      <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none w-full">{tc('labels.workspace')}</th>
                      <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('members')}</th>
                      <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('terms.projects')}</th>
                      <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('terms.deployments')}</th>
                      <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('labels.created')}</th>
                      <th className="bg-muted p-[6px_10px] border-b select-none"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWorkspaces.map((ws) => {
                      const isExpanded = expandedId === ws.id;
                      return (
                        <React.Fragment key={ws.id}>
                          <tr
                            className="border-b border-border/50 hover:bg-muted/50 cursor-pointer h-[44px]"
                            onClick={() => handleToggleExpand(ws.id)}
                          >
                            <td className="p-[4px_10px] align-middle text-muted-foreground">
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </td>
                            <td className="w-full p-[4px_10px] text-[13px] align-middle overflow-hidden" style={{ maxWidth: 0 }}>
                              <div className="min-w-0">
                                <span className="block font-medium text-foreground text-[13px] truncate">{ws.name}</span>
                                {ws.ownerEmail && <span className="block text-[11px] text-muted-foreground truncate">{t('ownerIs', { email: ws.ownerEmail })}</span>}
                              </div>
                            </td>
                            <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap tabular-nums">{ws.memberCount}</td>
                            <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap tabular-nums">{ws.projectCount}</td>
                            <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap tabular-nums">{ws.deploymentCount}</td>
                            <td className="p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap">{formatDate(ws.createdAt)}</td>
                            <td className="p-[4px_10px] align-middle whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="xs" className="px-1">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => handleOpenEdit(ws)}>
                                    <Pencil className="h-4 w-4 mr-2" />
                                    {tc('actions.edit')}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleDelete(ws)}
                                    className="text-destructive focus:text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    {tc('actions.delete')}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-muted/30 border-b border-border/50">
                              <td></td>
                              <td colSpan={6} className="p-[4px_10px] pb-4 align-top">
                          {/* The counts the row drops at narrow widths, shown only there so the panel
                              does not repeat columns already on screen. */}
                          <div className="@5xl:hidden mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{t('members')}{' '}<span className="text-foreground tabular-nums">{ws.memberCount}</span></span>
                            <span>{tc('terms.projects')}{' '}<span className="text-foreground tabular-nums">{ws.projectCount}</span></span>
                            <span>{tc('terms.deployments')}{' '}<span className="text-foreground tabular-nums">{ws.deploymentCount}</span></span>
                          </div>
                          {loadingDetail ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                              <Spinner size={16} color="#f97316" />
                              <span>{t('loadingDetails')}</span>
                            </div>
                          ) : workspaceDetail ? (
                            <div className="space-y-4">
                              {/* Quotas row */}
                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span>{t('quotaProjects', { count: workspaceDetail.maxProjects })}</span>
                                <span>{t('quotaDeployments', { count: workspaceDetail.maxDeployments })}</span>
                                <span>{t('quotaStorage', { mb: workspaceDetail.maxStorageMb })}</span>
                              </div>

                              {/* Members */}
                              <div>
                                <div className="flex items-center justify-between mb-2">
                                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    {t('membersCount', { count: workspaceDetail.members.length })}
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs gap-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setShowAddMemberDialog(true);
                                    }}
                                  >
                                    <UserPlus className="h-3 w-3" />
                                    {t('addMemberTitle')}
                                  </Button>
                                </div>
                                {workspaceDetail.members.length > 0 ? (
                                  <div className="space-y-1">
                                    {workspaceDetail.members.map((member) => (
                                      <div
                                        key={member.userId}
                                        className="flex items-center gap-3 text-sm p-2 rounded bg-background/60"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium truncate">{member.email}</span>
                                            <Badge variant={roleBadgeVariant(member.role)} className="text-xs">
                                              {roleLabel(member.role)}
                                            </Badge>
                                          </div>
                                          {member.displayName && (
                                            <div className="text-xs text-muted-foreground">{member.displayName}</div>
                                          )}
                                        </div>
                                        <div className="text-xs text-muted-foreground shrink-0">
                                          {formatDate(member.joinedAt)}
                                        </div>
                                        {member.userId !== workspaceDetail.ownerId && (
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleRemoveMember(ws.id, member.userId, member.email);
                                            }}
                                            title={t('removeMember')}
                                          >
                                            <UserMinus className="h-3.5 w-3.5" />
                                          </Button>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-sm text-muted-foreground py-1">{t('noMembers')}</div>
                                )}
                              </div>

                              {/* Projects */}
                              <div>
                                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                                  {t('projectsCount', { count: workspaceDetail.projects?.length ?? workspaceDetail.projectCount })}
                                </div>
                                {workspaceDetail.projects && workspaceDetail.projects.length > 0 ? (
                                  <div className="space-y-1">
                                    {workspaceDetail.projects.map((project) => (
                                      <div
                                        key={project.id}
                                        className="flex items-center gap-3 text-sm p-2 rounded bg-background/60"
                                      >
                                        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                        <span className="flex-1 min-w-0 truncate font-medium">{project.name}</span>
                                        <span className="text-xs text-muted-foreground shrink-0">
                                          {t('updatedOn', { date: formatDate(project.updatedAt) })}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-sm text-muted-foreground py-1">{t('noProjects')}</div>
                                )}
                              </div>

                              {/* Deployments */}
                              <div>
                                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                                  {t('deploymentsCount', { count: workspaceDetail.deployments?.length ?? workspaceDetail.deploymentCount })}
                                </div>
                                {workspaceDetail.deployments && workspaceDetail.deployments.length > 0 ? (
                                  <div className="space-y-1">
                                    {workspaceDetail.deployments.map((deployment) => (
                                      <div
                                        key={deployment.id}
                                        className="flex items-center gap-3 text-sm p-2 rounded bg-background/60"
                                      >
                                        <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                        <span className="flex-1 min-w-0 truncate font-medium">
                                          {deployment.slug || deployment.id.slice(0, 8)}
                                        </span>
                                        {deployment.customDomain && (
                                          <Badge variant="outline" className="text-xs shrink-0">
                                            {deployment.customDomain}
                                          </Badge>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-sm text-muted-foreground py-1">{t('noDeployments')}</div>
                                )}
                              </div>
                            </div>
                          ) : null}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </PageBody>
      </PageShell>

      {/* Edit Workspace Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(open) => { setShowEditDialog(open); if (!open) setEditWorkspace(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('editWorkspace')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{tc('labels.name')}</Label>
              <Input
                id="edit-name"
                value={editForm.name}
                onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))}
                placeholder={t('workspaceNamePlaceholder')}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="edit-maxProjects">{t('maxProjects')}</Label>
                <Input
                  id="edit-maxProjects"
                  type="number"
                  min={0}
                  value={editForm.maxProjects}
                  onChange={(e) => setEditForm(f => ({ ...f, maxProjects: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-maxDeployments">{t('maxDeploys')}</Label>
                <Input
                  id="edit-maxDeployments"
                  type="number"
                  min={0}
                  value={editForm.maxDeployments}
                  onChange={(e) => setEditForm(f => ({ ...f, maxDeployments: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-maxStorage">{t('storageMb')}</Label>
                <Input
                  id="edit-maxStorage"
                  type="number"
                  min={0}
                  value={editForm.maxStorageMb}
                  onChange={(e) => setEditForm(f => ({ ...f, maxStorageMb: Number(e.target.value) }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowEditDialog(false); setEditWorkspace(null); }}>{tc('actions.cancel')}</Button>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving ? tc('actions.saving') : t('saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Workspace Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('createWorkspace')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="create-name">{tc('labels.name')}</Label>
              <Input
                id="create-name"
                value={createForm.name}
                onChange={(e) => setCreateForm(f => ({ ...f, name: e.target.value }))}
                placeholder={t('workspaceNamePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-ownerEmail">{t('ownerEmail')}</Label>
              <Input
                id="create-ownerEmail"
                type="email"
                value={createForm.ownerEmail}
                onChange={(e) => setCreateForm(f => ({ ...f, ownerEmail: e.target.value }))}
                placeholder="owner@example.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>{tc('actions.cancel')}</Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? t('creating') : t('createWorkspace')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={showAddMemberDialog} onOpenChange={setShowAddMemberDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('addMemberTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="add-member-email">{t('userEmail')}</Label>
              <Input
                id="add-member-email"
                type="email"
                value={addMemberForm.email}
                onChange={(e) => setAddMemberForm(f => ({ ...f, email: e.target.value }))}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-member-role">{t('role')}</Label>
              <select
                id="add-member-role"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={addMemberForm.role}
                onChange={(e) => setAddMemberForm(f => ({ ...f, role: e.target.value }))}
              >
                <option value="viewer">{t('roleViewer')}</option>
                <option value="editor">{t('roleEditor')}</option>
                <option value="owner">{t('roleOwner')}</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddMemberDialog(false)}>{tc('actions.cancel')}</Button>
            <Button onClick={handleAddMember} disabled={addingMember}>
              {addingMember ? tc('actions.adding') : t('addMemberTitle')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
