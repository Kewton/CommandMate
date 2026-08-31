/**
 * The two "make this the default" actions of the agent pane (Issue #2067).
 *
 * ## Why a hook and not two `fetch` calls in the pane
 *
 * They are not two calls. Between them they own an eligible-branch count that
 * has to be read before the confirmation and re-read after the write, a
 * `saved` / `applied` badge that must not survive the next edit, and three
 * failure modes the pane renders in one place. That is a state machine, and the
 * pane is already a 600-line roster editor; keeping it here also means the
 * behaviour can be tested without mounting Radix menus.
 *
 * ## The blast radius belongs to the server
 *
 * Both requests carry the `worktreeId` the pane is rendered for, and the server
 * derives the repository from that row. The hook never names a repository: a
 * client that could would be a client that could aim the bulk write at any
 * repository on the machine.
 *
 * ## What it deliberately does not decide
 *
 * - **Confirmation.** `applyToUnchanged()` writes as soon as it is called. The
 *   dialog belongs to the component (`useConfirm`), because the copy that
 *   explains what is about to change is copy, and a hook that owned it would
 *   need the translator, the provider and a jsdom modal to be exercised at all.
 * - **Wording.** Errors surface as a {@link AgentDefaultsErrorKind}, never as a
 *   sentence. The pane translates.
 *
 * ## The settings write goes through #2065's endpoint, unchanged
 *
 * `saveAsDefault()` PUTs to `DEFAULT_AGENTS_ENDPOINT` — the same constant the
 * More screen's `DefaultAgentsSettings` reads and writes, so both surfaces are
 * one `app_settings.default_selected_agents` row and the More screen shows what
 * this pane just saved on its next load. No second key, and no second route.
 * The client-side mirror is updated from the RESPONSE rather than from what was
 * sent, so the store can never drift from what the server actually stored.
 */

'use client';

import { useCallback, useState } from 'react';
import {
  DEFAULT_AGENTS_ENDPOINT,
  setClientDefaultSelectedAgents,
} from '@/config/default-agents';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** Where the count and the bulk apply live (Issue #2067). */
export const APPLY_DEFAULT_AGENTS_ENDPOINT = '/api/worktrees/apply-default-agents';

/** Which of the three requests failed. The pane turns this into a sentence. */
export type AgentDefaultsErrorKind = 'count' | 'save' | 'apply';

export interface UseAgentDefaultsResult {
  /**
   * Branches IN THIS WORKTREE'S REPOSITORY a bulk apply would change, or null
   * when it has not been read yet (or the read failed). Null is NOT zero: "we do
   * not know" and "there are none" lead to different buttons, and only the
   * second one is safe to act on.
   */
  eligible: number | null;
  /** The repository the action is scoped to, once the server has named it. */
  repositoryName: string | null;
  /**
   * True when that repository declares its agents in `.commandmate/agents.yaml`
   * (Issue #2066). The bulk apply is refused there — the column outranks the
   * file permanently — and the panel explains that instead of showing a zero it
   * cannot account for.
   */
  repoDeclaresAgents: boolean;
  /** A request is in flight; the pane disables both buttons. */
  busy: boolean;
  /** The last `saveAsDefault()` succeeded and nothing has happened since. */
  savedDefault: boolean;
  /** Rows the last successful apply wrote, or null when none has run. */
  appliedCount: number | null;
  /** Which request failed, or null. */
  error: AgentDefaultsErrorKind | null;
  /** Read the eligible count. Returns it, so a caller can branch on it. */
  refreshEligible: () => Promise<number | null>;
  /** Store `agents` as the server-wide default for new branches. */
  saveAsDefault: () => Promise<boolean>;
  /** Write `agents` onto every unchanged branch. Returns the rows written. */
  applyToUnchanged: () => Promise<number | null>;
}

/**
 * @param worktreeId - The worktree the pane is rendered for. The server turns it
 *   into the repository the apply is scoped to.
 * @param agents - The tool order to save / apply, already deduplicated and
 *   within the validator's bounds. The hook does not validate it: the server
 *   does, on both routes, and a client-side copy of the rule is a second rule.
 */
export function useAgentDefaults(
  worktreeId: string,
  agents: CLIToolType[]
): UseAgentDefaultsResult {
  const [eligible, setEligible] = useState<number | null>(null);
  const [repositoryName, setRepositoryName] = useState<string | null>(null);
  const [repoDeclaresAgents, setRepoDeclaresAgents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const [error, setError] = useState<AgentDefaultsErrorKind | null>(null);

  /**
   * Adopt the scope fields both verbs return. Kept in one place because the
   * apply response carries them too: a repository whose `agents.yaml` landed
   * between the count and the apply has to be able to say so on the way back.
   */
  const adoptScope = useCallback((body: unknown): void => {
    const scope = body as { repositoryName?: unknown; repoDeclaresAgents?: unknown } | null;
    setRepositoryName(typeof scope?.repositoryName === 'string' ? scope.repositoryName : null);
    setRepoDeclaresAgents(scope?.repoDeclaresAgents === true);
  }, []);

  const refreshEligible = useCallback(async (): Promise<number | null> => {
    setBusy(true);
    try {
      const response = await fetch(
        `${APPLY_DEFAULT_AGENTS_ENDPOINT}?worktreeId=${encodeURIComponent(worktreeId)}`
      );
      if (!response.ok) throw new Error(String(response.status));
      const body: unknown = await response.json();
      const count = (body as { eligible?: unknown } | null)?.eligible;
      // A number is the whole contract. A server older than this screen answers
      // this path with a Next 404 page, and `undefined` rendered as a count is
      // worse than an error: it invites a confirmation for an unknown number of
      // branches.
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        throw new Error('unexpected body');
      }
      setEligible(count);
      adoptScope(body);
      setError(null);
      return count;
    } catch {
      setEligible(null);
      setError('count');
      return null;
    } finally {
      setBusy(false);
    }
  }, [worktreeId, adoptScope]);

  const saveAsDefault = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setSavedDefault(false);
    setAppliedCount(null);
    try {
      const response = await fetch(DEFAULT_AGENTS_ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents }),
      });
      const body: unknown = await response.json().catch(() => null);
      const stored = (body as { defaultSelectedAgents?: unknown } | null)?.defaultSelectedAgents;
      if (!response.ok || !Array.isArray(stored)) {
        setError('save');
        return false;
      }
      setClientDefaultSelectedAgents(stored);
      setSavedDefault(true);
      return true;
    } catch {
      setError('save');
      return false;
    } finally {
      setBusy(false);
    }
  }, [agents]);

  const applyToUnchanged = useCallback(async (): Promise<number | null> => {
    setBusy(true);
    setError(null);
    setSavedDefault(false);
    try {
      const response = await fetch(APPLY_DEFAULT_AGENTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, agents }),
      });
      const body: unknown = await response.json().catch(() => null);
      const updated = (body as { updated?: unknown } | null)?.updated;
      if (!response.ok || typeof updated !== 'number' || !Number.isFinite(updated)) {
        setError('apply');
        return null;
      }
      setAppliedCount(updated);
      adoptScope(body);
      // The server reports what a SECOND apply would still find, so the panel
      // stops offering to change branches it has just finished changing. Only
      // adopted when the server sent it; a body without the field leaves the
      // previous count standing rather than blanking it.
      const remaining = (body as { eligible?: unknown }).eligible;
      if (typeof remaining === 'number' && Number.isFinite(remaining)) {
        setEligible(remaining);
      }
      return updated;
    } catch {
      setError('apply');
      return null;
    } finally {
      setBusy(false);
    }
  }, [worktreeId, agents, adoptScope]);

  return {
    eligible,
    repositoryName,
    repoDeclaresAgents,
    busy,
    savedDefault,
    appliedCount,
    error,
    refreshEligible,
    saveAsDefault,
    applyToUnchanged,
  };
}
