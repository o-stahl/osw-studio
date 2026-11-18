import { centreDistance, visibleArtboards } from './layout';
import type { ArtboardBox, LiveBudget, Tier, ViewRect } from './types';

/** What the planner needs to know about an artboard beyond where it is. */
export interface TierInput extends ArtboardBox {
  tier: Tier;
  /** When it was last on screen (ms, same clock as `now`); 0 for never. */
  seen: number;
  /** There is a still to show: a settle has run, or the page was live and unloaded. */
  hasSnapshot: boolean;
  /** There is a thumbnail to show. */
  hasThumb: boolean;
}

export interface TierPlanInput {
  boards: readonly TierInput[];
  view: ViewRect;
  z: number;
  budget: LiveBudget;
  /** The artboard holding the selection: live wherever it is. */
  focus: string | null;
  /** The panel is on screen and the browser tab is visible. Inactive, nothing is live. */
  active: boolean;
  now: number;
}

export interface TierPlan {
  tiers: Map<string, Tier>;
  /** On screen now, so their `seen` becomes `now`. */
  onScreen: Set<string>;
  /** The artboards around the view, nearest the middle first: the order background jobs go in. */
  near: string[];
  /** When the next artboard kept live by the grace period runs out, if one is, in ms from `now`. */
  nextExpiry: number | null;
}

/** Around the view by this much of its size, stills and thumbnails are mounted ahead of time. */
const PREFETCH_MARGIN = 0.25;

/**
 * Which artboards are live, stills, thumbnails, placeholders or nothing.
 *
 * Live: the selected artboard, then the artboards on screen nearest the middle while the budget
 * lasts, at `zLive` zoom or more; then artboards still inside their grace period after leaving the
 * screen, most recently seen first. Everything else near the view is a still where it has one at
 * that zoom, else a thumbnail, else a placeholder; the rest hold nothing.
 */
export function planTiers({ boards, view, z, budget, focus, active, now }: TierPlanInput): TierPlan {
  const near = visibleArtboards(boards, view, PREFETCH_MARGIN).sort((a, b) => centreDistance(a, view) - centreDistance(b, view));
  const onScreen = new Set(visibleArtboards(boards, view, 0).map((b) => b.id));
  const seen = (b: TierInput) => (onScreen.has(b.id) ? now : b.seen);

  const live = new Set<string>();
  if (active) {
    if (focus && boards.some((b) => b.id === focus)) live.add(focus);
    if (z >= budget.zLive) {
      for (const b of near) {
        if (live.size >= budget.maxLive) break;
        if (onScreen.has(b.id)) live.add(b.id);
      }
      const recent = boards
        .filter((b) => b.tier === 'live' && !live.has(b.id) && now - seen(b) < budget.graceMs)
        .sort((a, b) => seen(b) - seen(a));
      for (const b of recent) {
        if (live.size >= budget.maxLive) break;
        live.add(b.id);
      }
    }
  }

  const nearIds = new Set(near.map((b) => b.id));
  const tiers = new Map<string, Tier>();
  for (const b of boards) {
    let tier: Tier = 'none';
    if (live.has(b.id)) tier = 'live';
    else if (nearIds.has(b.id)) {
      if (z >= budget.zLive && b.hasSnapshot) tier = 'still';
      else if (b.hasThumb) tier = 'image';
      else if (b.hasSnapshot && z >= budget.zLive * 0.6) tier = 'still';
      else tier = 'placeholder';
    }
    tiers.set(b.id, tier);
  }

  const waits = boards
    .filter((b) => live.has(b.id) && !onScreen.has(b.id) && b.id !== focus)
    .map((b) => seen(b) + budget.graceMs - now);
  return { tiers, onScreen, near: near.map((b) => b.id), nextExpiry: waits.length ? Math.max(0, Math.min(...waits)) : null };
}
