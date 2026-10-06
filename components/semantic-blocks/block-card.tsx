'use client';

import React, { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, GripVertical } from 'lucide-react';
import type { SemanticBlock } from '@/lib/semantic-blocks/types';

// Wireframe SVG thumbnails — simple shapes that convey block structure at a glance.
// All render at 28x20 viewBox with currentColor strokes for theme compatibility.
const BLOCK_THUMBNAILS: Record<string, React.ReactNode> = {
  // Sections
  'hero': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="1" width="26" height="18" rx="1.5" strokeDasharray="2 1" />
      <rect x="8" y="4" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="10" y="7.5" width="8" height="1" rx="0.5" fill="currentColor" opacity="0.3" />
      <rect x="10.5" y="11" width="7" height="3" rx="1" />
    </svg>
  ),
  'header-nav': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="5" width="26" height="10" rx="1.5" strokeDasharray="2 1" />
      <rect x="3" y="8.5" width="5" height="2.5" rx="0.5" fill="currentColor" opacity="0.5" />
      <circle cx="14" cy="10" r="0.7" fill="currentColor" opacity="0.4" />
      <circle cx="17" cy="10" r="0.7" fill="currentColor" opacity="0.4" />
      <circle cx="20" cy="10" r="0.7" fill="currentColor" opacity="0.4" />
      <circle cx="23" cy="10" r="0.7" fill="currentColor" opacity="0.4" />
    </svg>
  ),
  'footer': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="3" width="26" height="14" rx="1.5" strokeDasharray="2 1" />
      <rect x="3" y="5.5" width="4" height="1" rx="0.5" fill="currentColor" opacity="0.4" />
      <rect x="3" y="7.5" width="6" height="0.7" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="3" y="8.8" width="5" height="0.7" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="14" y="5.5" width="4" height="1" rx="0.5" fill="currentColor" opacity="0.4" />
      <rect x="14" y="7.5" width="6" height="0.7" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="14" y="8.8" width="5" height="0.7" rx="0.3" fill="currentColor" opacity="0.25" />
      <line x1="3" y1="12" x2="25" y2="12" strokeOpacity="0.2" />
      <rect x="10" y="13.5" width="8" height="0.7" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  'features-grid': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1.5" y="2" width="7" height="7" rx="1" strokeDasharray="2 1" />
      <rect x="10.5" y="2" width="7" height="7" rx="1" strokeDasharray="2 1" />
      <rect x="19.5" y="2" width="7" height="7" rx="1" strokeDasharray="2 1" />
      <rect x="3" y="4" width="3" height="1" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="12" y="4" width="3" height="1" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="21" y="4" width="3" height="1" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="2.5" y="6" width="5" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="11.5" y="6" width="5" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="20.5" y="6" width="5" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="1.5" y="11" width="7" height="7" rx="1" strokeDasharray="2 1" />
      <rect x="10.5" y="11" width="7" height="7" rx="1" strokeDasharray="2 1" />
      <rect x="19.5" y="11" width="7" height="7" rx="1" strokeDasharray="2 1" />
    </svg>
  ),
  'testimonials': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="2" width="24" height="16" rx="1.5" strokeDasharray="2 1" />
      <text x="4" y="7.5" fontSize="5" fill="currentColor" opacity="0.3" fontFamily="serif">&ldquo;</text>
      <rect x="8" y="5" width="14" height="0.7" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="8" y="7" width="12" height="0.7" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="8" y="9" width="10" height="0.7" rx="0.3" fill="currentColor" opacity="0.25" />
      <circle cx="9" cy="14" r="2" strokeOpacity="0.4" />
      <rect x="12.5" y="13" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="12.5" y="14.8" width="4" height="0.7" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  'pricing': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1.5" y="2" width="7" height="16" rx="1" strokeDasharray="2 1" />
      <rect x="10.5" y="1" width="7" height="17" rx="1" strokeOpacity="0.8" />
      <rect x="19.5" y="2" width="7" height="16" rx="1" strokeDasharray="2 1" />
      <rect x="3" y="4" width="4" height="1.2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="12" y="3" width="4" height="1.2" rx="0.3" fill="currentColor" opacity="0.5" />
      <rect x="21" y="4" width="4" height="1.2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="3" y="6.5" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="3" y="7.8" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="3" y="9.1" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="12" y="5.5" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="12" y="6.8" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="12" y="8.1" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="21" y="6.5" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="21" y="7.8" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="21" y="9.1" width="3" height="0.6" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  'faq': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="3" y="2" width="22" height="3.5" rx="0.8" strokeDasharray="2 1" />
      <rect x="3" y="7" width="22" height="3.5" rx="0.8" strokeDasharray="2 1" />
      <rect x="3" y="12" width="22" height="3.5" rx="0.8" strokeDasharray="2 1" />
      <rect x="5" y="3.2" width="8" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="5" y="8.2" width="10" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="5" y="13.2" width="7" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <text x="22" y="4.7" fontSize="3" fill="currentColor" opacity="0.3">+</text>
      <text x="22" y="9.7" fontSize="3" fill="currentColor" opacity="0.3">+</text>
      <text x="22" y="14.7" fontSize="3" fill="currentColor" opacity="0.3">+</text>
    </svg>
  ),
  'cta-banner': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="3" width="26" height="14" rx="1.5" fill="currentColor" opacity="0.06" />
      <rect x="1" y="3" width="26" height="14" rx="1.5" strokeDasharray="2 1" />
      <rect x="7" y="6" width="14" height="1.5" rx="0.5" fill="currentColor" opacity="0.4" />
      <rect x="9" y="9" width="10" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="10" y="12" width="8" height="3" rx="1" />
    </svg>
  ),
  // Content
  'text-block': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="3" y="3" width="14" height="2" rx="0.5" fill="currentColor" opacity="0.45" />
      <rect x="3" y="7" width="22" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="3" y="9" width="22" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="3" y="11" width="22" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="3" y="13" width="18" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="3" y="16" width="22" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  'image': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="2" width="24" height="16" rx="1.5" strokeDasharray="2 1" />
      <circle cx="8" cy="7" r="2" strokeOpacity="0.4" />
      <polyline points="3,16 10,10 15,13 19,9 25,14" strokeOpacity="0.3" fill="none" />
    </svg>
  ),
  'video': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="2" width="24" height="16" rx="1.5" strokeDasharray="2 1" />
      <polygon points="12,7 12,13 18,10" fill="currentColor" opacity="0.3" stroke="none" />
    </svg>
  ),
  'card': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="4" y="1" width="20" height="18" rx="1.5" />
      <rect x="4" y="1" width="20" height="8" rx="1.5" fill="currentColor" opacity="0.08" />
      <rect x="6.5" y="11" width="10" height="1.2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="6.5" y="13.5" width="14" height="0.7" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="6.5" y="15" width="12" height="0.7" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  'list': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <circle cx="5" cy="5" r="1" fill="currentColor" opacity="0.35" stroke="none" />
      <circle cx="5" cy="10" r="1" fill="currentColor" opacity="0.35" stroke="none" />
      <circle cx="5" cy="15" r="1" fill="currentColor" opacity="0.35" stroke="none" />
      <rect x="8" y="4.2" width="16" height="1.2" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="8" y="9.2" width="14" height="1.2" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="8" y="14.2" width="12" height="1.2" rx="0.3" fill="currentColor" opacity="0.25" />
    </svg>
  ),
  // Interactive
  'button': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="5" y="6" width="18" height="8" rx="2" />
      <rect x="9" y="9.2" width="10" height="1.5" rx="0.5" fill="currentColor" opacity="0.35" />
    </svg>
  ),
  'form': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="4" y="1.5" width="20" height="4" rx="0.8" strokeDasharray="2 1" />
      <rect x="4" y="7" width="20" height="4" rx="0.8" strokeDasharray="2 1" />
      <rect x="13" y="13" width="11" height="4" rx="1" />
      <rect x="15" y="14.3" width="7" height="1.4" rx="0.4" fill="currentColor" opacity="0.35" />
    </svg>
  ),
  'contact-form': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="4" y="1.5" width="9" height="3.5" rx="0.8" strokeDasharray="2 1" />
      <rect x="15" y="1.5" width="9" height="3.5" rx="0.8" strokeDasharray="2 1" />
      <rect x="4" y="6.5" width="20" height="3.5" rx="0.8" strokeDasharray="2 1" />
      <rect x="4" y="11.5" width="20" height="4" rx="0.8" strokeDasharray="2 1" />
      <rect x="15" y="16.5" width="9" height="2.5" rx="0.8" />
    </svg>
  ),
  'search-bar': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="3" y="6" width="22" height="8" rx="2" />
      <circle cx="8" cy="10" r="2" strokeOpacity="0.4" />
      <line x1="9.5" y1="11.5" x2="11" y2="13" strokeOpacity="0.4" />
      <rect x="13" y="9" width="8" height="1" rx="0.3" fill="currentColor" opacity="0.15" />
    </svg>
  ),
  'modal': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="1" width="26" height="18" rx="1" fill="currentColor" opacity="0.05" stroke="none" />
      <rect x="5" y="3" width="18" height="14" rx="1.5" fill="var(--background, white)" />
      <rect x="5" y="3" width="18" height="14" rx="1.5" />
      <rect x="7" y="5.5" width="8" height="1.2" rx="0.3" fill="currentColor" opacity="0.4" />
      <line x1="21" y1="4.5" x2="21" y2="5.5" strokeOpacity="0.4" />
      <line x1="20.5" y1="5" x2="21.5" y2="5" strokeOpacity="0.4" />
      <rect x="7" y="8" width="14" height="0.7" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="7" y="9.5" width="12" height="0.7" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="14" y="13" width="7" height="2.5" rx="0.8" />
    </svg>
  ),
  // Data
  'table': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="2" width="24" height="16" rx="1" />
      <rect x="2" y="2" width="24" height="4" rx="1" fill="currentColor" opacity="0.1" />
      <line x1="2" y1="6" x2="26" y2="6" strokeOpacity="0.3" />
      <line x1="2" y1="10" x2="26" y2="10" strokeOpacity="0.15" />
      <line x1="2" y1="14" x2="26" y2="14" strokeOpacity="0.15" />
      <line x1="10" y1="2" x2="10" y2="18" strokeOpacity="0.15" />
      <line x1="18" y1="2" x2="18" y2="18" strokeOpacity="0.15" />
    </svg>
  ),
  'chart': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <line x1="4" y1="17" x2="25" y2="17" strokeOpacity="0.3" />
      <line x1="4" y1="3" x2="4" y2="17" strokeOpacity="0.3" />
      <rect x="7" y="9" width="3" height="8" rx="0.5" fill="currentColor" opacity="0.2" stroke="none" />
      <rect x="12" y="5" width="3" height="12" rx="0.5" fill="currentColor" opacity="0.3" stroke="none" />
      <rect x="17" y="11" width="3" height="6" rx="0.5" fill="currentColor" opacity="0.2" stroke="none" />
      <rect x="22" y="7" width="3" height="10" rx="0.5" fill="currentColor" opacity="0.25" stroke="none" />
    </svg>
  ),
  'stats-counter': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="5" width="7" height="10" rx="1" strokeDasharray="2 1" />
      <rect x="10.5" y="5" width="7" height="10" rx="1" strokeDasharray="2 1" />
      <rect x="19" y="5" width="7" height="10" rx="1" strokeDasharray="2 1" />
      <rect x="3.5" y="7.5" width="4" height="2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="12" y="7.5" width="4" height="2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="20.5" y="7.5" width="4" height="2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="3.5" y="11" width="4" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="12" y="11" width="4" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="20.5" y="11" width="4" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  // Data (additional)
  'progress-bar': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="3" y="4" width="10" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="3" y="7" width="22" height="4" rx="2" />
      <rect x="3" y="7" width="14" height="4" rx="2" fill="currentColor" opacity="0.2" />
      <rect x="3" y="14" width="10" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="3" y="17" width="22" height="0.5" rx="0.25" strokeOpacity="0.3" />
      <rect x="3" y="17" width="8" height="0.5" rx="0.25" fill="currentColor" opacity="0.15" />
    </svg>
  ),
  'metric-cards': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="3" width="8" height="14" rx="1" />
      <rect x="10" y="3" width="8" height="14" rx="1" />
      <rect x="19" y="3" width="8" height="14" rx="1" />
      <rect x="2.5" y="5.5" width="5" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="2.5" y="8" width="5" height="2.5" rx="0.3" fill="currentColor" opacity="0.45" />
      <polyline points="3,14 4.5,12.5 6,13.5 7.5,11.5" strokeOpacity="0.3" fill="none" />
      <rect x="11.5" y="5.5" width="5" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="11.5" y="8" width="5" height="2.5" rx="0.3" fill="currentColor" opacity="0.45" />
      <polyline points="12,14 13.5,13 15,13.5 16.5,12" strokeOpacity="0.3" fill="none" />
      <rect x="20.5" y="5.5" width="5" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="20.5" y="8" width="5" height="2.5" rx="0.3" fill="currentColor" opacity="0.45" />
      <polyline points="21,14 22.5,13 24,12 25.5,11" strokeOpacity="0.3" fill="none" />
    </svg>
  ),
  'data-list': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="3" y="3" width="7" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="18" y="3" width="7" height="1" rx="0.3" fill="currentColor" opacity="0.2" />
      <line x1="3" y1="5.5" x2="25" y2="5.5" strokeOpacity="0.15" />
      <rect x="3" y="7" width="8" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="17" y="7" width="8" height="1" rx="0.3" fill="currentColor" opacity="0.2" />
      <line x1="3" y1="9.5" x2="25" y2="9.5" strokeOpacity="0.15" />
      <rect x="3" y="11" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="19" y="11" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.2" />
      <line x1="3" y1="13.5" x2="25" y2="13.5" strokeOpacity="0.15" />
      <rect x="3" y="15" width="9" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="16" y="15" width="9" height="1" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  // Sections (additional)
  'sidebar-nav': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="1" width="10" height="18" rx="1" />
      <rect x="1" y="1" width="10" height="18" rx="1" fill="currentColor" opacity="0.05" />
      <rect x="3" y="3.5" width="5" height="1.5" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="3" y="7" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="3" y="9.5" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="3" y="12" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="3" y="14.5" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.15" />
      <line x1="12" y1="1" x2="12" y2="19" strokeOpacity="0.2" />
      <rect x="14" y="3" width="12" height="1" rx="0.3" fill="currentColor" opacity="0.1" />
      <rect x="14" y="6" width="12" height="1" rx="0.3" fill="currentColor" opacity="0.1" />
    </svg>
  ),
  'breadcrumbs': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="8.5" width="5" height="1.2" rx="0.3" fill="currentColor" opacity="0.3" />
      <text x="8.5" y="10.2" fontSize="4" fill="currentColor" opacity="0.25">/</text>
      <rect x="11" y="8.5" width="6" height="1.2" rx="0.3" fill="currentColor" opacity="0.3" />
      <text x="18.5" y="10.2" fontSize="4" fill="currentColor" opacity="0.25">/</text>
      <rect x="21" y="8.5" width="5" height="1.2" rx="0.3" fill="currentColor" opacity="0.5" />
    </svg>
  ),
  'tabs': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="4" width="7" height="4" rx="0.8" fill="currentColor" opacity="0.15" />
      <rect x="2" y="4" width="7" height="4" rx="0.8" />
      <rect x="10" y="4" width="7" height="4" rx="0.8" strokeDasharray="2 1" />
      <rect x="18" y="4" width="7" height="4" rx="0.8" strokeDasharray="2 1" />
      <line x1="2" y1="8" x2="26" y2="8" strokeOpacity="0.3" />
      <rect x="3" y="10.5" width="16" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="3" y="12.5" width="20" height="0.8" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="3" y="14.5" width="12" height="0.8" rx="0.3" fill="currentColor" opacity="0.15" />
    </svg>
  ),
  'pagination': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <text x="3" y="11.5" fontSize="5" fill="currentColor" opacity="0.3">&lsaquo;</text>
      <rect x="7" y="7" width="4" height="4.5" rx="0.8" fill="currentColor" opacity="0.2" />
      <rect x="7" y="7" width="4" height="4.5" rx="0.8" />
      <rect x="12" y="7" width="4" height="4.5" rx="0.8" strokeDasharray="2 1" />
      <rect x="17" y="7" width="4" height="4.5" rx="0.8" strokeDasharray="2 1" />
      <text x="23" y="11.5" fontSize="5" fill="currentColor" opacity="0.3">&rsaquo;</text>
    </svg>
  ),
  // Content (additional)
  'accordion': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="3" y="1.5" width="22" height="3.5" rx="0.8" />
      <rect x="5" y="2.5" width="8" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <rect x="3" y="6" width="22" height="8" rx="0.8" fill="currentColor" opacity="0.05" />
      <rect x="3" y="6" width="22" height="8" rx="0.8" />
      <rect x="5" y="7.2" width="10" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <text x="22.5" y="8.5" fontSize="3" fill="currentColor" opacity="0.3">&minus;</text>
      <rect x="5" y="9.5" width="18" height="0.6" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="5" y="10.8" width="16" height="0.6" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="5" y="12.1" width="14" height="0.6" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="3" y="15" width="22" height="3.5" rx="0.8" />
      <rect x="5" y="16" width="9" height="1" rx="0.3" fill="currentColor" opacity="0.35" />
      <text x="22.5" y="17.5" fontSize="3" fill="currentColor" opacity="0.3">+</text>
    </svg>
  ),
  'gallery': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="1" y="2" width="8" height="7" rx="0.8" strokeDasharray="2 1" />
      <rect x="10" y="2" width="8" height="7" rx="0.8" strokeDasharray="2 1" />
      <rect x="19" y="2" width="8" height="7" rx="0.8" strokeDasharray="2 1" />
      <rect x="1" y="11" width="8" height="7" rx="0.8" strokeDasharray="2 1" />
      <rect x="10" y="11" width="8" height="7" rx="0.8" strokeDasharray="2 1" />
      <rect x="19" y="11" width="8" height="7" rx="0.8" strokeDasharray="2 1" />
      <circle cx="4" cy="4.5" r="1" strokeOpacity="0.3" />
      <polyline points="2,8 4.5,5.5 7,7 8,6" strokeOpacity="0.25" fill="none" />
      <circle cx="13" cy="4.5" r="1" strokeOpacity="0.3" />
      <polyline points="11,8 13.5,5.5 16,7 17,6" strokeOpacity="0.25" fill="none" />
    </svg>
  ),
  'timeline': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <line x1="8" y1="2" x2="8" y2="18" strokeOpacity="0.25" />
      <circle cx="8" cy="4" r="1.5" fill="currentColor" opacity="0.3" stroke="none" />
      <circle cx="8" cy="10" r="1.5" fill="currentColor" opacity="0.3" stroke="none" />
      <circle cx="8" cy="16" r="1.5" fill="currentColor" opacity="0.3" stroke="none" />
      <rect x="12" y="2.5" width="6" height="1" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="12" y="4.5" width="12" height="0.6" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="12" y="8.5" width="8" height="1" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="12" y="10.5" width="14" height="0.6" rx="0.3" fill="currentColor" opacity="0.15" />
      <rect x="12" y="14.5" width="5" height="1" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="12" y="16.5" width="10" height="0.6" rx="0.3" fill="currentColor" opacity="0.15" />
    </svg>
  ),
  'profile-card': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="5" y="1" width="18" height="18" rx="1.5" />
      <circle cx="14" cy="6.5" r="3" strokeOpacity="0.4" />
      <rect x="9" y="11.5" width="10" height="1.2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="10" y="13.5" width="8" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
      <rect x="11" y="16" width="6" height="2" rx="0.8" strokeOpacity="0.4" />
    </svg>
  ),
  // Interactive (additional)
  'login-form': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="5" y="1" width="18" height="18" rx="1.5" />
      <rect x="8" y="3.5" width="12" height="1.2" rx="0.3" fill="currentColor" opacity="0.4" />
      <rect x="8" y="6" width="12" height="3" rx="0.6" strokeDasharray="2 1" />
      <rect x="8" y="10.5" width="12" height="3" rx="0.6" strokeDasharray="2 1" />
      <rect x="8" y="15" width="12" height="3" rx="0.8" />
      <rect x="10" y="15.8" width="8" height="1.4" rx="0.3" fill="currentColor" opacity="0.3" />
    </svg>
  ),
  'file-upload': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="3" y="2" width="22" height="16" rx="1.5" strokeDasharray="3 2" />
      <polyline points="11,9 14,6 17,9" strokeOpacity="0.4" fill="none" />
      <line x1="14" y1="6" x2="14" y2="13" strokeOpacity="0.4" />
      <rect x="9" y="14.5" width="10" height="0.8" rx="0.3" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  'notification': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="2" y="5" width="24" height="10" rx="1.5" />
      <circle cx="6" cy="10" r="1.5" fill="currentColor" opacity="0.25" stroke="none" />
      <rect x="9" y="8.5" width="10" height="1" rx="0.3" fill="currentColor" opacity="0.3" />
      <rect x="9" y="10.5" width="7" height="0.7" rx="0.3" fill="currentColor" opacity="0.15" />
      <line x1="23" y1="7.5" x2="24.5" y2="9" strokeOpacity="0.3" />
      <line x1="24.5" y1="7.5" x2="23" y2="9" strokeOpacity="0.3" />
    </svg>
  ),
  'dropdown-menu': (
    <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
      <rect x="6" y="2" width="14" height="4" rx="0.8" />
      <rect x="9" y="3.3" width="6" height="1.2" rx="0.3" fill="currentColor" opacity="0.3" />
      <polyline points="17,3.5 18,4.5 19,3.5" strokeOpacity="0.3" fill="none" />
      <rect x="6" y="7" width="14" height="12" rx="0.8" />
      <rect x="8" y="8.5" width="8" height="1" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="8" y="10.5" width="10" height="1" rx="0.3" fill="currentColor" opacity="0.25" />
      <line x1="7" y1="12.5" x2="19" y2="12.5" strokeOpacity="0.15" />
      <rect x="8" y="13.5" width="7" height="1" rx="0.3" fill="currentColor" opacity="0.25" />
      <rect x="8" y="15.5" width="9" height="1" rx="0.3" fill="currentColor" opacity="0.25" />
    </svg>
  ),
};

interface BlockCardProps {
  block: SemanticBlock;
  onDragStart: (block: SemanticBlock) => void;
}

export function BlockCard({ block, onDragStart }: BlockCardProps) {
  const t = useTranslations('semanticBlocks');
  const [expanded, setExpanded] = useState(false);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/semantic-block', block.id);
    e.dataTransfer.effectAllowed = 'copy';
    onDragStart(block);
  }, [block, onDragStart]);

  return (
    <div className="group relative">
      <div className={`text-xs select-none transition-colors group-hover:border-primary/40 group-hover:bg-primary/5 ${expanded ? 'rounded-t-md border-b-0' : 'rounded-md'} border border-border/50 bg-background/80`}>
        <div
          draggable
          onDragStart={handleDragStart}
          onClick={() => expanded && setExpanded(false)}
          className="flex items-center gap-1.5 px-2 py-1.5 cursor-grab active:cursor-grabbing"
        >
          <div className="h-5 w-7 flex-shrink-0 text-primary/80">
            {BLOCK_THUMBNAILS[block.id] || (
              <svg viewBox="0 0 28 20" fill="none" stroke="currentColor" strokeWidth="0.8">
                <rect x="2" y="2" width="24" height="16" rx="1.5" strokeDasharray="2 1" />
              </svg>
            )}
          </div>
          <span className="text-foreground/90 truncate flex-1">{block.name}</span>
          <GripVertical className="h-3 w-3 flex-shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-colors" />
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            onMouseDown={(e) => e.stopPropagation()}
            className="flex-shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-muted-foreground transition-all"
            title={expanded ? t('hideDescription') : t('showDescription')}
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>
      {expanded && (
        <div
          className="absolute left-0 right-0 top-[calc(100%-1px)] z-10 rounded-b-md border border-t-0 border-border/50 bg-popover group-hover:border-primary/40 px-2.5 py-2 text-[10px] leading-snug text-muted-foreground shadow-md transition-colors"
          onClick={() => setExpanded(false)}
        >
          {block.description}
        </div>
      )}
    </div>
  );
}
