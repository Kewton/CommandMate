/**
 * AppUpdateContext
 * Issue #2654: app-wide update state.
 *
 * The update check, the self-update state machine and the restart watch used
 * to live inside UpdateNotificationBanner, which is rendered inside InfoModal.
 * Modal unmounts its children when closed, so closing the modal mid-update
 * stopped the ping loop and the page never reloaded onto the new version.
 * The provider sits in AppProviders, so the watch survives any modal and any
 * client-side navigation.
 *
 * Without a provider, useAppUpdate() returns APP_UPDATE_DEFAULT_VALUE (no
 * update, idle, no-op actions), so component tests need no wrapper.
 *
 * @module contexts/AppUpdateContext
 */

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { ApiError, appApi, type UpdateCheckResponse } from '@/lib/api-client';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

/**
 * Update lifecycle.
 * `no-restart` is a terminal success state, not a failure: the update landed
 * but this server has no PID file, so it keeps running the old version.
 * `no-restart` / `timeout` / `error` stay until the page is reloaded.
 */
export type AppUpdateState =
  | 'idle'
  | 'confirming'
  | 'starting'
  | 'updating'
  | 'no-restart'
  | 'timeout'
  | 'error';

/** `worktree` namespace keys of the start-failure messages */
export type AppUpdateErrorKey =
  | 'update.errorNotGlobal'
  | 'update.errorInProgress'
  | 'update.errorGeneric';

export interface AppUpdateContextValue {
  /** Last adopted /api/app/update-check response; null until one succeeds */
  updateInfo: UpdateCheckResponse | null;
  /** True until the first check settles (success or failure). Rechecks do not set it again. */
  checking: boolean;
  /** `updateInfo?.hasUpdate === true` */
  hasUpdate: boolean;
  /** installType is 'global' or 'npx' (Issue #1198 / #1395) */
  canSelfUpdate: boolean;
  state: AppUpdateState;
  /** logPath returned by POST /api/app/update */
  logPath: string | null;
  /** Set only in the `error` state */
  errorKey: AppUpdateErrorKey | null;
  /** idle → confirming. No-op unless hasUpdate && canSelfUpdate && state === 'idle' */
  openConfirm: () => void;
  /** confirming → idle. No-op in any other state */
  cancel: () => void;
  /** confirming → starting → updating / no-restart / error. No-op unless confirming */
  confirm: () => Promise<void>;
}

/** How often the liveness probe runs while waiting for the restart */
export const UPDATE_POLL_INTERVAL_MS = 2000;

/** Give up waiting for the server to come back after this long */
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

/** Re-run the update check this often (only while idle) */
export const UPDATE_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

const noop = (): void => {};

/** Value seen by consumers rendered without AppUpdateProvider */
export const APP_UPDATE_DEFAULT_VALUE: AppUpdateContextValue = {
  updateInfo: null,
  checking: false,
  hasUpdate: false,
  canSelfUpdate: false,
  state: 'idle',
  logPath: null,
  errorKey: null,
  openConfirm: noop,
  cancel: noop,
  confirm: async () => {},
};

const AppUpdateContext = createContext<AppUpdateContextValue>(APP_UPDATE_DEFAULT_VALUE);

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('worktree');
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState<AppUpdateState>('idle');
  const [logPath, setLogPath] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<AppUpdateErrorKey | null>(null);

  // Read by the recheck timer and by confirm() without re-subscribing them.
  const stateRef = useRef<AppUpdateState>('idle');
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Survives re-renders so a restart that completes between two polls is not missed.
  const seenDownRef = useRef(false);

  // Update check: once on mount, then every UPDATE_RECHECK_INTERVAL_MS while idle.
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      if (stateRef.current !== 'idle') return;
      try {
        const result = await appApi.checkForUpdate();
        if (cancelled) return;
        // A degraded answer means "could not check", not "no update": keep a known result.
        setUpdateInfo((prev) => (result.status === 'degraded' && prev !== null ? prev : result));
      } catch {
        // Keep the previous result: a failed recheck must not hide a known update.
      } finally {
        if (!cancelled) setChecking(false);
      }
    };
    void run();
    const timer = setInterval(() => {
      void run();
    }, UPDATE_RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const hasUpdate = updateInfo?.hasUpdate === true;
  const canSelfUpdate =
    updateInfo?.installType === 'global' || updateInfo?.installType === 'npx';

  const openConfirm = useCallback(() => {
    if (!hasUpdate || !canSelfUpdate) return;
    setState((prev) => (prev === 'idle' ? 'confirming' : prev));
  }, [hasUpdate, canSelfUpdate]);

  const cancel = useCallback(() => {
    setState((prev) => (prev === 'confirming' ? 'idle' : prev));
  }, []);

  const confirm = useCallback(async () => {
    if (stateRef.current !== 'confirming') return;
    // Claimed before the await so a second click cannot start a second update.
    stateRef.current = 'starting';
    setState('starting');
    try {
      const result = await appApi.startUpdate();
      setLogPath(result.logPath);
      // Issue #1198 決定3: with no PID file the update never stops this server.
      setState(result.willRestart ? 'updating' : 'no-restart');
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setErrorKey('update.errorNotGlobal');
      } else if (error instanceof ApiError && error.status === 409) {
        setErrorKey('update.errorInProgress');
      } else {
        setErrorKey('update.errorGeneric');
      }
      setState('error');
    }
  }, []);

  /**
   * Watch the server go down and come back, then reload onto the new version.
   * Moved verbatim from UpdateNotificationBanner (Issue #1198).
   *
   * `commandmate update` stops the server before `npm install -g` and only
   * starts it again afterwards (update.ts steps 6-9), so the outage is tens of
   * seconds — far wider than UPDATE_POLL_INTERVAL_MS. Probe failures here are
   * the expected signal and are swallowed by appApi.ping(): the update must not
   * spray connection-error toasts.
   */
  useEffect(() => {
    if (state !== 'updating') return;

    let cancelled = false;
    const startedAt = Date.now();
    seenDownRef.current = false;

    const timer = setInterval(async () => {
      if (cancelled) return;

      if (Date.now() - startedAt > UPDATE_TIMEOUT_MS) {
        setState('timeout');
        return;
      }

      const alive = await appApi.ping();
      if (cancelled) return;

      if (!alive) {
        seenDownRef.current = true;
        return;
      }
      if (seenDownRef.current) {
        window.location.reload();
      }
    }, UPDATE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state]);

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      updateInfo,
      checking,
      hasUpdate,
      canSelfUpdate,
      state,
      logPath,
      errorKey,
      openConfirm,
      cancel,
      confirm,
    }),
    [
      updateInfo,
      checking,
      hasUpdate,
      canSelfUpdate,
      state,
      logPath,
      errorKey,
      openConfirm,
      cancel,
      confirm,
    ]
  );

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      {/* The only update confirmation dialog in the app. */}
      <ConfirmDialog
        isOpen={state === 'confirming'}
        title={t('update.confirmTitle')}
        description={t('update.confirmDescription', { version: updateInfo?.latestVersion ?? '' })}
        confirmLabel={t('update.confirmButton')}
        onConfirm={() => {
          void confirm();
        }}
        onCancel={cancel}
      />
    </AppUpdateContext.Provider>
  );
}

/** App-wide update state. Outside AppUpdateProvider this is APP_UPDATE_DEFAULT_VALUE. */
export function useAppUpdate(): AppUpdateContextValue {
  return useContext(AppUpdateContext);
}
