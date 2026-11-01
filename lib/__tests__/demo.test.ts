// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { demoAccountLinks, demoAccountUrl, demoGatewayUrl, gatewayOrigin, hostedDemoOrigin, isDemo } from '../demo';
import { detectDeploymentType } from '../telemetry/config';

/** In the page the setting arrives as `<html data-demo-gateway>`, which the root layout writes. */
function servedAsDemo(value: string | undefined) {
  if (value === undefined) delete document.documentElement.dataset.demoGateway;
  else document.documentElement.dataset.demoGateway = value;
}

afterEach(() => {
  servedAsDemo(undefined);
  delete document.documentElement.dataset.demoAccounts;
  delete document.documentElement.dataset.hostedDemo;
  vi.unstubAllEnvs();
});

describe('gatewayOrigin', () => {
  it('keeps the origin of an http(s) URL and nothing else', () => {
    expect(gatewayOrigin('https://gateway.example.com/login?x=1')).toBe('https://gateway.example.com');
    expect(gatewayOrigin('http://localhost:3100')).toBe('http://localhost:3100');
  });

  it('refuses anything that is not an http(s) URL', () => {
    expect(gatewayOrigin('javascript:alert(1)')).toBeNull();
    expect(gatewayOrigin('gateway.example.com')).toBeNull();
    expect(gatewayOrigin('')).toBeNull();
    expect(gatewayOrigin(undefined)).toBeNull();
  });
});

describe('the demo, as the page sees it', () => {
  it('reads the gateway the layout wrote onto the page', () => {
    servedAsDemo('https://gateway.example.com');
    expect(demoGatewayUrl()).toBe('https://gateway.example.com');
    expect(isDemo()).toBe(true);
  });

  it("points at the hosted service's sign-in and sign-up only when the page says so", () => {
    servedAsDemo('https://gateway.example.com');
    expect(demoAccountLinks()).toBe(false);
    expect(demoAccountUrl('login')).toBeNull();
    document.documentElement.dataset.demoAccounts = 'on';
    expect(demoAccountLinks()).toBe(true);
    expect(demoAccountUrl('login')).toBe('https://gateway.example.com/login');
    expect(demoAccountUrl('register')).toBe('https://gateway.example.com/register');
    servedAsDemo(undefined);
    expect(demoAccountLinks()).toBe(false);
  });

  it('is not a demo without one', () => {
    expect(isDemo()).toBe(false);
    expect(demoAccountUrl('login')).toBeNull();
  });

  it('is never a demo in Server Mode, which signs people in itself', () => {
    servedAsDemo('https://gateway.example.com');
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    expect(isDemo()).toBe(false);
  });

  it('reports itself as the demo surface, apart from a Browser Mode install', () => {
    expect(detectDeploymentType()).toBe('browser');
    servedAsDemo('https://gateway.example.com');
    expect(detectDeploymentType()).toBe('demo');
  });
});

describe('the hosted demo, as an instance page sees it', () => {
  it('reads the demo the layout wrote onto the page, in Server Mode only', () => {
    document.documentElement.dataset.hostedDemo = 'https://try.example.com';
    expect(hostedDemoOrigin()).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    expect(hostedDemoOrigin()).toBe('https://try.example.com');
  });

  it('is none when the page carries something that is not an http(s) URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    document.documentElement.dataset.hostedDemo = 'try.example.com';
    expect(hostedDemoOrigin()).toBeNull();
  });
});
