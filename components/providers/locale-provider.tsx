'use client';

import * as React from 'react';
import { configManager } from '@/lib/config/storage';
import { dictionaries, type Locale, type Dictionary } from '@/lib/i18n';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Dictionary;
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  // Server and first client render both default to 'ko' so hydration matches;
  // the stored preference (if 'en') is applied after mount, same as ThemeProvider.
  const [locale, setLocaleState] = React.useState<Locale>('ko');

  React.useEffect(() => {
    setLocaleState(configManager.getLocale());
  }, []);

  const setLocale = React.useCallback((next: Locale) => {
    configManager.setLocale(next);
    setLocaleState(next);
  }, []);

  const value = React.useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: dictionaries[locale],
  }), [locale, setLocale]);

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useTranslation(): LocaleContextValue {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useTranslation must be used within a LocaleProvider');
  }
  return ctx;
}
