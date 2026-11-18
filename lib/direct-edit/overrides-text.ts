/**
 * `/overrides.css` as last read or written through the Styles tab, so changes not yet written can be
 * laid over it on every animation frame without a storage read each time. Anything else that writes
 * the file drops the copy, and the next read goes to storage.
 */
export class OverridesText {
  private text: string | null = null;
  /** Moves on every write and drop, so a read or write that was out meanwhile knows it is older. */
  private version = 0;

  constructor(private readonly load: () => Promise<string>) {}

  async read(): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      if (this.text !== null) return this.text;
      const version = this.version;
      const text = await this.load();
      if (this.version === version) {
        this.text = text;
        return text;
      }
      // The file changed while the read was out, so what it read may be older than the file.
      if (attempt === 2) return this.text ?? text;
    }
  }

  /** The file as a write left it. */
  set(text: string): void {
    this.text = text;
    this.version++;
  }

  /** The file changed some other way. */
  drop(): void {
    this.text = null;
    this.version++;
  }

  /**
   * Run a write and keep the file it reports, unless something else changed the file while it ran
   * (its own source writes included): then the next read goes to storage.
   */
  async track<T>(write: () => Promise<T>, textOf: (result: T) => string | undefined): Promise<T> {
    const version = this.version;
    const result = await write();
    const text = textOf(result);
    if (text !== undefined && this.version === version) this.set(text);
    return result;
  }
}
