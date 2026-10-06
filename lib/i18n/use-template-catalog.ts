'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

export interface TemplateCopy {
  name: string;
  description: string;
}

/**
 * The built-in templates' names and descriptions, translated.
 *
 * `TEMPLATE_DEFINITIONS` is a module constant and cannot call a hook, so the copy is looked up by
 * template id where it renders and the registry's own English stays the fallback. Every key is a
 * literal call because typed messages reject a computed key. The map is keyed by string, so `tsc`
 * cannot see a template missing from it: `registry-coverage.test.tsx` checks every built-in has an
 * entry here, which is what stops a new template rendering its English name in other languages.
 */
export function useTemplateCatalog(): Record<string, TemplateCopy> {
  const t = useTranslations('templateCatalog');

  return useMemo(() => ({
    blank: { name: t('blank.name'), description: t('blank.description') },
    'handlebars-starter': { name: t('handlebars-starter.name'), description: t('handlebars-starter.description') },
    demo: { name: t('demo.name'), description: t('demo.description') },
    'business-website': { name: t('business-website.name'), description: t('business-website.description') },
    portfolio: { name: t('portfolio.name'), description: t('portfolio.description') },
    'contact-landing': { name: t('contact-landing.name'), description: t('contact-landing.description') },
    'llm-wiki': { name: t('llm-wiki.name'), description: t('llm-wiki.description') },
    'project-tracker': { name: t('project-tracker.name'), description: t('project-tracker.description') },
    'store-locator': { name: t('store-locator.name'), description: t('store-locator.description') },
    'guided-chat': { name: t('guided-chat.name'), description: t('guided-chat.description') },
    'ai-assistant': { name: t('ai-assistant.name'), description: t('ai-assistant.description') },
    'react-starter': { name: t('react-starter.name'), description: t('react-starter.description') },
    'react-demo': { name: t('react-demo.name'), description: t('react-demo.description') },
    'preact-starter': { name: t('preact-starter.name'), description: t('preact-starter.description') },
    'svelte-starter': { name: t('svelte-starter.name'), description: t('svelte-starter.description') },
    'vue-starter': { name: t('vue-starter.name'), description: t('vue-starter.description') },
    'python-starter': { name: t('python-starter.name'), description: t('python-starter.description') },
    'lua-starter': { name: t('lua-starter.name'), description: t('lua-starter.description') },
    'spring-rest-postgres': { name: t('spring-rest-postgres.name'), description: t('spring-rest-postgres.description') },
    blog: { name: t('blog.name'), description: t('blog.description') },
  }), [t]);
}
