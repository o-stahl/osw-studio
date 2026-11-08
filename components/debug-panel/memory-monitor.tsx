'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Tip } from '@/components/ui/tooltip';

interface MemoryInfo {
  usedMB: number;
  totalMB: number;
  percent: number;
}

/**
 * Memory Monitor Component
 * Displays current JS heap memory usage in development mode
 * Only shows in development and on browsers that support performance.memory
 */
export function MemoryMonitor() {
  const t = useTranslations('debug');
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    // Only run in development and in browser
    if (process.env.NODE_ENV !== 'development') {
      return;
    }

    // Check if performance.memory is supported (Chrome only)
    if (typeof window !== 'undefined' && 'memory' in performance) {
      setIsSupported(true);

      const updateMemory = () => {
        const mem = (performance as any).memory;
        if (mem) {
          const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
          const totalMB = Math.round(mem.jsHeapSizeLimit / 1024 / 1024);
          const percent = Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
          setMemory({ usedMB, totalMB, percent });
        }
      };

      // Initial update
      updateMemory();

      // Update every 2 seconds
      const interval = setInterval(updateMemory, 2000);

      return () => clearInterval(interval);
    }
  }, []);

  // Don't render if not in development or not supported
  if (!isSupported || !memory) {
    return null;
  }

  // Color based on memory usage
  const getColor = () => {
    if (memory.percent > 80) return 'text-red-500';
    if (memory.percent > 60) return 'text-yellow-500';
    return 'text-muted-foreground';
  };

  return (
    <Tip label={t('memoryTip', { used: memory.usedMB, limit: memory.totalMB, percent: memory.percent })} side="bottom">
      <div className={`text-xs font-mono ${getColor()} flex items-center gap-1`}>
        <span className="opacity-60">MEM:</span>
        <span>{memory.usedMB}MB</span>
        {memory.percent > 60 && (
          <span className="opacity-60">({memory.percent}%)</span>
        )}
      </div>
    </Tip>
  );
}
