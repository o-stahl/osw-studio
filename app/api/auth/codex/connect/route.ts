import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { NextRequest, NextResponse } from 'next/server';
import {
  codexCookieName,
  CODEX_LOGIN_COOKIE_MAX_AGE,
  codexLoginCookieName,
  codexCookieOptions,
  legacyCodexCookieNames,
} from '../cookie';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

interface LoginFlow {
  verifier: string;
  expiresAt: number;
  result?: { accessToken: string; refreshToken: string; expiresIn: number } | { error: string };
}

const codexGlobal = globalThis as typeof globalThis & {
  oswCodexFlows?: Map<string, LoginFlow>;
  oswCodexCallbackServer?: Promise<void>;
};
const flows = codexGlobal.oswCodexFlows ??= new Map<string, LoginFlow>();

function callbackPage(success: boolean, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ChatGPT sign-in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font:16px system-ui;text-align:center}main{padding:24px}p{color:#a1a1aa}</style></head><body><main><h1>${success ? 'Authentication successful' : 'Authentication failed'}</h1><p>${message}</p></main></body></html>`;
}

async function exchangeCode(code: string, verifier: string) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
    cache: 'no-store',
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.access_token || !tokens.refresh_token) {
    throw new Error('OpenAI did not create a Codex session');
  }
  return {
    accessToken: tokens.access_token as string,
    refreshToken: tokens.refresh_token as string,
    expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600,
  };
}

function ensureCallbackServer(): Promise<void> {
  if (codexGlobal.oswCodexCallbackServer) return codexGlobal.oswCodexCallbackServer;

  codexGlobal.oswCodexCallbackServer = new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', REDIRECT_URI);
      if (url.pathname !== '/auth/callback') {
        response.writeHead(404).end();
        return;
      }

      const state = url.searchParams.get('state');
      const flow = state ? flows.get(state) : undefined;
      if (!flow || Date.now() >= flow.expiresAt) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(false, 'Login expired or state did not match. Return to OSW Studio and try again.'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        flow.result = { error: url.searchParams.get('error_description') || 'OpenAI did not return an authorization code' };
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(false, 'OpenAI did not authorize OSW Studio. Return to the app and try again.'));
        return;
      }

      try {
        flow.result = await exchangeCode(code, flow.verifier);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(true, 'You can close this window and return to OSW Studio.'));
      } catch (error) {
        flow.result = { error: error instanceof Error ? error.message : 'Token exchange failed' };
        response.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(false, 'OSW Studio could not create the session. Return to the app and try again.'));
      }
    });

    server.once('error', (error) => {
      delete codexGlobal.oswCodexCallbackServer;
      reject(error);
    });
    server.listen(1455, '127.0.0.1', () => {
      server.unref();
      resolve();
    });
  });

  return codexGlobal.oswCodexCallbackServer;
}

function clearLoginCookie(response: NextResponse): NextResponse {
  response.cookies.set(codexLoginCookieName(), '', codexCookieOptions(0));
  return response;
}

/** Start the same browser PKCE flow used by Pi and the Codex CLI. */
export async function POST(request: NextRequest) {
  const manualCallback = !['localhost', '127.0.0.1', '::1', '[::1]'].includes(request.nextUrl.hostname);

  try {
    if (!manualCallback) await ensureCallbackServer();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + CODEX_LOGIN_COOKIE_MAX_AGE * 1000;

    for (const [key, flow] of flows) {
      if (Date.now() >= flow.expiresAt) flows.delete(key);
    }
    flows.set(state, { verifier, expiresAt });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', 'osw-studio');

    const response = NextResponse.json({ authorizationUrl: url.toString(), manualCallback });
    response.cookies.set(codexLoginCookieName(), state, codexCookieOptions(CODEX_LOGIN_COOKIE_MAX_AGE));
    return response;
  } catch (error) {
    const message = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
      ? 'Port 1455 is already in use. Close Codex or Pi login and try again.'
      : error instanceof Error ? error.message : 'Failed to start ChatGPT login';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function getFlow(request: NextRequest) {
  const state = request.cookies.get(codexLoginCookieName())?.value;
  const flow = state ? flows.get(state) : undefined;
  return state && flow && Date.now() < flow.expiresAt ? { state, flow } : null;
}

function tokenResponse(state: string, result: { accessToken: string; refreshToken: string; expiresIn: number }) {
  flows.delete(state);
  const response = NextResponse.json({
    access_token: result.accessToken,
    expires_at: Math.floor(Date.now() / 1000) + result.expiresIn,
  });
  response.cookies.set(codexCookieName(), result.refreshToken, codexCookieOptions());
  for (const name of legacyCodexCookieNames()) response.cookies.delete(name);
  return clearLoginCookie(response);
}

/** Return tokens after the localhost OAuth callback completes. */
export async function PUT(request: NextRequest) {
  const login = getFlow(request);
  if (!login) {
    return clearLoginCookie(NextResponse.json({ error: 'ChatGPT login expired. Please try again.' }, { status: 401 }));
  }
  if (!login.flow.result) return NextResponse.json({ pending: true }, { status: 202 });
  if ('error' in login.flow.result) {
    flows.delete(login.state);
    return clearLoginCookie(NextResponse.json({ error: login.flow.result.error }, { status: 502 }));
  }
  return tokenResponse(login.state, login.flow.result);
}

/** Complete remote/HF login from the failed localhost redirect URL copied from the browser. */
export async function PATCH(request: NextRequest) {
  const login = getFlow(request);
  if (!login) {
    return clearLoginCookie(NextResponse.json({ error: 'ChatGPT login expired. Please try again.' }, { status: 401 }));
  }

  let redirectUrl: unknown;
  try {
    ({ redirectUrl } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Paste the full browser redirect URL.' }, { status: 400 });
  }
  if (typeof redirectUrl !== 'string' || redirectUrl.length > 10_000) {
    return NextResponse.json({ error: 'Paste the full browser redirect URL.' }, { status: 400 });
  }

  let url: URL;
  try {
    url = new URL(redirectUrl.trim());
  } catch {
    return NextResponse.json({ error: 'Paste the full browser redirect URL.' }, { status: 400 });
  }
  if (url.hostname !== 'localhost' || url.port !== '1455' || url.pathname !== '/auth/callback') {
    return NextResponse.json({ error: 'Paste the localhost:1455 redirect URL from the ChatGPT tab.' }, { status: 400 });
  }
  if (url.searchParams.get('state') !== login.state) {
    return NextResponse.json({ error: 'Login state did not match. Start sign-in again.' }, { status: 400 });
  }
  const code = url.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'The redirect URL does not contain an authorization code.' }, { status: 400 });
  }

  try {
    return tokenResponse(login.state, await exchangeCode(code, login.flow.verifier));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to complete ChatGPT login' },
      { status: 502 },
    );
  }
}
