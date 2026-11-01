import { NextRequest, NextResponse } from 'next/server';
import { isDemo } from '@/lib/demo';
import { issueTrialSession, trialClientAddress, trialRequestHostname, trialResponse, trialSetup } from '@/lib/inference/trial';

/**
 * The demo's trial sessions for the free allowance (lib/inference/trial): GET says what the page needs
 * to render the bot check; POST exchanges a solved check for a session cookie. On the demo only.
 */

export const dynamic = 'force-dynamic';

const notHere = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function GET() {
  if (!isDemo()) return notHere();
  return trialResponse(await trialSetup());
}

export async function POST(request: NextRequest) {
  if (!isDemo()) return notHere();
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Answered as a bad request.
  }
  return trialResponse(await issueTrialSession({ ip: trialClientAddress(request.headers), hostname: trialRequestHostname(request.headers), body }));
}
