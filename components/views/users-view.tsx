'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { getLoginUrl } from '@/lib/config/storage';
import { Users, Plus, Search, MoreHorizontal, UserCheck, UserX, Trash2, Pencil, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { PageShell, PageHeader, PageBody } from '@/components/ui/page-shell';
import { WorkspaceMembers } from './workspace-members';
import { emitViewChanged } from '@/lib/view-mode-event';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Section, SectionBody, SectionHeader } from '@/components/ui/section';
import { SettingRow } from '@/components/ui/setting-row';
import { useRoleLabel } from './role-label';
import { apiFetch } from '@/lib/api/backend-status';

interface WorkspaceInfo {
  id: string;
  name: string;
  owner_id: string;
  max_projects: number;
  max_deployments: number;
  max_storage_mb: number;
  role: string;
  created_at: string;
  updated_at: string;
}

interface UserInfo {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  active: boolean;
  studioView: boolean;
  workspaces: WorkspaceInfo[];
  projectCount: number;
  storageMb: number;
  lastActive: string | null;
  createdAt: string;
  updatedAt: string;
}


export function UsersView({
  workspaceId,
  embedded = false,
}: {
  workspaceId?: string;
  /**
   * Rendered inside the settings pane, which supplies the page title and the scrolling body.
   * Without this the pane shows two headings and two scroll containers, one inside the other.
   */
  embedded?: boolean;
} = {}) {
  const tt = useTranslations('tooltips');
  const t = useTranslations('admin');
  const roleLabel = useRoleLabel();
  const { dateTime } = useLocalFormat();
  const tc = useTranslations('common');
  const tn = useTranslations('nav');
  const ts = useTranslations('settings');
  // Two tiers on one page, the way the mail settings do it. An owner opening this from their
  // workspace gets the members section; only an instance admin additionally gets every account on
  // the instance, which is what /admin/users has always shown.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [editUser, setEditUser] = useState<UserInfo | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [editForm, setEditForm] = useState({
    displayName: '',
    isAdmin: false,
    active: true,
    studioView: true,
    password: '',
  });
  const [showEditPassword, setShowEditPassword] = useState(false);

  // Create form state
  const [createForm, setCreateForm] = useState({
    email: '',
    password: '',
    displayName: '',
    workspaceAssignment: 'new' as 'new' | 'existing' | 'none',
    workspaceId: '',
  });
  const [showPassword, setShowPassword] = useState(false);

  const [availableWorkspaces, setAvailableWorkspaces] = useState<Array<{ id: string; name: string }>>([]);

  // Workspace grant state (in edit dialog)
  const [grantWorkspaceId, setGrantWorkspaceId] = useState('');
  const [grantRole, setGrantRole] = useState<'owner' | 'editor' | 'viewer'>('editor');
  const [grantingAccess, setGrantingAccess] = useState(false);


  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const externalIdentity = !!process.env.NEXT_PUBLIC_GATEWAY_URL;

  useEffect(() => {
    apiFetch('/api/auth/me')
      .then(res => res.ok ? res.json() : null)
      .then(data => setIsAdmin(data?.user?.isAdmin === true))
      .catch(() => setIsAdmin(false));
  }, []);

  useEffect(() => {
    // The instance list is admin-only, so asking for it as an owner would just be a 403.
    if (isAdmin === true) loadUsers();
    else if (isAdmin === false) setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    if (showCreateDialog || showEditDialog) {
      apiFetch('/api/admin/workspaces')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.workspaces) {
            setAvailableWorkspaces(data.workspaces.map((w: { id: string; name: string }) => ({ id: w.id, name: w.name })));
          }
        })
        .catch(() => {});
    }
  }, [showCreateDialog, showEditDialog]);

  /** Loads the list into state and returns it, or null when it could not be loaded (already reported). */
  const loadUsers = async (): Promise<UserInfo[] | null> => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/users');
      if (res.status === 401) {
        window.location.href = getLoginUrl();
        return null;
      }
      if (!res.ok) throw new Error('Failed to load users');
      const data = await res.json();
      setUsers(data.users);
      return data.users as UserInfo[];
    } catch (err) {
      logger.error('[UsersView] Failed to load users:', err);
      toast.error(t('loadUsersFailed'));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleOpenEdit = (user: UserInfo) => {
    setEditUser(user);
    setEditForm({
      displayName: user.displayName || '',
      isAdmin: user.isAdmin,
      active: user.active,
      studioView: user.studioView,
      password: '',
    });
    setShowEditPassword(false);
    setGrantWorkspaceId('');
    setGrantRole('editor');
    setShowEditDialog(true);
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;
    if (editForm.password && editForm.password.length < 8) {
      toast.error(t('passwordTooShort'));
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        displayName: editForm.displayName || undefined,
        active: editForm.active,
        studioView: editForm.studioView,
      };
      if (editForm.isAdmin !== editUser.isAdmin) {
        body.isAdmin = editForm.isAdmin;
      }
      if (editForm.password) {
        body.password = editForm.password;
      }
      const res = await apiFetch(`/api/admin/users/${editUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('updateUserFailed'));
      }
      toast.success(t('userUpdated'));
      emitViewChanged();
      setShowEditDialog(false);
      setEditUser(null);
      await loadUsers();
    } catch (err) {
      logger.error('[UsersView] Failed to update user:', err);
      toast.error(err instanceof Error ? err.message : t('updateUserFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleChangeRole = async (workspaceId: string, newRole: string) => {
    if (!editUser) return;
    try {
      const res = await apiFetch(`/api/admin/workspaces/${workspaceId}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: editUser.id, role: newRole }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('changeRoleFailed'));
      }
      toast.success(t('roleUpdated'));
      const refreshed = (await loadUsers())?.find(u => u.id === editUser.id);
      if (refreshed) setEditUser(refreshed);
    } catch (err) {
      logger.error('[UsersView] Failed to change role:', err);
      toast.error(err instanceof Error ? err.message : t('changeRoleFailed'));
    }
  };

  const handleRevokeAccess = async (workspaceId: string) => {
    if (!editUser) return;
    try {
      const res = await apiFetch(`/api/admin/workspaces/${workspaceId}/access`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: editUser.id }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('revokeFailed'));
      }
      toast.success(t('accessRevoked'));
      const refreshed = (await loadUsers())?.find(u => u.id === editUser.id);
      if (refreshed) setEditUser(refreshed);
    } catch (err) {
      logger.error('[UsersView] Failed to revoke access:', err);
      toast.error(err instanceof Error ? err.message : t('revokeFailed'));
    }
  };

  const handleGrantAccess = async () => {
    if (!editUser || !grantWorkspaceId) return;
    setGrantingAccess(true);
    try {
      const res = await apiFetch(`/api/admin/workspaces/${grantWorkspaceId}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: editUser.id, role: grantRole }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('grantFailed'));
      }
      toast.success(t('accessGranted'));
      setGrantWorkspaceId('');
      setGrantRole('editor');
      const refreshed = (await loadUsers())?.find(u => u.id === editUser.id);
      if (refreshed) setEditUser(refreshed);
    } catch (err) {
      logger.error('[UsersView] Failed to grant access:', err);
      toast.error(err instanceof Error ? err.message : t('grantFailed'));
    } finally {
      setGrantingAccess(false);
    }
  };

  const handleToggleActive = async (user: UserInfo) => {
    try {
      const res = await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !user.active }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('updateUserFailed'));
      }
      toast.success(user.active ? t('userDeactivated') : t('userReactivated'));
      await loadUsers();
    } catch (err) {
      logger.error('[UsersView] Failed to toggle user status:', err);
      toast.error(err instanceof Error ? err.message : t('updateUserFailed'));
    }
  };

  const handleDelete = async (user: UserInfo) => {
    if (!confirm(t('confirmDeactivate', { email: user.email }))) {
      return;
    }
    try {
      const res = await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('deleteUserFailed'));
      }
      toast.success(t('userDeactivated'));
      await loadUsers();
    } catch (err) {
      logger.error('[UsersView] Failed to delete user:', err);
      toast.error(err instanceof Error ? err.message : t('deleteUserFailed'));
    }
  };

  const handleCreate = async () => {
    if (!createForm.email || !createForm.password) {
      toast.error(t('emailPasswordRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: createForm.email,
          password: createForm.password,
          displayName: createForm.displayName || undefined,
          workspaceAssignment: createForm.workspaceAssignment,
          workspaceId: createForm.workspaceId || undefined,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('createUserFailed'));
      }
      toast.success(t('userCreated'));
      setShowCreateDialog(false);
      setCreateForm({ email: '', password: '', displayName: '', workspaceAssignment: 'new', workspaceId: '' });
      setShowPassword(false);
      await loadUsers();
    } catch (err) {
      logger.error('[UsersView] Failed to create user:', err);
      toast.error(err instanceof Error ? err.message : t('createUserFailed'));
    } finally {
      setSaving(false);
    }
  };

  const filteredUsers = useMemo(() => {
    if (!searchQuery) return users;
    const query = searchQuery.toLowerCase();
    return users.filter(
      user =>
        user.email.toLowerCase().includes(query) ||
        user.displayName?.toLowerCase().includes(query)
    );
  }, [users, searchQuery]);

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

  // Workspaces the edit user does NOT already have access to
  const grantableWorkspaces = useMemo(() => {
    if (!editUser) return [];
    const existingIds = new Set(editUser.workspaces.map(ws => ws.id));
    return availableWorkspaces.filter(ws => !existingIds.has(ws.id));
  }, [editUser, availableWorkspaces]);

  if (!isServerMode) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p>{t('usersServerOnly')}</p>
        </div>
      </div>
    );
  }

  if (isAdmin === null || (isAdmin && loading)) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Spinner size={48} color="#f97316" className="mx-auto" />
          <p className="mt-4">{t('loadingUsers')}</p>
        </div>
      </div>
    );
  }

  // A workspace owner who is not an instance admin: members only, and no instance-wide controls.
  if (!isAdmin) {
    const members = workspaceId ? (
      <WorkspaceMembers workspaceId={workspaceId} />
    ) : (
      <p className="text-sm text-muted-foreground">{t('openWorkspaceForMembers')}</p>
    );

    return embedded ? members : (
      <PageShell>
        <PageHeader title={tn('settings.users')} />
        <PageBody maxWidth="max-w-4xl">{members}</PageBody>
      </PageShell>
    );
  }

  const toolbar = (
    <>
          {!externalIdentity && (
            <div className="flex items-center shrink-0">
              <Button onClick={() => setShowCreateDialog(true)} size="sm" className="gap-2">
                <Plus className="h-4 w-4" />
                <span>{t('newUser')}</span>
              </Button>
            </div>
          )}

          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('searchUsers')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {externalIdentity && (
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">
                {t('usersExternal')}
              </p>
            </div>
          )}
    </>
  );

  const body = (
    <>
            {workspaceId && (
              // Inside the body so it shares its gutters and max width; the table below still fills.
              <div className="shrink-0 mb-4">
                <WorkspaceMembers workspaceId={workspaceId} onMembershipChange={loadUsers} />
              </div>
            )}
            {filteredUsers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Users className="h-16 w-16 text-muted-foreground mb-4" />
                {users.length === 0 ? (
                  <>
                    <h2 className="text-xl font-semibold mb-2">{t('noUsersYet')}</h2>
                    <p className="text-muted-foreground mb-4 max-w-md">
                      {t('createFirstUser')}
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="text-xl font-semibold mb-2">{t('noUsersFound')}</h2>
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
                      <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none w-full">{tc('labels.user')}</th>
                      <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('terms.projects')}</th>
                      <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('storage')}</th>
                      <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('terms.workspaces')}</th>
                      <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('labels.active')}</th>
                      <th className="bg-muted p-[6px_10px] border-b select-none"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => (
                          <tr
                            key={user.id}
                            className="border-b border-border/50 hover:bg-muted/50 cursor-pointer h-[44px]"
                            onClick={() => handleOpenEdit(user)}
                          >
                            <td className="w-full p-[4px_10px] text-[13px] align-middle overflow-hidden" style={{ maxWidth: 0 }}>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-medium text-foreground text-[13px] truncate">{user.email}</span>
                                  {user.isAdmin && <Badge variant="destructive" className="text-[10px] shrink-0">admin</Badge>}
                                  {!user.active && <Badge variant="outline" className="text-[10px] shrink-0 text-muted-foreground">inactive</Badge>}
                                </div>
                                {user.displayName && <span className="block text-[11px] text-muted-foreground truncate">{user.displayName}</span>}
                              </div>
                            </td>
                            <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap tabular-nums">{user.projectCount}</td>
                            <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap tabular-nums">{t('storageUsedMb', { mb: user.storageMb })}</td>
                            <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap tabular-nums">{user.workspaces.length}</td>
                            <td className="@max-5xl:hidden p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap">{user.lastActive ? formatDate(user.lastActive) : formatDate(user.createdAt)}</td>
                            <td className="p-[4px_10px] align-middle whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="xs" className="px-1">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => handleOpenEdit(user)}>
                                    <Pencil className="h-4 w-4 mr-2" />
                                    {tc('actions.edit')}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleToggleActive(user)}>
                                    {user.active ? (
                                      <>
                                        <UserX className="h-4 w-4 mr-2" />
                                        {t('deactivate')}
                                      </>
                                    ) : (
                                      <>
                                        <UserCheck className="h-4 w-4 mr-2" />
                                        {t('reactivate')}
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleDelete(user)}
                                    className="text-destructive focus:text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    {tc('actions.delete')}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
    </>
  );

  // Embedded in the settings pane, which already supplies the title and the scrolling body. Two
  // shells nested would mean two headings and two scroll containers.
  const page = embedded ? (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="flex items-center gap-3 shrink-0">{toolbar}</div>
      <div className="flex-1 min-h-0 flex flex-col">{body}</div>
    </div>
  ) : (
    <PageShell>
      <PageHeader title={tn('settings.users')}>{toolbar}</PageHeader>
      <PageBody fill>{body}</PageBody>
    </PageShell>
  );

  return (
    <>
      {page}

      {/* Edit User Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(open) => { setShowEditDialog(open); if (!open) setEditUser(null); }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('editUser')}</DialogTitle>
            <DialogDescription>{editUser?.email}</DialogDescription>
          </DialogHeader>

          {/* The table hides these columns on a narrow window, so this is where they stay reachable. */}
          {editUser && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground -mt-1">
              <span>{tc('terms.projects')}{' '}<span className="text-foreground tabular-nums">{editUser.projectCount}</span></span>
              <span>{t('storage')}{' '}<span className="text-foreground tabular-nums">{t('storageUsedMb', { mb: editUser.storageMb })}</span></span>
              <span>
                {tc('labels.active')}{' '}
                <span className="text-foreground">
                  {editUser.lastActive ? formatDate(editUser.lastActive) : formatDate(editUser.createdAt)}
                </span>
              </span>
            </div>
          )}

          <div className="space-y-4 py-2">
            <Section>
              <SectionHeader title={tc('labels.account')} />
              <SectionBody className="py-0">
                <SettingRow title={tc('labels.displayName')}>
                  <Input
                    id="edit-displayName"
                    value={editForm.displayName}
                    onChange={(e) => setEditForm(f => ({ ...f, displayName: e.target.value }))}
                    placeholder={t('optional')}
                    className="w-[220px]"
                  />
                </SettingRow>

                <SettingRow
                  title={t('opensIn')}
                  description={t('interfaceNote')}
                >
                  <Select
                    value={editForm.studioView ? 'studio' : 'simple'}
                    onValueChange={(v) => setEditForm(f => ({ ...f, studioView: v === 'studio' }))}
                  >
                    <SelectTrigger size="sm" className="w-[120px]" aria-label={t('opensIn')}>
                      <span className="text-xs">{editForm.studioView ? ts('studio') : t('simpleView')}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="studio">{ts('studio')}</SelectItem>
                      <SelectItem value="simple">{t('simpleView')}</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>

                <SettingRow
                  title={tt('instanceAdmin')}
                  description={t('adminNote')}
                >
                  <Switch
                    id="edit-admin"
                    checked={editForm.isAdmin}
                    onCheckedChange={(checked) => setEditForm(f => ({ ...f, isAdmin: checked }))}
                  />
                </SettingRow>

                <SettingRow title={tc('labels.active')} description={t('inactiveNote')}>
                  <Switch
                    id="edit-active"
                    checked={editForm.active}
                    onCheckedChange={(checked) => setEditForm(f => ({ ...f, active: checked }))}
                  />
                </SettingRow>
              </SectionBody>
            </Section>

            {!externalIdentity && (
              <Section>
                <SectionHeader title={tc('labels.password')}>
                  <button
                    type="button"
                    className="text-xs text-primary hover:text-primary/80 transition-colors"
                    onClick={() => {
                      const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
                      let pw = '';
                      const rng = new Uint32Array(16); crypto.getRandomValues(rng);
                      for (let i = 0; i < 16; i++) pw += chars[rng[i] % chars.length];
                      setEditForm(f => ({ ...f, password: pw }));
                      setShowEditPassword(true);
                    }}
                  >
                    {tc('actions.generate')}
                  </button>
                </SectionHeader>
                <SectionBody>
                  <div className="relative">
                    <Input
                      id="edit-password"
                      type={showEditPassword ? 'text' : 'password'}
                      value={editForm.password}
                      onChange={(e) => setEditForm(f => ({ ...f, password: e.target.value }))}
                      placeholder={t('leaveBlankPassword')}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowEditPassword(!showEditPassword)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showEditPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {editForm.password && editForm.password.length > 0 && editForm.password.length < 8 && (
                    <p className="text-xs text-destructive mt-1.5">{t('minEightChars')}</p>
                  )}
                </SectionBody>
              </Section>
            )}

            <Section>
              <SectionHeader title={t('workspacesCount', { count: editUser?.workspaces.length ?? 0 })}>
                {/* These apply as they are changed, unlike the fields above, so the header says so. */}
                <span className="text-[11px] text-muted-foreground">{t('appliedImmediately')}</span>
              </SectionHeader>
              <SectionBody className="space-y-2">
                {editUser && editUser.workspaces.length > 0 ? (
                  editUser.workspaces.map((ws) => (
                    <div key={ws.id} className="flex items-center gap-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <span className="block truncate">{ws.name}</span>
                        <span className="block text-[11px] text-muted-foreground truncate">
                          {t('workspaceSummary', { projects: ws.max_projects, deployments: ws.max_deployments, created: formatDate(ws.created_at) })}
                        </span>
                      </div>
                      <Select value={ws.role} onValueChange={(value) => handleChangeRole(ws.id, value)}>
                        <SelectTrigger size="sm" className="w-[92px]" aria-label={t('roleIn', { name: ws.name })}>
                          <span className="text-xs">{roleLabel(ws.role)}</span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="editor">{t('roleEditor')}</SelectItem>
                          <SelectItem value="owner">{t('roleOwner')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost" size="sm" className="px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRevokeAccess(ws.id)}
                        aria-label={t('removeFrom', { name: ws.name })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">{t('notInAnyWorkspace')}</p>
                )}

                {grantableWorkspaces.length > 0 && (
                  <div className="flex items-center gap-2 border-t border-border pt-2">
                    <Select value={grantWorkspaceId} onValueChange={setGrantWorkspaceId}>
                      <SelectTrigger size="sm" className="flex-1 min-w-0" aria-label={t('addToWorkspace')}>
                        <span className="text-xs truncate">
                          {grantableWorkspaces.find(w => w.id === grantWorkspaceId)?.name ?? (
                            <span className="text-muted-foreground">{t('addToWorkspaceEllipsis')}</span>
                          )}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {grantableWorkspaces.map(ws => (
                          <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={grantRole} onValueChange={(v) => setGrantRole(v as 'owner' | 'editor' | 'viewer')}>
                      <SelectTrigger size="sm" className="w-[92px]" aria-label={t('roleToGrant')}>
                        <span className="text-xs">{roleLabel(grantRole)}</span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="editor">{t('roleEditor')}</SelectItem>
                        <SelectItem value="owner">{t('roleOwner')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm" variant="outline" className="shrink-0"
                      disabled={!grantWorkspaceId || grantingAccess}
                      onClick={handleGrantAccess}
                    >
                      {grantingAccess ? '…' : t('add')}
                    </Button>
                  </div>
                )}
              </SectionBody>
            </Section>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowEditDialog(false); setEditUser(null); }}>{tc('actions.cancel')}</Button>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving ? tc('actions.saving') : t('saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create User Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('createUser')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="create-email">{tc('labels.email')}</Label>
              <Input
                id="create-email"
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm(f => ({ ...f, email: e.target.value }))}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="create-password">{tc('labels.password')}</Label>
                <button
                  type="button"
                  className="text-xs text-primary hover:text-primary/80 transition-colors"
                  onClick={() => {
                    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
                    let pw = '';
                    const rng = new Uint32Array(16); crypto.getRandomValues(rng);
                    for (let i = 0; i < 16; i++) pw += chars[rng[i] % chars.length];
                    setCreateForm(f => ({ ...f, password: pw }));
                    setShowPassword(true);
                  }}
                >
                  {tc('actions.generate')}
                </button>
              </div>
              <div className="relative">
                <Input
                  id="create-password"
                  type={showPassword ? 'text' : 'password'}
                  value={createForm.password}
                  onChange={(e) => setCreateForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={t('minEightChars')}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-displayName">{tc('labels.displayName')}</Label>
              <Input
                id="create-displayName"
                value={createForm.displayName}
                onChange={(e) => setCreateForm(f => ({ ...f, displayName: e.target.value }))}
                placeholder={t('displayNameOptional')}
              />
            </div>

            {/* Workspace Assignment */}
            <div className="space-y-2">
              <Label>{tc('labels.workspace')}</Label>
              <Select
                value={createForm.workspaceAssignment}
                onValueChange={(value) => setCreateForm(f => ({
                  ...f,
                  workspaceAssignment: value as 'new' | 'existing' | 'none',
                  workspaceId: '',
                }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">{t('createNewWorkspace')}</SelectItem>
                  <SelectItem value="existing">{t('assignExistingWorkspace')}</SelectItem>
                  <SelectItem value="none">{t('noWorkspace')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {createForm.workspaceAssignment === 'existing' && (
              <div className="space-y-2">
                <Label>{t('selectWorkspace')}</Label>
                <Select
                  value={createForm.workspaceId}
                  onValueChange={(value) => setCreateForm(f => ({ ...f, workspaceId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('chooseWorkspace')} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableWorkspaces.map(ws => (
                      <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>{tc('actions.cancel')}</Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? t('creating') : t('createUser')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
