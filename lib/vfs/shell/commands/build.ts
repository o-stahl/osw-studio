import type { ShellEnv, ShellResult } from '../types';
import { drainCompileErrors, formatCompileErrors } from '@/lib/preview/compile-errors';

/** `build` — compile the project and report errors. */
export async function buildCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, ctx } = env;

  if (typeof window === 'undefined' && ctx?.onBuildRequested) {
    try {
      const result = await ctx.onBuildRequested();
      if (result.deferred) {
        return {
          stdout: '',
          stderr: 'build: not run. The build compiles in an open OSW Studio tab, and none answered within 30 seconds, so the project was not checked. This says nothing about errors in your files.',
          exitCode: 1,
        };
      }
      if (result.success) {
        return { stdout: 'Build successful — 0 errors', stderr: '', exitCode: 0 };
      }
      const stderr = (result.errors || ['Build failed']).join('\n');
      return { stdout: '', stderr, exitCode: 1 };
    } catch (err: any) {
      return { stdout: '', stderr: `Build failed: ${err.message}`, exitCode: 1 };
    }
  }

  if (typeof window === 'undefined') {
    return {
      stdout: '',
      stderr: 'Error: build requires the browser runtime (esbuild-wasm). This command is not available during server-side generation without a connected browser session.',
      exitCode: 1,
    };
  }

  try {
    const { VirtualServer } = await import('@/lib/preview/virtual-server');
    const buildProject = await vfs.getProject(projectId);
    const server = new VirtualServer(vfs, projectId, { runtime: buildProject?.settings?.runtime });
    await server.compileProject();
    server.cleanupBlobUrls();

    const compileErrors = drainCompileErrors();
    if (compileErrors.length === 0) {
      return { stdout: 'Build successful — 0 errors', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: formatCompileErrors(compileErrors), exitCode: 1 };
  } catch (err: any) {
    return { stdout: '', stderr: `Build failed: ${err.message}`, exitCode: 1 };
  }
}
