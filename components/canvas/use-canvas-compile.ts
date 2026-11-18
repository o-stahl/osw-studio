'use client';

import { useEffect, useRef, useState } from 'react';
import { vfs } from '@/lib/vfs';
import type { ProjectRuntime } from '@/lib/vfs/types';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { compileForCanvas, pageForPath, type CanvasProject } from '@/lib/canvas/project-compile';

/**
 * Canvas's own compile of the project: with provenance where elements can be traced to source, and
 * with every stylesheet's `vh` pinned to the device height (`lib/canvas/viewport-units.ts`), so an
 * artboard as tall as its page does not grow a screen-sized hero with it. Compiles again on the
 * events Live Preview compiles on; silent writes (the Styles tab's `/overrides.css`) are not among
 * them, and reach the artboards as style previews instead. While Canvas is off screen (`active`
 * false) nothing compiles; a change made meanwhile compiles when it comes back.
 */
export function useCanvasCompile(projectId: string, runtime: ProjectRuntime, enabled: boolean, active: boolean): {
  project: CanvasProject | null;
  error: string | null;
  compiling: boolean;
} {
  const [project, setProject] = useState<CanvasProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const workspaceReady = useWorkspaceStore((s) => s.workspaceReady);
  const refreshTrigger = useWorkspaceStore((s) => s.refreshTrigger);
  /** Revokes the blob URLs of the compile on show. */
  const disposeRef = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const [bump, setBump] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** Something changed while Canvas was off screen. */
  const staleRef = useRef(false);
  const compiledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (!activeRef.current) { staleRef.current = true; return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setBump((n) => n + 1), 250);
    };
    const onContent = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail || detail.projectId === projectId) soon();
    };
    window.addEventListener('filesChanged', soon);
    window.addEventListener('fileContentChanged', onContent);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('filesChanged', soon);
      window.removeEventListener('fileContentChanged', onContent);
    };
  }, [enabled, projectId]);

  // Back on screen after a change it did not compile for.
  useEffect(() => {
    if (active && staleRef.current) { staleRef.current = false; setBump((n) => n + 1); }
  }, [active]);

  useEffect(() => {
    if (!enabled || !workspaceReady) return;
    // Off screen, a compile waits; the first one waits too, until Canvas is first shown.
    const reason = `${projectId}|${runtime}|${bump}|${refreshTrigger}`;
    if (!activeRef.current) { if (compiledFor.current !== reason) staleRef.current = true; return; }
    compiledFor.current = reason;
    const gen = ++generation.current;
    let cancelled = false;
    setCompiling(true);
    (async () => {
      try {
        await vfs.init();
        const { project: next, dispose } = await compileForCanvas(vfs, projectId, runtime);
        if (cancelled || gen !== generation.current) { dispose(); return; }
        disposeRef.current?.();
        disposeRef.current = dispose;
        setProject(next);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && gen === generation.current) setCompiling(false);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, workspaceReady, projectId, runtime, bump, refreshTrigger]);

  useEffect(() => () => { disposeRef.current?.(); }, []);

  return { project, error, compiling };
}

export { pageForPath };
