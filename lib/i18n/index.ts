import { en } from './dictionaries/en';
import { ko } from './dictionaries/ko';
import type { Dictionary } from './dictionary-type';

export type Locale = 'ko' | 'en';
export type { Dictionary };

export const dictionaries: Record<Locale, Dictionary> = { en, ko };

export const LOCALE_LABELS: Record<Locale, string> = {
  ko: '한국어',
  en: 'English',
};
