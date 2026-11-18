import { getWorkspaceById } from '@/lib/auth/system-database';

/**
 * A workspace's project limit (`max_projects`), checked wherever the server creates a project: the
 * sync routes (`sync/projects/[id]`, which every push reaches with its first batch, and the
 * project-only `sync/projects`) and MCP `projects_create`. Call it only for a project the server does
 * not have yet: a write to an existing project is never counted against the limit.
 *
 * Counted from the summaries, which leave out each project's thumbnail.
 *
 * @returns the refusal to give when one more project would go past the limit, else null. A workspace
 *   the system database does not know (Browser Mode, a test) has no limit.
 */
export async function projectLimitRefusal(
  adapter: { listProjectSummaries(): readonly unknown[] },
  workspaceId: string,
): Promise<string | null> {
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace) return null;
  const projects = adapter.listProjectSummaries();
  return projects.length >= workspace.max_projects ? `Project limit reached (${workspace.max_projects}).` : null;
}
