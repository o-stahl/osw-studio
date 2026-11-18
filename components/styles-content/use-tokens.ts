'use client';

import { useEffect, useState } from 'react';
import { vfs } from '@/lib/vfs';
import { discoverColorTokens, discoverFontTokens, type ColorToken, type CssSource, type FontToken } from './tokens';
import { isPageFile, projectBreakpointsOf } from '@/lib/direct-edit/breakpoints';
import { countUses, scanProjectVariables, withoutShadowed, type VariableDefinition } from '@/lib/direct-edit/css-variables';
import { asText } from '@/lib/vfs/as-text';
import { OVERRIDES_PATH } from '@/lib/direct-edit/overrides-css';

/** Whether this browser meets an `@supports` condition; no where it cannot be asked. */
function supportsCondition(condition: string): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(condition);
  } catch {
    return false;
  }
}

/** What the Styles tab reads out of the project's CSS. */
export interface ProjectStyleFacts {
  colorTokens: ColorToken[];
  fontTokens: FontToken[];
  /** Every breakpoint edge the project's stylesheets and pages use, widest first. */
  breakpoints: number[];
  /** Every custom property the stylesheets define, where each stands (`lib/direct-edit/css-variables.ts`). */
  variables: VariableDefinition[];
  /** How many times the CSS reads each variable, by name. */
  variableUses: Record<string, number>;
}

const NONE: ProjectStyleFacts = { colorTokens: [], fontTokens: [], breakpoints: [], variables: [], variableUses: {} };

/** VFS read in its own hook, called by the workspace. Excludes /overrides.css from the tokens. */
export function useProjectStyleFacts(projectId: string | null, refreshKey: number): ProjectStyleFacts {
  const [facts, setFacts] = useState<ProjectStyleFacts>(NONE);

  useEffect(() => {
    if (!projectId) {
      setFacts(NONE);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await vfs.init();
        const files = await vfs.listFiles(projectId);
        const css = files
          .filter(file => file.path.toLowerCase().endsWith('.css') && file.path !== OVERRIDES_PATH)
          .sort((a, b) => a.path.localeCompare(b.path));
        const sources: CssSource[] = css.map(file => ({ path: file.path, content: asText(file.content) }));
        // Beside the stylesheets, decoded once above, the breakpoints come only from the pages and
        // /overrides.css: no other file (an image, a font) is decoded for them.
        const pages = files.filter(file => file.path === OVERRIDES_PATH || isPageFile(file.path));
        const breakpoints = projectBreakpointsOf([...sources, ...pages.map(file => ({ path: file.path, content: asText(file.content) }))]);
        if (cancelled) return;
        const variables = withoutShadowed(scanProjectVariables(sources), supportsCondition);
        const variableUses: Record<string, number> = {};
        for (const def of variables) variableUses[def.name] ??= countUses(sources, def.name);
        setFacts({
          colorTokens: discoverColorTokens(sources),
          fontTokens: discoverFontTokens(sources),
          breakpoints,
          variables,
          variableUses,
        });
      } catch {
        // A project that cannot be read has no tokens to offer. The controls still work; they just
        // never detect a token match, which is the same state as a project with none.
        if (!cancelled) setFacts(NONE);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, refreshKey]);

  return facts;
}

