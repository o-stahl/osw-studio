/**
 * Pure state for the preview's per-load handshake + escape recovery.
 *
 * The host writes a document into the iframe and stamps it with a monotonic `loadId`. The
 * injected bridge posts `preview:ready { loadId }` the instant it runs, and the host verifies the
 * loaded document is the one it wrote. If a document never acks (or the frame navigated away to a
 * page that isn't ours), that's an "escape": we try one bounded auto-reload, then surface a
 * recoverable overlay. This class holds the decision logic only — timers, srcdoc writes, and DOM
 * reads live in the component so this stays unit-testable.
 */

type LoadPhase = 'loading' | 'ready' | 'escaped';

/** What the host should do in response to an escape signal for the current load. */
type EscapeAction = 'auto-reload' | 'escaped' | 'ignore';

export class PreviewLifecycle {
  private currentLoadId = 0;
  private phase: LoadPhase = 'loading';
  /** Whether the single bounded auto-reload has been spent for the current escape episode. */
  private autoReloadUsed = false;

  get loadId(): number {
    return this.currentLoadId;
  }

  get state(): LoadPhase {
    return this.phase;
  }

  /**
   * Begin tracking a freshly written document. A normal load resets the auto-reload budget; a
   * recovery load (the auto-reload itself) keeps it spent, so a second escape → overlay.
   */
  beginLoad(loadId: number, isRecovery = false): void {
    this.currentLoadId = loadId;
    this.phase = 'loading';
    if (!isRecovery) this.autoReloadUsed = false;
  }

  /**
   * Handle a `preview:ready` ack. Returns true only when it matches the current load (→ ready);
   * a stale ack for a superseded load is ignored, never treated as an escape.
   */
  onAck(loadId: number): boolean {
    if (loadId !== this.currentLoadId) return false;
    this.phase = 'ready';
    this.autoReloadUsed = false;
    return true;
  }

  /**
   * A signal that the current document isn't (or is no longer) ours: a frame load with no ack
   * inside the timeout. Only the current load's signal acts; the phase transitions
   * once to `escaped` after the bounded auto-reload is spent.
   */
  onEscapeSignal(loadId: number): EscapeAction {
    if (loadId !== this.currentLoadId) return 'ignore';
    if (this.phase === 'escaped') return 'ignore';
    if (!this.autoReloadUsed) {
      this.autoReloadUsed = true;
      return 'auto-reload';
    }
    this.phase = 'escaped';
    return 'escaped';
  }
}
