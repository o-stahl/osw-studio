import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { claimRenderRequest } from '@/lib/server-generate/render-requests';

/**
 * A tab asking to be the one that renders a page for the server. The request reaches every tab the
 * account has open; the first to claim it renders, the rest leave it.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let requestId: unknown;
  try {
    ({ requestId } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof requestId !== 'string' || !requestId) return NextResponse.json({ error: 'requestId is required' }, { status: 400 });

  return NextResponse.json({ granted: claimRenderRequest(requestId, session.userId) });
}
