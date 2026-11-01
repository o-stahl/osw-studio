'use client';

import { useEffect } from 'react';

import { BRIDGE_PATH } from '@/lib/demo-bridge/protocol';
import { writeDemoProjectCount } from '@/lib/demo-bridge/project-count';
import { isEmbedded } from '@/lib/web/embedded';

/**
 * Keeps the demo's project count (`lib/demo-bridge/project-count.ts`) current: on load, shortly after
 * files change (a new project writes its files), and when the tab is hidden, as it is when the
 * visitor opens the sign-up page. Never from inside a frame: there, in Safari, the bridge sees no
 * projects and would write over the real count.
 */
export function DemoProjectCount() {
  useEffect(() => {
    if (isEmbedded() || window.location.pathname === BRIDGE_PATH) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const update = async () => {
      try {
        const { vfs } = await import('@/lib/vfs');
        await vfs.init();
        const projects = await vfs.listProjects();
        if (!stopped) writeDemoProjectCount(projects.length);
      } catch {
        // Written again on the next change or visit.
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void update(), 1000);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void update();
    };

    void update();
    window.addEventListener('filesChanged', soon);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('filesChanged', soon);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return null;
}
