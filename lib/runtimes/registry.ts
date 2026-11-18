import type { ProjectRuntime } from '@/lib/vfs/types';

export interface RuntimeConfig {
  id: ProjectRuntime;
  label: string;
  description: string;
  previewMode: 'visual' | 'terminal';
  bundled: boolean;
  jsxImportSource?: string;
  sfcExtension?: string;
  compilerCdnUrl?: string;
  badge: { label: string; color: string };
}

export const RUNTIME_CONFIGS: RuntimeConfig[] = [
  {
    id: 'static',
    label: 'Static',
    description: 'Pure HTML, CSS, and JavaScript',
    previewMode: 'visual',
    bundled: false,
    badge: { label: 'Static', color: 'gray' },
  },
  {
    id: 'handlebars',
    label: 'HTML + Handlebars',
    description: 'HTML, CSS, JavaScript with Handlebars templating',
    previewMode: 'visual',
    bundled: false,
    badge: { label: 'Handlebars', color: 'amber' },
  },
  {
    id: 'react',
    label: 'React + TypeScript',
    description: 'Component-based app with auto-bundling',
    previewMode: 'visual',
    bundled: true,
    jsxImportSource: 'react',
    badge: { label: 'React', color: 'sky' },
  },
  {
    id: 'preact',
    label: 'Preact + TypeScript',
    description: 'Lightweight React alternative with signals',
    previewMode: 'visual',
    bundled: true,
    jsxImportSource: 'preact',
    badge: { label: 'Preact', color: 'purple' },
  },
  {
    id: 'svelte',
    label: 'Svelte',
    description: 'Compile-time reactive framework',
    previewMode: 'visual',
    bundled: true,
    sfcExtension: '.svelte',
    compilerCdnUrl: 'https://esm.sh/svelte@5/compiler',
    badge: { label: 'Svelte', color: 'orange' },
  },
  {
    id: 'vue',
    label: 'Vue',
    description: 'Progressive framework with SFC support',
    previewMode: 'visual',
    bundled: true,
    sfcExtension: '.vue',
    compilerCdnUrl: 'https://esm.sh/@vue/compiler-sfc@3',
    badge: { label: 'Vue', color: 'green' },
  },
  {
    id: 'python',
    label: 'Python',
    description: 'Python scripts via Pyodide — terminal and visual output',
    previewMode: 'terminal',
    bundled: false,
    badge: { label: 'Python', color: 'yellow' },
  },
  {
    id: 'lua',
    label: 'Lua',
    description: 'Lua scripts via wasmoon — terminal output',
    previewMode: 'terminal',
    bundled: false,
    badge: { label: 'Lua', color: 'blue' },
  },
];

const configMap = new Map(RUNTIME_CONFIGS.map(c => [c.id, c]));

export function getRuntimeConfig(id: ProjectRuntime): RuntimeConfig {
  return configMap.get(id) ?? configMap.get('handlebars')!;
}

export function getProjectRuntimes(): { value: ProjectRuntime; label: string; description: string }[] {
  return RUNTIME_CONFIGS.map(c => ({ value: c.id, label: c.label, description: c.description }));
}

export function isRuntimeBundled(runtime: ProjectRuntime): boolean {
  return getRuntimeConfig(runtime).bundled;
}

const BADGE_CLASSES: Record<string, string> = {
  gray:   'bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600',
  amber:  'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800',
  sky:    'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-400 dark:border-sky-800',
  purple: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-400 dark:border-purple-800',
  orange: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800',
  green:  'bg-green-100 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800',
  yellow: 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-400 dark:border-yellow-800',
  blue:   'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800',
};

/**
 * Whether an element in this runtime's preview can be edited directly.
 *
 * Derived rather than declared, so it cannot drift from the two facts it rests on. Direct editing
 * resolves a rendered element back to the source that produced it through the `data-osw-src`
 * attribute stamped into HTML at compile. That needs a DOM to point at, which rules out `terminal`
 * runtimes, and it needs the element to have come from a source file rather than from a component
 * rendered at runtime, which rules out the bundled ones: their markup exists only after the bundle
 * has run, so `resolveSelection` answers `unresolvable` for everything the framework draws.
 */
export function supportsDirectEditing(runtime: ProjectRuntime | undefined | null): boolean {
  if (!runtime) return false;
  const config = RUNTIME_CONFIGS.find(c => c.id === runtime);
  if (!config) return false;
  return config.previewMode === 'visual' && !config.bundled;
}

/**
 * What the Canvas panel can do in a runtime: `edit` where the page's elements come from source files
 * (the same two facts as {@link supportsDirectEditing}), `view` where the page exists but a bundle
 * draws its markup at run time, so nothing on it can be traced to a source, and null where there is
 * no page at all. A missing or unknown runtime is null, for the reason it is for direct editing.
 */
export type CanvasSupport = 'edit' | 'view' | null;

export function canvasSupport(runtime: ProjectRuntime | undefined | null): CanvasSupport {
  if (!runtime) return null;
  const config = RUNTIME_CONFIGS.find(c => c.id === runtime);
  if (!config || config.previewMode !== 'visual') return null;
  return config.bundled ? 'view' : 'edit';
}

export function getRuntimeBadge(runtime: ProjectRuntime): { label: string; className: string } {
  const cfg = getRuntimeConfig(runtime);
  return {
    label: cfg.badge.label,
    className: BADGE_CLASSES[cfg.badge.color] || BADGE_CLASSES.gray,
  };
}
