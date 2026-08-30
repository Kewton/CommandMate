/**
 * The client-side mirror of the server-wide default (Issue #2065).
 *
 * This module exists because seven of the eight client fallbacks are either pure
 * functions or `useState` initializers, neither of which can read a React
 * context. That makes it module-scope mutable state, so what has to be pinned is
 * the discipline around it: it starts at the constant (an install with no
 * setting behaves exactly as before), it refuses a value that would blank a tab
 * strip, and the seed is single-flight so three screens mounting in a row cost
 * one request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_AGENTS_ENDPOINT,
  ensureClientDefaultSelectedAgents,
  getClientDefaultSelectedAgents,
  resetClientDefaultSelectedAgents,
  setClientDefaultSelectedAgents,
  subscribeToClientDefaultSelectedAgents,
} from '@/config/default-agents';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe('client default-agents store (Issue #2065)', () => {
  beforeEach(() => {
    resetClientDefaultSelectedAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetClientDefaultSelectedAgents();
  });

  it('starts at the compiled-in constant', () => {
    expect(getClientDefaultSelectedAgents()).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('adopts a valid server value, order intact', () => {
    expect(setClientDefaultSelectedAgents(['codex', 'claude'])).toBe(true);
    expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude']);
    expect(getClientDefaultSelectedAgents()[0]).toBe('codex');
  });

  it('reports "no change" when the value is already in force', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);
    expect(setClientDefaultSelectedAgents(['codex', 'claude'])).toBe(false);
  });

  /**
   * The failure this prevents: a payload missing the field, or an older server,
   * blanking the tab strip on every worktree that has no `selectedAgents`.
   */
  it('leaves the previous answer standing for anything invalid', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);
    for (const bad of [undefined, null, 'codex', 42, [], ['claude'], ['claude', 'nope'], ['claude', 'claude']]) {
      expect(setClientDefaultSelectedAgents(bad)).toBe(false);
      expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude']);
    }
  });

  it('notifies subscribers on a real change only', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToClientDefaultSelectedAgents(listener);

    setClientDefaultSelectedAgents(['codex', 'claude']);
    expect(listener).toHaveBeenCalledTimes(1);

    setClientDefaultSelectedAgents(['codex', 'claude']);
    setClientDefaultSelectedAgents(['nope']);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setClientDefaultSelectedAgents(['gemini', 'claude']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('seeds from the settings endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ defaultSelectedAgents: ['codex', 'claude'] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ensureClientDefaultSelectedAgents();

    expect(fetchMock).toHaveBeenCalledWith(DEFAULT_AGENTS_ENDPOINT);
    expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude']);
  });

  /**
   * /sessions, /review and the worktree controller all seed on mount. Without
   * single-flight, walking between them would issue one request per navigation.
   */
  it('is single-flight and seeds at most once per page session', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ defaultSelectedAgents: ['codex', 'claude'] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await Promise.all([
      ensureClientDefaultSelectedAgents(),
      ensureClientDefaultSelectedAgents(),
    ]);
    await ensureClientDefaultSelectedAgents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the constant when the server is unreachable, and does not throw', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(ensureClientDefaultSelectedAgents()).resolves.toEqual(DEFAULT_SELECTED_AGENTS);
    expect(getClientDefaultSelectedAgents()).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('retries on a later mount when the request failed', async () => {
    const failing = vi.fn(async () => jsonResponse({}, false));
    globalThis.fetch = failing as unknown as typeof fetch;
    await ensureClientDefaultSelectedAgents();
    expect(failing).toHaveBeenCalledTimes(1);

    const succeeding = vi.fn(async () =>
      jsonResponse({ defaultSelectedAgents: ['codex', 'claude'] })
    );
    globalThis.fetch = succeeding as unknown as typeof fetch;
    await ensureClientDefaultSelectedAgents();

    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude']);
  });
});
