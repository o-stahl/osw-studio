/**
 * Workspace-Scoped Deployments API
 *
 * GET - List all deployments
 * POST - Create a new deployment
 */

import { logger } from '@/lib/utils';
import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/api/workspace-context';
import { ensureDeploymentRoute } from '@/lib/auth/system-database';
import { Deployment } from '@/lib/vfs/types';
import { withPublicUrl } from '@/lib/api/deployment-url';
import { toPublicDeployment } from '@/lib/api/deployment-public';
import { v4 as uuidv4 } from 'uuid';
import { openThreadCounts } from '@/lib/review/open-thread-counts';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params, 'viewer');

    const deployments = await adapter.listDeployments?.() || [];

    // Attached here rather than fetched separately: it is one indexed count per review-enabled
    // deployment, and a second round trip per row would cost more than the counts do.
    const openThreads = openThreadCounts(deployments);

    // Asked of the server, not the browser: a project another device has not pulled yet is not gone.
    const missing = new Set<string>();
    for (const projectId of new Set(deployments.map((d) => d.projectId))) {
      if (!(await adapter.getProject(projectId))) missing.add(projectId);
    }

    return NextResponse.json(
      deployments.map(d => ({
        ...toPublicDeployment(withPublicUrl(d)),
        openReviewThreads: openThreads[d.id],
        ...(missing.has(d.projectId) ? { projectMissing: true } : {}),
      }))
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    logger.error('[Deployments API] Error listing deployments:', error);
    return NextResponse.json(
      { error: 'Failed to list deployments' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { adapter, workspaceId } = await getWorkspaceContext(params);

    const body = await request.json();
    const { projectId, name, slug } = body;

    if (!projectId || !name) {
      return NextResponse.json(
        { error: 'projectId and name are required' },
        { status: 400 }
      );
    }

    // Check if project exists
    const project = await adapter.getProject(projectId);
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    // Create new deployment
    const deployment: Deployment = {
      id: uuidv4(),
      projectId,
      name,
      slug: slug || undefined,
      underConstruction: false,
      headScripts: [],
      bodyScripts: [],
      cdnLinks: [],
      analytics: {
        enabled: false,
        provider: 'builtin',
        privacyMode: true,
      },
      seo: {},
      compliance: {
        enabled: false,
        bannerPosition: 'bottom' as const,
        bannerStyle: 'bar' as const,
        message: '',
        acceptButtonText: 'Accept',
        declineButtonText: 'Decline',
        mode: 'opt-in' as const,
        blockAnalytics: true,
      },
      settingsVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (adapter.createDeployment) {
      await adapter.createDeployment(deployment);
    }

    // Register the routing row now rather than only on publish, so routes addressed by deployment
    // id alone (analytics, edge functions, the scheduler) can find the owning workspace database
    // from the moment the deployment exists. Never overwrites an existing slug or custom domain.
    try {
      ensureDeploymentRoute(deployment.id, workspaceId);
    } catch (routeError) {
      logger.warn('[Deployments API] Failed to register deployment route:', routeError);
    }

    return NextResponse.json(toPublicDeployment(deployment), { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    logger.error('[Deployments API] Error creating deployment:', error);
    return NextResponse.json(
      { error: 'Failed to create deployment' },
      { status: 500 }
    );
  }
}
