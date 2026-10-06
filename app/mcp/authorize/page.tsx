import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth/session';
import { getUserById, listUserWorkspaces } from '@/lib/auth/system-database';
import { clientRedirectUris, getMcpClient } from '@/lib/mcp/store';
import { mcpEnabled } from '@/lib/mcp/auth';
import { grantableScopes, MCP_SCOPES, type McpScope } from '@/lib/mcp/scopes';
import { ConsentForm } from '@/components/mcp/consent-form';
import { Logo } from '@/components/ui/logo';

/**
 * The consent screen. An MCP client sends the user here; the page checks who is signed in, shows
 * what the client is asking for, and lets the account pick the workspace and narrow the scopes.
 * Approving is what mints the authorization code.
 *
 * A bad `client_id` or `redirect_uri` is shown here rather than redirected, because a redirect to
 * an unvalidated URI is the open-redirect the spec warns about. Everything else that fails is
 * reported back to the client through its registered URI.
 */

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-3 text-center">
        <Logo className="mx-auto h-8 w-8" />
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: PageProps) {
  const tt = await getTranslations('tooltips');
  const tc = await getTranslations('common');
  if (!mcpEnabled()) {
    return <Problem title={tc('labels.notAvailable')} detail={tt('mcpDisabledDetail')} />;
  }

  const params = await searchParams;
  const clientId = one(params.client_id);
  const redirectUri = one(params.redirect_uri);
  const state = one(params.state);
  const codeChallenge = one(params.code_challenge);
  const codeChallengeMethod = one(params.code_challenge_method) || 'S256';
  const resource = one(params.resource);
  const requestedScope = one(params.scope);
  const responseType = one(params.response_type) || 'code';

  const client = clientId ? getMcpClient(clientId) : undefined;
  if (!client) {
    return <Problem title={tt('unknownApplication')} detail={tt('unknownClientDetail')} />;
  }
  const registered = clientRedirectUris(client);
  if (!redirectUri || !registered.includes(redirectUri)) {
    return <Problem title={tt('redirectMismatch')} detail={tt('redirectMismatchDetail', { client: client.client_name })} />;
  }

  // From here a fault can be reported to the client, because the redirect URI is one it registered.
  const back = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    redirect(url.toString());
  };

  if (responseType !== 'code') back('unsupported_response_type', 'Only the authorization code flow is supported');
  if (codeChallengeMethod !== 'S256') back('invalid_request', 'code_challenge_method must be S256');
  if (!codeChallenge) back('invalid_request', 'code_challenge is required');

  const session = await getSession();
  if (!session) {
    const self = new URL('http://placeholder/mcp/authorize');
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') self.searchParams.set(key, value);
    }
    // With an external login there is nowhere to put `next`: the gateway's login page takes no
    // destination and its handoff names the dashboard, so the request is parked on this origin
    // instead and picked up by middleware when the browser comes back. See the hold route.
    if (process.env.NEXT_PUBLIC_GATEWAY_URL) {
      redirect(`/api/mcp/oauth/hold${self.search}`);
    }
    redirect(`/admin/login?next=${encodeURIComponent(`${self.pathname}${self.search}`)}`);
  }

  const user = getUserById(session!.userId);
  const workspaces = listUserWorkspaces(session!.userId);
  // An instance admin is not listed in workspace_access, so their workspaces come from the role
  // check rather than a grant row; they may still only connect one workspace at a time.
  const options = workspaces.map(w => ({ id: w.id, name: w.name, role: w.role as 'owner' | 'editor' | 'viewer' }));
  if (options.length === 0 && user?.is_admin) {
    const { listWorkspaces } = await import('@/lib/auth/system-database');
    for (const w of listWorkspaces()) options.push({ id: w.id, name: w.name, role: 'owner' });
  }

  if (options.length === 0) {
    return <Problem title={tt('noWorkspaceToConnect')} detail={tt('noWorkspaceDetail')} />;
  }

  const asked = requestedScope
    ? (requestedScope.split(/[\s,]+/).filter(s => (MCP_SCOPES as readonly string[]).includes(s)) as McpScope[])
    : [];

  return (
    <ConsentForm
      clientName={client.client_name}
      clientId={client.client_id}
      redirectUri={redirectUri}
      state={state}
      codeChallenge={codeChallenge}
      resource={resource}
      accountEmail={session!.email}
      workspaces={options}
      requestedScopes={asked}
      grantableByRole={Object.fromEntries(options.map(w => [w.id, grantableScopes(w.role)]))}
    />
  );
}
