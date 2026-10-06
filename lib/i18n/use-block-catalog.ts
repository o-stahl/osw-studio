'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

interface BlockCopy {
  name: string;
  description: string;
}

/**
 * The semantic blocks' palette copy, translated.
 *
 * Display only. `SEMANTIC_BLOCKS` keeps its English `name` and `description` because both are sent
 * to the agent as context (see multi-agent-orchestrator), and `wireframeHtml` stamps the name into
 * the placeholder that lands in the person's own page. Translating the registry in place would put
 * the interface language into both.
 *
 * Every key is a literal call, so a block added without palette copy fails tsc here.
 */
export function useBlockCatalog(): Record<string, BlockCopy> {
  const t = useTranslations('semanticBlocks');

  return useMemo(() => ({
    hero: { name: t('blocks.hero.name'), description: t('blocks.hero.description') },
    'header-nav': { name: t('blocks.header-nav.name'), description: t('blocks.header-nav.description') },
    footer: { name: t('blocks.footer.name'), description: t('blocks.footer.description') },
    'features-grid': { name: t('blocks.features-grid.name'), description: t('blocks.features-grid.description') },
    testimonials: { name: t('blocks.testimonials.name'), description: t('blocks.testimonials.description') },
    pricing: { name: t('blocks.pricing.name'), description: t('blocks.pricing.description') },
    faq: { name: t('blocks.faq.name'), description: t('blocks.faq.description') },
    'cta-banner': { name: t('blocks.cta-banner.name'), description: t('blocks.cta-banner.description') },
    'text-block': { name: t('blocks.text-block.name'), description: t('blocks.text-block.description') },
    image: { name: t('blocks.image.name'), description: t('blocks.image.description') },
    video: { name: t('blocks.video.name'), description: t('blocks.video.description') },
    card: { name: t('blocks.card.name'), description: t('blocks.card.description') },
    list: { name: t('blocks.list.name'), description: t('blocks.list.description') },
    button: { name: t('blocks.button.name'), description: t('blocks.button.description') },
    form: { name: t('blocks.form.name'), description: t('blocks.form.description') },
    'contact-form': { name: t('blocks.contact-form.name'), description: t('blocks.contact-form.description') },
    'search-bar': { name: t('blocks.search-bar.name'), description: t('blocks.search-bar.description') },
    modal: { name: t('blocks.modal.name'), description: t('blocks.modal.description') },
    table: { name: t('blocks.table.name'), description: t('blocks.table.description') },
    chart: { name: t('blocks.chart.name'), description: t('blocks.chart.description') },
    'stats-counter': { name: t('blocks.stats-counter.name'), description: t('blocks.stats-counter.description') },
    'progress-bar': { name: t('blocks.progress-bar.name'), description: t('blocks.progress-bar.description') },
    'metric-cards': { name: t('blocks.metric-cards.name'), description: t('blocks.metric-cards.description') },
    'data-list': { name: t('blocks.data-list.name'), description: t('blocks.data-list.description') },
    'sidebar-nav': { name: t('blocks.sidebar-nav.name'), description: t('blocks.sidebar-nav.description') },
    breadcrumbs: { name: t('blocks.breadcrumbs.name'), description: t('blocks.breadcrumbs.description') },
    tabs: { name: t('blocks.tabs.name'), description: t('blocks.tabs.description') },
    pagination: { name: t('blocks.pagination.name'), description: t('blocks.pagination.description') },
    accordion: { name: t('blocks.accordion.name'), description: t('blocks.accordion.description') },
    gallery: { name: t('blocks.gallery.name'), description: t('blocks.gallery.description') },
    timeline: { name: t('blocks.timeline.name'), description: t('blocks.timeline.description') },
    'profile-card': { name: t('blocks.profile-card.name'), description: t('blocks.profile-card.description') },
    'login-form': { name: t('blocks.login-form.name'), description: t('blocks.login-form.description') },
    'file-upload': { name: t('blocks.file-upload.name'), description: t('blocks.file-upload.description') },
    notification: { name: t('blocks.notification.name'), description: t('blocks.notification.description') },
    'dropdown-menu': { name: t('blocks.dropdown-menu.name'), description: t('blocks.dropdown-menu.description') },
  }), [t]);
}

/** The four palette groupings, translated. */
export function useBlockCategories(): Record<string, string> {
  const t = useTranslations('semanticBlocks.categories');

  return useMemo(() => ({
    Sections: t('Sections'),
    Content: t('Content'),
    Interactive: t('Interactive'),
    Data: t('Data'),
  }), [t]);
}
