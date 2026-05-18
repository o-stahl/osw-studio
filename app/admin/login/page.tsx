'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';

export default function LoginPage() {
  const router = useRouter();
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
        setError(data.error || 'Login failed');
        setIsLoading(false);
        return;
      }

      // Login successful - redirect to workspace or admin area
      if (data.defaultWorkspaceId) {
        document.cookie = `osw_workspace=${data.defaultWorkspaceId};path=/;max-age=${60 * 60 * 24 * 365}`;
        if (data.defaultWorkspaceName) localStorage.setItem('osw-workspace-name', data.defaultWorkspaceName);
        router.push(`/w/${data.defaultWorkspaceId}/projects`);
      } else {
        router.push('/admin');
      }
    } catch {
      setError('An error occurred. Please try again.');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4 animate-fadeIn">
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
        <p className="text-muted-foreground mb-8">Sign in to your account</p>

        {checkingSetup && (
          <div className="py-8 text-muted-foreground text-sm">Checking setup...</div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4" style={checkingSetup ? { display: 'none' } : undefined}>
          <div className="text-left">
            <label htmlFor="email" className="block text-sm font-medium text-muted-foreground mb-2">
              Email
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
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-all"
              placeholder="Enter your password"
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
            {isLoading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        {showRegisterLink && (
          <p className="mt-6 text-sm text-muted-foreground">
            Don&apos;t have an account?{' '}
            <Link href="/admin/register" className="text-orange-500 hover:text-orange-400 transition-colors">
              Create one
            </Link>
          </p>
        )}

        {/* Footer */}
        <div className="mt-12 pt-6 border-t border-border flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>Powered by</span>
          <Logo width={20} height={20} className="opacity-80" />
          <span>OSW Studio</span>
        </div>
      </div>
    </div>
  );
}
