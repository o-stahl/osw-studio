import { NextRequest } from 'next/server';
import { ACTIVE_SCOPES } from './scopes';
import { configuredAppUrl } from '@/lib/web/site-origin';

/**
 * The two OAuth discovery documents a client reads before it can authorize. Claude fetches
 * RFC 9728 protected-resource metadata first and falls back to RFC 8414 authorization-server
 * metadata, so both are served, and both describe this instance: OSW Studio is its own
 * authorization server.
 *
 * The issuer comes from the request, so an instance behind a proxy or on a custom domain
 * advertises the URL the client actually reached, not a configured guess. The configured address
 * (`APP_URL`, or `NEXT_PUBLIC_APP_URL`) wins when set, since that is the value the rest of the app
 * uses for absolute URLs.
 */

export function issuerFor(request: NextRequest | Request): string {
  const configured = configuredAppUrl();
  if (configured) return configured.replace(/\/$/, '');
  const url = new URL(request.url);
  const proto = (request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')).split(',')[0].trim();
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

export function resourceUrl(request: NextRequest | Request): string {
  return `${issuerFor(request)}/api/mcp`;
}

export function protectedResourceMetadata(request: NextRequest | Request) {
  const issuer = issuerFor(request);
  return {
    resource: resourceUrl(request),
    authorization_servers: [issuer],
    scopes_supported: [...ACTIVE_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${issuer}/docs`,
  };
}

export function authorizationServerMetadata(request: NextRequest | Request) {
  const issuer = issuerFor(request);
  return {
    issuer,
    authorization_endpoint: `${issuer}/mcp/authorize`,
    token_endpoint: `${issuer}/api/mcp/oauth/token`,
    registration_endpoint: `${issuer}/api/mcp/oauth/register`,
    revocation_endpoint: `${issuer}/api/mcp/oauth/revoke`,
    // offline_access is advertised so a client that wants a refreshable token asks for it; every
    // grant gets a refresh token regardless, because an agent session outlives an access token.
    scopes_supported: [...ACTIVE_SCOPES, 'offline_access'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  };
}
