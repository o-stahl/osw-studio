import { describe, it, expect } from 'vitest';
import { normalizePath } from '../shell/paths';

/**
 * The shell reads every path through `normalizePath`, redirect targets included, so a path it gets
 * wrong is a file written under the wrong name.
 */
describe('normalizePath', () => {
  it('reads /workspace as the project root', () => {
    expect(normalizePath('/workspace/index.html')).toBe('/index.html');
    expect(normalizePath('/workspace')).toBe('/');
    expect(normalizePath('/workspace/')).toBe('/');
  });

  it('leaves a file whose name only starts with "workspace" as it is', () => {
    for (const p of ['/workspaces.html', '/workspace-booking.html', '/workspace.json']) {
      expect(normalizePath(p)).toBe(p);
    }
  });

  it('reads the current-directory forms from the root', () => {
    expect(normalizePath('.')).toBe('/');
    expect(normalizePath('./a.css')).toBe('/a.css');
    expect(normalizePath('a.css')).toBe('/a.css');
  });
});
