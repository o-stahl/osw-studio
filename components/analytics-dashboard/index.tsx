'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Deployment } from '@/lib/vfs/types';
import { getLoginUrl } from '@/lib/config/storage';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HeatmapViewer } from '@/components/heatmap-viewer';
import { SessionViewer } from '@/components/session-viewer';
import { EngagementMetrics } from '@/components/engagement-metrics';
import { BarChart3, MousePointerClick, Users, Activity, Download, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface AnalyticsDashboardProps {
  deployment: Deployment;
  isOpen: boolean;
  onClose: () => void;
}

interface AnalyticsOverview {
  totalPageviews: number;
  uniqueVisitors: number;
  averageTimeOnSite: number;
  bounceRate: number;
  topPages: Array<{ page: string; views: number }>;
  topReferrers: Array<{ referrer: string; count: number }>;
  deviceBreakdown: Record<string, number>;
  countryBreakdown: Record<string, number>;
}

interface StorageInfo {
  totalMB: number;
  breakdown: {
    pageviews: { count: number; sizeMB: number };
    interactions: { count: number; sizeMB: number };
    sessions: { count: number; sizeMB: number };
  };
}

export function AnalyticsDashboard({ deployment, isOpen, onClose }: AnalyticsDashboardProps) {
  const t = useTranslations('analytics');
  const tc = useTranslations('common');
  const th = useTranslations('heatmap');
  const deviceLabel = (device: string) =>
    device === 'mobile' || device === 'tablet' || device === 'desktop' ? th(device) : device;
  const { number } = useLocalFormat();
  const [activeTab, setActiveTab] = useState('overview');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [notPublished, setNotPublished] = useState(false);

  useEffect(() => {
    if (!deployment) return;

    // The parent keeps this mounted for any selected deployment, so the settings and server-settings
    // dialogs mount it too. Without this guard it fetched — and toasted on failure — from behind
    // those dialogs. A null render is not enough: effects run regardless of what render returns.
    if (!isOpen) return;

    // Check if deployment has been published (database enabled)
    if (!deployment.databaseEnabled) {
      setNotPublished(true);
      setLoading(false);
      return;
    }

    setNotPublished(false);
    fetchOverview();
    fetchStorage();
  }, [isOpen, deployment?.id, deployment?.databaseEnabled]);

  const fetchOverview = async () => {
    if (!deployment) return;
    try {
      setLoading(true);
      const response = await fetch(`/api/analytics/${deployment.id}/overview`);

      if (response.status === 401) {
        window.location.href = getLoginUrl();
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('API Error:', response.status, errorData);
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data: AnalyticsOverview = await response.json();
      setOverview(data);

      const uniquePages = Array.from(new Set(data.topPages.map(p => p.page)));
      setPages(uniquePages);
    } catch (error) {
      console.error('Failed to fetch analytics overview:', error);
      toast.error(t('loadOverviewFailed', { error: error instanceof Error ? error.message : tc('labels.unknown') }));
    } finally {
      setLoading(false);
    }
  };

  const fetchStorage = async () => {
    if (!deployment) return;
    try {
      const response = await fetch(`/api/analytics/${deployment.id}/storage`);

      if (response.status === 401) {
        window.location.href = getLoginUrl();
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Storage API Error:', response.status, errorData);
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data: StorageInfo = await response.json();
      setStorage(data);
    } catch (error) {
      console.error('Failed to fetch storage info:', error);
      toast.error(t('loadStorageFailed', { error: error instanceof Error ? error.message : tc('labels.unknown') }));
    }
  };

  const handleExport = async () => {
    if (!deployment) return;
    try {
      const response = await fetch(`/api/analytics/${deployment.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv', type: 'all' }),
      });

      if (response.status === 401) {
        window.location.href = getLoginUrl();
        return;
      }

      if (!response.ok) throw new Error('Failed to export data');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `analytics-${deployment.id}-${Date.now()}.csv`; // i18n-ignore: a filename
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      toast.success(t('exported'));
    } catch (error) {
      console.error('Failed to export analytics:', error);
      toast.error(t('exportFailed'));
    }
  };

  const handleClearData = async () => {
    if (!deployment) return;
    if (!confirm(t('confirmClear'))) {
      return;
    }

    try {
      const response = await fetch(`/api/analytics/${deployment.id}/clear?type=all`, {
        method: 'DELETE',
      });

      if (response.status === 401) {
        window.location.href = getLoginUrl();
        return;
      }

      if (!response.ok) throw new Error('Failed to clear data');

      toast.success(t('cleared'));
      fetchOverview();
      fetchStorage();
    } catch (error) {
      console.error('Failed to clear analytics:', error);
      toast.error(t('clearFailed'));
    }
  };

  const unit = (value: number, name: 'minute' | 'second') =>
    number(value, { style: 'unit', unit: name, unitDisplay: 'narrow' });
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return unit(seconds, 'second');
    return `${unit(Math.floor(seconds / 60), 'minute')} ${unit(seconds % 60, 'second')}`;
  };
  const percent = (fraction: number) =>
    number(fraction, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

  if (!deployment) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[64rem] h-[90vh] p-0 flex flex-col">
        <div className="border-b px-6 py-4 flex items-center justify-between">
          <DialogHeader className="space-y-1">
            <DialogTitle className="text-2xl">{t('dashboard')}</DialogTitle>
            <DialogDescription>{deployment.name || deployment.id}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExport} disabled={notPublished}>
              <Download className="h-4 w-4 mr-2" />
              {tc('actions.export')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleClearData} disabled={notPublished}>
              <Trash2 className="h-4 w-4 mr-2" />
              {t('clearData')}
            </Button>
          </div>
        </div>

        {storage && (
        <div className="border-b px-6 py-2 bg-muted/50 text-sm">
          <span className="text-muted-foreground">{t('storage')}</span>{' '}
          <span className="font-medium">{number(storage.totalMB, { style: 'unit', unit: 'megabyte', minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          {' • '}
          <span className="text-muted-foreground">{t('pageviews')}</span>{' '}
          <span className="font-medium">{number(storage.breakdown.pageviews.count)}</span>
          {' • '}
          <span className="text-muted-foreground">{t('interactions')}</span>{' '}
          <span className="font-medium">{number(storage.breakdown.interactions.count)}</span>
          {' • '}
          <span className="text-muted-foreground">{t('sessionsCount')}</span>{' '}
          <span className="font-medium">{number(storage.breakdown.sessions.count)}</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <div className="border-b px-6">
            <TabsList>
              <TabsTrigger value="overview">
                <BarChart3 className="h-4 w-4 mr-2" />
                {t('overview')}
              </TabsTrigger>
              <TabsTrigger value="heatmaps">
                <MousePointerClick className="h-4 w-4 mr-2" />
                {t('heatmaps')}
              </TabsTrigger>
              <TabsTrigger value="sessions">
                <Users className="h-4 w-4 mr-2" />
                {t('sessions')}
              </TabsTrigger>
              <TabsTrigger value="engagement">
                <Activity className="h-4 w-4 mr-2" />
                {t('engagement')}
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-auto">
            <TabsContent value="overview" className="p-6 space-y-6">
              {loading && (
                <div className="flex items-center justify-center h-96">
                  <p className="text-muted-foreground">{t('loading')}</p>
                </div>
              )}

              {!loading && notPublished && (
                <div className="flex flex-col items-center justify-center h-96 text-center">
                  <BarChart3 className="h-16 w-16 text-muted-foreground/50 mb-4" />
                  <h3 className="text-lg font-medium mb-2">{t('notAvailable')}</h3>
                  <p className="text-muted-foreground max-w-md">
                    {t('notAvailableHint')}
                  </p>
                </div>
              )}

              {!loading && !notPublished && overview && (
                <>
                  <div className="grid grid-cols-4 gap-4">
                    <div className="border rounded-lg p-4">
                      <div className="text-sm text-muted-foreground">{t('totalPageviews')}</div>
                      <div className="text-2xl font-bold">{number(overview.totalPageviews)}</div>
                    </div>
                    <div className="border rounded-lg p-4">
                      <div className="text-sm text-muted-foreground">{t('uniqueVisitors')}</div>
                      <div className="text-2xl font-bold">{number(overview.uniqueVisitors)}</div>
                    </div>
                    <div className="border rounded-lg p-4">
                      <div className="text-sm text-muted-foreground">{t('avgTime')}</div>
                      <div className="text-2xl font-bold">{formatDuration(overview.averageTimeOnSite)}</div>
                    </div>
                    <div className="border rounded-lg p-4">
                      <div className="text-sm text-muted-foreground">{t('bounceRate')}</div>
                      <div className="text-2xl font-bold">{percent(overview.bounceRate)}</div>
                    </div>
                  </div>

                  <div className="border rounded-lg p-4">
                    <h3 className="font-medium mb-4">{t('topPages')}</h3>
                    <div className="space-y-2">
                      {overview.topPages.map((page) => (
                        <div key={page.page} className="flex justify-between items-center">
                          <span className="text-sm truncate flex-1">{page.page}</span>
                          <span className="text-sm font-medium ml-4">{number(page.views)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border rounded-lg p-4">
                    <h3 className="font-medium mb-4">{t('topReferrers')}</h3>
                    <div className="space-y-2">
                      {overview.topReferrers.map((referrer) => (
                        <div key={referrer.referrer} className="flex justify-between items-center">
                          <span className="text-sm truncate flex-1">
                            {referrer.referrer || t('directReferrer')}
                          </span>
                          <span className="text-sm font-medium ml-4">{number(referrer.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border rounded-lg p-4">
                    <h3 className="font-medium mb-4">{t('deviceBreakdown')}</h3>
                    <div className="space-y-2">
                      {Object.entries(overview.deviceBreakdown).map(([device, count]) => {
                        const total = Object.values(overview.deviceBreakdown).reduce((sum, c) => sum + c, 0);
                        const percentage = total > 0 ? (count / total) * 100 : 0;

                        return (
                          <div key={device}>
                            <div className="flex justify-between text-sm mb-1">
                              <span>{deviceLabel(device)}</span>
                              <span className="text-muted-foreground">
                                {number(count)} ({percent(percentage / 100)})
                              </span>
                            </div>
                            <div className="h-6 bg-muted rounded overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${percentage}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="heatmaps" className="p-6">
              {notPublished ? (
                <div className="flex flex-col items-center justify-center h-96 text-center">
                  <MousePointerClick className="h-16 w-16 text-muted-foreground/50 mb-4" />
                  <h3 className="text-lg font-medium mb-2">{t('heatmapsUnavailable')}</h3>
                  <p className="text-muted-foreground max-w-md">
                    {t('collectedAfterPublish')}
                  </p>
                </div>
              ) : (
                <HeatmapViewer deploymentId={deployment.id} pages={pages} />
              )}
            </TabsContent>

            <TabsContent value="sessions" className="p-6">
              {notPublished ? (
                <div className="flex flex-col items-center justify-center h-96 text-center">
                  <Users className="h-16 w-16 text-muted-foreground/50 mb-4" />
                  <h3 className="text-lg font-medium mb-2">{t('sessionsUnavailable')}</h3>
                  <p className="text-muted-foreground max-w-md">
                    {t('collectedAfterPublish')}
                  </p>
                </div>
              ) : (
                <SessionViewer deploymentId={deployment.id} />
              )}
            </TabsContent>

            <TabsContent value="engagement" className="p-6">
              {notPublished ? (
                <div className="flex flex-col items-center justify-center h-96 text-center">
                  <Activity className="h-16 w-16 text-muted-foreground/50 mb-4" />
                  <h3 className="text-lg font-medium mb-2">{t('engagementUnavailable')}</h3>
                  <p className="text-muted-foreground max-w-md">
                    {t('collectedAfterPublish')}
                  </p>
                </div>
              ) : (
                <EngagementMetrics deploymentId={deployment.id} />
              )}
            </TabsContent>
          </div>
        </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
