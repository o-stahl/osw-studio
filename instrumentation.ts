export async function register() {
  // Everything below serves Server Mode (desktop included): its scheduler, deployment routes and
  // Caddy. A Browser Mode build has better-sqlite3 installed too, so SQLite loading proves nothing.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PUBLIC_SERVER_MODE === 'true') {
    try {
      // Dynamic imports — avoids bundling SQLite into client
      const { listDeploymentIds } = await import('@/lib/vfs/adapters/sqlite-connection');
      listDeploymentIds(); // Verify SQLite is available

      const { Scheduler } = await import('@/lib/scheduler');
      const { createDeploymentSchedulerTask } = await import('@/lib/scheduler/deployment-scheduler');
      const { createReviewNotificationTask } = await import('@/lib/scheduler/review-notifications');
      const { createEmailDeliveryTask } = await import('@/lib/scheduler/email-delivery');

      const scheduler = new Scheduler({ pollIntervalMs: 30000 });
      scheduler.registerTask(createDeploymentSchedulerTask());
      // Composition only: it fills the outbox and stops. Registering it on an instance with no mail
      // transport is harmless — the queue accumulates and drains once one is configured.
      scheduler.registerTask(createReviewNotificationTask());
      // The other half. Also harmless unconfigured: with no transport it holds the queue untouched
      // rather than spending attempts against a server that does not exist yet.
      scheduler.registerTask(createEmailDeliveryTask());
      scheduler.start();
    } catch (err) {
      // Server Mode only reaches here, desktop included, so a failure is worth a line in the log.
      console.warn('[Scheduler] Failed to initialize:', err instanceof Error ? err.message : err);
    }

    // Register any deployment that predates routing rows being written at creation time. Without
    // a row, resolveDeployment finds the deployment in neither of the two databases it tries, so
    // analytics, edge functions, the scheduler and the owner's own review copy all act as though
    // it were deleted. Healing on boot means an admin no longer has to know about the per-workspace
    // repair endpoint. Runs before the Caddy regeneration below, which reads the same routing
    // table — a row created here gets its subdomain block on this boot rather than the next one.
    try {
      const { listWorkspaces, systemDatabaseExists } = await import('@/lib/auth/system-database');
      if (systemDatabaseExists()) {
        const { backfillDeploymentRoutes } = await import('@/lib/auth/default-workspace');
        let created = 0;
        for (const workspace of listWorkspaces()) {
          try {
            created += backfillDeploymentRoutes(workspace.id);
          } catch (err) {
            // One unreadable workspace must not stop the others from being healed.
            console.warn(
              `[DeploymentRoutes] Backfill failed for workspace ${workspace.id}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
        // Silent when there was nothing to do, which is every boot after the first.
        if (created > 0) {
          console.log(`[DeploymentRoutes] Registered ${created} previously unrouted deployment(s)`);
        }
      }
    } catch (err) {
      console.warn('[DeploymentRoutes] Backfill skipped:', err instanceof Error ? err.message : err);
    }

    // Rebuild the Caddy config from the deployment routing table on boot, so a
    // freshly (re)deployed instance serves every existing deployment subdomain
    // without waiting for the next publish to regenerate it. No-op unless
    // STATIC_PROXY=true.
    try {
      const { regenerateInstanceCaddy } = await import('@/lib/caddy/regenerate');
      await regenerateInstanceCaddy();
    } catch (err) {
      console.warn('[Caddy] Startup regeneration failed:', err instanceof Error ? err.message : err);
    }
  }
}
