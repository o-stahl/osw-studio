/**
 * A path as the shell reads it.
 *
 * Kept apart from the handlers' plumbing in `runtime.ts`, which imports the VFS, so code that only
 * needs to know where a command points, like the step labels in `lib/agent-activity`, can ask the
 * shell's own rule without loading it.
 */
export function normalizePath(p?: string): string | undefined {
  if (!p) return p;
  // `/workspace` is the root, as a whole path segment: `/workspaces.html` is a file of its own.
  if (p === '/workspace' || p.startsWith('/workspace/')) {
    const rest = p.slice('/workspace'.length);
    p = rest.length ? rest : '/';
  }
  // The VFS is rooted at '/' with no working directory, so the current-dir
  // forms ('.', './', './x') resolve relative to root.
  if (p === '.' || p === './') return '/';
  if (p.startsWith('./')) p = p.slice(2);
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}
