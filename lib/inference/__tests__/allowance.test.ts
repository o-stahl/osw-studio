import { describe, it, expect, afterEach } from 'vitest';
import { freeAllowanceOffered, allowanceFromServer } from '../allowance';

/** Where the free allowance exists: the demo and hosted instances, and nowhere else. */
const ENV = ['DEMO_GATEWAY_URL', 'NEXT_PUBLIC_SERVER_MODE', 'NEXT_PUBLIC_GATEWAY_URL', 'NEXT_PUBLIC_DESKTOP'] as const;
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('freeAllowanceOffered', () => {
  it('is offered on the demo, through a trial session', () => {
    process.env.DEMO_GATEWAY_URL = 'https://gateway.oswstudio.com';
    expect(freeAllowanceOffered()).toBe(true);
    expect(allowanceFromServer()).toBe(false);
  });

  it('is offered on a hosted instance, through the signed-in account', () => {
    process.env.NEXT_PUBLIC_SERVER_MODE = 'true';
    process.env.NEXT_PUBLIC_GATEWAY_URL = 'https://gateway.oswstudio.com';
    expect(freeAllowanceOffered()).toBe(true);
    expect(allowanceFromServer()).toBe(true);
  });

  it('is not offered on a git clone, a self-hosted server or the desktop app', () => {
    expect(freeAllowanceOffered()).toBe(false);
    process.env.NEXT_PUBLIC_SERVER_MODE = 'true';
    expect(freeAllowanceOffered()).toBe(false);
    process.env.NEXT_PUBLIC_DESKTOP = 'true';
    process.env.NEXT_PUBLIC_GATEWAY_URL = 'https://gateway.oswstudio.com';
    expect(freeAllowanceOffered()).toBe(false);
  });

  it('is never offered by a server install that also names a demo gateway', () => {
    process.env.NEXT_PUBLIC_SERVER_MODE = 'true';
    process.env.DEMO_GATEWAY_URL = 'https://gateway.oswstudio.com';
    expect(freeAllowanceOffered()).toBe(false);
  });
});
