'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, X, Crosshair, LayoutGrid, Image as ImageIcon, Info, FileText, Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlacedBlock } from '@/lib/semantic-blocks/types';
import { getBlockById } from '@/lib/semantic-blocks/registry';
import type { PendingImage, PendingFile, PendingAudio } from '@/lib/llm/multi-agent-orchestrator';
import type { ContentBlock } from '@/lib/llm/types';

interface FocusContextData {
  domPath: string;
  snippet: string;
}

interface SemanticBlockData {
  name: string;
  domPath: string;
  position: string;
  description: string;
}

interface MessageContextProps {
  focusContext?: FocusContextData | null;
  semanticBlocks?: (PlacedBlock[] | SemanticBlockData[]);
  images?: PendingImage[];
  /** For readOnly mode: image content blocks from the stored message */
  imageBlocks?: ContentBlock[];
  files?: PendingFile[];
  /** For readOnly mode: attached file names from the stored message */
  fileNames?: { name: string }[];
  audioClips?: PendingAudio[];
  /** For readOnly mode: input_audio content blocks from the stored message */
  audioBlocks?: ContentBlock[];
  /** Non-dismissable system note (e.g. "user declined project creation") */
  systemNote?: string | null;
  onClearFocus?: () => void;
  onRemoveBlock?: (placementId: string) => void;
  onClearBlocks?: () => void;
  onRemoveImage?: (imageId: string) => void;
  onClearImages?: () => void;
  onRemoveFile?: (fileId: string) => void;
  onClearFiles?: () => void;
  onRemoveAudio?: (audioId: string) => void;
  onClearAudio?: () => void;
  /** readOnly: start the context expanded (e.g. an attachment-only message) */
  defaultOpen?: boolean;
  readOnly?: boolean;
}

function isPlacedBlock(b: PlacedBlock | SemanticBlockData): b is PlacedBlock {
  return 'blockId' in b;
}

function getBlockName(b: PlacedBlock | SemanticBlockData): string {
  if (isPlacedBlock(b)) return getBlockById(b.blockId)?.name || b.blockId;
  return b.name;
}

function getBlockDescription(b: PlacedBlock | SemanticBlockData): string {
  if (isPlacedBlock(b)) return getBlockById(b.blockId)?.description || '';
  return b.description;
}

function getBlockDomPath(b: PlacedBlock | SemanticBlockData): string {
  return b.domPath;
}

function getBlockPosition(b: PlacedBlock | SemanticBlockData): string {
  return b.position;
}

function getBlockKey(b: PlacedBlock | SemanticBlockData, i: number): string {
  if (isPlacedBlock(b)) return b.placementId;
  return `sb-${i}`;
}

/** Collapsible section within the unified context component */
function Section({
  icon: Icon,
  label,
  summary,
  onClear,
  children,
  defaultOpen = false,
  readOnly = false,
}: {
  icon: React.ElementType;
  label: string;
  summary?: string;
  onClear?: () => void;
  children: React.ReactNode;
  defaultOpen?: boolean;
  readOnly?: boolean;
}) {
  const tc = useTranslations('common');
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-primary/10 first:border-t-0">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-primary/5 transition-colors"
        onClick={() => setOpen(prev => !prev)}
      >
        <ChevronDown className={cn("h-3 w-3 text-primary/50 flex-shrink-0 transition-transform", !open && "-rotate-90")} />
        <Icon className="h-3 w-3 text-primary/60 flex-shrink-0" />
        <span className="text-[11px] font-medium text-foreground/90">{label}</span>
        {summary && <span className="text-[10px] text-muted-foreground/60 truncate">{summary}</span>}
        {!readOnly && onClear && (
          <span
            className="ml-auto text-[10px] text-muted-foreground/50 hover:text-foreground/70 flex-shrink-0"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
          >
            {tc('actions.clear')}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** Code snippet box — shared between focus and block descriptions */
function SnippetBox({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre className={cn(
      "max-h-20 overflow-auto rounded border border-border/50 bg-background/80 px-2 py-1.5 text-[10px] text-foreground leading-relaxed",
      className,
    )}>
      <code>{children}</code>
    </pre>
  );
}

export function MessageContext({
  focusContext,
  semanticBlocks,
  images,
  imageBlocks,
  files,
  fileNames,
  audioClips,
  audioBlocks,
  systemNote,
  onClearFocus,
  onRemoveBlock,
  onClearBlocks,
  onRemoveImage,
  onClearImages,
  onRemoveFile,
  onClearFiles,
  onRemoveAudio,
  onClearAudio,
  defaultOpen,
  readOnly = false,
}: MessageContextProps) {
  const tt = useTranslations('tooltips');
  const tm = useTranslations('messageContext');
  const hasBlocks = semanticBlocks && semanticBlocks.length > 0;
  const hasImages = images && images.length > 0;
  const hasImageBlocks = imageBlocks && imageBlocks.some(b => b.type === 'image_url');
  const hasFiles = files && files.length > 0;
  const hasFileNames = fileNames && fileNames.length > 0;
  const hasAudio = audioClips && audioClips.length > 0;
  const hasAudioBlocks = audioBlocks && audioBlocks.some(b => b.type === 'input_audio');
  const hasFocus = !!focusContext;
  const hasNote = !!systemNote;

  if (!hasFocus && !hasBlocks && !hasImages && !hasImageBlocks && !hasFiles && !hasFileNames && !hasAudio && !hasAudioBlocks && !hasNote) return null;

  // Build summary for collapsed readOnly view
  const summaryParts: string[] = [];
  if (hasNote) summaryParts.push(tm('summaryNote'));
  if (hasFocus) summaryParts.push(tm('summaryFocus'));
  if (hasBlocks) summaryParts.push(tm('summaryBlocks', { count: semanticBlocks!.length }));
  if (hasImages) summaryParts.push(tm('summaryImages', { count: images!.length }));
  if (!hasImages && hasImageBlocks) {
    const count = imageBlocks!.filter(b => b.type === 'image_url').length;
    summaryParts.push(tm('summaryImages', { count }));
  }
  const fileCount = (files?.length ?? 0) || (fileNames?.length ?? 0);
  if (fileCount > 0) summaryParts.push(tm('summaryFiles', { count: fileCount }));
  const audioCount = (audioClips?.length ?? 0) || (audioBlocks?.filter(b => b.type === 'input_audio').length ?? 0);
  if (audioCount > 0) summaryParts.push(tm('summaryRecordings', { count: audioCount }));

  if (readOnly) {
    return <ReadOnlyContext
      focusContext={focusContext}
      semanticBlocks={semanticBlocks}
      imageBlocks={imageBlocks}
      fileNames={fileNames}
      audioBlocks={audioBlocks}
      summary={summaryParts.join(', ')}
      defaultOpen={defaultOpen}
    />;
  }

  return (
    <div className="rounded-md border border-dashed border-primary/30 bg-primary/5 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-1.5 flex items-center gap-2">
        <span className="font-medium text-[10px] uppercase tracking-wider text-primary/80">{tm('includedNext')}</span>
      </div>
      {/* Sections */}
      {hasNote && (
        <Section
          icon={Info}
          label={tm('context')}
          summary={systemNote!.length > 40 ? systemNote!.slice(0, 37) + '...' : systemNote!}
          readOnly={true}
        >
          <p className="text-[11px] text-foreground/70 leading-relaxed">{systemNote}</p>
        </Section>
      )}
      {hasFocus && (
        <Section
          icon={Crosshair}
          label={tm('focus')}
          summary={focusContext!.domPath.split(' > ').slice(-1)[0]}
          onClear={onClearFocus}
          readOnly={readOnly}
        >
          <div className="text-[10px] font-mono text-muted-foreground/70 break-all leading-snug mb-1">
            {focusContext!.domPath}
          </div>
          {focusContext!.snippet && (
            <SnippetBox>{focusContext!.snippet}</SnippetBox>
          )}
        </Section>
      )}
      {hasBlocks && (
        <Section
          icon={LayoutGrid}
          label={tm('blocksCount', { count: semanticBlocks!.length })}
          onClear={onClearBlocks}
          readOnly={readOnly}
        >
          <div className="space-y-2">
            {semanticBlocks!.map((block, i) => (
              <div key={getBlockKey(block, i)} className="group">
                <div className="flex items-center gap-1 mb-0.5">
                  <span className="text-[11px] font-medium text-foreground/90">{getBlockName(block)}</span>
                  {!readOnly && onRemoveBlock && isPlacedBlock(block) && (
                    <button
                      onClick={() => onRemoveBlock(block.placementId)}
                      className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-muted-foreground/50 hover:text-foreground/70"
                      title={tt('removeBlock')}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/60 mb-1">
                  {getBlockPosition(block)} {getBlockDomPath(block)}
                </div>
                {getBlockDescription(block) && (
                  <SnippetBox>{getBlockDescription(block)}</SnippetBox>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      {hasImages && (
        <Section
          icon={ImageIcon}
          label={tm('imagesCount', { count: images!.length })}
          onClear={onClearImages}
          defaultOpen={true}
          readOnly={readOnly}
        >
          <div className="flex flex-wrap gap-1.5">
            {images!.map((img) => (
              <div key={img.id} className="relative group">
                <img
                  src={img.preview}
                  alt={tm('attached')}
                  className="h-10 w-10 object-cover rounded border border-border/50"
                />
                {!readOnly && onRemoveImage && (
                  <button
                    onClick={() => onRemoveImage(img.id)}
                    className="absolute -top-1 -right-1 h-3.5 w-3.5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title={tt('removeImage')}
                  >
                    <X className="h-2 w-2" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      {hasFiles && (
        <Section
          icon={FileText}
          label={tm('filesCount', { count: files!.length })}
          onClear={onClearFiles}
          defaultOpen={true}
          readOnly={readOnly}
        >
          <div className="flex flex-wrap gap-1.5">
            {files!.map((f) => (
              <div key={f.id} className="group flex items-center gap-1.5 px-2 py-1 rounded border border-border/50 bg-muted/40 text-[11px] max-w-full">
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate text-foreground/90">{f.name}</span>
                {!readOnly && onRemoveFile && (
                  <button
                    onClick={() => onRemoveFile(f.id)}
                    className="shrink-0 text-muted-foreground/50 hover:text-foreground/70"
                    title={tt('removeFile')}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      {hasAudio && (
        <Section
          icon={Mic}
          label={tm('voiceCount', { count: audioClips!.length })}
          onClear={onClearAudio}
          defaultOpen={true}
          readOnly={readOnly}
        >
          <div className="flex flex-col gap-1.5">
            {audioClips!.map((clip) => (
              <div key={clip.id} className="group flex items-center gap-2">
                {clip.data ? (
                  <audio
                    controls
                    src={`data:audio/${clip.format};base64,${clip.data}`}
                    className="h-8 flex-1 min-w-0"
                  />
                ) : (
                  <span className="flex-1 min-w-0 flex items-center gap-1.5 text-[11px] text-foreground/80">
                    <Mic className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{clip.transcript || tm('voiceNote')}</span>
                  </span>
                )}
                {!readOnly && onRemoveAudio && (
                  <button
                    onClick={() => onRemoveAudio(clip.id)}
                    className="shrink-0 text-muted-foreground/50 hover:text-foreground/70"
                    title={tt('removeRecording')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/** Read-only version for user messages in chat history */
function ReadOnlyContext({
  focusContext,
  semanticBlocks,
  imageBlocks,
  fileNames,
  audioBlocks,
  summary,
  defaultOpen,
}: {
  focusContext?: FocusContextData | null;
  semanticBlocks?: (PlacedBlock[] | SemanticBlockData[]);
  imageBlocks?: ContentBlock[];
  fileNames?: { name: string }[];
  audioBlocks?: ContentBlock[];
  summary: string;
  defaultOpen?: boolean;
}) {
  const tm = useTranslations('messageContext');
  const [open, setOpen] = useState(defaultOpen ?? false);
  const hasBlocks = semanticBlocks && semanticBlocks.length > 0;
  const hasFocus = !!focusContext;
  const actualImageBlocks = imageBlocks?.filter(b => b.type === 'image_url') || [];
  const hasImages = actualImageBlocks.length > 0;
  const hasFiles = fileNames && fileNames.length > 0;
  const actualAudioBlocks = audioBlocks?.filter(b => b.type === 'input_audio') || [];
  const hasAudio = actualAudioBlocks.length > 0;

  return (
    <div className="mt-2">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] text-primary hover:text-primary/80 transition-colors"
        onClick={() => setOpen(prev => !prev)}
      >
        <ChevronDown className={cn("h-2.5 w-2.5 flex-shrink-0 transition-transform", !open && "-rotate-90")} />
        <span>{tm('context')}</span>
        <span className="text-[10px]">({summary})</span>
      </button>
      {open && (
        <div className="mt-1.5 rounded border border-border/40 bg-background/60 text-[10px] overflow-hidden">
          {hasFocus && (
            <div className="px-2.5 py-2 border-b border-border/30 last:border-b-0">
              <div className="flex items-center gap-1.5 mb-1">
                <Crosshair className="h-2.5 w-2.5 text-primary/60" />
                <span className="font-medium text-foreground/80">{tm('focus')}</span>
                <span className="font-mono text-muted-foreground/50 truncate">{focusContext!.domPath.split(' > ').slice(-1)[0]}</span>
              </div>
              {focusContext!.snippet && (
                <SnippetBox className="max-h-16 text-[9px]">{focusContext!.snippet}</SnippetBox>
              )}
            </div>
          )}
          {hasBlocks && (
            <div className="px-2.5 py-2 border-b border-border/30 last:border-b-0">
              <div className="flex items-center gap-1.5 mb-1">
                <LayoutGrid className="h-2.5 w-2.5 text-primary/60" />
                <span className="font-medium text-foreground/80">{tm('blocks')}</span>
              </div>
              <div className="space-y-1.5">
                {semanticBlocks!.map((block, i) => (
                  <div key={getBlockKey(block, i)}>
                    <div>
                      <span className="text-foreground/70 font-medium">{getBlockName(block)}</span>
                      <span className="text-muted-foreground/50 ml-1">{getBlockPosition(block)} {getBlockDomPath(block).split(' > ').slice(-2).join(' > ')}</span>
                    </div>
                    {getBlockDescription(block) && (
                      <SnippetBox className="max-h-14 text-[9px] mt-0.5">{getBlockDescription(block)}</SnippetBox>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {hasImages && (
            <div className="px-2.5 py-2">
              <div className="flex items-center gap-1.5 mb-1.5">
                <ImageIcon className="h-2.5 w-2.5 text-primary/60" />
                <span className="font-medium text-foreground/80">{tm('imagesCount', { count: actualImageBlocks.length })}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {actualImageBlocks.map((block, i) => (
                  block.type === 'image_url' && (
                    <img
                      key={`img-${i}`}
                      src={block.image_url.url}
                      alt={tm('attached')}
                      className="h-10 w-auto rounded border border-border/50 object-cover"
                    />
                  )
                ))}
              </div>
            </div>
          )}
          {hasFiles && (
            <div className="px-2.5 py-2 border-t border-border/30">
              <div className="flex items-center gap-1.5 mb-1.5">
                <FileText className="h-2.5 w-2.5 text-primary/60" />
                <span className="font-medium text-foreground/80">{tm('filesCount', { count: fileNames!.length })}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {fileNames!.map((f, i) => (
                  <span key={`file-${i}`} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/50 bg-muted/40 text-foreground/80">
                    <FileText className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                    <span className="truncate max-w-[160px]">{f.name}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasAudio && (
            <div className="px-2.5 py-2 border-t border-border/30">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Mic className="h-2.5 w-2.5 text-primary/60" />
                <span className="font-medium text-foreground/80">{tm('voiceCount', { count: actualAudioBlocks.length })}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {actualAudioBlocks.map((block, i) => (
                  block.type === 'input_audio' && (
                    <audio
                      key={`aud-${i}`}
                      controls
                      src={`data:audio/${block.input_audio.format};base64,${block.input_audio.data}`}
                      className="h-8 w-full max-w-[280px]"
                    />
                  )
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
