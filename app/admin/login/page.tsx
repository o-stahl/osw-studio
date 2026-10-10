'use client';

import { useState, useEffect, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { LanguagePill } from '@/components/language-menu';
import { writeWorkspaceCookie } from '@/lib/web/workspace-cookie';
import { sanitizeRedirect } from '@/lib/auth/safe-redirect';

/**
 * `useSearchParams` opts a client component out of static prerendering, which the production build
 * refuses at a page boundary. The boundary goes here so the page still prerenders and only the form
 * waits for the query string.
 */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const tc = useTranslations('common');
  const t = useTranslations('auth');
  const router = useRouter();
  // Where to land after signing in. Only same-origin paths are honoured, so a crafted link
  // cannot turn the login page into an open redirect.
  const nextParam = useSearchParams().get('next');
  const safeNext = nextParam ? sanitizeRedirect(nextParam) : '/';
  const next = safeNext !== '/' ? safeNext : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showRegisterLink, setShowRegisterLink] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);

  // Check if instance needs setup or registration is open
  useEffect(() => {
    fetch('/api/auth/setup-status')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.needsSetup) {
          // No users exist — redirect to registration
          router.replace('/admin/register');
          return;
        }
        setShowRegisterLink(data?.registrationOpen || false);
        setCheckingSetup(false);
      })
      .catch(() => setCheckingSetup(false));
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const body = email ? { email, password } : { password };
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t('loginFailed'));
        setIsLoading(false);
        return;
      }

      // Login successful - redirect to workspace or admin area
      if (next) {
        if (data.defaultWorkspaceId) {
          writeWorkspaceCookie(data.defaultWorkspaceId);
        }
        router.push(next);
        return;
      }
      if (data.defaultWorkspaceId) {
        writeWorkspaceCookie(data.defaultWorkspaceId);
        if (data.defaultWorkspaceName) localStorage.setItem('osw-workspace-name', data.defaultWorkspaceName);
        router.push(`/w/${data.defaultWorkspaceId}/projects`);
      } else {
        router.push('/admin');
      }
    } catch {
      setError(t('genericError'));
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-background text-foreground flex items-center justify-center p-4 animate-fadeIn">
      <LanguagePill className="absolute top-4 right-4" />
      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.6s ease-in;
        }
        .animate-float {
          animation: float 3s ease-in-out infinite;
        }
      `}</style>

      <div className="max-w-md w-full text-center">
        {/* Logo */}
        <div className="mb-8 animate-float flex justify-center">
          <Logo width={96} height={96} />
        </div>

        {/* Title */}
        <h1 className="text-3xl font-semibold mb-2 tracking-tight">OSW Studio</h1>
        <p className="text-muted-foreground mb-8">{t('signIn')}</p>

        {checkingSetup && (
          <div className="py-8 text-muted-foreground text-sm">{t('checkingSetup')}</div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4" style={checkingSetup ? { display: 'none' } : undefined}>
          <div className="text-left">
            <label htmlFor="email" className="block text-sm font-medium text-muted-foreground mb-2">
              {tc('labels.email')}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all"
              placeholder="you@example.com"
              autoFocus
            />
          </div>

          <div className="text-left">
            <label htmlFor="password" className="block text-sm font-medium text-muted-foreground mb-2">
              {tc('labels.password')}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all"
              placeholder={t('enterPassword')}
              required
            />
          </div>

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/30 text-destructive rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-orange-600 hover:bg-orange-700 text-white font-medium py-3 px-4 rounded-lg transition-colors disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
          >
            {isLoading ? t('loggingIn') : t('login')}
          </button>
        </form>

        {showRegisterLink && (
          <p className="mt-6 text-sm text-muted-foreground">
            {t('noAccount')}{' '}
            <Link href="/admin/register" className="text-orange-500 hover:text-orange-400 transition-colors">
              {t('createOne')}
            </Link>
          </p>
        )}

        {/* Footer */}
        <div className="mt-12 pt-6 border-t border-border flex items-center justify-center gap-2 text-sm text-muted-foreground">
          {t.rich('poweredBy', { logo: () => <Logo width={20} height={20} className="opacity-80" /> })}
        </div>
      </div>
    </div>
  );
}
