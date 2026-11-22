import type { ShellEnv, ShellResult } from '../types';
import { headOrTail } from './head-tail-shared';

/** `head` — read first lines (-n) or characters (-c) of each file, or of stdin. */
export function headCommand(env: ShellEnv): Promise<ShellResult> {
  return headOrTail(env, 'head');
}
