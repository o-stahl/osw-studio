import type { BuiltInTemplateDefinition, BuiltInTemplateMetadata } from './types';

export type { BuiltInTemplateMetadata, BuiltInTemplateDefinition } from './types';

/**
 * What a new project starts from when nobody has chosen.
 *
 * Handlebars rather than plain static: its partials mean a nav or footer is written once instead of
 * copied into every page, and the static domain prompt has to tell the assistant to duplicate them.
 * Both publish and export to the same plain HTML, so the templating costs nothing downstream.
 *
 * Not the same as the fallback for an unknown template id, which stays `blank`: that is a stale
 * selection landing somewhere safe, not a recommendation.
 */
export const DEFAULT_TEMPLATE_ID = 'handlebars-starter';

const BUILT_IN_EPOCH = new Date('2025-01-01T00:00:00Z');

/**
 * Every built-in template.
 *
 * The body sits behind `loadProjectTemplate` rather than in a field: this array is what the
 * template list renders from, and that screen needs a name and a description, not 147 KB of file
 * content. Inlining the templates would put every one of them in the bundle of anything that
 * imports the catalog, and that cost grows with each template added.
 */
const TEMPLATE_DEFINITIONS: BuiltInTemplateDefinition[] = [
  {
    id: 'blank',
    loadProjectTemplate: () => import('./barebones').then((m) => m.BAREBONES_PROJECT_TEMPLATE),
    name: 'Static Starter',
    description: 'Plain HTML, CSS and JavaScript with no template engine. Suitable for a single page or a small site',
    isBuiltIn: true,
    runtime: 'static',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['starter', 'basic', 'website']
    }
  },
  {
    id: 'handlebars-starter',
    loadProjectTemplate: () =>
      import('./handlebars-starter').then((m) => m.HANDLEBARS_STARTER_PROJECT_TEMPLATE),
    name: 'Handlebars Starter',
    description: 'Adds partials and a data file. Use for multi-page websites, so a nav or footer is written once',
    isBuiltIn: true,
    runtime: 'handlebars',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['handlebars', 'starter', 'website']
    }
  },
  {
    id: 'demo',
    loadProjectTemplate: () => import('./demo').then((m) => m.DEMO_PROJECT_TEMPLATE),
    name: 'Example Studios',
    description: 'Multi-page agency portfolio showcasing modern web development',
    isBuiltIn: true,
    runtime: 'handlebars',
    opensIn: 'canvas',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'website',
      tags: ['portfolio', 'multi-page', 'example']
    },
    promptSuggestions: [
      {
        id: 'demo-make-it-mine',
        label: 'Make it mine',
        prompt:
          'Replace the Example Studios name, services and portfolio entries in /data.json with my own. Ask me for whatever you need first.',
      },
      {
        id: 'demo-add-case-study',
        label: 'Add a case study',
        prompt:
          'Add a case study: an entry in the portfolio list in /data.json and a detail page under /portfolio/ following the structure of techflow-dashboard.html.',
      },
      {
        id: 'demo-restyle',
        label: 'Change how it looks',
        prompt:
          'Change the colours and typography in /styles/main.css. Show me two directions and let me pick before you apply one.',
      },
      {
        id: 'demo-add-page',
        label: 'Add a page',
        prompt:
          'Add a new page that uses the navigation and footer partials, and link to it from the header.',
      },
    ],
  },
  {
    id: 'business-website',
    loadProjectTemplate: () =>
      import('./business-website').then((m) => m.BUSINESS_WEBSITE_PROJECT_TEMPLATE),
    name: 'Business Website',
    description:
      'One-page site for a local business: what you do, prices, opening hours, where to find you and how to get in touch',
    isBuiltIn: true,
    runtime: 'static',
    opensIn: 'canvas',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'website',
      tags: ['business', 'local', 'one-page', 'services'],
    },
    // Written as instructions rather than topics, and naming the files, because the first thing
    // anyone does to this template is replace a joinery workshop with their own trade.
    promptSuggestions: [
      {
        id: 'business-make-it-mine',
        label: 'Make it my business',
        prompt:
          'Replace the Harbour Lane Joinery placeholder content in /index.html with my business: the title and meta description, the brand, the hero, the three service cards, the pricing section, the hours and address, and the contact details. Ask me for whatever you need first.',
      },
      {
        id: 'business-restaurant',
        label: 'Turn it into a restaurant',
        prompt:
          'Rework this into a restaurant site: the three cards become the menu highlights, the pricing section becomes how booking works, and the hours become service times. Keep the section ids and the navigation working.',
      },
      {
        id: 'business-trade',
        label: 'Turn it into a trade',
        prompt:
          "Rework this into a plumber's site: emergency callouts, the jobs covered, how callout charges work, and the area served instead of a shopfront address. Keep the section ids and the navigation working.",
      },
      {
        id: 'business-restyle',
        label: 'Change how it looks',
        prompt:
          'Change the palette and typography by editing the custom properties in :root in /styles/style.css. Show me two directions and let me pick before you apply one.',
      },
      {
        id: 'business-add-page',
        label: 'Add a page',
        prompt:
          'Add a second page as its own .html file, matching the header, footer and styles of the home page, and link to it from the navigation.',
      },
    ],
  },
  {
    id: 'portfolio',
    loadProjectTemplate: () => import('./portfolio').then((m) => m.PORTFOLIO_PROJECT_TEMPLATE),
    name: 'Portfolio & CV',
    description:
      'One page about one person: selected work, a short bio, work history and how to reach you',
    isBuiltIn: true,
    runtime: 'static',
    opensIn: 'canvas',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'website',
      tags: ['portfolio', 'cv', 'resume', 'personal'],
    },
    promptSuggestions: [
      {
        id: 'portfolio-make-it-mine',
        label: 'Make it about me',
        prompt:
          'Replace the Nadia Okonjo placeholder content in /index.html with me: the title and meta description, name, role, bio, links, work entries, about, work history and contact. Ask me for each piece rather than inventing anything.',
      },
      {
        id: 'portfolio-add-project',
        label: 'Add a project',
        prompt:
          'Add a work entry to the Selected work section. Follow the shape of the existing ones: what the work was, what was actually decided or changed, and what resulted. Ask me for the details.',
      },
      {
        id: 'portfolio-rewrite-entry',
        label: 'Sharpen my project write-ups',
        prompt:
          'Read my work entries and tell me which ones describe responsibilities rather than outcomes. Suggest a rewrite for each, and ask me for the missing facts instead of inventing results.',
      },
      {
        id: 'portfolio-case-study',
        label: 'Give a project its own page',
        prompt:
          'Turn one of the work entries into a full case study on its own .html page, reusing the stylesheet and the one-column layout, and link the entry title to it.',
      },
      {
        id: 'portfolio-restyle',
        label: 'Change how it looks',
        prompt:
          'Change the palette and typography via the custom properties in :root in /styles/style.css. Show me two directions first.',
      },
    ],
  },
  {
    id: 'contact-landing',
    loadProjectTemplate: () =>
      import('./contact-landing').then((m) => m.CONTACT_LANDING_PROJECT_TEMPLATE),
    name: 'Landing Page with Contact Form',
    description: 'Professional landing page with a working contact form powered by Resend',
    isBuiltIn: true,
    runtime: 'handlebars',
    opensIn: 'canvas',
    updatedAt: BUILT_IN_EPOCH,
    hasBackendFeatures: true,
    metadata: {
      intent: 'app',
      author: 'OSW Studio',
      tags: ['landing-page', 'contact-form', 'server-mode'],
    },
    promptSuggestions: [
      {
        id: 'contact-landing-make-it-mine',
        label: 'Make it my business',
        prompt:
          'Replace the placeholder headline, sections and copy in /index.html with my business. Ask me what it is first.',
      },
      {
        id: 'contact-landing-add-field',
        label: 'Add a form field',
        prompt:
          'Add a field to the contact form and store it: the form in /index.html, the submit handler in /scripts/main.js, the submit-contact edge function, and the messages table in the database schema.',
      },
      {
        id: 'contact-landing-restyle',
        label: 'Change how it looks',
        prompt:
          'Change the colours and typography in /styles/style.css. Show me two directions and let me pick before you apply one.',
      },
      {
        id: 'contact-landing-add-section',
        label: 'Add a section',
        prompt:
          'Add a section to the landing page above the contact form, matching the existing layout and styles.',
      },
    ],
  },
  {
    id: 'llm-wiki',
    loadProjectTemplate: () =>
      import('./llm-wiki').then((m) => m.LLM_WIKI_PROJECT_TEMPLATE),
    name: 'LLM Wiki',
    description:
      'A knowledge base the assistant writes and keeps current as you add sources, after Andrej Karpathy\u2019s LLM Wiki pattern',
    isBuiltIn: true,
    runtime: 'static',
    opensIn: 'preview',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'workspace',
      tags: ['wiki', 'research', 'notes', 'knowledge-base'],
    },
    // The three operations the pattern is built on. They are the whole workflow,
    // which is why they are the suggestions rather than a list of edits.
    promptSuggestions: [
      {
        id: 'wiki-ingest',
        label: 'Ingest a source',
        prompt:
          'I have a source to add. Read it, tell me what is in it and whether it contradicts anything the wiki already claims, then write its source page, update every page it touches, add it to the index and append to the log. Ask me for the source first.',
      },
      {
        id: 'wiki-file-drops',
        label: 'File what I dropped in',
        prompt:
          'I have added files to the project. Find what is new, wherever it landed, and file it: originals into /raw/, a readable copy of anything you can read into /raw/text/ under a matching name. Tell me which ones you cannot read, then ask me which to ingest first.',
      },
      {
        id: 'wiki-ingest-url',
        label: 'Ingest a link',
        prompt:
          'I have a URL. Fetch it with curl --markdown into /raw/text/, then ingest it: source page, updates to everything it touches, index, log. Tell me what is in it before you write anything.',
      },
      {
        id: 'wiki-query',
        label: 'Ask the wiki',
        prompt:
          'Answer a question from the wiki, citing the pages you used. If the answer is worth keeping, offer to file it as a new page; if the wiki cannot answer it, add it to open-questions.md with what would settle it. Ask me the question first.',
      },
      {
        id: 'wiki-lint',
        label: 'Lint the wiki',
        prompt:
          'Health-check the wiki: contradictions between pages, claims a newer source has superseded, orphan pages nothing links to, [[links]] to pages that were never written, pages missing from the index, and gaps that two sources mention but no page covers. Report before you fix anything.',
      },
      {
        id: 'wiki-start-subject',
        label: 'Start on my subject',
        prompt:
          'Clear out the street trees seed pages and start this wiki on my subject instead: a fresh index.md, an empty log.md, and an overview.md built from the first source I give you. Ask me what the subject is first.',
      },
    ],
  },
  {
    id: 'project-tracker',
    loadProjectTemplate: () =>
      import('./project-tracker').then((m) => m.PROJECT_TRACKER_PROJECT_TEMPLATE),
    name: 'Projects & Tasks',
    description:
      'A board of what you are working on and what is left, kept up to date by asking the assistant',
    isBuiltIn: true,
    runtime: 'vue',
    opensIn: 'preview',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'workspace',
      tags: ['tasks', 'projects', 'planning', 'board'],
    },
    promptSuggestions: [
      {
        id: 'tracker-start-mine',
        label: 'Set it up for my work',
        prompt:
          'Clear the seed projects and tasks out of /tasks.json and set it up for what I am actually working on. Ask me what my projects are, and give each one an objective saying what finished looks like.',
      },
      {
        id: 'tracker-add-project',
        label: 'Add a project',
        prompt:
          'Add a project to /tasks.json with an objective saying what finished looks like, then break it into three to six tasks. Ask me what the project is first.',
      },
      {
        id: 'tracker-whats-next',
        label: 'What should I do this week?',
        prompt:
          'Read /tasks.json and tell me what to work on this week: what is in progress, what is blocked and by what, and what has a date coming up. Answer in chat rather than changing the page.',
      },
      {
        id: 'tracker-move-done',
        label: 'Mark something done',
        prompt:
          'I will tell you what I finished. Set those tasks to done in /tasks.json, keep them in the file, and tell me what is left on that project.',
      },
    ],
  },
  {
    id: 'store-locator',
    loadProjectTemplate: () =>
      import('./store-locator').then((m) => m.STORE_LOCATOR_PROJECT_TEMPLATE),
    name: 'Store Locator',
    description:
      'A searchable map of your locations with opening hours and contact details, ready to embed in another site',
    isBuiltIn: true,
    runtime: 'static',
    opensIn: 'preview',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'app',
      tags: ['map', 'locations', 'embeddable', 'leaflet'],
    },
    promptSuggestions: [
      {
        id: 'locator-add-location',
        label: 'Add a location',
        prompt:
          'Add a location to /locations.json. Ask me for the name, address, opening hours and phone. Do not guess the coordinates: if I have not given them, tell me to look the address up on openstreetmap.org and read the lat and lng from the URL.',
      },
      {
        id: 'locator-import',
        label: 'Import a list I paste',
        prompt:
          'I am going to paste a list of shops. Turn it into entries in /locations.json, tell me which ones are missing coordinates, and set the map centre and zoom so they all fit in the first view.',
      },
      {
        id: 'locator-restyle',
        label: 'Change how it looks',
        prompt:
          'Change the palette and typography via the custom properties in :root in /styles/style.css so it matches my brand. Show me two directions first.',
      },
      {
        id: 'locator-embed',
        label: 'How do I put this on my site?',
        prompt:
          'Explain how to embed this locator in my existing website once it is published, and give me the exact HTML to paste.',
      },
    ],
  },
  {
    id: 'guided-chat',
    loadProjectTemplate: () =>
      import('./guided-chat').then((m) => m.GUIDED_CHAT_PROJECT_TEMPLATE),
    name: 'Guided Chat',
    description:
      'A chat widget that answers with pre-set replies and buttons, needs no backend and embeds into an existing site',
    isBuiltIn: true,
    runtime: 'static',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'app',
      tags: ['chat', 'widget', 'embeddable', 'no-backend'],
    },
    promptSuggestions: [
      {
        id: 'guided-make-it-mine',
        label: 'Make it about my business',
        prompt:
          'Replace the joinery flow in /flow.json with my business: the questions people actually ask, and real answers with prices or times where I can give them. Ask me what my business is and what people ask about first.',
      },
      {
        id: 'guided-add-branch',
        label: 'Add a branch',
        prompt:
          'Add a new branch to /flow.json for a topic I will name. Give it a real answer at the step, a route back to the start, and check every next id points at a step that exists.',
      },
      {
        id: 'guided-check-flow',
        label: 'Check the flow for dead ends',
        prompt:
          'Read /flow.json and tell me: any next id that does not exist, any step you cannot get back from, and any answer that defers instead of answering. Then fix them.',
      },
      {
        id: 'guided-embed',
        label: 'How do I put this on my site?',
        prompt:
          'Explain how to embed this chat widget in my existing website once it is published, and give me the exact HTML to paste.',
      },
    ],
  },
  {
    id: 'ai-assistant',
    loadProjectTemplate: () =>
      import('./ai-assistant').then((m) => m.AI_ASSISTANT_PROJECT_TEMPLATE),
    name: 'AI Assistant',
    description:
      'A chat page backed by a server function that holds your API key, so the key never reaches the browser (needs Server Mode)',
    isBuiltIn: true,
    runtime: 'static',
    updatedAt: BUILT_IN_EPOCH,
    hasBackendFeatures: true,
    metadata: {
      author: 'OSW Studio',
      intent: 'app',
      tags: ['ai', 'chat', 'server-mode', 'secrets'],
    },
    promptSuggestions: [
      {
        id: 'ai-system-prompt',
        label: 'Tell it what it knows',
        prompt:
          'Rewrite the SYSTEM constant in the ask function so the assistant answers as my business: what it does, what it should help with, and what it should refuse or hand off. Ask me for the details first.',
      },
      {
        id: 'ai-switch-provider',
        label: 'Use a different provider',
        prompt:
          'Change the ask function to use a different OpenAI-compatible provider: update API_URL and MODEL, and tell me exactly what to set AI_API_KEY to.',
      },
      {
        id: 'ai-rate-limit',
        label: 'Stop it being abused',
        prompt:
          'Add a rate limit to the ask function so one visitor cannot run up my bill, using the project database to count requests. Explain what limit you chose and why.',
      },
      {
        id: 'ai-suggested-questions',
        label: 'Add starter questions',
        prompt:
          'Add three suggested questions as buttons above the composer in /index.html that fill the box when clicked, matching the existing styles.',
      },
    ],
  },
  {
    id: 'react-starter',
    loadProjectTemplate: () => import('./react-starter').then((m) => m.REACT_STARTER_PROJECT_TEMPLATE),
    name: 'React Starter',
    description: 'Minimal React app with TypeScript and auto-bundling',
    isBuiltIn: true,
    runtime: 'react',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['react', 'typescript', 'starter']
    }
  },
  {
    id: 'react-demo',
    loadProjectTemplate: () => import('./react-demo').then((m) => m.REACT_DEMO_PROJECT_TEMPLATE),
    name: 'To-do List',
    description: 'A personal checklist that remembers itself between visits, kept in the browser it was written in',
    isBuiltIn: true,
    runtime: 'react',
    opensIn: 'preview',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'app',
      tags: ['react', 'typescript', 'demo']
    },
    promptSuggestions: [
      {
        id: 'react-demo-add-feature',
        label: 'Add due dates',
        prompt:
          'Add a due date to each task: the field, an input on the add form, and sorting the list so the soonest is first.',
      },
      {
        id: 'react-demo-add-filter',
        label: 'Add a filter',
        prompt:
          'Add filter buttons above the task list for all, active and completed, and keep the current filter in component state.',
      },
      {
        id: 'react-demo-clear-done',
        label: 'Clear the finished ones',
        prompt:
          'Add a button that removes every completed task at once, shown only while there is at least one to remove.',
      },
      {
        id: 'react-demo-restyle',
        label: 'Change how it looks',
        prompt:
          'Change the colours and typography. Show me two directions and let me pick before you apply one.',
      },
    ],
  },
  {
    id: 'preact-starter',
    loadProjectTemplate: () =>
      import('./preact-starter').then((m) => m.PREACT_STARTER_PROJECT_TEMPLATE),
    name: 'Preact Starter',
    description: 'Lightweight Preact app with TypeScript and auto-bundling',
    isBuiltIn: true,
    runtime: 'preact',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['preact', 'typescript', 'starter']
    }
  },
  {
    id: 'svelte-starter',
    loadProjectTemplate: () =>
      import('./svelte-starter').then((m) => m.SVELTE_STARTER_PROJECT_TEMPLATE),
    name: 'Svelte Starter',
    description: 'Svelte 5 app with runes and auto-bundling',
    isBuiltIn: true,
    runtime: 'svelte',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['svelte', 'starter']
    }
  },
  {
    id: 'vue-starter',
    loadProjectTemplate: () => import('./vue-starter').then((m) => m.VUE_STARTER_PROJECT_TEMPLATE),
    name: 'Vue Starter',
    description: 'Vue 3 app with Composition API and auto-bundling',
    isBuiltIn: true,
    runtime: 'vue',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['vue', 'starter']
    }
  },
  {
    id: 'python-starter',
    loadProjectTemplate: () =>
      import('./python-starter').then((m) => m.PYTHON_STARTER_PROJECT_TEMPLATE),
    name: 'Python Starter',
    description: 'Minimal Python script with Pyodide (browser-based CPython)',
    isBuiltIn: true,
    runtime: 'python',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['python', 'starter', 'scripting']
    }
  },
  {
    id: 'lua-starter',
    loadProjectTemplate: () => import('./lua-starter').then((m) => m.LUA_STARTER_PROJECT_TEMPLATE),
    name: 'Lua Starter',
    description: 'Minimal Lua script with wasmoon (browser-based Lua 5.4)',
    isBuiltIn: true,
    runtime: 'lua',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'starter',
      tags: ['lua', 'starter', 'scripting']
    }
  },
  {
    id: 'spring-rest-postgres',
    loadProjectTemplate: () =>
      import('./spring-rest-postgres').then((m) => m.SPRING_REST_POSTGRES_PROJECT_TEMPLATE),
    name: 'Spring Boot REST API',
    description:
      'A layered Spring Boot and PostgreSQL service to edit here and run elsewhere: controller, service, repository, migrations, tests and Docker Compose. OSWS cannot build or run Java, so it is exported and run with Maven',
    isBuiltIn: true,
    // Nothing here is compiled or served. `static` is what the preview needs to render the project
    // overview page, which is the only thing OSWS can do with a Java project.
    runtime: 'static',
    updatedAt: BUILT_IN_EPOCH,
    metadata: {
      author: 'OSW Studio',
      intent: 'project-kit',
      tags: ['spring-boot', 'java', 'postgresql', 'rest-api', 'project-kit'],
    },
    promptSuggestions: [
      {
        id: 'spring-add-endpoint',
        label: 'Add an endpoint',
        prompt:
          'Add a new REST endpoint to this service. Follow the layering in /docs/architecture.md: controller, service, repository interface, JPA adapter, DTOs, and a unit test. Add a Flyway migration rather than editing an existing one. Tell me the Maven commands to verify it, since nothing here can be built or run in OSWS.',
      },
      {
        id: 'spring-add-field',
        label: 'Add a field',
        prompt:
          'Add a field to the widget resource. Change the migration by adding a new one, then the entity, the domain record, the request and response DTOs, and the tests. List every file you changed and the commands I should run to check it.',
      },
      {
        id: 'spring-explain',
        label: 'Explain the structure',
        prompt:
          'Walk me through how this project is organised and why: what each package is for, why the domain model is separate from the JPA entity, and what would break if I merged them.',
      },
      {
        id: 'spring-add-auth',
        label: 'Add authentication',
        prompt:
          'Explain what adding Spring Security to this service would involve, which files would change, and what I would need to decide before you start. Do not write any code yet.',
      },
    ],
  },
  {
    id: 'blog',
    loadProjectTemplate: () =>
      import('./blog').then((m) => m.BLOG_PROJECT_TEMPLATE),
    name: 'Blog with Comments',
    description: 'Blog platform with posts, user auth, and moderated comments',
    isBuiltIn: true,
    runtime: 'handlebars',
    opensIn: 'canvas',
    updatedAt: BUILT_IN_EPOCH,
    hasBackendFeatures: true,
    metadata: {
      intent: 'website',
      author: 'OSW Studio',
      tags: ['blog', 'comments', 'auth', 'server-mode'],
    },
    promptSuggestions: [
      {
        id: 'blog-write-post',
        label: 'Write a post',
        prompt:
          'Add a blog post: an HTML file under /blog/ using the navigation, comments and footer partials, and its entry in the posts array in /data.json. Ask me what it should be about.',
      },
      {
        id: 'blog-add-tags',
        label: 'Add tags',
        prompt:
          'Add tags to each post in /data.json and let the home page filter the list by tag.',
      },
      {
        id: 'blog-make-it-mine',
        label: 'Make it mine',
        prompt:
          'Replace the blog title, description and about text with mine. Ask me for them first.',
      },
      {
        id: 'blog-restyle',
        label: 'Change how it looks',
        prompt:
          'Change the colours and typography in the stylesheet. Show me two directions and let me pick before you apply one.',
      },
    ],
  },
];

/**
 * The order templates are listed in, which is the order they appear in the template browser.
 *
 * Kept as an explicit list rather than falling out of the order the definitions happen to be
 * declared in, so that adding a template where it reads best in this file does not also decide
 * where it lands in the picker.
 *
 * A template that isn't named here sorts to the end. Only the templates whose position is
 * deliberate need an entry.
 */
const BUILT_IN_TEMPLATE_ORDER: readonly string[] = [
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

function orderIndex(id: string): number {
  const index = BUILT_IN_TEMPLATE_ORDER.indexOf(id);
  return index === -1 ? BUILT_IN_TEMPLATE_ORDER.length : index;
}

export const BUILT_IN_TEMPLATE_DEFINITIONS: BuiltInTemplateDefinition[] = [
  ...TEMPLATE_DEFINITIONS,
].sort((a, b) => orderIndex(a.id) - orderIndex(b.id));

/**
 * Every built-in as the template list needs it. Typed down to the metadata rather than copied into
 * a second array: `BuiltInTemplateDefinition` extends the metadata, so widening is enough, and
 * there is no second array to drift.
 */
export const BUILT_IN_TEMPLATES: BuiltInTemplateMetadata[] = BUILT_IN_TEMPLATE_DEFINITIONS;

const DEFINITIONS_BY_ID = new Map(
  BUILT_IN_TEMPLATE_DEFINITIONS.map((definition) => [definition.id, definition])
);

/**
 * The one place an id becomes a template. Everything that creates a project from a built-in goes
 * through here, so adding a template is adding a definition and nothing else. Returns undefined
 * rather than throwing: ids reach this from persisted user data, where a stale one is a project to
 * fall back on rather than a crash.
 */
export function getBuiltInTemplateDefinition(id: string): BuiltInTemplateDefinition | undefined {
  return DEFINITIONS_BY_ID.get(id);
}
