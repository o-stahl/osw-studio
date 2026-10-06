'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface EngagementMetrics {
  timeOnPage: {
    average: number;
    median: number;
    distribution: Record<string, number>;
  };
  scrollDepth: {
    average: number;
    milestones: Record<number, number>;
  };
  exitPages: Array<{
    page: string;
    exitCount: number;
    exitRate: number;
  }>;
  topLandingPages: Array<{
    page: string;
    visitCount: number;
    bounceRate: number;
  }>;
}

interface EngagementMetricsProps {
  deploymentId: string;
}

export function EngagementMetrics({ deploymentId }: EngagementMetricsProps) {
  const tc = useTranslations('common');
  const t = useTranslations('engagement');
  const { number } = useLocalFormat();
  const [data, setData] = useState<EngagementMetrics | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch engagement metrics
  const fetchEngagementMetrics = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/analytics/${deploymentId}/engagement`);
      if (!response.ok) throw new Error('Failed to fetch engagement metrics');

      const metrics: EngagementMetrics = await response.json();
      setData(metrics);
    } catch (error) {
      console.error('Failed to fetch engagement metrics:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Load data on mount
  useEffect(() => {
    fetchEngagementMetrics();
  }, [deploymentId]);

  // Format duration
  const unit = (value: number, name: 'minute' | 'second') =>
    number(value, { style: 'unit', unit: name, unitDisplay: 'narrow' });
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return unit(seconds, 'second');
    return `${unit(Math.floor(seconds / 60), 'minute')} ${unit(seconds % 60, 'second')}`;
  };
  const percent = (fraction: number) =>
    number(fraction, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96 border rounded-lg">
        <p className="text-muted-foreground">{t('loading')}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-96 border rounded-lg">
        <p className="text-muted-foreground">{t('noData')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Time on Page Overview */}
      <div className="grid grid-cols-2 gap-4">
        <div className="border rounded-lg p-4">
          <div className="text-sm text-muted-foreground mb-1">{t('avgTime')}</div>
          <div className="text-2xl font-bold">{formatDuration(data.timeOnPage.average)}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-sm text-muted-foreground mb-1">{t('medianTime')}</div>
          <div className="text-2xl font-bold">{formatDuration(data.timeOnPage.median)}</div>
        </div>
      </div>

      {/* Time on Page by Page */}
      <div className="border rounded-lg p-4">
        <h3 className="font-medium mb-4">{t('timeByPath')}</h3>
        <div className="space-y-2">
          {Object.entries(data.timeOnPage.distribution)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([page, time]) => (
              <div key={page} className="flex justify-between items-center">
                <span className="text-sm truncate flex-1">{page}</span>
                <span className="text-sm font-medium ml-4">{formatDuration(time)}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Scroll Depth */}
      <div className="border rounded-lg p-4">
        <h3 className="font-medium mb-4">{t('scrollFunnel')}</h3>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground mb-2">
            {t.rich('average', { value: number(data.scrollDepth.average, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), b: (chunks) => <span className="font-medium text-foreground">{chunks}</span> })}
          </div>
          {(() => {
            const milestones = [25, 50, 75, 100];
            // Calculate cumulative counts (users who reached AT LEAST this depth)
            const cumulativeCounts = milestones.map((milestone) => {
              // Sum all events at this milestone and above
              return milestones
                .filter((m) => m >= milestone)
                .reduce((sum, m) => sum + (Number(data.scrollDepth.milestones[m]) || 0), 0);
            });

            const maxCount = Number(cumulativeCounts[0]) || 1; // Max is "reached 25%+"

            return milestones.map((milestone, index) => {
              const count = Number(cumulativeCounts[index]) || 0;
              const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;

              return (
                <div key={milestone}>
                  <div className="flex justify-between text-sm mb-1">
                    <span>{t('reached', { milestone })}</span>
                    <span className="text-muted-foreground">
                      {number(count)} ({percent(percentage / 100)})
                    </span>
                  </div>
                  <div className="h-6 bg-muted rounded overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* Top Landing Pages */}
      <div className="border rounded-lg p-4">
        <h3 className="font-medium mb-4">{t('topLanding')}</h3>
        <div className="space-y-2">
          {data.topLandingPages.slice(0, 10).map((landing) => (
            <div key={landing.page} className="flex justify-between items-center border-b pb-2">
              <div className="flex-1">
                <div className="text-sm font-medium">{landing.page}</div>
                <div className="text-xs text-muted-foreground">
                  {t('visits', { count: landing.visitCount })}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm">
                  <span className={landing.bounceRate > 0.7 ? 'text-red-500' : landing.bounceRate > 0.4 ? 'text-orange-500' : 'text-green-500'}>
                    {percent(landing.bounceRate)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">{t('bounceRate')}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Exit Pages */}
      <div className="border rounded-lg p-4">
        <h3 className="font-medium mb-4">{t('topExit')}</h3>
        <div className="space-y-2">
          {data.exitPages.slice(0, 10).map((exit) => (
            <div key={exit.page} className="flex justify-between items-center">
              <span className="text-sm truncate flex-1">{exit.page}</span>
              <div className="text-right ml-4">
                <div className="text-sm font-medium">{number(exit.exitCount)}</div>
                <div className="text-xs text-muted-foreground">
                  {t('exitRate', { rate: percent(exit.exitRate) })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Refresh Button */}
      <div className="flex justify-end">
        <Button onClick={fetchEngagementMetrics} disabled={loading}>
          {loading ? tc('loading') : tc('actions.refresh')}
        </Button>
      </div>
    </div>
  );
}
