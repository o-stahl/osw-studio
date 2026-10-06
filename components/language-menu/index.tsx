'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Languages } from 'lucide-react';
import { MenuPill } from '@/components/ui/menu-pill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLocaleSwitch } from '@/lib/i18n/use-locale-switch';
import { locales, localeNames, type Locale } from '@/lib/i18n/config';

/**
 * The interface languages, each in its own name, behind whatever trigger the caller gives. For the
 * places Settings cannot be reached from, or where a reader who cannot read the current language
 * still has to find it: the sidebar footer and the sign-in pages.
 */
export function LanguageMenu({
  children,
  onOpenChange,
  modal,
  side = 'top',
  align = 'start',
}: {
  /** The trigger, rendered as the menu's button. */
  children: React.ReactElement;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
}) {
  const { current, pending, change } = useLocaleSwitch();

  return (
    <DropdownMenu modal={modal} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} collisionPadding={8} className="min-w-40">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(value) => {
            if (value !== current) void change(value as Locale);
          }}
        >
          {locales.map((locale) => (
            <DropdownMenuRadioItem key={locale} value={locale} lang={locale} disabled={pending}>
              {localeNames[locale]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The language menu as a labelled pill, for a page with no other chrome (sign-in, registration). */
export function LanguagePill({ className }: { className?: string }) {
  const t = useTranslations('settings');
  const activeLocale = useLocale();
  return (
    <LanguageMenu side="bottom" align="end">
      <MenuPill
        icon={Languages}
        label={<span lang={activeLocale}>{localeNames[activeLocale]}</span>}
        opens="down"
        className={className}
        aria-label={t('language.title')}
      />
    </LanguageMenu>
  );
}
