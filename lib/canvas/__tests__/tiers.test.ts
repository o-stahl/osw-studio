import { describe, it, expect } from 'vitest';
import { layoutArtboards } from '../layout';
import { planTiers, type TierInput } from '../tiers';
import { DEFAULT_BUDGET, type Tier } from '../types';

const pages = ['/a.html', '/b.html', '/c.html', '/d.html'].map((file) => ({ file, title: file }));
const boxes = layoutArtboards(pages, ['phone', 'tablet', 'desktop'], () => 3000);

function boards(over: Partial<Record<string, Partial<TierInput>>> = {}): TierInput[] {
  return boxes.map((b) => ({ ...b, tier: 'none' as Tier, seen: 0, hasSnapshot: true, hasThumb: true, ...over[b.id] }));
}
/** The first page's three artboards fill the view. */
const pageA = { x: 0, y: 0, w: 375 + 72 + 768 + 72 + 1440, h: 1200 };
const base = { view: pageA, z: 0.5, budget: DEFAULT_BUDGET, focus: null, active: true, now: 100000 };
const live = (plan: ReturnType<typeof planTiers>) => [...plan.tiers].filter(([, t]) => t === 'live').map(([id]) => id);

describe('planTiers', () => {
  it('makes the artboards on screen live', () => {
    expect(live(planTiers({ ...base, boards: boards() }))).toEqual(['/a.html@phone', '/a.html@tablet', '/a.html@desktop']);
  });

  it('holds at most the budget, nearest the middle of the view first', () => {
    const wide = { x: 0, y: 0, w: 12000, h: 1200 };
    const plan = planTiers({ ...base, view: wide, boards: boards() });
    expect(live(plan)).toHaveLength(6);
    // The middle of the view is x = 6000: on /c.html's phone artboard, 326 px from /b.html's desktop
    // one and 341 px from /c.html's tablet one.
    const two = planTiers({ ...base, view: wide, budget: { ...DEFAULT_BUDGET, maxLive: 2 }, boards: boards() });
    expect(live(two)).toEqual(['/b.html@desktop', '/c.html@phone']);
  });

  it('keeps a page that left the screen live through the grace period, then lets it go', () => {
    const away = { x: 20000, y: 0, w: 1000, h: 800 };
    const was = boards({ '/a.html@phone': { tier: 'live', seen: 100000 - 5000 } });
    const kept = planTiers({ ...base, view: away, boards: was });
    expect(live(kept)).toEqual(['/a.html@phone']);
    expect(kept.nextExpiry).toBe(3000);
    expect(live(planTiers({ ...base, view: away, boards: was, now: 100000 + 3001 }))).toEqual([]);
  });

  it('lets the least recently seen go first when over the budget', () => {
    const away = { x: 20000, y: 0, w: 1000, h: 800 };
    const was = boards({
      '/a.html@phone': { tier: 'live', seen: 99000 },
      '/a.html@tablet': { tier: 'live', seen: 98000 },
      '/a.html@desktop': { tier: 'live', seen: 97000 },
    });
    expect(live(planTiers({ ...base, view: away, boards: was, budget: { ...DEFAULT_BUDGET, maxLive: 2 } }))).toEqual(['/a.html@phone', '/a.html@tablet']);
  });

  it('holds nothing live below the zoom threshold, and shows thumbnails there', () => {
    const plan = planTiers({ ...base, z: 0.1, view: { x: 0, y: 0, w: 30000, h: 30000 }, boards: boards() });
    expect(live(plan)).toEqual([]);
    expect(plan.tiers.get('/a.html@phone')).toBe('image');
  });

  it('keeps the selected artboard live wherever it is, even zoomed out', () => {
    const plan = planTiers({ ...base, z: 0.05, view: { x: 20000, y: 0, w: 100, h: 100 }, focus: '/d.html@desktop', boards: boards() });
    expect(live(plan)).toEqual(['/d.html@desktop']);
  });

  it('holds nothing live while the panel or the tab is hidden', () => {
    const plan = planTiers({ ...base, active: false, focus: '/a.html@phone', boards: boards() });
    expect(live(plan)).toEqual([]);
    expect(plan.tiers.get('/a.html@phone')).toBe('still');
  });

  it('shows a still, then a thumbnail, then a placeholder, for what is near but not live', () => {
    const near = { x: 0, y: 0, w: 375, h: 800 };
    const plan = planTiers({ ...base, budget: { ...DEFAULT_BUDGET, maxLive: 1 }, view: near, boards: boards({
      '/a.html@tablet': { hasSnapshot: false },
    }) });
    expect(plan.tiers.get('/a.html@phone')).toBe('live');
    expect(plan.tiers.get('/a.html@tablet')).toBe('image');
    const bare = planTiers({ ...base, budget: { ...DEFAULT_BUDGET, maxLive: 1 }, view: near, boards: boards({
      '/a.html@tablet': { hasSnapshot: false, hasThumb: false },
    }) });
    expect(bare.tiers.get('/a.html@tablet')).toBe('placeholder');
    expect(bare.tiers.get('/d.html@desktop')).toBe('none');
  });

  it('shows a still a little below the live zoom where there is no thumbnail, and a placeholder further out', () => {
    const noThumbs = boards(Object.fromEntries(boxes.map((b) => [b.id, { hasThumb: false }])));
    const at = (z: number) => planTiers({ ...base, z, boards: noThumbs }).tiers.get('/a.html@phone');
    expect(at(DEFAULT_BUDGET.zLive * 0.8)).toBe('still');
    expect(at(DEFAULT_BUDGET.zLive * 0.5)).toBe('placeholder');
  });
});
