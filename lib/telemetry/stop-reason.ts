/**
 * The one-tap "why did you stop?" asked after a user stops a task.
 *
 * Stops outnumber real failures by a wide margin, and a stop carries no reason at all, while a
 * failure already carries its category. This is the
 * cheapest way to learn whether the next thing to build is speed, planning or cost display.
 *
 * Fixed chips, no free text: the answer has to aggregate. `other` is deliberate: it says "none of
 * these" without inviting prose, and if it grows large the list is wrong, which is itself the
 * finding. The ask is measured separately from the answer because only people who stay around
 * answer, and that bias should be visible in the numbers rather than hidden in them.
 *
 * Only shown while telemetry is active. Asking someone who opted out would look like the opt-out
 * did not take.
 */
export const STOP_REASONS = ['too_slow', 'wrong_direction', 'cost', 'done_already', 'other'] as const;

/** Also the chip's label key under `chat.stopReasons`; the question itself is `chat.stopReasons.prompt`. */
export type StopReasonId = (typeof STOP_REASONS)[number];

/**
 * Whether the ask is on screen: only for the project being looked at, and only once its run has
 * ended. A stop recorded for another project stays pending for that project's panel.
 */
export function shouldShowStopReason(
  userStop: { projectId: string } | null,
  viewedProjectId: string,
  generating: boolean,
): boolean {
  return !!userStop && userStop.projectId === viewedProjectId && !generating;
}
