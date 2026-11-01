import { redirect } from 'next/navigation';

import { getSession } from '@/lib/auth/session';
import { getUserById, getUserDefaultWorkspace, verifyWorkspaceAccess } from '@/lib/auth/system-database';
import { ViewModeProvider } from '@/components/view-mode-provider';
import { DemoImportOffer } from '@/components/demo-import';
import { hostedDemoOrigin } from '@/lib/demo';

/**
 * Membership check for every page under /w/{workspaceId}.
 *
 * The middleware guards these paths, but it runs on the Edge runtime and the access tables live in
 * SQLite, so all it can establish is that the session is valid. A signed-in user could therefore
 * load another workspace's URL and get the shell. Nothing leaked: the client reads its own
 * cookie-scoped IndexedDB, and every route under /api/w/{id} goes through getWorkspaceContext. But
 * the page rendered, which reads as access.
 *
 * A layout is the one place this can be done once for all nine pages, and it is a server component,
 * so the lookup the middleware cannot make is available here.
 *
 * A refused workspace sends the user to their own rather than to an error: arriving at a workspace
 * you are not in is almost always a stale link or a bookmark from a revoked membership.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return <>{children}</>;

  const session = await getSession();
  // The middleware already redirects an unauthenticated caller; this is the same answer if it is
  // ever reached another way.
  if (!session) redirect('/admin/login');

  try {
    verifyWorkspaceAccess(session.userId, workspaceId, 'viewer');
  } catch {
    const fallback = getUserDefaultWorkspace(session.userId);
    redirect(fallback && fallback !== workspaceId ? `/w/${fallback}/projects` : '/admin/login');
  }

  // Decided here so the first HTML already carries the right menu. The sidebar cannot work this out
  // on its own: it renders on the server too, where there is no localStorage to read it from.
  const studioView = (getUserById(session.userId)?.studio_view ?? 1) === 1;

  // A hosted instance offers a new account the projects it made in the demo (components/demo-import),
  // on a workspace of its own: a member who is not the owner has landed in someone else's.
  const hostedDemo = hostedDemoOrigin() !== null;
  const owner = hostedDemo && (() => {
    try {
      verifyWorkspaceAccess(session.userId, workspaceId, 'owner');
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <ViewModeProvider initialStudioView={studioView}>
      {children}
      {hostedDemo && <DemoImportOffer workspaceId={workspaceId} owner={owner} />}
    </ViewModeProvider>
  );
}
