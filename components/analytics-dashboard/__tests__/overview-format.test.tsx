// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import type { Deployment } from '@/lib/vfs/types';

/** The overview's figures: time on site in minutes and seconds, device names and shares. */

vi.mock('@/components/heatmap-viewer', () => ({ HeatmapViewer: () => null }));
vi.mock('@/components/session-viewer', () => ({ SessionViewer: () => null }));
vi.mock('@/components/engagement-metrics', () => ({ EngagementMetrics: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AnalyticsDashboard } from '../index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/overview') ? {
    totalPageviews: 10, uniqueVisitors: 4, averageTimeOnSite: 125_000, bounceRate: 0.5,
    topPages: [{ page: '/', views: 10 }], topReferrers: [],
    deviceBreakdown: { mobile: 1, smartwatch: 3 }, countryBreakdown: {},
  } : { totalMB: 0.1, breakdown: { pageviews: { count: 1, sizeMB: 0 }, interactions: { count: 0, sizeMB: 0 }, sessions: { count: 0, sizeMB: 0 } } }), { status: 200 })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('AnalyticsDashboard overview', () => {
  it('words the figures in the interface language', async () => {
    const deployment = { id: 'd1', name: 'Site', databaseEnabled: true } as unknown as Deployment;
    await act(async () => {
      root.render(withMessages(<AnalyticsDashboard deployment={deployment} isOpen onClose={() => {}} />));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // The dashboard renders in a dialog portal.
    const text = document.body.textContent ?? '';
    expect(text).toContain('2m 5s');
    expect(text).toContain('Mobile');
    expect(text).toContain('smartwatch');
    expect(text).toContain('(25.0%)');
    expect(text).toContain('(75.0%)');
  });
});
