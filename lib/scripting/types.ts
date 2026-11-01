/**
 * Types for the script execution system (Python/Lua in a worker inside a sandboxed frame, `lib/sandbox/script-sandbox.ts`).
 */

export type ScriptRuntime = 'python' | 'lua';

export type ScriptWorkerResponse =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'status'; data: string }
  | { type: 'error'; data: string }
  | { type: 'complete'; exitCode: number }
  | { type: 'output-file'; path: string; content: string };
