'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface HeatmapPoint {
  x: number;
  y: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  documentHeight: number;
  elementSelector?: string;
  timestamp: string;
}

interface ClickHeatmapData {
  type: 'click';
  page: string;
  sampleSize: number;
  points: HeatmapPoint[];
}

interface ScrollHeatmapData {
  type: 'scroll';
  page: string;
  sampleSize: number;
  depthDistribution: Record<number, number>;
  rawData: Array<{
    scrollDepth: number;
    timeOnPage: number;
    timestamp: string;
  }>;
}

type HeatmapData = ClickHeatmapData | ScrollHeatmapData;

interface HeatmapViewerProps {
  deploymentId: string;
  pages: string[]; // Available pages to select from
}

export function HeatmapViewer({ deploymentId, pages }: HeatmapViewerProps) {
  const tc = useTranslations('common');
  const t = useTranslations('heatmap');
  const tb = useTranslations('backend');
  const [selectedPage, setSelectedPage] = useState<string>(pages[0] || '/');
  const [deviceFilter, setDeviceFilter] = useState<'all' | 'mobile' | 'tablet' | 'desktop'>('all');
  const [data, setData] = useState<HeatmapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  // Cache screenshots by page to avoid re-capturing
  const [screenshotCache, setScreenshotCache] = useState<Record<string, string>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fetch heatmap data
  const fetchHeatmapData = async () => {
    if (!selectedPage) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: selectedPage,
        type: 'click',
      });

      if (deviceFilter !== 'all') {
        params.set('device', deviceFilter);
      }

      const response = await fetch(`/api/analytics/${deploymentId}/heatmap?${params}`);
      if (!response.ok) throw new Error('Failed to fetch heatmap data');

      const heatmapData: HeatmapData = await response.json();
      setData(heatmapData);
    } catch (error) {
      console.error('Failed to fetch heatmap data:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Load data when page or device filter changes
  useEffect(() => {
    fetchHeatmapData();

    // Check if we have a cached screenshot for this page and device
    const cacheKey = `${selectedPage}-${deviceFilter}`;
    if (screenshotCache[cacheKey]) {
      setScreenshotDataUrl(screenshotCache[cacheKey]);
    } else {
      setScreenshotDataUrl(null);
    }
  }, [selectedPage, deviceFilter, deploymentId]);

  // Rendered from the build in a sandboxed frame, like the deployment thumbnail, so the published
  // page's code never runs where the studio could be reached from it.
  const captureScreenshot = async () => {
    setScreenshotLoading(true);
    try {
      const { captureDeploymentPage } = await import('@/lib/utils/deployment-thumbnail');

      // Determine capture dimensions based on device filter
      let captureWidth = 1280;
      let captureHeight = 720;

      if (deviceFilter === 'mobile') {
        captureWidth = 375;
        captureHeight = 667; // iPhone SE size
      } else if (deviceFilter === 'tablet') {
        captureWidth = 768;
        captureHeight = 1024; // iPad size
      }
      // 'all' and 'desktop' use default 1280x720

      const dataUrl = await captureDeploymentPage(deploymentId, {
        pagePath: selectedPage,
        captureWidth,
        captureHeight,
        fullPage: true,
      });

      if (dataUrl) {
        setScreenshotDataUrl(dataUrl);
        // Cache the screenshot for this page and device
        const cacheKey = `${selectedPage}-${deviceFilter}`;
        setScreenshotCache(prev => ({ ...prev, [cacheKey]: dataUrl }));
      } else {
        toast.error(t('captureFailed'));
      }
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
      toast.error(t('capturePageFailed'));
    } finally {
      setScreenshotLoading(false);
    }
  };

  // Render click heatmap on canvas with screenshot background
  useEffect(() => {
    if (!canvasRef.current || !data || data.type !== 'click' || !screenshotDataUrl) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Load screenshot image
    const img = new Image();
    img.onload = () => {
      // Set canvas size to screenshot size
      canvas.width = img.width;
      canvas.height = img.height;

      // Draw screenshot as background
      ctx.drawImage(img, 0, 0);

      // Calculate absolute Y positions and scale to screenshot dimensions
      const screenshotWidth = canvas.width;

      const transformedPoints = data.points.map((point) => {
        // Scale factor based on viewport width where click was recorded vs screenshot width
        const scale = screenshotWidth / point.viewportWidth;

        // Handle missing or invalid scrollY with fallback to 0
        const scrollY = Number.isFinite(point.scrollY) ? point.scrollY : 0;

        return {
          x: point.x * scale,
          y: (point.y + scrollY) * scale, // Absolute Y position, scaled
          viewportWidth: point.viewportWidth,
          scale,
        };
      });

      const points = transformedPoints
        // Filter out invalid coordinates (NaN, Infinity, negative, etc.)
        .filter((point) => {
          return (
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            point.x >= 0 &&
            point.y >= 0 &&
            point.x <= canvas.width &&
            point.y <= canvas.height
          );
        });

      // Draw heatmap using radial gradients
      points.forEach((point) => {
        // Scale radius too
        const radius = 40 * point.scale;

        const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
        gradient.addColorStop(0, 'rgba(255, 0, 0, 0.7)');
        gradient.addColorStop(0.5, 'rgba(255, 165, 0, 0.5)');
        gradient.addColorStop(1, 'rgba(255, 255, 0, 0)');

        ctx.fillStyle = gradient;
        ctx.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
      });
    };
    img.src = screenshotDataUrl;
  }, [data, screenshotDataUrl]);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex gap-4 items-end flex-wrap">
        <div className="min-w-48">
          <Label htmlFor="page-select">{tb('page')}</Label>
          <Select value={selectedPage} onValueChange={setSelectedPage}>
            <SelectTrigger id="page-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pages.map((page) => (
                <SelectItem key={page} value={page}>
                  {page}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-36">
          <Label htmlFor="device-select">{t('device')}</Label>
          <Select value={deviceFilter} onValueChange={(value) => setDeviceFilter(value as any)}>
            <SelectTrigger id="device-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allDevices')}</SelectItem>
              <SelectItem value="mobile">{t('mobile')}</SelectItem>
              <SelectItem value="tablet">{t('tablet')}</SelectItem>
              <SelectItem value="desktop">{t('desktop')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button onClick={fetchHeatmapData} disabled={loading}>
          {loading ? tc('loading') : tc('actions.refresh')}
        </Button>
      </div>

      {/* Sample Size */}
      {data && (
        <div className="text-sm text-muted-foreground">
          {t.rich('sampleSizeCount', { count: data.sampleSize, b: (chunks) => <span className="font-medium">{chunks}</span> })}
        </div>
      )}

      {/* Visualization */}
      {loading && (
        <div className="flex items-center justify-center h-96 border rounded-lg">
          <p className="text-muted-foreground">{t('loading')}</p>
        </div>
      )}

      {!loading && data && data.type === 'click' && (
        <div className="border rounded-lg overflow-hidden">
          {!screenshotDataUrl && !screenshotLoading && (
            <div className="p-8 text-center">
              <p className="text-muted-foreground mb-4">{t('captureHint')}</p>
              <Button onClick={captureScreenshot}>{t('capturePage')}</Button>
            </div>
          )}

          {screenshotLoading && (
            <div className="p-8 text-center">
              <p className="text-muted-foreground">{t('capturing')}</p>
            </div>
          )}

          {screenshotDataUrl && (
            <>
              <div className="bg-muted/30 p-4 overflow-auto" style={{ maxHeight: '70vh' }}>
                <canvas
                  ref={canvasRef}
                  className="mx-auto"
                  style={{ maxWidth: '100%', height: 'auto' }}
                />
              </div>

              <div className="p-4 bg-muted text-sm border-t">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium mb-2">{t('legendTitle')}</p>
                    <div className="flex gap-4">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded bg-red-500/70" />
                        <span>{t('highActivity')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded bg-orange-500/50" />
                        <span>{t('mediumActivity')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded bg-yellow-500/20" />
                        <span>{t('lowActivity')}</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <Button variant="outline" size="sm" onClick={captureScreenshot}>
                      {t('recapture')}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}

        </div>
      )}

      {!loading && !data && (
        <div className="flex items-center justify-center h-96 border rounded-lg">
          <p className="text-muted-foreground">{t('noData')}</p>
        </div>
      )}
    </div>
  );
}
