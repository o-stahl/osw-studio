import React from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import { setRuntimeTranslator, type RuntimeTranslator } from '@/lib/i18n/runtime';

/**
 * Wraps a tree in the provider the app's root layout supplies, with the English messages.
 *
 * A component that calls `useTranslations` throws without it, so any rendering test of a translated
 * component needs this. English rather than a fixture, so an assertion on visible text stays
 * readable and a renamed key fails the test instead of silently matching a stub.
 */
export function withMessages(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );
}

/**
 * Registers the English catalogue with `lib/i18n/runtime`, as `TranslatorBridge` does in the app.
 *
 * For tests of code outside components (stores, sync) that assert on what a toast says. Without
 * it the toast receives a key path, and an assertion on the absence of an English phrase passes
 * whether or not the toast fired.
 */
export function registerEnglishTranslator() {
  setRuntimeTranslator(createTranslator({ locale: 'en', messages: en }) as unknown as RuntimeTranslator);
}
