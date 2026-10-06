'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

export default function AdminPage() {
  const t = useTranslations('auth');
  const router = useRouter();

  useEffect(() => {
    // Middleware handles workspace redirect for authenticated users.
    // If we reach here, redirect to login.
    router.push('/admin/login');
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
      <p className="text-zinc-400">{t('redirecting')}</p>
    </div>
  );
}
