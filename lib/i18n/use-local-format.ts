'use client';

import { useMemo } from 'react';
import { useFormatter, useLocale, type DateTimeFormatOptions } from 'next-intl';

import { elapsed } from './relative-time';

/**
 * Dates and numbers in the app's locale, and dates in the viewer's own time zone.
 *
 * `useFormatter` follows the app's locale (a bare `toLocaleString()` follows the browser's, so a
 * Finnish interface on an English browser showed US dates). It needs a time zone, though: none is
 * configured globally on purpose, since the only one the server knows is its own, and a timestamp
 * shown in the server's zone is wrong for everyone else. Without one, every call reports
 * ENVIRONMENT_FALLBACK through `onError`, which logs. This passes the browser's zone explicitly.
 *
 * Client-side formatting only: on the server this would format in the server's zone, and the
 * hydrated client would disagree. Format dates in an effect or after data loads, as the session
 * viewer does, or behind a client-only boundary.
 */
export function useLocalFormat() {
  const format = useFormatter();
  const locale = useLocale();

  return useMemo(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      dateTime: (value: Date | number | string, options?: DateTimeFormatOptions) =>
        format.dateTime(value instanceof Date ? value : new Date(value), { timeZone, ...options }),
      number: format.number,
      /**
       * "3 days ago", "eilen", "어제". `numeric: 'auto'` lets each language use its own word for one
       * unit away.
       */
      relativeTime: (value: Date | number | string) => {
        const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
        if (Number.isNaN(then)) return '';
        const { value: amount, unit } = elapsed((then - Date.now()) / 1000);
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit);
      },
      /**
       * Relative within a week, then the date: past that, "23 days ago" is harder to place than the
       * date itself. Compact ("3 min sitten", "2시간 전") for lists and comment headers. A value
       * that will not parse renders as nothing, rather than as "NaN" or "Invalid Date".
       */
      recent: (value: Date | number | string) => {
        const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
        if (Number.isNaN(then)) return '';
        const seconds = (then - Date.now()) / 1000;
        if (Math.abs(seconds) >= 7 * 86400) {
          return format.dateTime(new Date(then), { timeZone, dateStyle: 'medium' });
        }
        const { value: amount, unit } = elapsed(seconds);
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(amount, unit);
      },
      /** How old something is, with no "ago": "17 days", "17 päivää", "17일", for dense columns. */
      age: (value: Date | number | string) => {
        const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
        if (Number.isNaN(then)) return '';
        const { value: amount, unit } = elapsed((Date.now() - then) / 1000);
        return format.number(Math.max(amount, 0), { style: 'unit', unit, unitDisplay: 'long' });
      },
      /**
       * A size in binary steps: "512 bytes", "2 kB", "1.5 GB", "5 Mt". Plain bytes are spelled out,
       * since the short form reads "512 byte" in English.
       */
      bytes: (bytes: number, maximumFractionDigits = 0) => {
        const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
        const step = bytes >= 1024 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
        return format.number(bytes / 1024 ** step, {
          style: 'unit',
          unit: units[step],
          unitDisplay: step === 0 ? 'long' : 'short',
          maximumFractionDigits,
        });
      },
    };
  }, [format, locale]);
}
