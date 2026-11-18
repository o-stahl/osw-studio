import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_TEMPLATES,
  BUILT_IN_TEMPLATE_DEFINITIONS,
  DEFAULT_TEMPLATE_ID,
  getBuiltInTemplateDefinition,
} from '@/lib/vfs/templates/registry';
import { TEMPLATE_INTENTS } from '@/lib/vfs/templates/intents';
import { RUNTIME_CONFIGS, canvasSupport } from '@/lib/runtimes/registry';

/**
 * The registry is the one place an id becomes a template, so what it guarantees is worth pinning:
 * that no id resolves twice, that every id resolves to something instantiable, and that the list
 * order is the one declared rather than the one the definitions happen to be written in.
 */
/** Mirrors BUILT_IN_TEMPLATE_ORDER in the registry: the templates whose position is deliberate. */
const PLACED_ORDER = [
  'blank',
  'handlebars-starter',
  'demo',
  'business-website',
  'portfolio',
  'contact-landing',
  'llm-wiki',
  'project-tracker',
  'store-locator',
  'guided-chat',
  'ai-assistant',
  'react-starter',
  'react-demo',
  'preact-starter',
  'svelte-starter',
  'vue-starter',
  'python-starter',
  'lua-starter',
  'blog',
  'spring-rest-postgres',
];

describe('built-in template registry', () => {
  it('has no duplicate ids', () => {
    const ids = BUILT_IN_TEMPLATE_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every listed template by id', () => {
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      expect(getBuiltInTemplateDefinition(definition.id)).toBe(definition);
    }
  });

  it('starts new projects from a template that exists', () => {
    // Quick create uses this before anyone opens the picker, so a stale id here would be an empty
    // project rather than a visible error.
    expect(getBuiltInTemplateDefinition(DEFAULT_TEMPLATE_ID)).toBeDefined();
  });

  it('defaults to a template the list has a section for', () => {
    // The default may sit in a section that starts closed: the create dialog names it, and a closed
    // section reports that the current pick is inside it. What it must not be is an intent with no
    // heading, which would file the default under "Your templates" alongside imports.
    const definition = getBuiltInTemplateDefinition(DEFAULT_TEMPLATE_ID)!;
    const intent = TEMPLATE_INTENTS.find((i) => i.id === definition.metadata?.intent);

    expect(intent, `${DEFAULT_TEMPLATE_ID} has an intent the list draws`).toBeDefined();
  });

  it('returns undefined for an unknown id rather than throwing', () => {
    // Ids reach the resolver from persisted briefs and saved selections, where a stale one should
    // fall back to a blank project instead of failing project creation.
    expect(getBuiltInTemplateDefinition('template-that-was-removed')).toBeUndefined();
  });

  it('declares a runtime the runtime registry knows', () => {
    const known = new Set(RUNTIME_CONFIGS.map((r) => r.id));
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      expect(known).toContain(definition.runtime);
    }
  });

  it('opens a template on Canvas only where its pages are HTML the Canvas can edit', () => {
    // Canvas edits pages that come from HTML source. A bundled runtime draws its pages itself, so a
    // template on one that asked for Canvas would open on a surface where nothing can be selected.
    for (const template of BUILT_IN_TEMPLATES) {
      if (template.opensIn === 'canvas') expect(canvasSupport(template.runtime), template.id).toBe('edit');
    }
    // What each template's pages are made of, measured on Canvas (`lib/canvas/tracing.ts`): pages
    // written as HTML, and pages a script or a bundle draws.
    const declared = Object.fromEntries(BUILT_IN_TEMPLATES.filter((t) => t.opensIn).map((t) => [t.id, t.opensIn]));
    expect(declared).toEqual({
      demo: 'canvas', 'business-website': 'canvas', portfolio: 'canvas', 'contact-landing': 'canvas', blog: 'canvas',
      'llm-wiki': 'preview', 'store-locator': 'preview', 'project-tracker': 'preview', 'react-demo': 'preview',
    });
  });

  it('lists the templates it places in exactly the order it places them', () => {
    // Asserted as a policy rather than as a literal list of every template: the point is that a
    // template keeps the position the registry gives it however the definitions are arranged, so
    // that moving one for readability cannot quietly move it in the picker too.
    const shown = BUILT_IN_TEMPLATE_DEFINITIONS.map((d) => d.id);
    const placed = shown.filter((id) => PLACED_ORDER.includes(id));

    expect(placed).toEqual(PLACED_ORDER);
  });

  it('puts templates it does not place after every one it does', () => {
    // Where a contributed template lands. Adding one must not mean editing the registry, and must
    // not disturb the order of the templates that are placed deliberately.
    const shown = BUILT_IN_TEMPLATE_DEFINITIONS.map((d) => d.id);
    const lastPlaced = Math.max(...PLACED_ORDER.map((id) => shown.indexOf(id)));
    const unplaced = shown.filter((id) => !PLACED_ORDER.includes(id));

    for (const id of unplaced) {
      expect(shown.indexOf(id), `${id} sorts above a deliberately placed template`)
        .toBeGreaterThan(lastPlaced);
    }
  });

  it('loads a complete project for every template', async () => {
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      expect(template.files.length, `${definition.id} has no files`).toBeGreaterThan(0);
      expect(template.name, `${definition.id} has no name`).toBeTruthy();
      for (const file of template.files) {
        expect(file.path.startsWith('/'), `${definition.id}: ${file.path} is not absolute`).toBe(
          true
        );
      }
    }
  });

  it('marks exactly the templates whose files bring backend features with them', async () => {
    // `hasBackendFeatures` is declared on the metadata while the features themselves travel with
    // the files, so the two are only as accurate as this check. A template that grew an edge
    // function without the flag would create it silently and never show the badge; one that lost
    // its last function would keep claiming a backend it no longer has.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      expect(
        definition.hasBackendFeatures ?? false,
        `${definition.id}: hasBackendFeatures disagrees with what loadProjectTemplate returns`
      ).toBe(!!template.backendFeatures);
    }
  });

  it('never hands an edge-function fetch a body it has already stringified', async () => {
    // The edge runtime does `JSON.stringify(options.body)` itself, so a body that arrives as a
    // string is encoded twice and the receiving API rejects it. Verified against the real executor:
    // an object body sends {"a":1}, a stringified one sends "{\"a\":1}". This shipped broken once,
    // in the contact form template's Resend call, where it only fired if a key was configured.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      const fns = [
        ...(template.backendFeatures?.edgeFunctions ?? []),
        ...(template.backendFeatures?.serverFunctions ?? []),
      ];
      for (const fn of fns) {
        expect(
          fn.code,
          `${definition.id}/${fn.name} passes a pre-stringified fetch body, which double-encodes`
        ).not.toMatch(/body:\s*JSON\.stringify/);
      }
    }
  });

  it('never builds HTML by concatenating data a template reads from its own files', async () => {
    // These templates render JSON that the assistant writes, often from something the user pasted
    // in, and the result is a published page other people visit. The store locator shipped
    // `bindPopup('<strong>' + location.name + ...)`, which Leaflet parses as HTML: a name carrying
    // an <img onerror> ran in the visitor's browser. Build elements and set textContent instead.
    const sinks = /(?:\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|bindPopup\s*\()[^\n]*\+/;
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      for (const file of template.files) {
        if (!file.path.endsWith('.js')) continue;
        const offending = file.content
          .split('\n')
          .map((line, i) => ({ line: line.trim(), n: i + 1 }))
          .filter(({ line }) => sinks.test(line));
        expect(
          offending,
          `${definition.id} ${file.path} concatenates into an HTML sink`
        ).toEqual([]);
      }
    }
  });

  it('ships JavaScript that parses', async () => {
    // Template scripts live as strings inside TypeScript modules, so a stray escape or an unclosed
    // brace survives typechecking and only fails once the file reaches a browser.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      for (const file of template.files) {
        if (!file.path.endsWith('.js') || file.isBase64) continue;
        // Sources under /src belong to a bundled runtime and are ES modules, which `new Function`
        // cannot parse. Dropping the import/export keywords still catches what this guards
        // against: a stray escape or an unclosed brace surviving into the shipped string.
        // The import stripper has to survive a multi-line import list, which the llm-wiki
        // reader legitimately has; anchoring on the closing quote is what makes that work.
        const body = file.content
          .replace(/^\s*import\b[\s\S]*?["'][^"']+["'];?\s*$/gm, '')
          .replace(/^export function /gm, 'function ')
          .replace(/^export (const|let|default) /gm, '$1 ')
          .replace(/^export \{[^}]*\};?$/gm, '');
        expect(
          () => new Function(body),
          `${definition.id} ${file.path} does not parse`
        ).not.toThrow();
      }
    }
  });

  it('keeps every element a template script looks up', async () => {
    // Markup and script are edited apart, and rewriting a page is where an element the script
    // needs goes missing. Nothing fails at build time; the feature just stops happening in the
    // browser, which a glance at the rendered page can easily read as working.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      const markup = template.files
        .filter((f) => /\.(html|hbs|svelte|vue|tsx|jsx)$/.test(f.path))
        .map((f) => f.content)
        .join('\n');

      for (const script of template.files.filter((f) => f.path.endsWith('.js'))) {
        const wanted = [...script.content.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
        // An id the script writes into the page itself counts as present.
        const missing = [...new Set(wanted)].filter(
          (id) => !markup.includes(`id="${id}"`) && !script.content.includes(`id="${id}"`)
        );
        expect(missing, `${definition.id} ${script.path} looks up ids nothing renders`).toEqual([]);
      }
    }
  });

  it('never leaves a backslash in front of a backtick', async () => {
    // Template content is written inside TypeScript template literals, where a backtick needs \\`
    // and a literal backslash-then-backtick needs \\\\`. Getting that wrong ships prose reading
    // \\`like this\\` throughout a template, and nothing else catches it: the markdown renderer
    // still produces <code>, just with a visible backslash inside it. Found 70 of these in one
    // template at once, which is why it runs across all of them rather than in one template's file.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      const offenders = template.files
        .filter((f) => typeof f.content === 'string' && f.content.includes('\\`'))
        .map((f) => f.path);

      expect(offenders, `${definition.id} ships a stray backslash before a backtick`).toEqual([]);
    }
  });

  it('never ships instructions written for a different runtime', async () => {
    // llm-wiki declared svelte and opened its .PROMPT.md with the static-site prompt, so the
    // agent's instructions began "DO NOT create routing logic, create separate .html files" and
    // ended "this is a Svelte project compiled to /bundle.js". Which half the model obeys is luck.
    // Not every template carries a domain prompt (the Spring kit deliberately has none); the rule
    // is only that whichever one it carries is the one for its declared runtime.
    const { getDomainPrompt } = await import('@/lib/llm/prompts');
    const runtimes = RUNTIME_CONFIGS.map((r) => r.id);

    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      const prompt = template.files.find((f) => f.path === '/.PROMPT.md')?.content;
      if (!prompt) continue;

      const carried = runtimes.filter((r) => prompt.includes(getDomainPrompt(r)));
      for (const r of carried) {
        expect(r, `${definition.id} declares ${definition.runtime} but ships the ${r} prompt`).toBe(
          definition.runtime
        );
      }
    }
  });

  it('gives every visual template an entry point to render', async () => {
    const terminal = new Set(['python', 'lua']);
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      if (terminal.has(definition.runtime)) continue;
      const template = await definition.loadProjectTemplate();
      const paths = template.files.map((f) => f.path);
      expect(paths, `${definition.id} has no /index.html`).toContain('/index.html');
    }
  });

  it('commits each template to one colour scheme instead of shipping two palettes', async () => {
    // A template that answers `prefers-color-scheme` carries two sets of values to keep in step and
    // two sets of contrast to check, and it teaches the assistant that a restyle is a two-place
    // edit, so a request to change a colour comes back as a second palette or a theme toggle. The
    // rule is that a template picks light or dark, says so in `color-scheme`, and ships that one.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      for (const file of template.files) {
        if (file.isBase64) continue;
        if (!/\.(css|html)$/.test(file.path)) continue;
        expect(
          file.content,
          `${definition.id} ${file.path} answers prefers-color-scheme; commit to one scheme instead`
        ).not.toMatch(/prefers-color-scheme/);
      }
    }
  });

  it('declares the scheme it committed to wherever it sets a palette', async () => {
    // Without `color-scheme`, the browser still paints form controls, scrollbars and the canvas
    // behind the page from the visitor's OS preference, so a light template gets dark inputs on a
    // dark machine. Only templates that set a palette need it: the starters deliberately have none.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      const styled = template.files.filter(
        (f) => !f.isBase64 && /\.(css|html)$/.test(f.path) && /--(canvas|ink)\b/.test(f.content)
      );
      for (const file of styled) {
        expect(
          file.content,
          `${definition.id} ${file.path} sets a palette but never declares color-scheme`
        ).toMatch(/color-scheme:\s*(light|dark)\s*;/);
      }
    }
  });

  it('keeps em-dashes out of what a template ships', async () => {
    // Templates are the voice the assistant writes the rest of the project in, so an em-dash in
    // seed copy or in a .PROMPT.md propagates into everything it goes on to write. The house rule
    // is a comma, a colon, a semicolon or a second sentence.
    for (const definition of BUILT_IN_TEMPLATE_DEFINITIONS) {
      const template = await definition.loadProjectTemplate();
      for (const file of template.files) {
        if (file.isBase64) continue;
        const lines = file.content
          .split('\n')
          .map((line, i) => ({ line: line.trim(), n: i + 1 }))
          .filter(({ line }) => line.includes('—') || line.includes('&mdash;'));
        expect(lines, `${definition.id} ${file.path} ships an em-dash`).toEqual([]);
      }
    }
  });
});

describe('contact form template', () => {
  it('does not expose stored submissions over an unauthenticated endpoint', async () => {
    // The template shipped a `list-messages` GET returning the 50 most recent submissions, with
    // names, addresses and message bodies, to anyone who asked for it. Its only caller was a
    // server-mode probe on the published page that discarded the response.
    const definition = getBuiltInTemplateDefinition('contact-landing');
    const template = await definition!.loadProjectTemplate();
    const edgeFunctions = template.backendFeatures?.edgeFunctions ?? [];

    const readers = edgeFunctions.filter((fn) => /SELECT[\s\S]*FROM messages/i.test(fn.code));
    expect(readers).toEqual([]);

    const source = template.files.map((f) => f.content).join('\n');
    expect(source).not.toContain('list-messages');
  });

  it('probes for a server with an endpoint that returns nothing else', async () => {
    const definition = getBuiltInTemplateDefinition('contact-landing');
    const template = await definition!.loadProjectTemplate();
    const probe = template.backendFeatures?.edgeFunctions?.find(
      (fn) => fn.name === 'contact-status'
    );
    expect(probe?.method).toBe('GET');
    expect(probe?.code).not.toMatch(/\bdb\b/);

    const source = template.files.map((f) => f.content).join('\n');
    expect(source).toContain('/contact-status');
  });
});
