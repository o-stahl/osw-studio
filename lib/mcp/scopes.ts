/**
 * The capabilities an MCP grant can carry, and the workspace role each needs. Kept apart from
 * the store and the server so the consent page can import the list without pulling in
 * server-only modules.
 */

export const MCP_SCOPES = [
  'projects:read',
  'projects:write',
  'agent',
  'deploy',
  'analytics',
  'workspace:admin',
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * The scopes the consent screen offers.
 *
 * `workspace:admin` stays in `MCP_SCOPES` so a token issued before it was withdrawn still
 * validates, but no tool reads it: the member tools it was added for are not built. Offering it
 * would ask for a permission that grants nothing. Move it here when those tools land.
 */
export const ACTIVE_SCOPES: readonly McpScope[] = MCP_SCOPES.filter(
  scope => scope !== 'workspace:admin'
);

export const ROLE_FOR_SCOPE: Record<McpScope, 'owner' | 'editor' | 'viewer'> = {
  'projects:read': 'viewer',
  'projects:write': 'editor',
  agent: 'editor',
  deploy: 'editor',
  analytics: 'editor',
  'workspace:admin': 'owner',
};

const LEVEL: Record<'owner' | 'editor' | 'viewer', number> = { viewer: 1, editor: 2, owner: 3 };

/** The scopes an account holding `role` in a workspace is able to grant. */
export function grantableScopes(role: 'owner' | 'editor' | 'viewer'): McpScope[] {
  return ACTIVE_SCOPES.filter(scope => LEVEL[role] >= LEVEL[ROLE_FOR_SCOPE[scope]]);
}
