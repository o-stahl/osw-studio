/**
 * Edge Function Invocation API
 *
 * Public endpoint for invoking edge functions
 * URL: /api/deployments/{deploymentId}/functions/{functionName}[/additional/path]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveDeploymentByIdOrSlug } from '@/lib/vfs/adapters/deployment-adapter';
import { executeFunction } from '@/lib/edge-functions/executor';
import { FunctionRequest } from '@/lib/edge-functions/types';
import { functionRequestHeaders, functionResponseHeaders } from '@/lib/edge-functions/http-boundary';
import { logger } from '@/lib/utils';

interface RouteParams {
  params: Promise<{
    id: string;      // Deployment ID
    path: string[];  // [functionName, ...additionalPath]
  }>;
}

/**
 * Handle edge function invocation
 */
async function handleRequest(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const startTime = Date.now();

  try {
    const { id: deploymentId, path } = await params;

    // Extract function name and additional path
    const functionName = path[0];
    const additionalPath = path.slice(1).join('/');

    if (!functionName) {
      return NextResponse.json(
        { error: 'Function name is required' },
        { status: 400 }
      );
    }

    // Check if deployment exists — try UUID first, then slug. Resolved through deployment_routing
    // so the lookup reaches the workspace database that owns it; this endpoint is called by
    // published sites and has no workspace in its URL.
    const resolved = await resolveDeploymentByIdOrSlug(deploymentId);
    if (!resolved) {
      return NextResponse.json(
        { error: 'Deployment not found' },
        { status: 404 }
      );
    }
    const { adapter, deployment } = resolved;

    // Use the actual deployment ID for subsequent lookups (in case we matched by slug)
    const resolvedDeploymentId = deployment.id;

    // An unpublished deployment is off traffic, and that has to include this endpoint. The
    // published pages are gone but the id stays addressable, so without this check a site taken
    // down still runs code and writes to its database for anyone holding the URL.
    if (!deployment.publishedAt) {
      return NextResponse.json(
        { error: 'Deployment is not published' },
        { status: 404 }
      );
    }

    if (!deployment.databaseEnabled) {
      return NextResponse.json(
        { error: 'Edge functions not enabled for this deployment' },
        { status: 404 }
      );
    }

    // Get the deployment database
    const deploymentDb = adapter.getDeploymentDatabaseForAnalytics(resolvedDeploymentId);
    if (!deploymentDb) {
      return NextResponse.json(
        { error: 'Deployment database not available' },
        { status: 500 }
      );
    }

    // Get the function by name
    const fn = deploymentDb.getFunctionByName(functionName);
    if (!fn) {
      return NextResponse.json(
        { error: `Function "${functionName}" not found` },
        { status: 404 }
      );
    }

    if (!fn.enabled) {
      return NextResponse.json(
        { error: `Function "${functionName}" is disabled` },
        { status: 503 }
      );
    }

    // Check HTTP method
    if (fn.method !== 'ANY' && fn.method !== request.method) {
      return NextResponse.json(
        { error: `Method ${request.method} not allowed for this function` },
        { status: 405 }
      );
    }

    // Parse request body for non-GET requests
    let body: unknown = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          body = await request.json();
        } catch {
          body = null;
        }
      } else if (contentType.includes('text/')) {
        body = await request.text();
      }
    }

    // Build query params
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const headers = functionRequestHeaders(request.headers);

    // Build function request
    const functionRequest: FunctionRequest = {
      method: request.method,
      headers,
      body,
      params: { path: additionalPath },
      query,
      path: `/${functionName}${additionalPath ? '/' + additionalPath : ''}`,
    };

    // Execute function
    const result = await executeFunction(fn, functionRequest, deploymentDb);

    // Surface the sandbox's own console output when the call went wrong. Without this the
    // function's `console.error` is collected and dropped, so an upstream 401 or 404 reaches the
    // caller as nothing but the function's own generic error message.
    if (result.logs.length > 0 && (result.error || result.response.status >= 400)) {
      logger.warn(
        `[Edge Functions] ${fn.name} (${result.response.status}) output:\n${result.logs.join('\n')}`
      );
    }

    // Log execution (async, don't await)
    try {
      deploymentDb.logFunctionExecution(fn.id, {
        method: request.method,
        path: functionRequest.path,
        statusCode: result.response.status,
        durationMs: result.durationMs,
        error: result.error,
      });
    } catch (logError) {
      logger.error('[Edge Functions] Failed to log execution:', logError);
    }

    // Build response
    const responseHeaders = functionResponseHeaders(result.response.headers);

    // Add timing header
    responseHeaders.set('X-Execution-Time', `${Date.now() - startTime}ms`);

    // Serialize body
    let responseBody: string;
    if (typeof result.response.body === 'object') {
      responseBody = JSON.stringify(result.response.body);
      if (!responseHeaders.has('Content-Type')) {
        responseHeaders.set('Content-Type', 'application/json');
      }
    } else {
      responseBody = result.response.body;
    }

    return new NextResponse(responseBody, {
      status: result.response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    logger.error('[Edge Functions] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Export handlers for all HTTP methods
export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const DELETE = handleRequest;
export const PATCH = handleRequest;
