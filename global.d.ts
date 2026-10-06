import type en from './messages/en.json';
import type { locales } from './lib/i18n/config';

declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof locales)[number];
    Messages: typeof en;
  }
}
