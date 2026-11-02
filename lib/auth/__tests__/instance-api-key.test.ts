import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { verifyInstanceApiKey } from '@/lib/auth/session';

/**
 * The gateway calls an instance with its API key, and GATEWAY_IPS limits the key to the gateway's
 * addresses, checked against the address the instance's Caddy passes on in X-Forwarded-For
 * (`lib/caddy/regenerate.ts`). A client can send any Cf-Connecting-Ip or X-Real-IP, and Caddy
 * passes those on as they came.
 */

const KEY = 'instance-key-0123456789';
const GATEWAY = '203.0.113.10';
const GATEWAY_V6 = '2001:db8::10';

function call(headers: Record<string, string>, key = KEY) {
  return verifyInstanceApiKey(new NextRequest('https://inst.example/api/w/ws-1/projects', {
    headers: { 'x-instance-api-key': key, ...headers },
  }));
}

beforeEach(() => {
  vi.stubEnv('INSTANCE_API_KEY', KEY);
  vi.stubEnv('GATEWAY_IPS', `${GATEWAY}, ${GATEWAY_V6}`);
});
afterEach(() => vi.unstubAllEnvs());

describe('verifyInstanceApiKey', () => {
  it("accepts the key from a gateway address, as the instance's Caddy reports it", () => {
    expect(call({ 'x-forwarded-for': GATEWAY })).toMatchObject({ userId: 'instance-api', isAdmin: true });
    expect(call({ 'x-forwarded-for': GATEWAY_V6 })).toMatchObject({ userId: 'instance-api' });
  });

  it('refuses the key from any other address, whatever Cf-Connecting-Ip or X-Real-IP claim', () => {
    expect(call({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': GATEWAY })).toBeNull();
    expect(call({ 'x-forwarded-for': '198.51.100.7', 'x-real-ip': GATEWAY })).toBeNull();
    expect(call({ 'cf-connecting-ip': GATEWAY, 'x-real-ip': GATEWAY })).toBeNull();
  });

  it('refuses a wrong key from a gateway address', () => {
    expect(call({ 'x-forwarded-for': GATEWAY }, 'instance-key-9876543210')).toBeNull();
  });

  it('takes the key from any address when GATEWAY_IPS is not set', () => {
    vi.stubEnv('GATEWAY_IPS', '');
    expect(call({ 'x-forwarded-for': '198.51.100.7' })).toMatchObject({ userId: 'instance-api' });
  });
});
