/**
 * Workspace-Scoped Project Swap API
 *
 * GET - What changing the deployment's source project does to its backend features. The change
 * itself is a deployment update, and reaches the live site on the next publish.
 */

import { logger } from '@/lib/utils';
import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/api/workspace-context';
import { analyzeProjectSwap } from '@/lib/compiler/project-swap-analyzer';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter, workspaceId } = await getWorkspaceContext(params, 'viewer');
    const { id } = await params;
    const newProjectId = request.nextUrl.searchParams.get('projectId');

    if (!newProjectId) {
      return NextResponse.json(
        { error: 'projectId query parameter is required' },
        { status: 400 }
      );
    }

    const deployment = await adapter.getDeployment?.(id);
    if (!deployment) {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    const project = await adapter.getProject(newProjectId);
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const diff = await analyzeProjectSwap(newProjectId, id, workspaceId);

    return NextResponse.json({
      diff,
      currentProjectId: deployment.projectId,
      newProjectId,
      newProjectName: project.name,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    logger.error('[Swap Project API] Error analyzing swap:', error);
    return NextResponse.json(
      { error: 'Failed to analyze project swap' },
      { status: 500 }
    );
  }
}
