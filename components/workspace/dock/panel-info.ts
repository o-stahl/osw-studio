import { Bug, Code2, Eye, FolderTree, History, ListTree, MessageSquare, Sparkles, Terminal, type LucideIcon } from 'lucide-react';
import type { PanelKey } from '@/lib/workspace-layout';

/** Each panel's icon and colour, as its header and its rail button show them. Titles: `usePanelTitles`. */
export const PANEL_INFO: Record<PanelKey, { icon: LucideIcon; color: string }> = {
  chat: { icon: MessageSquare, color: 'var(--button-assistant-active)' },
  files: { icon: FolderTree, color: 'var(--button-files-active)' },
  editor: { icon: Code2, color: 'var(--button-editor-active)' },
  preview: { icon: Eye, color: 'var(--button-preview-active)' },
  elements: { icon: ListTree, color: 'var(--button-elements-active)' },
  skills: { icon: Sparkles, color: 'var(--button-skills-active, #a855f7)' },
  console: { icon: Terminal, color: 'var(--button-terminal-active, #22c55e)' },
  checkpoints: { icon: History, color: 'var(--button-checkpoint-active)' },
  debug: { icon: Bug, color: 'var(--foreground)' },
};
