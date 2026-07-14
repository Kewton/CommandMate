/**
 * useTerminalPanePolling hook (Issue #728)
 *
 * Per-(worktreeId, cliToolId) terminal output polling for the PC split layout.
 * Each `TerminalSplitPane` owns one of these so split 0 (Claude) and split 1
 * (Codex) fetch their own /current-output independently.
 *
 * What it owns:
 *  - terminal output / realtimeSnippet / isRunning / isThinking
 *  - prompt state (visible / data / answering / messageId)
 *  - isSelectionListActive (Issue #473 navigation buttons)
 *  - attaching flag (R3-006): true until first successful fetch resolves
 *  - autoScroll (per-pane)
 *
 * What it intentionally does NOT own:
 *  - Auto-Yes state — globally keyed by activeCliTab (mobile/header level)
 *  - History messages — globally keyed by activeCliTab
 *  - lastServerResponseTimestamp / serverPollerActive (used by useAutoYes only)
 *
 * Polling lifecycle mirrors `useFilePolling`:
 *  - setInterval cadence switches between ACTIVE / IDLE based on isRunning
 *  - pauses when document.visibilityState === 'hidden'
 *  - re-fetches once on visibility becoming visible
 *
 * Stale-response guard: a request id is bumped per fetch; older promises
 * that resolve out of order are dropped (mirrors the WorktreeDetailRefactored
 * activeCliTabRef pattern but per-pane).
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { PromptData } from '@/types/models';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import type { RealtimeEvent, TerminalSnapshotEvent } from '@/lib/realtime/types';

export const ACTIVE_POLLING_INTERVAL_MS = 2000;
export const IDLE_POLLING_INTERVAL_MS = 5000;

/**
 * Issue #1120: while a live WebSocket connection is established the terminal
 * output streams via `terminal_snapshot` push, so the HTTP poll is throttled to
 * a slow fallback that only recovers if push delivery stalls.
 */
export const WS_CONNECTED_POLLING_INTERVAL_MS = 15000;
/** Push is unhealthy when no terminal snapshot heartbeat arrives in this window. */
export const WS_PUSH_STALE_AFTER_MS = 5000;
/** Require two consecutive low-confidence frames before exposing escape controls. */
export const UNCLASSIFIED_CONFIRMATION_COUNT = 2;
export const UNCLASSIFIED_CONFIRMATION_DELAY_MS = 500;

export interface PaneTerminalState {
  output: string;
  realtimeSnippet: string;
  isRunning: boolean;
  isThinking: boolean;
  isSelectionListActive: boolean;
  /**
   * Issue #1017: Codex pager / edit-previous mode (a subset of
   * isSelectionListActive). Drives the pager-specific keys in NavigationButtons.
   */
  isPagerActive: boolean;
  /**
   * Issue #1017: the session is interactive but detection could not classify the
   * frame (status 'running', reason 'default') — i.e. stuck in an unrecognized TUI
   * mode. Gates the detection-independent Esc/q escape hatch. Deliberately false
   * during normal generation (which is 'thinking_indicator') and at an idle input
   * prompt ('ready'), so the hatch never appears where 'q' would insert text.
   */
  isUnclassifiedActive: boolean;
  attaching: boolean;
  autoScroll: boolean;
}

export interface PanePromptState {
  visible: boolean;
  data: PromptData | null;
  messageId: string | null;
  answering: boolean;
}

interface CurrentOutputResponse {
  isRunning?: boolean;
  cliToolId?: CLIToolType;
  isGenerating?: boolean;
  isPromptWaiting?: boolean;
  promptData?: PromptData;
  fullOutput?: string;
  realtimeSnippet?: string;
  thinking?: boolean;
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
  isUnclassifiedActive?: boolean;
}

export interface UseTerminalPanePollingOptions {
  worktreeId: string;
  cliToolId: CLIToolType;
  /**
   * Issue #869: agent instance id for this pane. Defaults to the primary
   * instance (`=== cliToolId`), in which case the request is identical to the
   * pre-#869 behavior. Additional instances (e.g. `claude-2`) target their own
   * session via the `instance` query param.
   */
  instanceId?: string;
  /** When false the poller is suspended (e.g. parent unmounted / error state). */
  enabled?: boolean;
}

export interface UseTerminalPanePollingReturn {
  terminal: PaneTerminalState;
  prompt: PanePromptState;
  setAutoScroll: (next: boolean) => void;
  setPromptAnswering: (answering: boolean) => void;
  clearPrompt: () => void;
  /** Manually refresh; useful after sending a message / prompt response. */
  refresh: () => Promise<void>;
}

export function useTerminalPanePolling({
  worktreeId,
  cliToolId,
  instanceId,
  enabled = true,
}: UseTerminalPanePollingOptions): UseTerminalPanePollingReturn {
  // Resolve to the primary instance when omitted (instanceId === cliToolId).
  const resolvedInstanceId = instanceId ?? cliToolId;
  const [terminal, setTerminal] = useState<PaneTerminalState>(() => ({
    output: '',
    realtimeSnippet: '',
    isRunning: false,
    isThinking: false,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    attaching: true,
    autoScroll: true,
  }));

  const [prompt, setPrompt] = useState<PanePromptState>(() => ({
    visible: false,
    data: null,
    messageId: null,
    answering: false,
  }));

  // Stale-response guard. Bump on every fetch; ignore older resolutions.
  const requestIdRef = useRef(0);
  // The cliToolId active when the in-flight request was started. Even if the
  // requestId race protects against ordering inversions within the same CLI,
  // we also need to drop responses that landed under a different CLI.
  const inFlightCliToolRef = useRef<CLIToolType>(cliToolId);
  inFlightCliToolRef.current = cliToolId;
  // Issue #869: also drop responses that landed under a different instance (two
  // splits may share a CLI tool but differ by instance).
  const inFlightInstanceRef = useRef<string>(resolvedInstanceId);
  inFlightInstanceRef.current = resolvedInstanceId;

  // promptVisible is read inside fetchCurrentOutput; keep it as a ref so the
  // fetchCurrentOutput callback identity stays stable across prompt visibility
  // changes. This mirrors the WorktreeDetailRefactored pattern.
  const promptVisibleRef = useRef(prompt.visible);
  promptVisibleRef.current = prompt.visible;

  // Issue #1120: realtime push integration. Terminal output streams via
  // `terminal_snapshot` while a session generates; `version` guards against
  // out-of-order deliveries (parity with the poll's requestId stale-guard).
  const { connected, subscribe, unsubscribe, addListener } = useRealtime();
  const lastSnapshotVersionRef = useRef(0);
  const unclassifiedCountRef = useRef(0);
  const unclassifiedSinceRef = useRef<number | null>(null);
  const pushStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pushHealthy, setPushHealthy] = useState(false);

  const markPushHealthy = useCallback(() => {
    setPushHealthy(true);
    if (pushStaleTimerRef.current !== null) {
      clearTimeout(pushStaleTimerRef.current);
    }
    pushStaleTimerRef.current = setTimeout(() => {
      pushStaleTimerRef.current = null;
      setPushHealthy(false);
    }, WS_PUSH_STALE_AFTER_MS);
  }, []);

  /**
   * Apply a normalized output snapshot (from a poll response or a WS push) to the
   * terminal / prompt state. Shared so push and poll behave identically.
   */
  const applySnapshot = useCallback(
    (data: {
      fullOutput?: string;
      realtimeSnippet?: string;
      isRunning?: boolean;
      thinking?: boolean;
      isSelectionListActive?: boolean;
      isPagerActive?: boolean;
      isUnclassifiedActive?: boolean;
      isPromptWaiting?: boolean;
      promptData?: PromptData | null;
    }): void => {
      const nextOutput = data.fullOutput ?? data.realtimeSnippet ?? '';
      const rawUnclassified = data.isUnclassifiedActive === true
        && data.isPromptWaiting !== true
        && data.isSelectionListActive !== true
        && data.isPagerActive !== true;
      if (rawUnclassified) {
        unclassifiedCountRef.current += 1;
        unclassifiedSinceRef.current ??= Date.now();
      } else {
        unclassifiedCountRef.current = 0;
        unclassifiedSinceRef.current = null;
      }
      const confirmedUnclassified =
        unclassifiedCountRef.current >= UNCLASSIFIED_CONFIRMATION_COUNT
        && unclassifiedSinceRef.current !== null
        && Date.now() - unclassifiedSinceRef.current >= UNCLASSIFIED_CONFIRMATION_DELAY_MS;

      setTerminal(prev => {
        // Overwrite output if we have content or the session is still running.
        // Issue #842: also overwrite (i.e. clear) once the session has stopped,
        // so kill / natural-termination residue does not linger.
        const sessionStopped = data.isRunning === false;
        const writeOutput = !!nextOutput || !!data.isRunning || sessionStopped;
        return {
          ...prev,
          output: writeOutput ? nextOutput : prev.output,
          realtimeSnippet: data.realtimeSnippet ?? '',
          isRunning: data.isRunning ?? false,
          isThinking: data.thinking ?? false,
          isSelectionListActive: data.isSelectionListActive ?? false,
          isPagerActive: data.isPagerActive ?? false,
          isUnclassifiedActive: confirmedUnclassified,
          attaching: false,
        };
      });

      if (data.isPromptWaiting && data.promptData) {
        setPrompt(prev => ({
          ...prev,
          visible: true,
          data: data.promptData ?? prev.data,
          messageId: prev.messageId ?? `prompt-${Date.now()}`,
        }));
      } else if (!data.isPromptWaiting && promptVisibleRef.current) {
        setPrompt({ visible: false, data: null, messageId: null, answering: false });
      }
    },
    [],
  );

  const fetchCurrentOutput = useCallback(async (): Promise<void> => {
    const requestedCli = cliToolId;
    const requestedInstance = resolvedInstanceId;
    const requestId = ++requestIdRef.current;
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/current-output?cliTool=${requestedCli}&instance=${encodeURIComponent(requestedInstance)}`,
      );
      if (!response.ok) return;
      const data: CurrentOutputResponse = await response.json();
      // Drop if a newer request superseded us, or the CLI / instance changed.
      if (
        requestIdRef.current !== requestId ||
        inFlightCliToolRef.current !== requestedCli ||
        inFlightInstanceRef.current !== requestedInstance
      ) {
        return;
      }
      if (data.cliToolId && data.cliToolId !== requestedCli) {
        return;
      }

      applySnapshot(data);
    } catch (err) {
      if (
        requestIdRef.current !== requestId ||
        inFlightCliToolRef.current !== requestedCli ||
        inFlightInstanceRef.current !== requestedInstance
      ) {
        return;
      }
      // Network errors are swallowed; next interval will retry.
      console.error('[useTerminalPanePolling] fetch error:', err);
    }
  }, [worktreeId, cliToolId, resolvedInstanceId, applySnapshot]);

  // When (worktreeId, cliToolId) changes, treat it like a fresh attach.
  // We reset attaching=true and clear stale output/prompt so the new CLI starts
  // from a blank state.
  const compositeKey = `${worktreeId}::${cliToolId}::${resolvedInstanceId}`;
  const prevCompositeKeyRef = useRef(compositeKey);
  useEffect(() => {
    if (prevCompositeKeyRef.current === compositeKey) return;
    prevCompositeKeyRef.current = compositeKey;
    // Bump the requestId so any in-flight prior-CLI promise is dropped.
    requestIdRef.current += 1;
    // Issue #1120: reset the push version guard so the new session's snapshots
    // (which restart their own version counter) are not rejected as stale.
    lastSnapshotVersionRef.current = 0;
    unclassifiedCountRef.current = 0;
    unclassifiedSinceRef.current = null;
    setPushHealthy(false);
    if (pushStaleTimerRef.current !== null) {
      clearTimeout(pushStaleTimerRef.current);
      pushStaleTimerRef.current = null;
    }
    setTerminal(prev => ({
      ...prev,
      output: '',
      realtimeSnippet: '',
      isRunning: false,
      isThinking: false,
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      attaching: true,
    }));
    setPrompt({ visible: false, data: null, messageId: null, answering: false });
  }, [compositeKey]);

  // Issue #1120: subscribe to the worktree room so terminal snapshots stream in.
  useEffect(() => {
    if (!enabled) return;
    subscribe(worktreeId);
    return () => unsubscribe(worktreeId);
  }, [enabled, worktreeId, subscribe, unsubscribe]);

  // Issue #1120: a fresh connection resets the push version guard so snapshots
  // are accepted after a server restart (which restarts server-side counters).
  useEffect(() => {
    lastSnapshotVersionRef.current = 0;
    setPushHealthy(false);
    if (pushStaleTimerRef.current !== null) {
      clearTimeout(pushStaleTimerRef.current);
      pushStaleTimerRef.current = null;
    }
  }, [connected]);

  useEffect(() => () => {
    if (pushStaleTimerRef.current !== null) {
      clearTimeout(pushStaleTimerRef.current);
    }
  }, []);

  // Issue #1120: apply pushed terminal snapshots for this exact pane.
  useEffect(() => {
    if (!enabled) return;
    return addListener((event: RealtimeEvent) => {
      if (event.type !== 'terminal_snapshot') return;
      const snap = event as TerminalSnapshotEvent;
      if (
        snap.worktreeId !== worktreeId ||
        snap.cliToolId !== inFlightCliToolRef.current ||
        snap.instanceId !== inFlightInstanceRef.current
      ) {
        return;
      }
      // Version guard: drop out-of-order / stale deliveries.
      if (snap.version <= lastSnapshotVersionRef.current) return;
      lastSnapshotVersionRef.current = snap.version;
      markPushHealthy();

      const realtimeSnippet = snap.output.split('\n').slice(-100).join('\n');
      applySnapshot({
        fullOutput: snap.output,
        realtimeSnippet,
        isRunning: snap.isRunning,
        thinking: snap.thinking,
        isSelectionListActive: snap.isSelectionListActive,
        isPagerActive: snap.isPagerActive,
        isUnclassifiedActive: snap.isUnclassifiedActive,
        isPromptWaiting: snap.isPromptWaiting,
        promptData: snap.promptData ?? null,
      });
    });
  }, [enabled, worktreeId, addListener, applySnapshot, markPushHealthy]);

  // Initial + interval polling. Pauses when hidden, resumes on visible.
  // Cadence depends on isRunning (active=2s, idle=5s); while a WS push
  // connection is up (Issue #1120) the poll is throttled to a slow fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const startInterval = (ms: number) => {
      return setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        void fetchCurrentOutput();
      }, ms);
    };

    const interactionActive = prompt.visible
      || terminal.isSelectionListActive
      || terminal.isPagerActive
      || terminal.isUnclassifiedActive;
    const intervalMs = connected && pushHealthy && !interactionActive
      ? WS_CONNECTED_POLLING_INTERVAL_MS
      : terminal.isRunning || interactionActive
        ? ACTIVE_POLLING_INTERVAL_MS
        : IDLE_POLLING_INTERVAL_MS;
    let intervalId: ReturnType<typeof setInterval> | null = startInterval(intervalMs);

    // Kick once immediately if the page is visible.
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
      void fetchCurrentOutput();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        void fetchCurrentOutput();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // We re-create the interval when:
    //   - enabled toggles
    //   - the cadence-driving isRunning flips
    //   - the WS connection state flips (Issue #1120)
    //   - fetchCurrentOutput identity changes (cliToolId / worktreeId)
  }, [
    enabled,
    connected,
    pushHealthy,
    terminal.isRunning,
    terminal.isSelectionListActive,
    terminal.isPagerActive,
    terminal.isUnclassifiedActive,
    prompt.visible,
    fetchCurrentOutput,
  ]);

  const setAutoScroll = useCallback((next: boolean) => {
    setTerminal(prev => (prev.autoScroll === next ? prev : { ...prev, autoScroll: next }));
  }, []);

  const setPromptAnswering = useCallback((answering: boolean) => {
    setPrompt(prev => ({ ...prev, answering }));
  }, []);

  const clearPrompt = useCallback(() => {
    setPrompt({ visible: false, data: null, messageId: null, answering: false });
  }, []);

  const refresh = useCallback(() => fetchCurrentOutput(), [fetchCurrentOutput]);

  return {
    terminal,
    prompt,
    setAutoScroll,
    setPromptAnswering,
    clearPrompt,
    refresh,
  };
}
