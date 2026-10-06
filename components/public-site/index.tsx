'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Spinner } from '@/components/ui/spinner';

interface PublicDeploymentProps {
  projectId?: string;
}

export function PublicDeployment({ projectId }: PublicDeploymentProps) {
  const tt = useTranslations('tooltips');
  const tps = useTranslations('publicSite');
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDeployment() {
      try {
        // Fetch the published project's index.html
        const url = projectId
          ? `/api/deployments/${projectId}/index.html`
          : '/api/deployments/published/index.html';

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(tps('notFound'));
        }

        const content = await response.text();
        setHtml(content);
      } catch (err) {
        setError(err instanceof Error ? err.message : tps('loadFailed'));
      } finally {
        setLoading(false);
      }
    }

    loadDeployment();
  }, [projectId, tps]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <Spinner size={48} className="mx-auto mb-4 text-gray-900 dark:text-gray-100" />
          <p className="text-gray-600 dark:text-gray-400">{tps('loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center max-w-md px-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            {tps('noneTitle')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {error}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-500">
            {tps.rich('goToAdmin', { link: (chunks) => <a href="/admin" className="text-blue-600 hover:underline">{chunks}</a> })}
          </p>
        </div>
      </div>
    );
  }

  // Render the HTML in an iframe for isolation
  return (
    <iframe
      srcDoc={html}
      title={tt('publishedDeployment')}
      className="w-full h-screen border-0"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  );
}
