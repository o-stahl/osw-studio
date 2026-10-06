/**
 * Backend Feature Extractor
 *
 * Extracts backend features from project-level storage (core SQLite)
 * and provisions them into a deployment's runtime database during publish.
 *
 * Data flow: project tables in core SQLite -> runtime.sqlite per deployment
 *
 * This runs server-side during the publish pipeline.
 */

import 'server-only';

import { getSQLiteAdapter, getWorkspaceAdapter } from '@/lib/vfs/adapters/server';
import { RuntimeDatabase } from '@/lib/vfs/adapters/runtime-database';
import { ProjectDatabase } from '@/lib/vfs/adapters/project-database';
import { projectDatabaseExists, getProjectDatabasePath } from '@/lib/vfs/adapters/sqlite-connection';
import { encryptSecret, isEncryptionConfigured } from '@/lib/edge-functions/secrets-crypto';

export interface ExtractionSummary {
  edgeFunctions: number;
  serverFunctions: number;
  secrets: number;
  scheduledFunctions: number;
  databaseSchemaApplied: boolean;
  errors: string[];
}

/**
 * Extract backend features from a project's data in core SQLite
 * and provision them into a deployment's runtime.sqlite.
 *
 * This is called during the publish pipeline after static files are built.
 * It replaces all backend features in the deployment's runtime database
 * with the current project state.
 *
 * @param projectId - The project containing the backend features
 * @param deploymentId - The target deployment's runtime database
 * @returns Summary of what was provisioned
 */
export async function extractBackendFeatures(
  projectId: string,
  deploymentId: string,
  workspaceId?: string
): Promise<ExtractionSummary> {
  const summary: ExtractionSummary = {
    edgeFunctions: 0,
    serverFunctions: 0,
    secrets: 0,
    scheduledFunctions: 0,
    databaseSchemaApplied: false,
    errors: [],
  };

  const adapter = workspaceId ? getWorkspaceAdapter(workspaceId) : getSQLiteAdapter();
  await adapter.init();

  // Read backend features from project tables in core SQLite
  const edgeFunctions = adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
  const serverFunctions = adapter.listServerFunctions ? await adapter.listServerFunctions(projectId) : [];
  const secrets = adapter.listSecrets ? await adapter.listSecrets(projectId) : [];
  const scheduledFunctions = adapter.listScheduledFunctions ? await adapter.listScheduledFunctions(projectId) : [];

  // If no backend features, nothing to do
  if (edgeFunctions.length === 0 && serverFunctions.length === 0 &&
      secrets.length === 0 && scheduledFunctions.length === 0) {
    return summary;
  }

  // Get or create the runtime database for this deployment
  const runtimeDb = new RuntimeDatabase(deploymentId);
  runtimeDb.init();

  // Clear existing backend features in runtime database before provisioning
  // This ensures the deployment matches the project state exactly
  const existingFunctions = runtimeDb.listFunctions();
  for (const fn of existingFunctions) {
    runtimeDb.deleteFunction(fn.id);
  }

  const existingServerFunctions = runtimeDb.listServerFunctions();
  for (const fn of existingServerFunctions) {
    runtimeDb.deleteServerFunction(fn.id);
  }

  const existingSecrets = runtimeDb.listSecrets();
  for (const s of existingSecrets) {
    runtimeDb.deleteSecret(s.id);
  }

  const existingScheduled = runtimeDb.listScheduledFunctions();
  for (const fn of existingScheduled) {
    runtimeDb.deleteScheduledFunction(fn.id);
  }

  // Provision edge functions
  const functionNameToId = new Map<string, string>();
  for (const fn of edgeFunctions) {
    try {
      const id = runtimeDb.createFunction({
        name: fn.name,
        description: fn.description,
        code: fn.code,
        method: fn.method,
        enabled: fn.enabled,
        timeoutMs: fn.timeoutMs,
      });
      functionNameToId.set(fn.name, id);
      summary.edgeFunctions++;
    } catch (err) {
      summary.errors.push(`Edge function "${fn.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Provision server functions
  for (const fn of serverFunctions) {
    try {
      runtimeDb.createServerFunction({
        name: fn.name,
        description: fn.description,
        code: fn.code,
        enabled: fn.enabled,
      });
      summary.serverFunctions++;
    } catch (err) {
      summary.errors.push(`Server function "${fn.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Provision secrets
  for (const secret of secrets) {
    try {
      if (secret.value && isEncryptionConfigured()) {
        // Project has a cleartext value — encrypt for runtime
        runtimeDb.createSecret(secret.name, secret.value, secret.description);
      } else {
        // No value or no encryption — create placeholder
        runtimeDb.createSecretPlaceholder(secret.name, secret.description);
      }
      summary.secrets++;
    } catch (err) {
      summary.errors.push(`Secret "${secret.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Provision scheduled functions
  for (const fn of scheduledFunctions) {
    try {
      // Resolve function name to runtime ID
      const runtimeFunctionId = functionNameToId.get(fn.functionId) || fn.functionId;

      // Try to find by name if the functionId looks like a project-level ID
      if (!functionNameToId.has(fn.functionId)) {
        // The functionId might be the project-level edge function ID
        // Try to find the corresponding runtime function by matching names
        const projectEdgeFn = edgeFunctions.find(ef => ef.id === fn.functionId);
        if (projectEdgeFn) {
          const resolvedId = functionNameToId.get(projectEdgeFn.name);
          if (resolvedId) {
            runtimeDb.createScheduledFunction({
              name: fn.name,
              description: fn.description,
              functionId: resolvedId,
              cronExpression: fn.cronExpression,
              timezone: fn.timezone,
              config: fn.config,
              enabled: fn.enabled,
              lastRunAt: fn.lastRunAt,
              nextRunAt: fn.nextRunAt,
              lastStatus: fn.lastStatus,
              lastError: fn.lastError,
              lastDurationMs: fn.lastDurationMs,
            });
            summary.scheduledFunctions++;
            continue;
          }
        }
      }

      runtimeDb.createScheduledFunction({
        name: fn.name,
        description: fn.description,
        functionId: runtimeFunctionId,
        cronExpression: fn.cronExpression,
        timezone: fn.timezone,
        config: fn.config,
        enabled: fn.enabled,
        lastRunAt: fn.lastRunAt,
        nextRunAt: fn.nextRunAt,
        lastStatus: fn.lastStatus,
        lastError: fn.lastError,
        lastDurationMs: fn.lastDurationMs,
      });
      summary.scheduledFunctions++;
    } catch (err) {
      summary.errors.push(`Scheduled function "${fn.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Extract project database schema + data to deployment runtime
  // A workspace keeps its project databases under its own directory, where the project's own
  // tables were created; the shared data directory only holds the legacy default workspace's.
  const projectDbBaseDir = adapter.getProjectDatabaseBaseDir();
  if (projectDatabaseExists(projectId, projectDbBaseDir)) {
    try {
      // Validate projectId is a safe identifier (UUID format)
      if (!/^[a-f0-9-]+$/i.test(projectId)) {
        summary.errors.push('Project database: invalid project ID format');
      } else {
        const projectDb = new ProjectDatabase(projectId, projectDbBaseDir);
        projectDb.init();
        const tables = projectDb.getTableSchema();

        if (tables.length > 0) {
          // Create tables in runtime database from project schema
          const schemaSql = projectDb.getSchemaForExport();
          runtimeDb.executeDDL(schemaSql);

          // Use ATTACH to efficiently copy data
          const projectDbPath = getProjectDatabasePath(projectId, projectDbBaseDir);
          runtimeDb.executeDDL(`ATTACH DATABASE '${projectDbPath.replace(/'/g, "''")}' AS project_db`);

          for (const table of tables) {
            if (table.rowCount > 0) {
              const escaped = `"${table.name.replace(/"/g, '""')}"`;
              runtimeDb.executeDDL(`INSERT INTO ${escaped} SELECT * FROM project_db.${escaped}`);
            }
          }

          runtimeDb.executeDDL(`DETACH DATABASE project_db`);
          summary.databaseSchemaApplied = true;
        }
      }
    } catch (err) {
      summary.errors.push(`Project database: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
