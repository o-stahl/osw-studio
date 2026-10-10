/**
 * The public URL of a deployment, resolved server-side.
 *
 * Wraps `resolveDeploymentServing` so the API and the static builder answer the same question the
 * same way. Issue #14 was this logic drifting inside the builder; the UI then kept its own copy and
 * drifted again, which is why nothing client-side may compute this.
 */
import { resolveDeploymentServing } from '@/lib/compiler/deployment-paths';
import { appUrl, sitesOrigin } from '@/lib/web/site-origin';

export function deploymentPublicUrl(
  deployment: { id: string; slug?: string; customDomain?: string }
): string {
  return resolveDeploymentServing(deployment, deployment.id, {
    staticProxyEnabled: process.env.STATIC_PROXY === 'true',
    appUrl: appUrl(),
    sitesOrigin: sitesOrigin(),
  }).baseUrl;
}

/** Attach `publicUrl` to a deployment on its way out of an API route. */
export function withPublicUrl<T extends { id: string; slug?: string; customDomain?: string }>(
  deployment: T
): T & { publicUrl: string } {
  return { ...deployment, publicUrl: deploymentPublicUrl(deployment) };
}
