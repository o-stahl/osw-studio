/**
 * Pairs each document the preview writes with the iframe load event it belongs to.
 *
 * Each document the host writes reports in by message (its shell asking for its page, then its own
 * `preview:ready`), and the iframe element fires `load` in the host's window. The two arrive in
 * either order (a cross-origin frame runs in its own process), so they are paired by count: a load
 * with no ack inside the timeout is a document that is not ours, the frame having navigated to an
 * external site. What to do about that is `PreviewLifecycle`'s decision; this only spots it.
 */
export class AckPairer {
  private loadId = 0;
  private unpaired = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly timeoutMs: number) {}

  /** A new document was written: acks and loads owed to the one it replaces no longer count. */
  begin(loadId: number): void {
    this.loadId = loadId;
    this.unpaired = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The iframe fired `load`. `onEscape` runs when no ack pairs with it within the timeout. */
  onFrameLoad(onEscape: () => void): void {
    if (this.unpaired > 0) {
      this.unpaired -= 1;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.unpaired > 0) {
        this.unpaired -= 1;
        return;
      }
      onEscape();
    }, this.timeoutMs);
  }

  /**
   * A document reported in. Only the current load's acks pair with load events: an outgoing
   * document's late one would leave a surplus that hides the next real escape. Returns whether
   * the ack was the current load's.
   */
  onAck(loadId: number): boolean {
    if (loadId !== this.loadId) return false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    } else {
      this.unpaired += 1;
    }
    return true;
  }

  /**
   * The load listener is going away: stop waiting. A load already waiting stays owed its ack, so
   * that ack, when it comes, is not counted against the next load.
   */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
