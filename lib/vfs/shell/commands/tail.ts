import type { ShellEnv, ShellResult } from '../types';
import { headOrTail } from './head-tail-shared';

/** `tail` — read last lines (-n) or characters (-c) of each file, or of stdin. */
export function tailCommand(env: ShellEnv): Promise<ShellResult> {
  return headOrTail(env, 'tail');
}
