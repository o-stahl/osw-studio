import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { answerSelectionRequest, sanitizeSelectionAnswer } from '@/lib/server-generate/render-requests';

/** One tab's answer to `selection_requested`: what it has selected, or nothing. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let requestId: unknown, selection: unknown;
  try {
    ({ requestId, selection } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof requestId !== 'string' || !requestId) return NextResponse.json({ error: 'requestId is required' }, { status: 400 });

  if (!answerSelectionRequest(requestId, session.userId, sanitizeSelectionAnswer(selection))) {
    return NextResponse.json({ error: 'Unknown or expired request' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
