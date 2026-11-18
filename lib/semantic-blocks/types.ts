export interface SemanticBlock {
  id: string;
  name: string;
  category: 'Sections' | 'Content' | 'Interactive' | 'Data';
  description: string;
  wireframeHtml: string;
}

/** A block placed on a page and not yet sent: a chip in the composer. */
interface Placement {
  blockId: string;
  placementId: string;
  /** The page it was placed on, `/index.html`. */
  page: string;
}

/**
 * Written into the source as a placeholder element: the one in `file` whose `data-osw-block` is
 * `placementId` (`lib/semantic-blocks/placement.ts`).
 */
export interface SourcePlacedBlock extends Placement {
  file: string;
  /** The placeholder is not in `file` now (deleted, or a write undone); it shows again if it comes back. */
  missing?: boolean;
}

/**
 * Shown only in the preview frame, for a page compiled without source positions (a bundled
 * runtime): where it went, and the page's markup around it with the drop marked.
 */
export interface FramePlacedBlock extends Placement {
  domPath: string;
  position: 'before' | 'after';
  htmlContext: string;
}

export type PlacedBlock = SourcePlacedBlock | FramePlacedBlock;

export const isSourcePlaced = (b: PlacedBlock): b is SourcePlacedBlock => 'file' in b;

/**
 * A placed block as a sent message records it (`ui_metadata.semanticBlocks`). `name` and
 * `description` are the English the agent was given; `blockId` names the palette copy to show.
 * Messages from before `blockId` and `file` carry `domPath` and `position` only.
 */
export interface SentBlock {
  blockId?: string;
  name: string;
  description: string;
  /** The file its placeholder was written into. */
  file?: string;
  /** That placeholder's `data-osw-block` value. */
  placementId?: string;
  domPath?: string;
  position?: string;
}
