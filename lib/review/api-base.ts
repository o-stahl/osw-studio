/**
 * Where review comment traffic is addressed.
 *
 * These endpoints have to stay under the review copy's own prefix. The participant cookie is scoped
 * to `path=/review/{deploymentId}` (lib/review/session.ts), so a browser sends it nowhere else, and
 * the same endpoints under `/api` would receive every client write anonymous.
 *
 * `osw-api` rather than `_osw`: Next keeps directories starting with `_` out of the router.
 */
export function reviewApiBase(deploymentId: string): string {
  return `/review/${encodeURIComponent(deploymentId)}/osw-api`;
}

/**
 * Sent by the studio's review panel, which only ever speaks as the team. Without it, a request whose
 * account session has expired falls through to a participant cookie this browser may also hold, and
 * a team reply would be posted as that client.
 */
export const REVIEW_AS_TEAM_HEADER = 'X-OSW-Review-As';
