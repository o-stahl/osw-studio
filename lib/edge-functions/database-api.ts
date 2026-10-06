/**
 * Sandboxed Database API for Edge Functions
 *
 * Provides a secure, limited interface to the deployment's SQLite database
 * for use within edge functions. Blocks access to system tables and
 * enforces query limits.
 */

import { RuntimeDatabase } from '@/lib/vfs/adapters/runtime-database';
import { DatabaseAPI, DatabaseAPIOptions } from './types';

/**
 * Runtime database tables that edge functions cannot access: the deployment's own machinery.
 * Analytics is in a separate database, so its table names (`sessions`, `pageviews`) are free for
 * a site's own tables.
 */
const FORBIDDEN_TABLES = [
  'sqlite_',        // SQLite internal tables
  '_migrations',    // Migration tracking
  'site_info',      // Site configuration
  'edge_functions', // Function definitions
  'function_logs',  // Execution logs
  'server_functions', // Server function definitions
  'scheduled_functions', // Scheduled function definitions
  'secrets',        // Encrypted secrets
  'files',          // VFS files
  'file_tree_nodes', // VFS tree
];

/**
 * DDL keywords that modify schema
 */
const DDL_KEYWORDS = ['create', 'drop', 'alter', 'truncate'];

/**
 * Dangerous keywords that should never be allowed
 */
const DANGEROUS_KEYWORDS = ['attach', 'detach', 'vacuum', 'reindex'];

/**
 * Create a sandboxed database API for edge function use
 *
 * @param deploymentDb The deployment's database instance
 * @param options Configuration options
 * @returns A DatabaseAPI that enforces security restrictions
 */
export function createDatabaseAPI(
  deploymentDb: RuntimeDatabase,
  options: DatabaseAPIOptions = {}
): DatabaseAPI {
  let queryCount = 0;
  const maxQueries = options.maxQueries ?? 100;
  const readOnly = options.readOnly ?? false;

  /**
   * Validate SQL query for security
   * Throws an error if the query is not allowed
   */
  const validateSQL = (sql: string): void => {
    const lowerSQL = sql.toLowerCase().trim();

    // Check for dangerous keywords
    for (const keyword of DANGEROUS_KEYWORDS) {
      if (lowerSQL.includes(keyword)) {
        throw new Error(`SQL keyword "${keyword}" is not allowed`);
      }
    }

    // Block access to system tables
    for (const table of FORBIDDEN_TABLES) {
      // Check if the forbidden table name appears in the query
      // Use word boundaries to avoid false positives
      const tableRegex = new RegExp(`\\b${table.replace('_', '_?')}\\w*\\b`, 'i');
      if (tableRegex.test(lowerSQL)) {
        throw new Error(`Access to system table "${table}" is not allowed`);
      }
    }

    // Block DDL in read-only mode
    if (readOnly) {
      for (const keyword of DDL_KEYWORDS) {
        if (lowerSQL.startsWith(keyword)) {
          throw new Error(`DDL statements (${keyword.toUpperCase()}) not allowed in read-only mode`);
        }
      }
    }

    // Check query count limit
    queryCount++;
    if (queryCount > maxQueries) {
      throw new Error(`Query limit exceeded (max ${maxQueries} queries per execution)`);
    }
  };

  /**
   * Execute a query and convert results to objects
   */
  const executeQuery = <T>(sql: string, params?: unknown[]): T[] => {
    validateSQL(sql);

    try {
      const result = deploymentDb.executeRawSQL(sql, params);

      // Convert row arrays to objects
      return result.rows.map(row => {
        const obj: Record<string, unknown> = {};
        result.columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj as T;
      });
    } catch (error) {
      // Re-throw with cleaner message
      const message = error instanceof Error ? error.message : 'Query failed';
      throw new Error(`Database error: ${message}`);
    }
  };

  /**
   * Execute a statement that modifies data
   */
  const executeRun = (sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } => {
    validateSQL(sql);

    if (readOnly) {
      throw new Error('Database is in read-only mode');
    }

    try {
      const result = deploymentDb.executeRawSQL(sql, params);
      return {
        changes: result.rowsAffected,
        lastInsertRowid: result.lastInsertRowid ?? 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Query failed';
      throw new Error(`Database error: ${message}`);
    }
  };

  return {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      return executeQuery<T>(sql, params);
    },

    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
      return executeRun(sql, params);
    },

    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      return executeQuery<T>(sql, params);
    },
  };
}
