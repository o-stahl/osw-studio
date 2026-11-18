import { describe, it, expect } from 'vitest';
import { breakpointsOf, offeredScopes, projectBreakpoints, scopeOfWidth, styleBlocksOf } from '../breakpoints';

describe('breakpointsOf', () => {
  it('reads max-width edges in px, em and rem', () => {
    expect(breakpointsOf('@media (max-width: 640px) {} @media screen and (max-width:56rem){} @media (max-width: 30em) {}'))
      .toEqual([640, 896, 480]);
  });

  it('turns a min-width into the edge just below it', () => {
    // `min-width: 768px` starts at 768, so the scope it closes is everything up to 767.
    expect(breakpointsOf('@media (min-width: 768px) {}')).toEqual([767]);
  });

  it('reads both ends of a range, and range syntax either way round', () => {
    expect(breakpointsOf('@media (min-width: 768px) and (max-width: 1023px) {}')).toEqual([767, 1023]);
    expect(breakpointsOf('@media (width <= 640px) {} @media (width >= 1024px) {} @media (640px < width) {}'))
      .toEqual([640, 1023, 640]);
    // A strict `<` and a reversed `<=` each close the scope one pixel lower.
    expect(breakpointsOf('@media (width < 640px) {} @media (768px <= width) {}')).toEqual([639, 767]);
  });

  it('skips commented-out queries, other features and other units', () => {
    expect(breakpointsOf('/* @media (max-width: 999px) {} */ @media (prefers-reduced-motion: reduce) {} @media (max-width: 40vw) {}'))
      .toEqual([]);
  });
});

describe('projectBreakpoints', () => {
  it('merges every source, each edge once, widest first', () => {
    expect(projectBreakpoints(['@media (max-width: 640px) {}', '@media (max-width: 1024px) {} @media (max-width: 640px) {}']))
      .toEqual([1024, 640]);
  });

  it('finds the queries a page keeps in its <style> blocks', () => {
    const page = '<head><style>@media (max-width: 700px) { .a { color: red } }</style></head>'
      + '<body><style media="screen">@media (max-width: 480px) { .b { color: blue } }</style></body>';
    expect(projectBreakpoints(styleBlocksOf(page))).toEqual([700, 480]);
  });
});

describe('scopeOfWidth', () => {
  const bps = [1024, 640];

  it('is the narrowest breakpoint at or above the width', () => {
    expect(scopeOfWidth(375, bps)).toBe(640);
    expect(scopeOfWidth(640, bps)).toBe(640);
    expect(scopeOfWidth(768, bps)).toBe(1024);
  });

  it('is All widths above every breakpoint, or with none', () => {
    expect(scopeOfWidth(1440, bps)).toBe('all');
    expect(scopeOfWidth(375, [])).toBe('all');
  });

  it('does not depend on the breakpoints arriving widest first', () => {
    expect(scopeOfWidth(375, [640, 1024])).toBe(640);
  });
});

describe('offeredScopes', () => {
  it('offers All widths and the scopes the widths reach, widest first', () => {
    expect(offeredScopes([1024, 640], [375, 768, 1440], 'all')).toEqual(['all', 1024, 640]);
  });

  it('leaves out a breakpoint no width reaches, but keeps the current one', () => {
    // 768 lands in 1024 and 1440 above everything, so no Canvas width is in 1200; a frame 1100 px wide is.
    expect(offeredScopes([1200, 1024, 767, 480], [375, 768, 1440], 'all')).toEqual(['all', 1024, 480]);
    expect(offeredScopes([1200, 1024, 767, 480], [375, 768, 1440], 1200)).toEqual(['all', 1200, 1024, 480]);
  });
});
