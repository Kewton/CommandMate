/**
 * "Default output surface for new sessions" setting (More screen, Issue #2201).
 *
 * Issue #2193 made the output half of a session switchable between the tmux
 * frame and the transcript, and remembered the choice per split / per phone
 * tab. What it could not express is "I always want to start in chat": a
 * remembered last state says nothing about a surface that has no last state.
 * This card is that statement, and it is server-wide because it describes the
 * user, not the branch.
 *
 * Two things it deliberately does not do:
 *
 * - It does not touch surfaces that already have a mode. `readSurfaceMode()`
 *   consults localStorage first and this setting second, so saving here cannot
 *   reset a split the user switched by hand; the copy under `appliesToNew` says
 *   so, because a settings screen that silently flipped every open terminal
 *   would be worse than one that explains itself.
 * - It does not offer a reset. The mode vocabulary has two values and one of
 *   them IS the built-in default, so "reset" and "choose Terminal" are the same
 *   click — see the route's docblock.
 *
 * It saves on selection rather than behind a Save button: a two-option radio
 * has no intermediate state worth confirming, and the neighbouring
 * `DefaultAgentsSettings` needs its button only because an ordered list can be
 * mid-edit.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, Spinner } from '@/components/ui';
import {
  DEFAULT_SURFACE_MODE_ENDPOINT,
  setClientDefaultSurfaceMode,
} from '@/config/surface-mode-config';
import { isSurfaceMode, type SurfaceMode } from '@/types/ui-state';

/**
 * The GET/PUT body, redeclared rather than imported.
 *
 * The route module pulls in `better-sqlite3` through `@/lib/db`, and this is a
 * client component — the same reason `DefaultAgentsSettings` redeclares its
 * server types. `available` comes from the server on every response, so nothing
 * here hardcodes the vocabulary.
 */
interface DefaultSurfaceModePayload {
  defaultSurfaceMode: SurfaceMode;
  configured: boolean;
  constantDefault: SurfaceMode;
  available: SurfaceMode[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * A failure, as data rather than as a translated sentence.
 *
 * Deliberately not a `string` built with `t(...)` at the point of failure:
 * doing that puts `t` in the dependency list of the callbacks that can fail,
 * and `t` is a fresh function on every render, so the load effect would re-run
 * on every render — a fetch loop that only shows up as flicker in the browser
 * and as a clobbered optimistic update in a test. `detail` carries the server's
 * own message when it sent one; `kind` picks the fallback at render time.
 */
interface CardError {
  kind: 'load' | 'save';
  detail?: string;
}

/**
 * Accept a response only when it is actually this route's body.
 *
 * A 200 is not enough: a server older than this screen answers the path with a
 * Next 404 page or an unrelated shape, and `payload.available.map(...)` runs
 * unconditionally during render — so trusting `response.ok` would turn "the
 * setting is unavailable" into a thrown `TypeError` that unmounts the whole
 * More page, taking Notifications and External Apps with it.
 */
function isDefaultSurfaceModePayload(value: unknown): value is DefaultSurfaceModePayload {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return (
    isSurfaceMode(body.defaultSurfaceMode) &&
    isSurfaceMode(body.constantDefault) &&
    Array.isArray(body.available) &&
    body.available.length > 0 &&
    body.available.every(isSurfaceMode)
  );
}

export function DefaultSurfaceModeSettings() {
  const t = useTranslations('common');

  const [payload, setPayload] = useState<DefaultSurfaceModePayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<CardError | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(DEFAULT_SURFACE_MODE_ENDPOINT);
      if (!response.ok) throw new Error(String(response.status));
      const body: unknown = await response.json();
      if (!isDefaultSurfaceModePayload(body)) throw new Error('unexpected body');
      setPayload(body);
      // Mirror it for the worktree screens, on LOAD and not only on save: the
      // worktree screens also seed themselves in the background, but this makes
      // a save take effect on this device without waiting for the next reload.
      setClientDefaultSurfaceMode(body.defaultSurfaceMode);
    } catch {
      setError({ kind: 'load' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback(
    async (mode: SurfaceMode) => {
      setSaveState('saving');
      setError(null);
      // Optimistic, because the radio is the control the user is looking at and
      // a round trip's worth of "nothing happened" reads as a broken button.
      // A failed PUT restores the server's answer below.
      setPayload((prev) => (prev ? { ...prev, defaultSurfaceMode: mode } : prev));
      try {
        const response = await fetch(DEFAULT_SURFACE_MODE_ENDPOINT, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isDefaultSurfaceModePayload(body)) {
          setSaveState('error');
          setError({ kind: 'save', detail: (body as { error?: string } | null)?.error });
          void load();
          return;
        }
        setPayload(body);
        setClientDefaultSurfaceMode(body.defaultSurfaceMode);
        setSaveState('saved');
      } catch {
        setSaveState('error');
        setError({ kind: 'save' });
        void load();
      }
    },
    [load]
  );

  const errorMessage = error
    ? (error.detail ??
      t(
        error.kind === 'load'
          ? 'settings.defaultSurfaceMode.loadError'
          : 'settings.defaultSurfaceMode.saveError'
      ))
    : null;

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          {t('loadingPage')}
        </div>
      </Card>
    );
  }

  if (!payload) {
    return (
      <Card>
        <div
          className="text-sm text-danger-foreground"
          data-testid="default-surface-mode-load-error"
        >
          {errorMessage ?? t('settings.defaultSurfaceMode.loadError')}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-4" data-testid="default-surface-mode-settings">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t('settings.defaultSurfaceMode.title')}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.defaultSurfaceMode.description')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.defaultSurfaceMode.appliesToNew')}
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label={t('settings.defaultSurfaceMode.title')}
          className="space-y-2"
          data-selected={payload.defaultSurfaceMode}
        >
          {payload.available.map((mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2"
              data-testid={`default-surface-mode-option-${mode}`}
            >
              <input
                type="radio"
                name="default-surface-mode"
                value={mode}
                className="mt-0.5"
                checked={payload.defaultSurfaceMode === mode}
                disabled={saveState === 'saving'}
                onChange={() => void select(mode)}
                data-testid={`default-surface-mode-radio-${mode}`}
              />
              <span>
                <span className="block text-sm text-foreground">
                  {t(`settings.defaultSurfaceMode.mode.${mode}`)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(`settings.defaultSurfaceMode.hint.${mode}`)}
                </span>
              </span>
            </label>
          ))}
        </div>

        {errorMessage && (
          <div className="text-xs text-danger-foreground" data-testid="default-surface-mode-error">
            {errorMessage}
          </div>
        )}

        <div className="text-xs text-muted-foreground" data-testid="default-surface-mode-state">
          {saveState === 'saving'
            ? t('settings.defaultSurfaceMode.saving')
            : saveState === 'saved'
              ? t('settings.defaultSurfaceMode.saved')
              : payload.configured
                ? t('settings.defaultSurfaceMode.configured')
                : t('settings.defaultSurfaceMode.usingBuiltIn')}
        </div>
      </div>
    </Card>
  );
}
