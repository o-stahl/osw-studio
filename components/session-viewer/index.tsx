'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

interface SessionPage {
  path: string;
  timestamp: string;
  duration?: number;
}

interface SessionJourney {
  sessionId: string;
  pages: SessionPage[];
  entryPage: string;
  exitPage: string;
  pageCount: number;
  totalDuration: number;
  isBounce: boolean;
  createdAt: string;
  endedAt: string;
}

interface FlowNode {
  id: string;
  label: string;
  value: number;
}

interface FlowLink {
  source: string;
  target: string;
  value: number;
}

interface FlowData {
  nodes: FlowNode[];
  links: FlowLink[];
}

interface SessionData {
  sessions: SessionJourney[];
  flowData: FlowData;
  summary: {
    totalSessions: number;
    bounceRate: number;
    averageDuration: number;
    averagePageCount: number;
  };
}

interface SessionViewerProps {
  deploymentId: string;
}

export function SessionViewer({ deploymentId }: SessionViewerProps) {
  const t = useTranslations('analytics.sessionViewer');
  const ta = useTranslations('analytics');
  const format = useLocalFormat();
  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionJourney | null>(null);

  // Fetch session data
  const fetchSessionData = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/analytics/${deploymentId}/sessions?limit=100`);
      if (!response.ok) throw new Error('Failed to fetch session data');

      const sessionData: SessionData = await response.json();
      setData(sessionData);
    } catch (error) {
      console.error('Failed to fetch session data:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Load data on mount
  useEffect(() => {
    fetchSessionData();
  }, [deploymentId]);

  // Format duration
  // Unit abbreviations are the locale's, not English: Finnish writes "min" (an "m" is metres) and
  // Korean "분"/"초".
  const unit = (value: number, name: 'minute' | 'second') =>
    format.number(value, { style: 'unit', unit: name, unitDisplay: 'narrow' });
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return unit(seconds, 'second');
    return `${unit(Math.floor(seconds / 60), 'minute')} ${unit(seconds % 60, 'second')}`;
  };
  const formatDate = (value: string) => format.dateTime(new Date(value), { dateStyle: 'short', timeStyle: 'medium' });

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      {data && data.summary && (
        <div className="grid grid-cols-4 gap-4">
          <div className="border rounded-lg p-4">
            <div className="text-sm text-muted-foreground">{t('totalSessions')}</div>
            <div className="text-2xl font-bold">{format.number(data.summary.totalSessions || 0)}</div>
          </div>
          <div className="border rounded-lg p-4">
            <div className="text-sm text-muted-foreground">{ta('bounceRate')}</div>
            <div className="text-2xl font-bold">{format.number(data.summary.bounceRate || 0, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })}</div>
          </div>
          <div className="border rounded-lg p-4">
            <div className="text-sm text-muted-foreground">{t('avgDuration')}</div>
            <div className="text-2xl font-bold">{formatDuration(data.summary.averageDuration || 0)}</div>
          </div>
          <div className="border rounded-lg p-4">
            <div className="text-sm text-muted-foreground">{t('avgPagesPerSession')}</div>
            <div className="text-2xl font-bold">{format.number(data.summary.averagePageCount || 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</div>
          </div>
        </div>
      )}

      {/* Flow Visualization */}
      {data && data.flowData && (
        <div className="border rounded-lg p-4">
          <h3 className="font-medium mb-4">{t('pageFlow')}</h3>
          <div className="space-y-2">
            {/* Simple flow visualization */}
            {data.flowData.nodes.slice(0, 10).map((node, index) => {
              const outgoingLinks = data.flowData.links.filter((l) => l.source === node.id);
              const incomingLinks = data.flowData.links.filter((l) => l.target === node.id);

              return (
                <div key={node.id} className="border rounded p-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium">{node.label}</span>
                    <span className="text-sm text-muted-foreground">{t('visits', { count: node.value })}</span>
                  </div>

                  {/* Incoming links */}
                  {incomingLinks.length > 0 && (
                    <div className="text-xs text-muted-foreground mb-1">
                      {t('linksFrom', {
                        pages: incomingLinks.slice(0, 3).map((l) => l.source).join(', '),
                        more: Math.max(incomingLinks.length - 3, 0),
                      })}
                    </div>
                  )}

                  {/* Outgoing links */}
                  {outgoingLinks.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {t('linksTo', {
                        pages: outgoingLinks.slice(0, 3).map((l) => l.target).join(', '),
                        more: Math.max(outgoingLinks.length - 3, 0),
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Session List */}
      {data && data.sessions.length > 0 && (
        <div className="border rounded-lg">
          <div className="p-4 border-b">
            <h3 className="font-medium">{t('recentSessions')}</h3>
          </div>
          <div className="divide-y max-h-96 overflow-y-auto">
            {data.sessions.slice(0, 50).map((session) => (
              <div
                key={session.sessionId}
                className="p-4 hover:bg-muted cursor-pointer"
                onClick={() => setSelectedSession(session)}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {session.entryPage} → {session.exitPage}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(session.createdAt)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm">{t('pageCount', { count: session.pageCount })}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDuration(session.totalDuration)}
                    </div>
                  </div>
                </div>

                {session.isBounce && (
                  <div className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-red-100 text-red-800">
                    {t('bounce')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Session Details Modal */}
      {selectedSession && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setSelectedSession(null)}
        >
          <div
            className="bg-background border rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-medium">{t('sessionJourney')}</h3>
              <Button variant="ghost" size="sm" onClick={() => setSelectedSession(null)} aria-label={t('close')}>
                ✕
              </Button>
            </div>

            <div className="space-y-4">
              {/* Session metadata */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">{t('started')}</span>{' '}
                  {formatDate(selectedSession.createdAt)}
                </div>
                <div>
                  <span className="text-muted-foreground">{t('ended')}</span>{' '}
                  {formatDate(selectedSession.endedAt)}
                </div>
                <div>
                  <span className="text-muted-foreground">{t('totalDuration')}</span>{' '}
                  {formatDuration(selectedSession.totalDuration)}
                </div>
                <div>
                  <span className="text-muted-foreground">{t('pagesVisited')}</span>{' '}
                  {format.number(selectedSession.pageCount)}
                </div>
              </div>

              {/* Journey timeline */}
              <div className="border-t pt-4">
                <h4 className="font-medium mb-3">{t('pageJourney')}</h4>
                <div className="space-y-3">
                  {selectedSession.pages.map((page, index) => (
                    <div key={index} className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-medium">
                          {index + 1}
                        </div>
                        {index < selectedSession.pages.length - 1 && (
                          <div className="w-0.5 h-8 bg-border" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium">{page.path}</div>
                        <div className="text-xs text-muted-foreground">
                          {format.dateTime(page.timestamp, { timeStyle: 'medium' })}
                          {page.duration && ` • ${formatDuration(page.duration)}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center h-96 border rounded-lg">
          <p className="text-muted-foreground">{t('loading')}</p>
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
