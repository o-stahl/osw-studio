'use client';

import { useState, useEffect } from 'react';
import { configManager } from '@/lib/config/storage';
import { Switch } from '@/components/ui/switch';
import { useTheme } from 'next-themes';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { setTelemetryOptIn } from '@/lib/telemetry';
import { Palette } from 'lucide-react';
import { toast } from 'sonner';
import { emitViewChanged, writeLocalStudioView } from '@/lib/view-mode-event';
import { useStudioView } from '@/components/view-mode-provider';
import { Section, SectionHeader, SectionBody } from '@/components/ui/section';
import { SettingRow } from '@/components/ui/setting-row';
import { Tip } from '@/components/ui/tooltip';
import { useTranslations } from 'next-intl';
import { useLocaleSwitch } from '@/lib/i18n/use-locale-switch';
import { locales, localeNames, type Locale } from '@/lib/i18n/config';

export function AppearancePane() {
  const tn = useTranslations('nav');
  const { theme, setTheme } = useTheme();
  const t = useTranslations('settings');
  const locale = useLocaleSwitch();
  const [mounted, setMounted] = useState(false);
  // Where the choice is kept differs: server mode holds it on the account so it follows the person
  // between devices, browser mode on the device because there is no account to hold it.
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  /**
   * Read from context, which already has the answer: server mode seeds it during the page's own
   * server render and browser mode reads it from storage, so it is there on the first paint.
   *
   * Fetching it here instead left the row out of the first render and dropped it in above Theme a
   * round trip later, moving everything below it.
   */
  const studioView = useStudioView();
  /**
   * The choice being saved, shown until context catches up.
   *
   * Server mode writes to the account and then announces it, so the refreshed value arrives a
   * request after the press; without this the toggle would sit on the old answer in between.
   */
  const [pendingView, setPendingView] = useState<boolean | null>(null);
  const [savingView, setSavingView] = useState(false);
  const [telemetryOptIn, setTelemetryOptInState] = useState(() =>
    configManager.getSettings().telemetryOptIn !== false
  );
  // The tip names each language in the one the interface is in now.
  const languageTips: Record<Locale, string> = {
    en: t('tips.languageEn'),
    ko: t('tips.languageKo'),
    fi: t('tips.languageFi'),
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (pendingView !== null && studioView === pendingView) setPendingView(null);
  }, [studioView, pendingView]);

  const changeView = async (studio: boolean) => {
    if (!isServerMode) {
      // Local, synchronous, and it announces itself, so context has the new value already.
      writeLocalStudioView(studio);
      return;
    }
    setPendingView(studio);
    setSavingView(true);
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studioView: studio }),
      });
      if (!res.ok) throw new Error('Failed to change the view');
      emitViewChanged();
    } catch {
      setPendingView(null);
      toast.error(t('viewChangeFailed'));
    } finally {
      setSavingView(false);
    }
  };

  return (
    <Section>
      <SectionHeader icon={Palette} title={tn('settings.appearance')} />
      <SectionBody className="px-4 py-1">
        <SettingRow
          title={t('interface')}
          description={t('interfaceHint')}
        >
          <ToggleGroup
            type="single"
            value={(pendingView ?? studioView) ? 'studio' : 'simple'}
            onValueChange={(v) => { if (v && !savingView) changeView(v === 'studio'); }}
            disabled={savingView}
          >
            <Tip label={t('tips.studio')} wrap>
              <ToggleGroupItem value="studio">{t('studio')}</ToggleGroupItem>
            </Tip>
            <Tip label={t('tips.simple')} wrap>
              <ToggleGroupItem value="simple">{t('simple')}</ToggleGroupItem>
            </Tip>
          </ToggleGroup>
        </SettingRow>

        <SettingRow title={t('theme')} description={t('themeHint')}>
          <ToggleGroup
            type="single"
            value={mounted ? (theme || 'dark') : 'dark'}
            onValueChange={(value: string) => {
              if (value) {
                setTheme(value);
                configManager.setSetting('theme', value as 'light' | 'dark' | 'system');
              }
            }}
          >
            <Tip label={t('tips.dark')} wrap>
              <ToggleGroupItem value="dark">{t('dark')}</ToggleGroupItem>
            </Tip>
            <Tip label={t('tips.light')} wrap>
              <ToggleGroupItem value="light">{t('light')}</ToggleGroupItem>
            </Tip>
            <Tip label={t('tips.system')} wrap>
              <ToggleGroupItem value="system">{t('system')}</ToggleGroupItem>
            </Tip>
          </ToggleGroup>
        </SettingRow>

        <SettingRow title={t('language.title')} description={t('language.description')}>
          <ToggleGroup
            type="single"
            value={locale.current}
            onValueChange={(value: string) => {
              if (value && value !== locale.current) void locale.change(value as Locale);
            }}
            disabled={locale.pending}
          >
            {locales.map((locale) => (
              // Each language is named in itself: its English name is no help to someone looking
              // for it.
              <Tip key={locale} label={languageTips[locale]} wrap>
                <ToggleGroupItem value={locale}>
                  {localeNames[locale]}
                </ToggleGroupItem>
              </Tip>
            ))}
          </ToggleGroup>
        </SettingRow>

        <SettingRow
          title={t('analytics')}
          description={t('analyticsHint')}
        >
          <Tip label={telemetryOptIn ? t('tips.analyticsOff') : t('analyticsHint')} wrap align="end">
            <Switch
              id="telemetry"
              aria-label={t('analytics')}
              checked={telemetryOptIn}
              onCheckedChange={(checked) => {
                setTelemetryOptInState(checked);
                setTelemetryOptIn(checked);
              }}
            />
          </Tip>
        </SettingRow>
      </SectionBody>
    </Section>
  );
}
