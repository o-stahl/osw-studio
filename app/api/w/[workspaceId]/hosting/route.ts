/**
 * How this install serves published sites (lib/web/site-origin.ts), so the deployments view can say
 * when they share the studio's origin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/api/workspace-context';
import { sitesMode } from '@/lib/web/site-origin';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    await getWorkspaceContext(params, 'viewer');
    return NextResponse.json({ sitesMode: sitesMode() });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
