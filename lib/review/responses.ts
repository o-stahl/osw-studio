import { NextResponse } from 'next/server';

/** A review copy and its API are private: nothing between here and the client may cache them. */
export const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** A request that asked to act as the team and may not (`teamAccessRefusal`). */
export function teamRefused(status: 401 | 403): NextResponse {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden' },
    { status, headers: PRIVATE_HEADERS }
  );
}
