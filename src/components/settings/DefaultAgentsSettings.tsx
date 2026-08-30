/**
 * "Default agents for new branches" setting (More screen, Issue #2065).
 *
 * The list is ORDERED and the order is the point: `agents[0]` becomes the
 * primary — the tab that opens first on a newly discovered worktree, and the
 * instance a bare `commandmate send` targets — so this is a reorderable list
 * with explicit up/down controls rather than a set of checkboxes.
 *
 * Two things it deliberately does not do:
 *
 * - It does not touch existing branches. A worktree's `agent_instances` rows are
 *   the authority once they exist, and saving a preference must not rewrite
 *   them; the copy under `appliesToNew` says so, because a settings screen that
 *   silently reorders every open terminal would be worse than one that explains
 *   itself. Applying a default to existing branches is Issue #2067's action.
 * - It does not gate the choice on installation. The installed markers are an
 *   annotation: a user can legitimately preselect a CLI they are about to
 *   install, and the roster is not a launcher.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Check, Plus, X } from 'lucide-react';
import { Button, Card, Spinner } from '@/components/ui';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';
import {
  DEFAULT_AGENTS_ENDPOINT,
  setClientDefaultSelectedAgents,
} from '@/config/default-agents';

/**
 * The GET/PUT body, redeclared rather than imported.
 *
 * The route module pulls in `better-sqlite3` through `@/lib/db`, and this is a
 * client component — the same reason `NotificationsSettings` redeclares its
 * server types. The server sends `available` / `minAgents` / `maxAgents` with
 * every response, so nothing here hardcodes the vocabulary or the bounds.
 */
interface DefaultAgentsPayload {
  defaultSelectedAgents: CLIToolType[];
  configured: boolean;
  constantDefault: CLIToolType[];
  available: CLIToolType[];
  minAgents: number;
  maxAgents: number;
  installed?: CLIToolType[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Accept a response only when it is actually this route's body.
 *
 * A 200 is not enough. A server older than this screen answers the path with a
 * Next 404 page or an unrelated shape, and every field below is read
 * unconditionally during render — so trusting `response.ok` turns "the setting
 * is unavailable" into a thrown `TypeError` that unmounts the whole More page,
 * taking Notifications and External Apps with it. Guarding here keeps the
 * failure inside this card's error state.
 */
function isDefaultAgentsPayload(value: unknown): value is DefaultAgentsPayload {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return (
    Array.isArray(body.defaultSelectedAgents) &&
    body.defaultSelectedAgents.length > 0 &&
    Array.isArray(body.available) &&
    body.available.length > 0 &&
    typeof body.minAgents === 'number' &&
    typeof body.maxAgents === 'number'
  );
}

export function DefaultAgentsSettings() {
  const t = useTranslations('common');

  const [payload, setPayload] = useState<DefaultAgentsPayload | null>(null);
  const [selected, setSelected] = useState<CLIToolType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // `?include=installed` is what makes this screen the only caller that pays
      // for the `which` fan-out (cached; see @/config/installed-agents-cache).
      const response = await fetch(`${DEFAULT_AGENTS_ENDPOINT}?include=installed`);
      if (!response.ok) throw new Error(String(response.status));
      const body: unknown = await response.json();
      if (!isDefaultAgentsPayload(body)) throw new Error('unexpected body');
      setPayload(body);
      setSelected(body.defaultSelectedAgents);
      setClientDefaultSelectedAgents(body.defaultSelectedAgents);
    } catch {
      setErrorMessage(t('settings.defaultAgents.loadError'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any edit clears a lingering "Saved" so the badge always describes the list
  // currently on screen rather than the one that was saved a minute ago.
  const edit = useCallback((next: CLIToolType[]) => {
    setSelected(next);
    setSaveState('idle');
    setErrorMessage(null);
  }, []);

  const move = useCallback(
    (index: number, delta: number) => {
      const target = index + delta;
      if (target < 0 || target >= selected.length) return;
      const next = [...selected];
      [next[index], next[target]] = [next[target], next[index]];
      edit(next);
    },
    [selected, edit]
  );

  /**
   * Save (`agents`) or reset (`null`) — one path, because they differ only in
   * the body: same validation of the response, same store update, same error
   * handling. Two copies of this is how one of them ends up not updating the
   * client-side mirror.
   */
  const submit = useCallback(
    async (agents: CLIToolType[] | null) => {
      setSaveState('saving');
      setErrorMessage(null);
      try {
        const response = await fetch(DEFAULT_AGENTS_ENDPOINT, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agents }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isDefaultAgentsPayload(body)) {
          setSaveState('error');
          setErrorMessage(
            (body as { error?: string } | null)?.error ?? t('settings.defaultAgents.saveError')
          );
          return;
        }
        // Keep `installed` from the initial load: the PUT response omits it (it
        // is the expensive half) and dropping it would blank every marker.
        setPayload((prev) => ({ ...body, installed: prev?.installed }));
        setSelected(body.defaultSelectedAgents);
        setClientDefaultSelectedAgents(body.defaultSelectedAgents);
        setSaveState('saved');
      } catch {
        setSaveState('error');
        setErrorMessage(t('settings.defaultAgents.saveError'));
      }
    },
    [t]
  );

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
        <div className="text-sm text-danger-foreground" data-testid="default-agents-load-error">
          {errorMessage ?? t('settings.defaultAgents.loadError')}
        </div>
      </Card>
    );
  }

  const installed = payload.installed ?? [];
  const remaining = payload.available.filter((id) => !selected.includes(id));
  const tooFew = selected.length < payload.minAgents;
  const tooMany = selected.length > payload.maxAgents;
  const canSave = !tooFew && !tooMany && saveState !== 'saving';

  const installedMarker = (id: CLIToolType) =>
    installed.includes(id) ? (
      <span
        className="inline-flex items-center gap-1 rounded bg-success-subtle px-1.5 py-0.5 text-xs text-success-foreground"
        data-testid={`default-agents-installed-${id}`}
      >
        <Check className="h-3 w-3" aria-hidden="true" />
        {t('settings.defaultAgents.installed')}
      </span>
    ) : (
      <span className="text-xs text-muted-foreground">
        {t('settings.defaultAgents.notInstalled')}
      </span>
    );

  return (
    <Card>
      <div className="space-y-4" data-testid="default-agents-settings">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t('settings.defaultAgents.title')}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.defaultAgents.description')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.defaultAgents.appliesToNew')}
          </p>
        </div>

        <ul className="space-y-2" data-testid="default-agents-selected">
          {selected.map((id, index) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
              data-testid={`default-agents-row-${id}`}
            >
              <span className="w-6 text-xs text-muted-foreground">{index + 1}</span>
              <span className="text-sm text-foreground">{getCliToolDisplayName(id)}</span>
              {index === 0 && (
                <span
                  className="rounded bg-info-subtle px-1.5 py-0.5 text-xs text-info-foreground"
                  data-testid="default-agents-primary-badge"
                >
                  {t('settings.defaultAgents.primary')}
                </span>
              )}
              <span className="ml-auto">{installedMarker(id)}</span>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={t('settings.defaultAgents.moveUp')}
                data-testid={`default-agents-up-${id}`}
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
                onClick={() => move(index, 1)}
                disabled={index === selected.length - 1}
                aria-label={t('settings.defaultAgents.moveDown')}
                data-testid={`default-agents-down-${id}`}
              >
                <ArrowDown className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
                onClick={() => edit(selected.filter((v) => v !== id))}
                disabled={selected.length <= payload.minAgents}
                aria-label={t('settings.defaultAgents.remove')}
                data-testid={`default-agents-remove-${id}`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>

        {remaining.length > 0 && (
          <div>
            <div className="mb-2 text-xs text-muted-foreground">
              {t('settings.defaultAgents.addLabel')}
            </div>
            <ul className="space-y-2" data-testid="default-agents-available">
              {remaining.map((id) => (
                <li
                  key={id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="text-sm text-foreground">{getCliToolDisplayName(id)}</span>
                  <span className="ml-auto">{installedMarker(id)}</span>
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
                    onClick={() => edit([...selected, id])}
                    disabled={selected.length >= payload.maxAgents}
                    aria-label={t('settings.defaultAgents.add')}
                    data-testid={`default-agents-add-${id}`}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(tooFew || tooMany) && (
          <div className="text-xs text-danger-foreground" data-testid="default-agents-range-error">
            {t('settings.defaultAgents.range', {
              min: payload.minAgents,
              max: payload.maxAgents,
            })}
          </div>
        )}

        {errorMessage && (
          <div className="text-xs text-danger-foreground" data-testid="default-agents-error">
            {errorMessage}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void submit(selected)}
            disabled={!canSave}
            data-testid="default-agents-save"
          >
            {saveState === 'saving'
              ? t('settings.defaultAgents.saving')
              : t('settings.defaultAgents.save')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void submit(null)}
            disabled={!payload.configured || saveState === 'saving'}
            data-testid="default-agents-reset"
          >
            {t('settings.defaultAgents.reset')}
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="default-agents-state">
            {saveState === 'saved'
              ? t('settings.defaultAgents.saved')
              : payload.configured
                ? t('settings.defaultAgents.configured')
                : t('settings.defaultAgents.usingBuiltIn')}
          </span>
        </div>
      </div>
    </Card>
  );
}
