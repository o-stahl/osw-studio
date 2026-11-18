'use client';

import { useEffect } from 'react';

/** The class on `<html>` that turns trackpad swipes between pages off (`assets/globals.css`). */
export const NO_HISTORY_SWIPE_CLASS = 'no-history-swipe';

/**
 * While mounted, a sideways two-finger swipe does not go Back or Forward; the Back button and its
 * shortcut still do. Back closes the open project, and a sideways swipe in the workspace is meant
 * for Canvas or a panel. Chrome, Edge and Firefox honour it; Safari's swipe on macOS does not read
 * `overscroll-behavior`.
 */
export function useNoHistorySwipe(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(NO_HISTORY_SWIPE_CLASS);
    return () => root.classList.remove(NO_HISTORY_SWIPE_CLASS);
  }, []);
}
