/**
 * The hosted demo: a Browser Mode install standing in front of a hosted OSW Studio, as
 * try.oswstudio.com stands in front of the gateway at gateway.oswstudio.com. Nobody signs in to the
 * demo itself; with `DEMO_ACCOUNT_LINKS=true` it points visitors at the hosted service when they want
 * their projects on a server.
 *
 * `DEMO_GATEWAY_URL` names that service's gateway. Both are read at run time, so the demo ships the
 * same build as any other Browser Mode install; the root layout hands them to the page as
 * `<html data-demo-gateway>` and `<html data-demo-accounts>`, where client code reads them.
 */

/** Set when a visitor dismisses the demo notice, which then stays away (`components/demo-notice`). */
export const DEMO_NOTICE_COOKIE = 'osws_demo_notice';

/** The origin of an http(s) URL, or null for any other value. */
export function gatewayOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The hosted service's gateway when this install is its demo, otherwise null. */
export function demoGatewayUrl(): string | null {
  // A server install signs people in itself; it is never someone else's demo.
  if (process.env.NEXT_PUBLIC_SERVER_MODE === 'true') return null;
  const raw = typeof document === 'undefined'
    ? process.env.DEMO_GATEWAY_URL
    : document.documentElement?.dataset?.demoGateway;
  return gatewayOrigin(raw);
}

export function isDemo(): boolean {
  return demoGatewayUrl() !== null;
}

/**
 * Whether the demo offers the hosted service's sign-in and sign-up (`DEMO_ACCOUNT_LINKS=true`). Off by
 * default; while it is off, the notice, the dashboard card and the deploy dialog's sign-in stay away.
 */
export function demoAccountLinks(): boolean {
  if (!isDemo()) return false;
  return typeof document === 'undefined'
    ? process.env.DEMO_ACCOUNT_LINKS === 'true'
    : document.documentElement?.dataset?.demoAccounts === 'on';
}

/** Where the demo sends someone to sign in to the hosted service, or to create an account there. */
export function demoAccountUrl(page: 'login' | 'register'): string | null {
  const gateway = demoGatewayUrl();
  return gateway && demoAccountLinks() ? `${gateway}/${page}` : null;
}

/**
 * The other side: on a hosted instance, the demo it stands behind (`HOSTED_DEMO_URL`), whose
 * visitors' projects a new account can bring along (`components/demo-import`). Instance
 * configuration, never taken from a link: the instance loads this origin's bridge page and imports
 * what it sends. Server Mode only; handed to the page as `<html data-hosted-demo>`.
 */
export function hostedDemoOrigin(): string | null {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return null;
  const raw = typeof document === 'undefined'
    ? process.env.HOSTED_DEMO_URL
    : document.documentElement?.dataset?.hostedDemo;
  return gatewayOrigin(raw);
}
