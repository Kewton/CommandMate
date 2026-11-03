/**
 * The role settings of a worktree, shared by everything on screen that shows them
 * (Issue #4117): the split header, the roster's role section, the add dialog.
 *
 * One answer per worktree, so a change made in one place shows in the others at once,
 * and one request at a time however many panes ask. The same answer is the roster
 * snapshot `useAgentInstancesRoster` writes against: a roster and the
 * `rosterRevision` it was read with, always taken together. A newer revision on an
 * older roster would pass the server's check and overwrite what it was meant to protect.
 *
 * Answers can cross on the way back, so `version` moves whenever one is taken: a read
 * or a write whose answer finds it moved since it left is not believed, and the settings
 * are read again. Concurrent writes can be handled by the server in either order, so
 * which of their answers is newest cannot be told from which arrived last. An overlap
 * therefore always ends in a read made after the last answer.
 *
 * @module hooks/useInstanceRoleSettings
 */

'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { readWorktreeRoster, roleApi, type RoleApiResult } from '@/lib/api-client-agent-roles';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { InstanceRoleEntry, InstanceRoleSettingsResponse } from '@/types/agent-roles';

export interface RosterSnapshot {
  roster: AgentInstance[];
  revision: string;
}

interface WorktreeEntry {
  settings: InstanceRoleSettingsResponse | null;
  snapshot: RosterSnapshot | null;
  listeners: Set<() => void>;
  inFlight: Promise<InstanceRoleSettingsResponse | null> | null;
  /** Another read was asked for while one was on its way, so its answer may be old. */
  rerun: boolean;
  /** Moves whenever an answer is taken or the snapshot changes, so an older answer is not believed. */
  version: number;
}

const entries = new Map<string, WorktreeEntry>();

function entryFor(worktreeId: string): WorktreeEntry {
  let entry = entries.get(worktreeId);
  if (!entry) {
    entry = { settings: null, snapshot: null, listeners: new Set(), inFlight: null, rerun: false, version: 0 };
    entries.set(worktreeId, entry);
  }
  return entry;
}

function notify(entry: WorktreeEntry): void {
  entry.listeners.forEach((listener) => listener());
}

/** The roster an answer describes. Entries come in roster order. */
export function rosterFromRoleEntries(instances: readonly InstanceRoleEntry[]): AgentInstance[] {
  return instances.map((entry, order) => ({
    id: entry.instanceId,
    cliTool: entry.cliToolId,
    alias: entry.alias,
    order,
  }));
}

function isSettings(value: unknown): value is InstanceRoleSettingsResponse {
  const candidate = value as Partial<InstanceRoleSettingsResponse> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.rosterRevision === 'string' &&
    Array.isArray(candidate.instances) &&
    Array.isArray(candidate.toolDefaults)
  );
}

function adoptSettings(entry: WorktreeEntry, settings: InstanceRoleSettingsResponse): void {
  entry.version += 1;
  entry.settings = settings;
  entry.snapshot = { roster: rosterFromRoleEntries(settings.instances), revision: settings.rosterRevision };
  notify(entry);
}

/**
 * Send a write to a role route that answers the worktree's settings. The answer is
 * taken only if nothing else moved while it was on its way; otherwise it may be older
 * than what is shown, and the settings are read again.
 */
export async function writeInstanceRoleSettings<T extends InstanceRoleSettingsResponse>(
  worktreeId: string,
  send: () => Promise<RoleApiResult<T>>,
): Promise<RoleApiResult<T>> {
  const entry = entryFor(worktreeId);
  const issued = entry.version;
  const result = await send();
  if (result.ok) {
    if (entry.version === issued) adoptSettings(entry, result.data);
    else void refreshInstanceRoleSettings(worktreeId);
  }
  return result;
}

/** The roster a client may write against, or null when none is known. */
export function getRosterSnapshot(worktreeId: string): RosterSnapshot | null {
  return entries.get(worktreeId)?.snapshot ?? null;
}

/** Forget the snapshot: the server said it is stale, or a write did not say what replaced it. */
export function clearRosterSnapshot(worktreeId: string): void {
  const entry = entries.get(worktreeId);
  if (!entry) return;
  entry.version += 1;
  entry.snapshot = null;
}

/**
 * The snapshot to write against, read from the server when none is held. Null when it
 * cannot be had, and then nothing may be saved: a full replace with no revision is what
 * erases another client's rows.
 */
export async function ensureRosterSnapshot(worktreeId: string): Promise<RosterSnapshot | null> {
  const entry = entryFor(worktreeId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (entry.snapshot) return entry.snapshot;
    const version = entry.version;
    const answer = await readWorktreeRoster(worktreeId);
    if (!answer) return null;
    // Something was written or adopted meanwhile: this answer may predate it.
    if (entry.version === version) {
      entry.version += 1;
      entry.snapshot = answer;
      return answer;
    }
  }
  return entry.snapshot;
}

/**
 * Record what a roster PATCH saved, and read the role entries again for whoever is
 * showing them, since that answer has none. With nobody showing them nothing is read.
 */
export function recordRosterSaved(worktreeId: string, roster: AgentInstance[], revision: string | undefined): void {
  const entry = entryFor(worktreeId);
  entry.version += 1;
  entry.snapshot = revision ? { roster, revision } : null;
  if (entry.listeners.size > 0) void refreshInstanceRoleSettings(worktreeId);
}

/**
 * Read the settings again. Calls made while a read is on its way share it, and one
 * more read follows, because what prompted them may be newer than that read.
 *
 * @returns The latest answer, or null when none could be had
 */
export function refreshInstanceRoleSettings(worktreeId: string): Promise<InstanceRoleSettingsResponse | null> {
  const entry = entryFor(worktreeId);
  if (entry.inFlight) {
    entry.rerun = true;
    return entry.inFlight;
  }
  const read = async (): Promise<InstanceRoleSettingsResponse | null> => {
    try {
      let answer: InstanceRoleSettingsResponse | null = null;
      do {
        entry.rerun = false;
        const version = entry.version;
        const result = await roleApi.instanceSettings(worktreeId);
        if (!result.ok || !isSettings(result.data)) {
          answer = null;
        } else if (entry.version === version) {
          adoptSettings(entry, result.data);
          answer = result.data;
        } else {
          // Written meanwhile: this answer may predate it.
          entry.rerun = true;
        }
      } while (entry.rerun);
      return answer;
    } finally {
      entry.inFlight = null;
    }
  };
  entry.inFlight = read();
  return entry.inFlight;
}

/** Read again for every worktree on screen: a role's text or a default has changed. */
export function refreshAllShownInstanceRoleSettings(): void {
  entries.forEach((entry, worktreeId) => {
    if (entry.listeners.size > 0) void refreshInstanceRoleSettings(worktreeId);
  });
}

const roleCatalogListeners = new Set<() => void>();

/**
 * A role was created, edited or deleted, or a system default changed. Every session,
 * repository default and role list on screen depends on those.
 */
export function notifyRoleCatalogChanged(): void {
  refreshAllShownInstanceRoleSettings();
  roleCatalogListeners.forEach((listener) => listener());
}

/** Run `onChange` after {@link notifyRoleCatalogChanged}, and on coming back from another tab. */
export function useRoleCatalogChanged(onChange: () => void): void {
  useEffect(() => {
    roleCatalogListeners.add(onChange);
    window.addEventListener('focus', onChange);
    return () => {
      roleCatalogListeners.delete(onChange);
      window.removeEventListener('focus', onChange);
    };
  }, [onChange]);
}

/** The settings of a worktree, read while mounted and whenever `refreshKey` moves. */
export function useInstanceRoleSettings(
  worktreeId: string,
  refreshKey?: string,
): { settings: InstanceRoleSettingsResponse | null; refresh: () => Promise<InstanceRoleSettingsResponse | null> } {
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryFor(worktreeId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [worktreeId],
  );
  const settings = useSyncExternalStore(
    subscribe,
    () => entries.get(worktreeId)?.settings ?? null,
    () => null,
  );

  useEffect(() => {
    void refreshInstanceRoleSettings(worktreeId);
  }, [worktreeId, refreshKey]);

  // Back from another tab or window: the roster and the launches may have moved.
  useEffect(() => {
    const onFocus = (): void => {
      void refreshInstanceRoleSettings(worktreeId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [worktreeId]);

  const refresh = useCallback(() => refreshInstanceRoleSettings(worktreeId), [worktreeId]);
  return { settings, refresh };
}
