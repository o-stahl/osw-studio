import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { forgetAccountToken, getAccountToken } from '@/lib/inference/account-token';
import { allowanceFromServer, freeAllowanceOffered, inferenceBaseUrl } from '@/lib/inference/allowance';
import { trialAvailable } from '@/lib/inference/trial';
import { trialSessionsLeftToday } from '@/lib/inference/trial/caps';

/**
 * Whether the free allowance can be used now, for the app's connection status
 * (lib/inference/allowance-status.ts). On the demo: this server can run the trial (lib/inference/trial)
 * and the inference server answers. On a hosted instance: the gateway issues the signed-in user's token
 * and the inference server accepts it. Answers are kept for a short while, so many visitors make few
 * checks.
 */

export const dynamic = 'force-dynamic';

type Reason = 'config' | 'limit' | 'gateway' | 'server' | 'token';
interface Status {
  available: boolean;
  reason?: Reason;
}

const KEEP_MS = 30_000;
const TIMEOUT_MS = 5_000;

const kept = new Map<string, { at: number; status: Status }>();
const pending = new Map<string, Promise<Status>>();

async function demoStatus(): Promise<Status> {
  const [configured, answering] = await Promise.all([
    trialAvailable(),
    // The API base ends in /v1; the health check sits at the server's root.
    fetch(`${inferenceBaseUrl().replace(/\/v1$/, '')}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then((res) => res.ok)
      .catch(() => false),
  ]);
  if (!configured) return { available: false, reason: 'config' };
  // The day's sessions all taken: nobody new gets one until the next UTC day.
  if (trialSessionsLeftToday() === 0) return { available: false, reason: 'limit' };
  if (!answering) return { available: false, reason: 'server' };
  return { available: true };
}

async function hostedStatus(userId: string): Promise<Status> {
  const issued = await getAccountToken(userId);
  if (!issued) return { available: false, reason: 'gateway' };
  try {
    const res = await fetch(`${inferenceBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${issued.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { available: true };
    if (res.status !== 401) return { available: false, reason: 'server' };
    forgetAccountToken(userId, issued.token);
    return { available: false, reason: 'token' };
  } catch {
    return { available: false, reason: 'server' };
  }
}

/** The kept answer for `key` while it is recent, else one check, shared by concurrent callers. */
async function statusFor(key: string, check: () => Promise<Status>): Promise<Status> {
  const now = Date.now();
  const answer = kept.get(key);
  if (answer && now - answer.at < KEEP_MS) return answer.status;
  let request = pending.get(key);
  if (!request) {
    request = check().finally(() => pending.delete(key));
    pending.set(key, request);
  }
  const status = await request;
  for (const [k, v] of kept) if (now - v.at >= KEEP_MS) kept.delete(k);
  kept.set(key, { at: Date.now(), status });
  return status;
}

export async function GET() {
  const noStore = { 'Cache-Control': 'no-store' };
  if (!freeAllowanceOffered()) {
    return NextResponse.json({ available: false }, { status: 404, headers: noStore });
  }
  if (!allowanceFromServer()) {
    return NextResponse.json(await statusFor('demo', demoStatus), { headers: noStore });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ available: false }, { status: 401, headers: noStore });
  return NextResponse.json(await statusFor(`user:${session.userId}`, () => hostedStatus(session.userId)), { headers: noStore });
}
