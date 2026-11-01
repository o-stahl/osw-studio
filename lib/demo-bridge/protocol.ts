/**
 * How a hosted workspace asks the demo for the projects a visitor left there.
 *
 * The workspace loads the demo's bridge page in a hidden frame. The demo and the instance hosts are
 * one site, so Chrome and Firefox do not partition that frame's storage: it reads the very projects
 * the visitor made in the demo. Safari keeps IndexedDB apart for each top-level origin, so there the
 * frame finds none, and `list` says how many it cannot reach (`./project-count.ts`). The bridge
 * answers only the instance origins the gateway lists, and a reply goes back to the exact origin
 * that asked.
 */
export const BRIDGE_CHANNEL = 'osws-demo-bridge';
export const BRIDGE_PATH = '/demo-bridge';

export interface DemoProjectSummary {
  id: string;
  name: string;
  /** ISO time of the last change. */
  updatedAt: string;
  fileCount: number;
}

export type BridgeRequest =
  | { channel: typeof BRIDGE_CHANNEL; id: string; op: 'list' }
  | { channel: typeof BRIDGE_CHANNEL; id: string; op: 'export'; projectIds: string[] }
  | { channel: typeof BRIDGE_CHANNEL; id: string; op: 'delete'; projectIds: string[] };

export type BridgeReply =
  | {
      channel: typeof BRIDGE_CHANNEL;
      id: string;
      ok: true;
      projects?: DemoProjectSummary[];
      /** Projects the demo holds that this frame cannot read (Safari). */
      unreachable?: number;
      backup?: Blob;
      deleted?: number;
    }
  | { channel: typeof BRIDGE_CHANNEL; id: string; ok: false; error: string };

/** Sent once by the bridge when it is listening. It carries nothing, so it may go to any parent. */
export interface BridgeReady {
  channel: typeof BRIDGE_CHANNEL;
  ready: true;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 1000 && value.every((id) => typeof id === 'string');

export function isBridgeRequest(data: unknown): data is BridgeRequest {
  if (!isObject(data) || data.channel !== BRIDGE_CHANNEL || typeof data.id !== 'string') return false;
  if (data.op === 'list') return true;
  return (data.op === 'export' || data.op === 'delete') && isIdList(data.projectIds);
}

export function isBridgeReply(data: unknown): data is BridgeReply {
  return isObject(data) && data.channel === BRIDGE_CHANNEL && typeof data.id === 'string' && typeof data.ok === 'boolean';
}

export function isBridgeReady(data: unknown): data is BridgeReady {
  return isObject(data) && data.channel === BRIDGE_CHANNEL && data.ready === true;
}
