/**
 * Client state for the agent-CLI update surfaces (Issue #2069).
 *
 * Two reads and one write, shared by the More screen's card and the copy of it
 * inside the agent pane:
 *
 *  - `GET /api/agents/versions` — installed versions, plus codex's own
 *    "there is a newer one" (from `~/.codex/version.json`; no network).
 *  - `POST /api/agents/update` — runs the tool's own updater in a process that
 *    is not an agent pane, and streams NDJSON back.
 *  - a re-read with `?refresh=1` the moment the update finishes, because "the
 *    updater exited 0" and "the binary on PATH changed" are different claims
 *    and this Issue's acceptance criterion is the second one.
 *
 * ## Why the response is read as a stream rather than awaited
 *
 * A global install takes tens of seconds and npm narrates the whole way. The
 * route answers in NDJSON specifically so this hook can show that narration as
 * it arrives; `await response.json()` would show nothing until it was over,
 * which is the spinner this Issue set out to remove.
 *
 * A partial line at the end of a chunk is held in `buffer` and joined with the
 * next one — a JSON object can and does straddle a network chunk boundary, and
 * parsing per-chunk instead of per-line would drop whichever event was unlucky.
 *
 * @module hooks/useAgentUpdates
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** One tool's row, mirroring `AgentVersionRow` on the server. */
export interface AgentVersionView {
  tool: string;
  installed: string | null;
  latestVersion: string | null;
  dismissedVersion: string | null;
  updateAvailable: boolean;
  dismissedInCodex: boolean;
  updatable: boolean;
  source: 'version.json' | null;
}

/** One NDJSON line from `POST /api/agents/update`. */
type AgentUpdateEvent =
  | { type: 'plan'; tool: string; strategy: string; command: string; installed: string | null }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | {
      type: 'done';
      ok: boolean;
      exitCode: number | null;
      previousVersion: string | null;
      installed: string | null;
      error?: string;
    };

/** What the card renders while and after an update runs. */
export interface AgentUpdateRun {
  tool: string;
  /** Display form of the argv, once the server has told us. */
  command: string | null;
  /** Raw updater output, appended in arrival order. */
  output: string;
  /** null while running. */
  ok: boolean | null;
  previousVersion: string | null;
  installed: string | null;
  error: string | null;
}

/** Accept a versions payload only when it is actually this route's body. */
function isVersionsPayload(value: unknown): value is { tools: AgentVersionView[]; updatable: string[] } {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return Array.isArray(body.tools) && Array.isArray(body.updatable);
}

/** Parse one NDJSON line, ignoring anything that is not one of our events. */
function parseEvent(line: string): AgentUpdateEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const type = (parsed as { type?: unknown }).type;
    if (type !== 'plan' && type !== 'output' && type !== 'done') return null;
    return parsed as AgentUpdateEvent;
  } catch {
    return null;
  }
}

/**
 * Read the agent CLI versions, and run one tool's updater.
 *
 * @param enabled - False keeps the hook inert (no fetch at all). The agent
 *   pane passes the pane's own visibility here so a roster editor that is not
 *   on screen costs nothing, on the same reasoning `useAgentSourceByInstance`
 *   uses to return before touching the network.
 */
export function useAgentUpdates(enabled: boolean = true) {
  const [versions, setVersions] = useState<AgentVersionView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(enabled);
  const [run, setRun] = useState<AgentUpdateRun | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  // A component that unmounts mid-install must not setState afterwards; the
  // install itself keeps running server-side, which is the correct behaviour.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (force: boolean = false): Promise<void> => {
      if (!enabled) return;
      setIsLoading(true);
      try {
        const response = await fetch(`/api/agents/versions${force ? '?refresh=1' : ''}`);
        if (!response.ok) throw new Error(String(response.status));
        const body: unknown = await response.json();
        if (!isVersionsPayload(body)) throw new Error('unexpected body');
        if (!mounted.current) return;
        setVersions(body.tools);
        setLoadError(false);
      } catch {
        if (!mounted.current) return;
        setLoadError(true);
      } finally {
        if (mounted.current) setIsLoading(false);
      }
    },
    [enabled]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const update = useCallback(
    async (tool: string): Promise<void> => {
      if (isUpdating) return;
      setIsUpdating(true);
      setRun({
        tool,
        command: null,
        output: '',
        ok: null,
        previousVersion: null,
        installed: null,
        error: null,
      });

      const fail = (message: string): void => {
        if (!mounted.current) return;
        setRun((prev) => (prev ? { ...prev, ok: false, error: message } : prev));
      };

      try {
        const response = await fetch('/api/agents/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool }),
        });

        if (!response.ok || !response.body) {
          const body: unknown = await response.json().catch(() => null);
          fail(
            (body as { error?: string } | null)?.error ?? `Request failed (${response.status})`
          );
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const apply = (event: AgentUpdateEvent): void => {
          if (!mounted.current) return;
          setRun((prev) => {
            if (!prev) return prev;
            if (event.type === 'plan') return { ...prev, command: event.command };
            if (event.type === 'output') return { ...prev, output: prev.output + event.text };
            return {
              ...prev,
              ok: event.ok,
              previousVersion: event.previousVersion,
              installed: event.installed,
              error: event.error ?? null,
            };
          });
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // The last element is whatever came after the final newline — a
          // partial event if the chunk cut one in half. Keep it for next time.
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const event = parseEvent(line);
            if (event) apply(event);
          }
        }

        const trailing = parseEvent(buffer);
        if (trailing) apply(trailing);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      } finally {
        if (mounted.current) setIsUpdating(false);
        // Bypass the server's 30s TTL: the whole question the user just asked
        // is whether the version changed.
        await load(true);
      }
    },
    [isUpdating, load]
  );

  return { versions, isLoading, loadError, run, isUpdating, reload: load, update };
}
