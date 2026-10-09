/**
 * Edge-function calls from the preview, made by the host on the preview's behalf.
 *
 * The preview frame runs on an opaque origin, so a request it makes itself goes out cross-origin, and
 * the function route answers no other origin (see its header test). The frame's interceptor
 * (`lib/preview/virtual-server.ts`) posts `preview:function-call` instead; the host checks the call
 * is for the previewed deployment's functions and nothing else, makes it same-origin, and answers
 * with `preview:function-response`. Anything else the frame asks for is refused, so this is not a
 * way for project code to reach the app's API.
 */

export interface FunctionCall {
  type: 'preview:function-call';
  id: number;
  path: string;
  method: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
}

export interface FunctionResponse {
  type: 'preview:function-response';
  id: number;
  status?: number;
  statusText?: string;
  headers?: Array<[string, string]>;
  body?: ArrayBuffer | null;
  error?: string;
}

/** The path, normalised, when it names one of this deployment's functions; otherwise null. */
export function functionCallPath(path: unknown, deploymentId: string | null | undefined, origin: string): string | null {
  if (!deploymentId || typeof path !== 'string' || !path.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  const prefix = `/api/deployments/${encodeURIComponent(deploymentId)}/functions/`;
  if (url.origin !== origin || !url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) return null;
  return url.pathname + url.search;
}

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

export async function runFunctionCall(
  call: FunctionCall,
  deploymentId: string | null | undefined,
  origin: string = window.location.origin,
): Promise<FunctionResponse> {
  const path = functionCallPath(call.path, deploymentId, origin);
  if (!path) return { type: 'preview:function-response', id: call.id, error: 'not a function of this deployment' };
  const method = String(call.method || 'GET').toUpperCase();
  try {
    const response = await fetch(origin + path, {
      method,
      headers: Array.isArray(call.headers) ? call.headers : [],
      body: method === 'GET' || method === 'HEAD' ? undefined : call.body ?? undefined,
      credentials: 'same-origin',
    });
    return {
      type: 'preview:function-response',
      id: call.id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body: NO_BODY_STATUS.has(response.status) ? null : await response.arrayBuffer(),
    };
  } catch (err) {
    return { type: 'preview:function-response', id: call.id, error: err instanceof Error ? err.message : String(err) };
  }
}
