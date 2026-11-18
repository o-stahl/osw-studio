import type { RecordedWrite } from './types';

/**
 * Undo and redo for the Inspector's own writes: styles, text and images.
 *
 * An entry is one gesture: the files one write changed, each with what it held before and after,
 * or several writes recorded under one group key (a scrub). Undo writes `before` back and redo
 * writes `after`, but only after checking every file still holds what the journal expects; anything
 * else wrote to one of them since, and the journal refuses and empties rather than overwrite that
 * write. Checking contents at the moment of undo is what catches every other writer, including the
 * agent and the editor, without each of them announcing itself.
 *
 * Entries carry the time they were made and the time they were undone, so one key can undo
 * whichever of this and the layout changed last.
 */

/** What an entry's writes were, for messages. */
export type EditKind = 'style' | 'text' | 'image' | 'structure';

export interface JournalEntry {
  kind: EditKind;
  /** The group key the writes came under. A write with the same key as the newest entry joins it. */
  group: string;
  /** One per path: the first write's `before` and the last write's `after`. */
  files: RecordedWrite[];
  /** When it was made, or last redone. */
  at: number;
  /** When it was last undone. */
  undoneAt: number | null;
}

/** The project's files as the journal reads and writes them. `null` content: no such file. */
export interface JournalFiles {
  read(path: string): Promise<string | null>;
  write(path: string, content: string, silent: boolean): Promise<void>;
  remove(path: string, silent: boolean): Promise<void>;
}

/** A file an undo or redo wrote; `content: null` when it removed it. */
export interface JournalWrite {
  path: string;
  content: string | null;
  silent: boolean;
}

export type JournalOutcome =
  | { ok: true; entry: JournalEntry; written: JournalWrite[] }
  /** Nothing to undo or redo. */
  | { ok: false; reason: 'empty' }
  /** `path` changed since the entry was recorded; the journal emptied. */
  | { ok: false; reason: 'changed'; path: string }
  /** A write failed part way; what was written is in `written`, and the journal emptied. */
  | { ok: false; reason: 'failed'; path: string; written: JournalWrite[] };

/** Image swaps carry whole pages; past this many bytes the oldest entries go. */
const JOURNAL_MAX_BYTES = 16 * 1024 * 1024;

const sizeOf = (entry: JournalEntry) =>
  entry.files.reduce((n, f) => n + (f.before?.length ?? 0) + f.after.length, 0);

export class EditJournal {
  private entries: JournalEntry[] = [];
  /** `entries[0, cursor)` are done; `entries[cursor, …)` were undone and can be redone. */
  private cursor = 0;
  private busy = false;

  constructor(
    private readonly files: JournalFiles,
    private readonly now: () => number = Date.now,
    private readonly maxBytes: number = JOURNAL_MAX_BYTES,
  ) {}

  /** A write one gesture made. A new gesture drops whatever was undone after the newest entry. */
  record(group: string, kind: EditKind, write: RecordedWrite): void {
    const last = this.entries[this.cursor - 1];
    if (this.cursor === this.entries.length && last && last.group === group) {
      const same = last.files.find((f) => f.path === write.path);
      if (same) same.after = write.after;
      else last.files.push({ ...write });
      last.at = this.now();
    } else {
      this.entries.splice(this.cursor);
      this.entries.push({ kind, group, files: [{ ...write }], at: this.now(), undoneAt: null });
      this.cursor = this.entries.length;
    }
    this.trim();
  }

  /** When the entry undo would take back was made, or `null` with nothing to undo. */
  undoAt(): number | null {
    return this.entries[this.cursor - 1]?.at ?? null;
  }

  /** When the entry redo would bring back was undone, or `null` with nothing to redo. */
  redoAt(): number | null {
    return this.entries[this.cursor]?.undoneAt ?? null;
  }

  clear(): void {
    this.entries = [];
    this.cursor = 0;
  }

  async undo(): Promise<JournalOutcome> {
    const entry = this.entries[this.cursor - 1];
    if (!entry || this.busy) return { ok: false, reason: 'empty' };
    const outcome = await this.apply(entry, 'undo');
    if (outcome.ok) {
      this.cursor--;
      entry.undoneAt = this.now();
    }
    return outcome;
  }

  async redo(): Promise<JournalOutcome> {
    const entry = this.entries[this.cursor];
    if (!entry || this.busy) return { ok: false, reason: 'empty' };
    const outcome = await this.apply(entry, 'redo');
    if (outcome.ok) {
      this.cursor++;
      entry.at = this.now();
    }
    return outcome;
  }

  /** Check every file first, then write; any surprise empties the journal. */
  private async apply(entry: JournalEntry, way: 'undo' | 'redo'): Promise<JournalOutcome> {
    this.busy = true;
    try {
      const expect = (f: RecordedWrite) => (way === 'undo' ? f.after : f.before);
      const target = (f: RecordedWrite) => (way === 'undo' ? f.before : f.after);
      for (const file of entry.files) {
        if ((await this.files.read(file.path)) !== expect(file)) {
          this.clear();
          return { ok: false, reason: 'changed', path: file.path };
        }
      }
      // Undo in reverse order, so a file a later write depended on is restored after it.
      const order = way === 'undo' ? [...entry.files].reverse() : entry.files;
      const written: JournalWrite[] = [];
      for (const file of order) {
        const content = target(file);
        try {
          if (content === null) await this.files.remove(file.path, file.silent);
          else await this.files.write(file.path, content, file.silent);
        } catch {
          this.clear();
          return { ok: false, reason: 'failed', path: file.path, written };
        }
        written.push({ path: file.path, content, silent: file.silent });
      }
      return { ok: true, entry, written };
    } finally {
      this.busy = false;
    }
  }

  private trim(): void {
    let total = this.entries.reduce((n, e) => n + sizeOf(e), 0);
    while (total > this.maxBytes && this.entries.length > 1) {
      total -= sizeOf(this.entries[0]);
      this.entries.shift();
      this.cursor = Math.max(0, this.cursor - 1);
    }
  }
}

/** Which history one key acts on: the one whose entry is newest, or `null` when neither has one. */
export function newestHistory(layoutAt: number | null, editAt: number | null): 'layout' | 'edit' | null {
  if (layoutAt === null && editAt === null) return null;
  if (editAt === null) return 'layout';
  if (layoutAt === null) return 'edit';
  return editAt >= layoutAt ? 'edit' : 'layout';
}
