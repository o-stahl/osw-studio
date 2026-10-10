'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { LanguagePill } from '@/components/language-menu';
import { writeWorkspaceCookie } from '@/lib/web/workspace-cookie';

export default function RegisterPage() {
  const tc = useTranslations('common');
  const t = useTranslations('auth');
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSetup, setIsSetup] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    fetch('/api/auth/setup-status')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.needsSetup) setIsSetup(true);
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password, displayName: displayName || undefined }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t('registrationFailed'));
        setIsLoading(false);
        return;
      }

      // Registration successful - redirect to workspace or admin area
      if (data.defaultWorkspaceId) {
        writeWorkspaceCookie(data.defaultWorkspaceId);
        if (data.defaultWorkspaceName) localStorage.setItem('osw-workspace-name', data.defaultWorkspaceName);
        router.push(`/w/${data.defaultWorkspaceId}/projects`);
      } else {
        router.push('/admin');
      }
    } catch (err) {
      setError(t('genericError'));
      // Error details intentionally not logged to client console
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
        <h1 className="text-3xl font-semibold mb-2 tracking-tight">
          {isSetup ? t('setupTitle') : t('createAccountTitle')}
        </h1>
        <p className="text-muted-foreground mb-8">
          {isSetup ? t('setupSubtitle') : t('joinSubtitle')}
        </p>

        {/* Register Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
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
              required
              autoFocus
            />
          </div>

          <div className="text-left">
            <label htmlFor="displayName" className="block text-sm font-medium text-muted-foreground mb-2">
              {tc('labels.displayName')} <span className="text-muted-foreground/70">{tc('labels.optionalParen')}</span>
            </label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-4 py-3 bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all"
              placeholder={t('yourName')}
            />
          </div>

          <div className="text-left">
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="password" className="text-sm font-medium text-muted-foreground">
                {tc('labels.password')}
              </label>
              <button
                type="button"
                className="text-xs text-orange-500 hover:text-orange-400 transition-colors"
                onClick={() => {
                  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
                  let pw = '';
                  const rng = new Uint32Array(16); crypto.getRandomValues(rng);
                  for (let i = 0; i < 16; i++) pw += chars[rng[i] % chars.length];
                  setPassword(pw);
                  setShowPassword(true);
                }}
              >
                {tc('actions.generate')}
              </button>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 pr-11 bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all"
                placeholder={t('atLeastEight')}
                required
                minLength={8}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
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
            {isLoading ? t('creatingAccount') : t('createAccount')}
          </button>
        </form>

        {!isSetup && (
          <p className="mt-6 text-sm text-muted-foreground">
            {t('haveAccount')}{' '}
            <Link href="/admin/login" className="text-orange-500 hover:text-orange-400 transition-colors">
              {t('signInLink')}
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
