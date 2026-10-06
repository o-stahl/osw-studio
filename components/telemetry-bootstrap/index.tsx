'use client';

import { useEffect, useState, useCallback } from 'react';
import { initTelemetry, track } from '@/lib/telemetry';
import { markSessionStartedOnce } from '@/lib/telemetry/session-guard';
import { sessionStartFields } from '@/lib/telemetry/session-fields';
import { isDisclosurePending, markDisclosureSettled } from '@/lib/telemetry/disclosure-state';
import { TelemetryDisclosure } from '@/components/telemetry-disclosure';

/**
 * Initializes telemetry and shows the first-run disclosure. Mounted by both
 * the browser-mode SPA (StudioApp) and the server-mode PageWrapper so every
 * deployment mode reports.
 */

export function TelemetryBootstrap() {
  const [showDisclosure, setShowDisclosure] = useState(false);

  useEffect(() => {
    initTelemetry();
    // Once per page load, even though PageWrapper remounts on every server-mode
    // route navigation.
    if (markSessionStartedOnce()) {
      track('session_start', sessionStartFields(document.referrer, window.location.search, window.location.hostname));
    }
    if (isDisclosurePending()) setShowDisclosure(true);
  }, []);

  const dismiss = useCallback(() => {
    markDisclosureSettled();
    setShowDisclosure(false);
  }, []);

  return <TelemetryDisclosure open={showDisclosure} onDismiss={dismiss} />;
}
