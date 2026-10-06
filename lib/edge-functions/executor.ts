/**
 * Edge Function Executor using QuickJS WebAssembly Sandbox
 *
 * Executes user-defined JavaScript functions in a secure sandbox using QuickJS
 * compiled to WebAssembly. This provides complete isolation from the Node.js
 * host environment.
 *
 * Security features:
 * - No access to Node.js APIs (process, require, fs, child_process, etc.)
 * - Complete isolation via WebAssembly (different JS engine)
 * - Memory limits enforced by WebAssembly (64MB default)
 * - Execution time limits via interrupt handler
 * - Controlled API surface (only db, secrets, Response helpers exposed)
 *
 * @see https://github.com/justjake/quickjs-emscripten
 */

import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { EdgeFunction, ServerFunction } from '@/lib/vfs/types';
import {
  FunctionRequest,
  FunctionResponse,
  ExecutionResult,
  DatabaseAPI,
} from './types';
import { createDatabaseAPI } from './database-api';
import { RuntimeDatabase } from '@/lib/vfs/adapters/runtime-database';
import { decryptSecret, isEncryptionConfigured } from './secrets-crypto';
import { createHash, randomUUID } from 'crypto';
import { publicFetch } from './public-fetch';

// Cache the QuickJS module to avoid re-initializing WASM on every request
let quickJSModulePromise: Promise<QuickJSWASMModule> | null = null;

/**
 * Get or initialize the QuickJS WASM module
 * Packages externalized via serverExternalPackages in next.config.ts
 */
async function getQuickJSModule(): Promise<QuickJSWASMModule> {
  if (!quickJSModulePromise) {
    quickJSModulePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return quickJSModulePromise;
}

/**
 * Maximum execution time in milliseconds
 */
const MAX_EXECUTION_TIME_MS = 30000;

/**
 * Maximum memory in bytes (64MB)
 */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * Fetch security limits
 */
const MAX_FETCH_REQUESTS = 10;
/**
 * Ceiling for a single outbound request. The function's own deadline is the real bound: a fetch
 * that outlives it only leaves work in flight when the runtime is torn down. This was a flat 10s
 * while functions get up to 30s, so a slow upstream (a model call is the common one) was aborted
 * well inside the budget the function had been given.
 */
const FETCH_TIMEOUT_MS = 30000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
/** How long teardown waits for a cancelled request to settle before disposing anyway. */
const FETCH_SETTLE_MS = 2000;
/**
 * Execute an edge function in a secure QuickJS WebAssembly sandbox
 *
 * @param fn The edge function definition
 * @param request The incoming request
 * @param deploymentDb The deployment's database instance
 * @returns Execution result including response, logs, and timing
 */
export async function executeFunction(
  fn: EdgeFunction,
  request: FunctionRequest,
  deploymentDb: RuntimeDatabase
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const logs: string[] = [];

  // Track response
  let responseSet = false;
  let response: FunctionResponse = {
    status: 200,
    headers: {},
    body: '',
  };

  // Create database API
  const db = createDatabaseAPI(deploymentDb);

  // The evaluated module's handle. Held out here because the disposal below sits on the success
  // path: a throw between here and there (a deadline, a pending-job error) would otherwise leave it
  // alive when the runtime is freed, which QuickJS turns into a process-level abort.
  let evalValue: QuickJSHandle | undefined;

  // Load enabled server functions
  const serverFunctions = deploymentDb.listServerFunctions().filter(f => f.enabled);

  // Load and decrypt secrets
  const decryptedSecrets: Record<string, string> = {};
  if (isEncryptionConfigured()) {
    try {
      const secretRecords = deploymentDb.listSecretsWithValues();
      for (const record of secretRecords) {
        try {
          decryptedSecrets[record.name] = decryptSecret(
            record.encryptedValue,
            record.iv,
            record.authTag
          );
        } catch {
          logs.push(`[WARN] Failed to decrypt secret "${record.name}"`);
        }
      }
    } catch (error) {
      logs.push(`[WARN] Failed to load secrets: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Get QuickJS instance (using dynamic import for Next.js compatibility)
  const QuickJS = await getQuickJSModule();

  // Create runtime with memory limit
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);

  // Set up execution timeout
  const timeout = Math.min(fn.timeoutMs || 5000, MAX_EXECUTION_TIME_MS);
  const deadline = Date.now() + timeout;

  // Interrupt handler for timeout
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      return true; // Interrupt execution
    }
    return false;
  });

  // Create context
  const context = runtime.newContext();

  // Track fetch usage for this execution
  const fetchState: FetchState = { requestCount: 0, pendingFetches: [] };

  try {
    // Inject globals into the sandbox
    injectGlobals(context, {
      request,
      db,
      logs,
      decryptedSecrets,
      serverFunctions,
      setResponse: (newResponse: FunctionResponse) => {
        if (!responseSet) {
          responseSet = true;
          response = newResponse;
        } else {
          logs.push('[WARN] Response already set, ignoring subsequent call');
        }
      },
      fetchState,
      deadline,
    });

    // Build the code to execute
    const wrappedCode = buildWrappedCode(fn.code);

    // Execute the code
    const result = context.evalCode(wrappedCode, `edge-function:${fn.name}`);

    // Handle async execution
    if (result.error) {
      const errorStr = context.dump(result.error);
      result.error.dispose();
      const message = typeof errorStr === 'object' && errorStr !== null
        ? (errorStr as Record<string, unknown>).message as string || JSON.stringify(errorStr)
        : String(errorStr);
      throw new Error(message);
    }

    // If we got a promise, we need to execute pending jobs
    const value = result.value;
    evalValue = value;

    // Execute any pending async operations (including fetch)
    let executePending = true;
    while (executePending) {
      // Wait for any pending fetch operations
      const incompleteFetches = fetchState.pendingFetches.filter(f => !f.completed && f.promise !== null);
      if (incompleteFetches.length > 0) {
        // Wait a small amount for fetches to complete, then check again
        await Promise.race([
          Promise.all(incompleteFetches.map(f => f.promise!)),
          new Promise(resolve => setTimeout(resolve, 10)),
        ]);
      }

      // Execute QuickJS pending jobs
      const pendingResult = runtime.executePendingJobs();
      if (pendingResult.error) {
        const errorStr = context.dump(pendingResult.error);
        pendingResult.error.dispose();
        const message = typeof errorStr === 'object' && errorStr !== null
          ? (errorStr as Record<string, unknown>).message as string || JSON.stringify(errorStr)
          : String(errorStr);
        throw new Error(message);
      }

      // Continue if there are more QuickJS jobs OR pending fetches
      const hasMoreJobs = pendingResult.value > 0;
      const hasPendingFetches = fetchState.pendingFetches.some(f => !f.completed);
      executePending = hasMoreJobs || hasPendingFetches;

      // Check timeout
      if (Date.now() > deadline) {
        throw new Error('Function execution timed out');
      }
    }

    value.dispose();
    evalValue = undefined;

    // If no response was set, return 204 No Content
    if (!responseSet) {
      response = { status: 204, headers: {}, body: '' };
    }

    return {
      response,
      logs,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = formatError(error);
    logs.push(`[ERROR] ${errorMessage}`);

    return {
      response: {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: { error: errorMessage },
      },
      logs,
      durationMs: Date.now() - startTime,
      error: errorMessage,
    };
  } finally {
    // A request still in flight owns QuickJS handles it disposes in its own `finally`. Tearing the
    // context down first leaves those alive and QuickJS aborts the process at `JS_FreeRuntime`
    // ("Assertion failed: list_empty(&rt->gc_obj_list)"). This is reachable whenever the function's
    // deadline trips mid-request, which a slow upstream does routinely. Cancel them and let their
    // continuations run before disposing.
    const inFlight = fetchState.pendingFetches.filter((f) => !f.completed && f.promise);
    if (inFlight.length > 0) {
      for (const f of inFlight) {
        try { f.abort?.(); } catch { /* already gone */ }
      }
      await Promise.race([
        Promise.allSettled(inFlight.map((f) => f.promise!)),
        new Promise((resolve) => setTimeout(resolve, FETCH_SETTLE_MS)),
      ]);
    }

    if (evalValue?.alive) evalValue.dispose();
    context.dispose();
    runtime.dispose();
  }
}

/**
 * Configuration for injecting globals into the sandbox
 */
interface GlobalsConfig {
  request: FunctionRequest;
  db: DatabaseAPI;
  logs: string[];
  decryptedSecrets: Record<string, string>;
  serverFunctions: ServerFunction[];
  setResponse: (response: FunctionResponse) => void;
  fetchState: FetchState;
  /** When the invoking function's budget expires; outbound requests are bounded by it. */
  deadline: number;
}

/**
 * Tracks fetch usage within a single execution
 */
interface FetchState {
  requestCount: number;
  pendingFetches: Array<{
    promise: Promise<void> | null;
    completed: boolean;
    /** Cancels the request so its continuation settles and releases its handles. */
    abort?: () => void;
  }>;
}

/**
 * Inject global objects and functions into the QuickJS context
 */
function injectGlobals(context: QuickJSContext, config: GlobalsConfig): void {
  const { request, db, logs, decryptedSecrets, serverFunctions, setResponse, fetchState, deadline } = config;

  // Inject request object (read-only data)
  const requestHandle = jsonToHandle(context, request);
  context.setProp(context.global, 'request', requestHandle);
  requestHandle.dispose();

  // Inject console object
  injectConsole(context, logs);

  // Inject Response helpers
  injectResponseHelpers(context, setResponse);

  // Inject database API
  injectDatabaseAPI(context, db, logs);

  // Inject secrets API
  injectSecretsAPI(context, decryptedSecrets);

  // Inject server functions namespace
  injectServerFunctions(context, serverFunctions, logs);

  // Inject fetch API
  injectFetch(context, logs, fetchState, deadline);

  // Inject base64 helpers (atob/btoa)
  injectBase64Helpers(context);

  // Inject crypto helpers (sha256, randomUUID)
  injectCryptoHelpers(context);
}

/**
 * Inject console object with log capture
 */
function injectConsole(context: QuickJSContext, logs: string[]): void {
  const consoleObj = context.newObject();

  const methods = ['log', 'error', 'warn', 'info'] as const;
  const prefixes = {
    log: '[LOG]',
    error: '[ERROR]',
    warn: '[WARN]',
    info: '[INFO]',
  };

  for (const method of methods) {
    const fn = context.newFunction(method, (...args: QuickJSHandle[]) => {
      const parts = args.map(arg => {
        const value = context.dump(arg);
        return formatValue(value);
      });
      logs.push(`${prefixes[method]} ${parts.join(' ')}`);
    });
    context.setProp(consoleObj, method, fn);
    fn.dispose();
  }

  context.setProp(context.global, 'console', consoleObj);
  consoleObj.dispose();
}

/**
 * Inject Response helper object
 */
function injectResponseHelpers(context: QuickJSContext, setResponse: (response: FunctionResponse) => void): void {
  const responseObj = context.newObject();

  // Response.json(data, status?, headers?)
  const jsonFn = context.newFunction('json', (dataHandle: QuickJSHandle, statusHandle?: QuickJSHandle, headersHandle?: QuickJSHandle) => {
    const data = context.dump(dataHandle);
    const status = statusHandle ? (context.dump(statusHandle) as number) : 200;
    const extraHeaders = headersHandle ? (context.dump(headersHandle) as Record<string, string>) : {};
    setResponse({
      status,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: data as object,
    });
  });
  context.setProp(responseObj, 'json', jsonFn);
  jsonFn.dispose();

  // Response.text(text, status?, headers?)
  const textFn = context.newFunction('text', (textHandle: QuickJSHandle, statusHandle?: QuickJSHandle, headersHandle?: QuickJSHandle) => {
    const text = context.dump(textHandle) as string;
    const status = statusHandle ? (context.dump(statusHandle) as number) : 200;
    const extraHeaders = headersHandle ? (context.dump(headersHandle) as Record<string, string>) : {};
    setResponse({
      status,
      headers: { 'Content-Type': 'text/plain', ...extraHeaders },
      body: text,
    });
  });
  context.setProp(responseObj, 'text', textFn);
  textFn.dispose();

  // Response.error(message, status?, headers?)
  const errorFn = context.newFunction('error', (msgHandle: QuickJSHandle, statusHandle?: QuickJSHandle, headersHandle?: QuickJSHandle) => {
    const message = context.dump(msgHandle) as string;
    const status = statusHandle ? (context.dump(statusHandle) as number) : 500;
    const extraHeaders = headersHandle ? (context.dump(headersHandle) as Record<string, string>) : {};
    setResponse({
      status,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: { error: message },
    });
  });
  context.setProp(responseObj, 'error', errorFn);
  errorFn.dispose();

  context.setProp(context.global, 'Response', responseObj);
  responseObj.dispose();
}

/**
 * Inject database API
 */
function injectDatabaseAPI(context: QuickJSContext, db: DatabaseAPI, logs: string[]): void {
  const dbObj = context.newObject();

  // db.query(sql, params?)
  const queryFn = context.newFunction('query', (sqlHandle: QuickJSHandle, paramsHandle?: QuickJSHandle) => {
    try {
      const sql = context.dump(sqlHandle) as string;
      const params = paramsHandle ? (context.dump(paramsHandle) as unknown[]) : undefined;
      const result = db.query(sql, params);
      return jsonToHandle(context, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logs.push(`[ERROR] db.query failed: ${msg}`);
      throw error;
    }
  });
  context.setProp(dbObj, 'query', queryFn);
  queryFn.dispose();

  // db.run(sql, params?)
  const runFn = context.newFunction('run', (sqlHandle: QuickJSHandle, paramsHandle?: QuickJSHandle) => {
    try {
      const sql = context.dump(sqlHandle) as string;
      const params = paramsHandle ? (context.dump(paramsHandle) as unknown[]) : undefined;
      const result = db.run(sql, params);
      return jsonToHandle(context, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logs.push(`[ERROR] db.run failed: ${msg}`);
      throw error;
    }
  });
  context.setProp(dbObj, 'run', runFn);
  runFn.dispose();

  // db.all(sql, params?) - alias for query
  const allFn = context.newFunction('all', (sqlHandle: QuickJSHandle, paramsHandle?: QuickJSHandle) => {
    try {
      const sql = context.dump(sqlHandle) as string;
      const params = paramsHandle ? (context.dump(paramsHandle) as unknown[]) : undefined;
      const result = db.all(sql, params);
      return jsonToHandle(context, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logs.push(`[ERROR] db.all failed: ${msg}`);
      throw error;
    }
  });
  context.setProp(dbObj, 'all', allFn);
  allFn.dispose();

  context.setProp(context.global, 'db', dbObj);
  dbObj.dispose();
}

/**
 * Inject secrets API
 */
function injectSecretsAPI(context: QuickJSContext, secrets: Record<string, string>): void {
  const secretsObj = context.newObject();

  // secrets.get(name)
  const getFn = context.newFunction('get', (nameHandle: QuickJSHandle) => {
    const name = context.dump(nameHandle) as string;
    const value = secrets[name];
    if (value === undefined) {
      return context.null;
    }
    return context.newString(value);
  });
  context.setProp(secretsObj, 'get', getFn);
  getFn.dispose();

  // secrets.has(name)
  const hasFn = context.newFunction('has', (nameHandle: QuickJSHandle) => {
    const name = context.dump(nameHandle) as string;
    return name in secrets ? context.true : context.false;
  });
  context.setProp(secretsObj, 'has', hasFn);
  hasFn.dispose();

  // secrets.list()
  const listFn = context.newFunction('list', () => {
    return jsonToHandle(context, Object.keys(secrets));
  });
  context.setProp(secretsObj, 'list', listFn);
  listFn.dispose();

  context.setProp(context.global, 'secrets', secretsObj);
  secretsObj.dispose();
}

/**
 * Inject server functions namespace
 */
function injectServerFunctions(
  context: QuickJSContext,
  serverFunctions: ServerFunction[],
  logs: string[]
): void {
  const serverObj = context.newObject();

  for (const serverFn of serverFunctions) {
    const fn = context.newFunction(serverFn.name, (...args: QuickJSHandle[]) => {
      try {
        const jsArgs = args.map(arg => context.dump(arg));

        const serverFnCode = `
          (function(args, db) {
            'use strict';
            ${serverFn.code}
          })
        `;

        const evalResult = context.evalCode(serverFnCode, `server-function:${serverFn.name}`);
        if (evalResult.error) {
          const errorStr = context.dump(evalResult.error);
          evalResult.error.dispose();
          throw new Error(`Server function "${serverFn.name}" error: ${errorStr}`);
        }

        const fnHandle = evalResult.value;
        const argsHandle = jsonToHandle(context, jsArgs);
        const dbHandle = context.getProp(context.global, 'db');

        const callResult = context.callFunction(fnHandle, context.undefined, argsHandle, dbHandle);

        fnHandle.dispose();
        argsHandle.dispose();
        dbHandle.dispose();

        if (callResult.error) {
          const errorStr = context.dump(callResult.error);
          callResult.error.dispose();
          throw new Error(`Server function "${serverFn.name}" error: ${errorStr}`);
        }

        const result = callResult.value;
        const resultValue = context.dump(result);
        result.dispose();

        return jsonToHandle(context, resultValue);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logs.push(`[ERROR] Server function "${serverFn.name}" failed: ${msg}`);
        throw error;
      }
    });

    context.setProp(serverObj, serverFn.name, fn);
    fn.dispose();
  }

  context.setProp(context.global, 'server', serverObj);
  serverObj.dispose();
}

/**
 * Inject fetch API with security controls
 *
 * Since QuickJS is synchronous, we implement fetch by:
 * 1. Creating a QuickJS promise that user code can await
 * 2. Starting the real fetch on Node.js side
 * 3. Resolving the QuickJS promise when fetch completes
 * 4. The execution loop polls for pending fetches
 */
function injectFetch(
  context: QuickJSContext,
  logs: string[],
  fetchState: FetchState,
  deadline: number
): void {
  const fetchFn = context.newFunction('fetch', (urlHandle: QuickJSHandle, optionsHandle?: QuickJSHandle) => {
    try {
      const url = context.dump(urlHandle) as string;
      const options = optionsHandle ? (context.dump(optionsHandle) as Record<string, unknown>) : {};

      // Security checks
      if (fetchState.requestCount >= MAX_FETCH_REQUESTS) {
        throw new Error(`Maximum fetch requests (${MAX_FETCH_REQUESTS}) exceeded`);
      }

      // Validate URL and protocol
      let protocol: string;
      try {
        const parsedUrl = new URL(url);
        protocol = parsedUrl.protocol;
      } catch {
        throw new Error('Invalid URL');
      }

      if (!['http:', 'https:'].includes(protocol)) {
        throw new Error('Only http and https protocols are allowed');
      }

      fetchState.requestCount++;
      logs.push(`[INFO] fetch: ${options.method || 'GET'} ${url}`);

      // Create a deferred promise in QuickJS
      const promiseCode = `
        (function() {
          let _resolve, _reject;
          const promise = new Promise((resolve, reject) => {
            _resolve = resolve;
            _reject = reject;
          });
          promise._resolve = _resolve;
          promise._reject = _reject;
          return promise;
        })()
      `;

      const promiseResult = context.evalCode(promiseCode, 'fetch-promise');
      if (promiseResult.error) {
        const errorStr = context.dump(promiseResult.error);
        promiseResult.error.dispose();
        throw new Error(`Failed to create promise: ${errorStr}`);
      }

      const promiseHandle = promiseResult.value;

      // Track this fetch operation
      const fetchEntry: {
        promise: Promise<void> | null;
        completed: boolean;
        abort?: () => void;
      } = { promise: null, completed: false };

      // Execute the actual fetch
      fetchEntry.promise = (async () => {
        try {
          const controller = new AbortController();
          fetchEntry.abort = () => controller.abort();
          // Never outlive the function that issued it, and never cut it short of its own budget.
          const budget = Math.max(0, Math.min(FETCH_TIMEOUT_MS, deadline - Date.now()));
          const timeoutId = setTimeout(() => controller.abort(), budget);

          const fetchOptions: RequestInit = {
            method: (options.method as string) || 'GET',
            headers: options.headers as Record<string, string>,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          };

          const { response, url: finalUrl } = await publicFetch(url, fetchOptions, () => {
            if (fetchState.requestCount >= MAX_FETCH_REQUESTS) {
              throw new Error(`Maximum fetch requests (${MAX_FETCH_REQUESTS}) exceeded`);
            }
            fetchState.requestCount++;
          });
          clearTimeout(timeoutId);

          // Check response size
          const contentLength = response.headers.get('content-length');
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`);
          }

          // Read response body
          const text = await response.text();
          if (text.length > MAX_RESPONSE_SIZE) {
            throw new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`);
          }

          // Build response object for QuickJS
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });

          const responseObj = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers,
            url: finalUrl,
          };

          // Resolve the promise with the response object
          const resolveHandle = context.getProp(promiseHandle, '_resolve');
          const responseHandle = jsonToHandle(context, responseObj);

          // Add json() and text() methods to the response
          const jsonMethod = context.newFunction('json', () => {
            try {
              return jsonToHandle(context, JSON.parse(text));
            } catch {
              throw new Error('Failed to parse JSON');
            }
          });
          context.setProp(responseHandle, 'json', jsonMethod);
          jsonMethod.dispose();

          const textMethod = context.newFunction('text', () => {
            return context.newString(text);
          });
          context.setProp(responseHandle, 'text', textMethod);
          textMethod.dispose();

          context.callFunction(resolveHandle, context.undefined, responseHandle);
          resolveHandle.dispose();
          responseHandle.dispose();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logs.push(`[ERROR] fetch failed: ${errorMsg}`);

          // Reject the promise
          const rejectHandle = context.getProp(promiseHandle, '_reject');
          const errorHandle = context.newString(errorMsg);
          context.callFunction(rejectHandle, context.undefined, errorHandle);
          rejectHandle.dispose();
          errorHandle.dispose();
        } finally {
          fetchEntry.completed = true;
          // Release the host's reference. The VM holds its own (see the dup below), so the promise
          // stays alive for the sandbox while this side stops tracking it.
          promiseHandle.dispose();
        }
      })();

      fetchState.pendingFetches.push(fetchEntry);

      // Returning a handle from newFunction hands ownership to the VM, which disposes it. The async
      // continuation above still needs the promise to resolve it, so the VM gets a duplicate and the
      // host keeps `promiseHandle`. Returning it directly left the continuation writing through a
      // handle the VM had already freed, which corrupted the refcounts and aborted QuickJS at
      // teardown: "Assertion failed: list_empty(&rt->gc_obj_list)".
      return promiseHandle.dup();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logs.push(`[ERROR] fetch failed: ${errorMsg}`);
      throw context.newError(errorMsg);
    }
  });

  context.setProp(context.global, 'fetch', fetchFn);
  fetchFn.dispose();
}

/**
 * Inject atob/btoa base64 encoding functions
 */
function injectBase64Helpers(context: QuickJSContext): void {
  // btoa - binary to ASCII (encode)
  const btoaFn = context.newFunction('btoa', (dataHandle: QuickJSHandle) => {
    const data = context.dump(dataHandle) as string;
    const encoded = Buffer.from(data, 'binary').toString('base64');
    return context.newString(encoded);
  });
  context.setProp(context.global, 'btoa', btoaFn);
  btoaFn.dispose();

  // atob - ASCII to binary (decode)
  const atobFn = context.newFunction('atob', (dataHandle: QuickJSHandle) => {
    const data = context.dump(dataHandle) as string;
    const decoded = Buffer.from(data, 'base64').toString('binary');
    return context.newString(decoded);
  });
  context.setProp(context.global, 'atob', atobFn);
  atobFn.dispose();
}

/**
 * Inject crypto helpers (sha256, randomUUID)
 * These run in the Node.js host and are exposed as sync functions to QuickJS.
 */
function injectCryptoHelpers(context: QuickJSContext): void {
  const cryptoObj = context.newObject();

  const sha256Fn = context.newFunction('sha256', (dataHandle: QuickJSHandle) => {
    const data = context.dump(dataHandle) as string;
    const hash = createHash('sha256').update(data).digest('hex');
    return context.newString(hash);
  });
  context.setProp(cryptoObj, 'sha256', sha256Fn);
  sha256Fn.dispose();

  const uuidFn = context.newFunction('randomUUID', () => {
    return context.newString(randomUUID());
  });
  context.setProp(cryptoObj, 'randomUUID', uuidFn);
  uuidFn.dispose();

  context.setProp(context.global, 'crypto', cryptoObj);
  cryptoObj.dispose();
}

/**
 * Build the wrapped code for execution
 */
function buildWrappedCode(code: string): string {
  return `
    (async function() {
      'use strict';
      try {
        ${code}
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        Response.error(msg, 500);
      }
    })();
  `;
}

/**
 * Convert a JavaScript value to a QuickJS handle
 */
function jsonToHandle(context: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === null) {
    return context.null;
  }
  if (value === undefined) {
    return context.undefined;
  }
  if (typeof value === 'boolean') {
    return value ? context.true : context.false;
  }
  if (typeof value === 'number') {
    return context.newNumber(value);
  }
  if (typeof value === 'string') {
    return context.newString(value);
  }
  if (Array.isArray(value)) {
    const arr = context.newArray();
    for (let i = 0; i < value.length; i++) {
      const itemHandle = jsonToHandle(context, value[i]);
      context.setProp(arr, i, itemHandle);
      itemHandle.dispose();
    }
    return arr;
  }
  if (typeof value === 'object') {
    const obj = context.newObject();
    for (const [key, val] of Object.entries(value)) {
      const valHandle = jsonToHandle(context, val);
      context.setProp(obj, key, valHandle);
      valHandle.dispose();
    }
    return obj;
  }
  return context.newString(String(value));
}

/**
 * Format a value for console output
 */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Format an error message
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('interrupted')) {
      return 'Function execution timed out';
    }
    if (error.message.includes('memory')) {
      return 'Function exceeded memory limit';
    }
    return error.message;
  }
  return String(error);
}

/**
 * Validate function code before saving
 * Returns an error message if invalid, null if valid
 */
export function validateFunctionCode(code: string): string | null {
  if (!code || code.trim().length === 0) {
    return 'Function code cannot be empty';
  }

  // Check for common mistakes
  if (code.includes('import ')) {
    return 'ES6 import statements are not supported. Use the provided APIs.';
  }
  if (code.includes('require(')) {
    return 'require() is not available. Use the provided APIs.';
  }

  return null;
}

/**
 * Validate function name (URL-safe)
 * Returns an error message if invalid, null if valid
 */
export function validateFunctionName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return 'Function name cannot be empty';
  }

  if (name.length > 64) {
    return 'Function name must be 64 characters or less';
  }

  // Must be URL-safe: lowercase letters, numbers, hyphens
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    return 'Function name must be URL-safe (lowercase letters, numbers, hyphens only, cannot start or end with hyphen)';
  }

  // Reserved names
  const reserved = ['health', 'status', 'ping', 'api', 'admin', 'static'];
  if (reserved.includes(name)) {
    return `Function name "${name}" is reserved`;
  }

  return null;
}

/**
 * Validate server function name (valid JS identifier)
 * Returns an error message if invalid, null if valid
 */
export function validateServerFunctionName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return 'Function name cannot be empty';
  }

  if (name.length > 64) {
    return 'Function name must be 64 characters or less';
  }

  // Must be valid JavaScript identifier
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return 'Function name must be a valid identifier (letters, numbers, underscores; cannot start with number)';
  }

  // Reserved JavaScript keywords
  const jsReserved = [
    'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new',
    'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
    'while', 'with', 'class', 'const', 'enum', 'export', 'extends', 'import',
    'super', 'implements', 'interface', 'let', 'package', 'private', 'protected',
    'public', 'static', 'yield', 'await', 'async',
  ];

  if (jsReserved.includes(name)) {
    return `"${name}" is a reserved JavaScript keyword`;
  }

  // Reserved server function names
  const reserved = ['db', 'fetch', 'console', 'args', 'request', 'Response', 'server', 'secrets', 'atob', 'btoa'];
  if (reserved.includes(name)) {
    return `"${name}" is reserved and cannot be used as a server function name`;
  }

  return null;
}
