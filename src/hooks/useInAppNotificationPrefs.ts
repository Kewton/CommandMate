/**
 * The "in-app notifications" preference (Issue #1788).
 *
 * One boolean: may a cross-screen toast interrupt you when some *other*
 * worktree starts waiting. Kept out of the push-subscription preferences on
 * purpose — those live on the server keyed by a Web Push endpoint, and this one
 * has to work on a device that has no push subscription, no VAPID keys on the
 * server, and no service worker. Those are exactly the setups where the in-app
 * toast is the only notification there is.
 *
 * localStorage rather than the DB for the same reason the sidebar's own
 * preferences are: it describes this browser, and a phone and a laptop pointed
 * at the same server should be allowed to disagree.
 *
 * Writes go through {@link setInAppWaitingToastEnabled}, which fires a
 * `CustomEvent` so the listener mounted in the app shell sees a change made on
 * the More screen immediately, without a reload. The `storage` event covers the
 * other direction (another tab of the same app).
 *
 * Issue #1789 adds a second boolean of the same shape — the waiting chime —
 * sharing this file's storage discipline and its change event. It defaults the
 * other way (**off**); see {@link INAPP_WAITING_SOUND_DEFAULT}.
 *
 * @module hooks/useInAppNotificationPrefs
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

/** localStorage key. `mcbd-` prefix matches the existing client-side settings. */
export const INAPP_WAITING_TOAST_STORAGE_KEY = 'mcbd-inapp-waiting-toast';

/**
 * Same-tab change notification. `storage` only fires in *other* tabs, so the
 * settings toggle and the app-shell listener — both in this tab — need this.
 */
export const INAPP_NOTIFICATION_PREFS_EVENT = 'mcbd:inapp-notification-prefs-changed';

/**
 * On by default: a user who has never opened the setting should still be told
 * that a branch is blocked on them. Only an explicit `"false"` turns it off, so
 * a corrupt or half-written value fails toward being notified.
 */
export const INAPP_WAITING_TOAST_DEFAULT = true;

/** Read the stored preference. Safe on the server and with localStorage denied. */
export function readInAppWaitingToastEnabled(): boolean {
  if (typeof window === 'undefined') return INAPP_WAITING_TOAST_DEFAULT;
  try {
    const raw = window.localStorage.getItem(INAPP_WAITING_TOAST_STORAGE_KEY);
    if (raw === null) return INAPP_WAITING_TOAST_DEFAULT;
    return raw !== 'false';
  } catch {
    return INAPP_WAITING_TOAST_DEFAULT;
  }
}

/** Persist the preference and tell every listener in this tab. */
export function setInAppWaitingToastEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INAPP_WAITING_TOAST_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Quota / private mode — the in-memory state below still updates, the
    // preference simply does not survive a reload.
  }
  window.dispatchEvent(new CustomEvent(INAPP_NOTIFICATION_PREFS_EVENT));
}

export interface UseInAppWaitingToastReturn {
  /** Whether cross-screen waiting toasts may be shown. */
  enabled: boolean;
  /** Persist a new value (and notify every other consumer). */
  setEnabled: (enabled: boolean) => void;
}

/**
 * Subscribe to the preference.
 *
 * Starts at the default and syncs on mount rather than reading storage during
 * render, so the server render and the first client render agree (the same
 * hydration discipline `useLocalStorageState` follows).
 */
export function useInAppWaitingToast(): UseInAppWaitingToastReturn {
  const [enabled, setEnabledState] = useState(INAPP_WAITING_TOAST_DEFAULT);

  useEffect(() => {
    const sync = () => setEnabledState(readInAppWaitingToastEnabled());
    sync();
    window.addEventListener(INAPP_NOTIFICATION_PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(INAPP_NOTIFICATION_PREFS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    setInAppWaitingToastEnabled(next);
  }, []);

  return { enabled, setEnabled };
}

/** localStorage key for the waiting chime (Issue #1789). */
export const INAPP_WAITING_SOUND_STORAGE_KEY = 'mcbd-inapp-waiting-sound';

/**
 * **Off** by default — the opposite of the toast, and deliberately so.
 *
 * A toast appears in a window you are already looking at. A sound leaves the
 * machine: it plays in a meeting, in a shared office, over headphones someone
 * else is wearing. Audio that nobody asked for is the fastest way to have the
 * whole tab muted, which would take the toast down with it. So only an explicit
 * `'true'` turns it on, and a corrupt value stays quiet.
 */
export const INAPP_WAITING_SOUND_DEFAULT = false;

/** Read the stored preference. Safe on the server and with localStorage denied. */
export function readInAppWaitingSoundEnabled(): boolean {
  if (typeof window === 'undefined') return INAPP_WAITING_SOUND_DEFAULT;
  try {
    const raw = window.localStorage.getItem(INAPP_WAITING_SOUND_STORAGE_KEY);
    if (raw === null) return INAPP_WAITING_SOUND_DEFAULT;
    return raw === 'true';
  } catch {
    return INAPP_WAITING_SOUND_DEFAULT;
  }
}

/** Persist the preference and tell every listener in this tab. */
export function setInAppWaitingSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INAPP_WAITING_SOUND_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Quota / private mode — the in-memory state still updates.
  }
  window.dispatchEvent(new CustomEvent(INAPP_NOTIFICATION_PREFS_EVENT));
}

export interface UseInAppWaitingSoundReturn {
  /** Whether the waiting chime may play. */
  enabled: boolean;
  /** Persist a new value (and notify every other consumer). */
  setEnabled: (enabled: boolean) => void;
}

/** Subscribe to the chime preference. Same hydration discipline as the toast. */
export function useInAppWaitingSound(): UseInAppWaitingSoundReturn {
  const [enabled, setEnabledState] = useState(INAPP_WAITING_SOUND_DEFAULT);

  useEffect(() => {
    const sync = () => setEnabledState(readInAppWaitingSoundEnabled());
    sync();
    window.addEventListener(INAPP_NOTIFICATION_PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(INAPP_NOTIFICATION_PREFS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    setInAppWaitingSoundEnabled(next);
  }, []);

  return { enabled, setEnabled };
}
