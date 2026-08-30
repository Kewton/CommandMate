/**
 * Client-side mirror of the server's default agent list (Issue #2065).
 *
 * ## Why a module store rather than a prop or a context
 *
 * Before #2065 the client's fallback for "this worktree has no `selectedAgents`"
 * was the imported constant `DEFAULT_SELECTED_AGENTS`, read from module scope at
 * seven sites — two of them inside `deriveSidebarCliStatus()`, a PURE function
 * that receives one `Worktree` and nothing else, and four inside `useState`
 * initializers that run before any fetch has resolved. Neither shape can consume
 * a React context or a prop without rewriting its callers, so the smallest
 * honest change is to keep the read at module scope and make the module scope
 * itself configurable.
 *
 * The store starts at the compiled-in constant, so a page that never seeds it
 * behaves exactly as it did before this Issue.
 *
 * ## What it is not
 *
 * It is NOT the authority. The server resolves `selectedAgents` for every
 * worktree it sends (`parseSelectedAgents` + `app_settings`), so these fallbacks
 * only fire for a payload that omits the field — an older response, a test
 * fixture, or the moment before the first fetch lands. Seeding this store makes
 * that moment agree with the server instead of disagreeing with it.
 *
 * ## Freshness
 *
 * Reads are synchronous and non-reactive: a component that reads the store does
 * not re-render when it changes. Every screen that reads it polls (`/sessions`,
 * `/review`, the worktree detail controller), so a change is visible on the next
 * poll tick, and `subscribe()` is available for a surface that needs it sooner.
 */

import {
  DEFAULT_SELECTED_AGENTS,
  validateAgentsPair,
} from '@/lib/selected-agents-validator';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** Where the client asks for the server-wide default. */
export const DEFAULT_AGENTS_ENDPOINT = '/api/settings/default-agents';

let current: CLIToolType[] = DEFAULT_SELECTED_AGENTS;
const listeners = new Set<() => void>();

/**
 * The agent list to fall back to when a worktree payload carries no
 * `selectedAgents`. Ordered; `[0]` is the primary.
 */
export function getClientDefaultSelectedAgents(): CLIToolType[] {
  return current;
}

/**
 * Adopt a default sent by the server.
 *
 * Validated here rather than trusted, for the same reason the DB read is:
 * whatever ships this value (a settings GET, a `/api/worktrees` payload, a save
 * response) is one JSON field away from being wrong, and a malformed value must
 * leave the previous answer standing rather than blank the tab strip.
 *
 * @param value - Candidate list from a server response
 * @returns true when the store changed
 */
export function setClientDefaultSelectedAgents(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const result = validateAgentsPair(value);
  if (!result.valid) return false;
  const next = result.value!;
  if (next.length === current.length && next.every((id, i) => id === current[i])) {
    return false;
  }
  current = next;
  for (const listener of listeners) listener();
  return true;
}

/** Return the store to the compiled-in constant. Used by tests and by a reset. */
export function resetClientDefaultSelectedAgents(): void {
  const changed = current !== DEFAULT_SELECTED_AGENTS;
  current = DEFAULT_SELECTED_AGENTS;
  if (changed) {
    for (const listener of listeners) listener();
  }
  inFlight = null;
  seeded = false;
}

/** Subscribe to store changes. Returns an unsubscribe function. */
export function subscribeToClientDefaultSelectedAgents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let inFlight: Promise<CLIToolType[]> | null = null;
let seeded = false;

/**
 * Seed the store from the server, at most once per page session.
 *
 * Single-flight and idempotent: `/sessions`, `/review` and the worktree detail
 * controller all call it on mount and a route change between them must not
 * produce a second request. Failures are swallowed — the constant is a correct
 * answer, and a settings fetch is never a reason to break a screen.
 *
 * Deliberately hits the settings route and not `/api/worktrees`: this is called
 * from mount effects on screens that may not fetch the worktree list at all, and
 * the settings route is a single point query with no tmux work behind it.
 *
 * @returns The default in force after the attempt
 */
export async function ensureClientDefaultSelectedAgents(): Promise<CLIToolType[]> {
  if (seeded) return current;
  if (inFlight) return inFlight;
  if (typeof fetch !== 'function') return current;

  inFlight = (async () => {
    try {
      const response = await fetch(DEFAULT_AGENTS_ENDPOINT);
      if (response.ok) {
        const body = await response.json();
        setClientDefaultSelectedAgents(body?.defaultSelectedAgents);
        seeded = true;
      }
    } catch {
      // Offline / server restarting: keep whatever the store already holds.
    } finally {
      inFlight = null;
    }
    return current;
  })();

  return inFlight;
}
