'use client';

import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { TableOfContents } from '@/components/table-of-contents';
import { useTableOfContents } from '@/lib/hooks/use-table-of-contents';
import { AlertCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { DOCS_ITEMS } from '@/lib/constants/docs';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { DocsPageActions } from '@/components/docs-page-actions';

function DocsViewContent() {
  const tc = useTranslations('common');
  const td = useTranslations('docs');
  const searchParams = useSearchParams();
  const docId = searchParams.get('doc') || 'overview';

  const selectedDoc = DOCS_ITEMS.find(d => d.id === docId) || DOCS_ITEMS[0];
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [visibleIds, setVisibleIds] = useState<string[]>([]);

  const isManualScrolling = useRef(false);
  const scrollDebounceTimer = useRef<NodeJS.Timeout | null>(null);

  const tocItems = useTableOfContents(content);

  useEffect(() => {
    // Guard against out-of-order responses: if the user switches docs while a fetch is
    // in flight, an earlier request resolving later must not overwrite the newer doc's
    // content (which showed the wrong doc's body under the current title).
    let cancelled = false;

    async function loadDoc() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/docs/${selectedDoc.file}`);
        if (cancelled) return;
        if (!response.ok) {
          throw new Error(td('loadFailed', { status: response.statusText }));
        }
        const text = await response.text();
        if (cancelled) return;
        setContent(text);

        // Scroll to hash if present in URL
        setTimeout(() => {
          if (cancelled) return;
          if (window.location.hash) {
            const element = document.getElementById(window.location.hash.slice(1));
            if (element) {
              element.scrollIntoView({ behavior: 'smooth' });
            }
          } else {
            // Scroll to top if no hash
            const contentArea = document.querySelector('.docs-content-area');
            if (contentArea) {
              contentArea.scrollTop = 0;
            }
          }
        }, 100);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load doc:', err);
        setError(err instanceof Error ? err.message : td('loadDocFailed'));
        setContent('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadDoc();

    return () => { cancelled = true; };
  }, [selectedDoc, td]);

  // Handle TOC item clicks
  const handleTocClick = useCallback((id: string) => {
    // Set active immediately when user clicks
    setActiveId(id);

    // Immediately update visible IDs to include only the clicked item
    // This prevents stale blue highlights during the scroll
    setVisibleIds([id]);

    // Disable auto-tracking during manual scroll
    isManualScrolling.current = true;

    // Re-enable auto-tracking after scroll animation completes
    // and then trigger an immediate update
    setTimeout(() => {
      isManualScrolling.current = false;

      // Trigger immediate recalculation of visible items after scroll completes
      const scrollContainer = document.querySelector('.docs-content-area');
      if (!scrollContainer) return;

      const headings = document.querySelectorAll('.docs-content-area [data-heading-index]');
      if (headings.length === 0) return;

      const containerTop = scrollContainer.getBoundingClientRect().top;
      const visible: string[] = [];

      headings.forEach((heading) => {
        const rect = heading.getBoundingClientRect();
        const viewportTop = containerTop;
        const viewportBottom = viewportTop + scrollContainer.clientHeight;

        if (rect.top >= viewportTop && rect.bottom <= viewportBottom) {
          const index = heading.getAttribute('data-heading-index');
          if (index) {
            visible.push(index);
          }
        }
      });

      setVisibleIds(visible);
    }, 1000); // Smooth scroll takes ~500-800ms, add buffer
  }, []);

  // Scroll-based active section tracking with debouncing
  useEffect(() => {
    if (tocItems.length === 0) return;

    const scrollContainer = document.querySelector('.docs-content-area');
    if (!scrollContainer) return;

    const updateActiveSection = () => {
      // Skip if user is manually scrolling from TOC click
      if (isManualScrolling.current) {
        return;
      }

      // Select headings by data-heading-index attribute for unique identification
      const headings = document.querySelectorAll('.docs-content-area [data-heading-index]');
      if (headings.length === 0) return;

      const containerTop = scrollContainer.getBoundingClientRect().top;

      // Find the heading that's currently at the top of the viewport
      let activeHeading = headings[0];
      let minDistance = Infinity;

      headings.forEach((heading) => {
        const rect = heading.getBoundingClientRect();
        const distance = Math.abs(rect.top - containerTop - 100); // 100px offset

        if (rect.top - containerTop < 200 && distance < minDistance) {
          minDistance = distance;
          activeHeading = heading;
        }
      });

      // Collect IDs of all headings in viewport
      const visible: string[] = [];
      headings.forEach((heading) => {
        const rect = heading.getBoundingClientRect();
        const viewportTop = containerTop;
        const viewportBottom = viewportTop + scrollContainer.clientHeight;

        // Check if heading is in viewport
        if (rect.top >= viewportTop && rect.bottom <= viewportBottom) {
          const index = heading.getAttribute('data-heading-index');
          if (index) {
            visible.push(index);
          }
        }
      });

      // Use data-heading-index as the unique identifier
      const headingIndex = activeHeading?.getAttribute('data-heading-index');
      if (headingIndex) {
        setActiveId(headingIndex);
      }

      // Update visible IDs for TOC range highlighting
      setVisibleIds(visible);
    };

    // Debounced scroll handler
    const handleScroll = () => {
      // Clear existing timer
      if (scrollDebounceTimer.current) {
        clearTimeout(scrollDebounceTimer.current);
      }

      // Set new timer - only update after scrolling stops for 50ms
      scrollDebounceTimer.current = setTimeout(updateActiveSection, 50);
    };

    // Initial update - delay to ensure markdown heading indices are set
    // Increase delay to 500ms to ensure MarkdownRenderer's useEffect completes
    const timeout = setTimeout(() => {
      updateActiveSection();
    }, 500);

    // Update on scroll with debouncing
    scrollContainer.addEventListener('scroll', handleScroll);

    return () => {
      clearTimeout(timeout);
      if (scrollDebounceTimer.current) {
        clearTimeout(scrollDebounceTimer.current);
      }
      scrollContainer.removeEventListener('scroll', handleScroll);
    };
  }, [tocItems, content]);

  const showToc = tocItems.length >= 3;

  return (
    <PageShell>
      <PageHeader title={tc('terms.docs')} maxWidth="max-w-none" className="pb-2" />
      {/* Two-column layout: Content + TOC */}
      <div className={`flex-1 min-h-0 overflow-hidden ${showToc ? 'lg:grid lg:grid-cols-[1fr_280px]' : ''}`}>
        {/* Main Content Area - scrollable */}
        <div className="h-full overflow-y-auto docs-content-area bg-background">
          <div
            className="p-6 sm:p-8 max-w-4xl mx-auto"
            onClick={(e) => {
              // Handle anchor link clicks
              const target = e.target as HTMLElement;
              if (target.tagName === 'A') {
                const href = target.getAttribute('href');
                if (href?.startsWith('#')) {
                  e.preventDefault();
                  const element = document.getElementById(href.slice(1));
                  if (element) {
                    element.scrollIntoView({ behavior: 'smooth' });
                    window.history.pushState(null, '', href);
                  }
                }
              }
            }}
          >
          {loading && (
            <div className="flex items-center justify-center h-screen">
              <div className="text-center">
                <Spinner size={48} className="mx-auto text-primary" />
                <p className="mt-4 text-muted-foreground">{td('loading')}</p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-3 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <div>
                <p className="font-semibold">{td('errorLoading')}</p>
                <p className="text-sm">{error}</p>
              </div>
            </div>
          )}

          {!loading && !error && content && (
            <>
              {/* Document Title */}
              <div className="mb-6 pb-4 border-b">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <selectedDoc.icon className="h-8 w-8 text-primary shrink-0" />
                    <h1 className="text-3xl font-bold">{selectedDoc.title}</h1>
                  </div>
                  <DocsPageActions markdown={content} />
                </div>
              </div>

              {/* Markdown Content */}
              <MarkdownRenderer content={content} />
            </>
          )}
          </div>
        </div>

        {/* Table of Contents Sidebar - independent scrollable column */}
        {showToc && (
          <div className="hidden lg:block h-full overflow-y-auto border-l border-border bg-muted/30">
            <div className="p-6 sticky top-0">
              <TableOfContents items={tocItems} activeId={activeId} visibleIds={visibleIds} onItemClick={handleTocClick} />
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

// Wrapper component with Suspense boundary for Next.js 15
export function DocsView() {
  const td = useTranslations('docs');
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full">{td('loading')}</div>}>
      <DocsViewContent />
    </Suspense>
  );
}
