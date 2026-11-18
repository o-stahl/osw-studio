import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth/system-database', () => ({
  getWorkspaceById: (id: string) => (id === 'ws' ? { id, max_projects: 2 } : null),
}));

import { projectLimitRefusal } from '../project-quota';

/**
 * The project limit is counted on every push of a new project and every MCP `projects_create`, so
 * the count must not read each project's row whole: those rows carry a base64 thumbnail each.
 */
describe('projectLimitRefusal', () => {
  it('counts the projects from their summaries, without reading every column of every row', async () => {
    const listProjects = vi.fn(async () => [{}, {}]);
    const summaries = [{ id: 'a' }, { id: 'b' }];
    const adapter = { listProjects, listProjectSummaries: vi.fn(() => summaries) };
    expect(await projectLimitRefusal(adapter, 'ws')).toBe('Project limit reached (2).');
    summaries.pop();
    expect(await projectLimitRefusal(adapter, 'ws')).toBeNull();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('has no limit for a workspace the system database does not know', async () => {
    const adapter = { listProjectSummaries: vi.fn(() => [{ id: 'a' }, { id: 'b' }, { id: 'c' }]) };
    expect(await projectLimitRefusal(adapter, 'elsewhere')).toBeNull();
  });
});
