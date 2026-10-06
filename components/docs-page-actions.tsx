'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Copy, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface DocsPageActionsProps {
  /** Raw Markdown source of the document being shown. */
  markdown: string;
}

export function DocsPageActions({ markdown }: DocsPageActionsProps) {
  const tc = useTranslations('common');
  const tda = useTranslations('docsActions');
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copyPage = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(tda('copyFailed'));
    }
  };

  // Served as text/plain from a Blob: browsers download text/markdown instead of showing it.
  const viewMarkdown = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/plain;charset=utf-8' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="flex items-center shrink-0">
      <Button
        variant="outline"
        size="sm"
        onClick={copyPage}
        className="rounded-r-none border-r-0"
        aria-label={tda('copyPage')}
      >
        {copied ? <Check className="h-4 w-4 sm:mr-2" /> : <Copy className="h-4 w-4 sm:mr-2" />}
        <span className="hidden sm:inline">{copied ? tc('labels.copied') : tda('copyPage')}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="rounded-l-none px-2" aria-label={tda('pageActions')}>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={copyPage} className="items-start gap-3 py-2">
            <Copy className="h-4 w-4 mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span>{tda('copyPage')}</span>
              <span className="text-xs text-muted-foreground">{tda('copyPageHint')}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={viewMarkdown} className="items-start gap-3 py-2">
            <FileText className="h-4 w-4 mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span>{tda('viewMarkdown')}</span>
              <span className="text-xs text-muted-foreground">{tda('viewMarkdownHint')}</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
