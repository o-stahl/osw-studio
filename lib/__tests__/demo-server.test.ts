import { describe, it, expect, afterEach, vi } from 'vitest';
import { demoAccountUrl, demoGatewayUrl, hostedDemoOrigin } from '../demo';

/** On the server the setting is DEMO_GATEWAY_URL, read when asked, so it needs no rebuild. */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the demo, as the server sees it', () => {
  it('reads DEMO_GATEWAY_URL at run time', () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com/');
    expect(demoGatewayUrl()).toBe('https://gateway.example.com');
    vi.stubEnv('DEMO_GATEWAY_URL', '');
    expect(demoGatewayUrl()).toBeNull();
  });

  it('offers the hosted sign-in only with DEMO_ACCOUNT_LINKS=true, and only on the demo', () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
    expect(demoAccountUrl('login')).toBeNull();
    vi.stubEnv('DEMO_ACCOUNT_LINKS', 'true');
    expect(demoAccountUrl('login')).toBe('https://gateway.example.com/login');
    vi.stubEnv('DEMO_GATEWAY_URL', '');
    expect(demoAccountUrl('login')).toBeNull();
  });

  it('ignores it in Server Mode', () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    expect(demoGatewayUrl()).toBeNull();
  });
});

describe('the hosted demo, as an instance sees it', () => {
  // The bridge client builds the frame's address from it and matches replies against it exactly.
  it('reads HOSTED_DEMO_URL in Server Mode as a bare origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubEnv('HOSTED_DEMO_URL', 'https://try.example.com/');
    expect(hostedDemoOrigin()).toBe('https://try.example.com');
    vi.stubEnv('HOSTED_DEMO_URL', 'https://try.example.com/projects?x=1');
    expect(hostedDemoOrigin()).toBe('https://try.example.com');
  });

  it('is none for a value that is not an http(s) URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubEnv('HOSTED_DEMO_URL', 'try.example.com');
    expect(hostedDemoOrigin()).toBeNull();
    vi.stubEnv('HOSTED_DEMO_URL', '');
    expect(hostedDemoOrigin()).toBeNull();
  });

  it('ignores it outside Server Mode', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', '');
    vi.stubEnv('HOSTED_DEMO_URL', 'https://try.example.com');
    expect(hostedDemoOrigin()).toBeNull();
  });
});
