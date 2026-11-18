import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { sanitizeRenderResult, settleRenderRequest } from '@/lib/server-generate/render-requests';

/** The claiming tab's render: the inspect report or the screenshot's images, or why there are none. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let requestId: unknown, result: unknown;
  try {
    ({ requestId, result } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof requestId !== 'string' || !requestId) return NextResponse.json({ error: 'requestId is required' }, { status: 400 });

  if (!settleRenderRequest(requestId, session.userId, sanitizeRenderResult(result))) {
    return NextResponse.json({ error: 'Unknown or expired request' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
