import { useTranslations } from 'next-intl';

/** A workspace role as the admin views word it; an unknown role is shown as stored. */
export function useRoleLabel(): (role: string) => string {
  const t = useTranslations('admin');
  return (role) =>
    role === 'owner' ? t('roleOwner') : role === 'editor' ? t('roleEditor') : role === 'viewer' ? t('roleViewer') : role;
}
