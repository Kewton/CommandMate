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

export const ACTIVE_POLLING_INTERVAL_MS = 2000;
export const IDLE_POLLING_INTERVAL_MS = 5000;

export interface PaneTerminalState {
  output: string;
  realtimeSnippet: string;
  isRunning: boolean;
  isThinking: boolean;
  isSelectionListActive: boolean;
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

      const nextOutput = data.fullOutput ?? data.realtimeSnippet ?? '';

      setTerminal(prev => {
        // Overwrite output if we have content or the session is still running.
        // Issue #842: also overwrite (i.e. clear) once the session has stopped,
        // so kill / natural-termination residue does not linger. The prior guard
        // only kept stale output in the "empty + stopped" case, which is exactly
        // the kill case we need to clear. Running sessions are unaffected, so no
        // meaningful flicker is introduced.
        const sessionStopped = data.isRunning === false;
        const writeOutput = !!nextOutput || !!data.isRunning || sessionStopped;
        return {
          ...prev,
          output: writeOutput ? nextOutput : prev.output,
          realtimeSnippet: data.realtimeSnippet ?? '',
          isRunning: data.isRunning ?? false,
          isThinking: data.thinking ?? false,
          isSelectionListActive: data.isSelectionListActive ?? false,
          // First successful fetch flips attaching off.
          attaching: false,
        };
      });

      // Prompt transitions.
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
  }, [worktreeId, cliToolId, resolvedInstanceId]);

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
    setTerminal(prev => ({
      ...prev,
      output: '',
      realtimeSnippet: '',
      isRunning: false,
      isThinking: false,
      isSelectionListActive: false,
      attaching: true,
    }));
    setPrompt({ visible: false, data: null, messageId: null, answering: false });
  }, [compositeKey]);

  // Initial + interval polling. Pauses when hidden, resumes on visible.
  // Cadence depends on isRunning (active=2s, idle=5s).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const startInterval = (ms: number) => {
      return setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        void fetchCurrentOutput();
      }, ms);
    };

    let intervalId: ReturnType<typeof setInterval> | null = startInterval(
      terminal.isRunning ? ACTIVE_POLLING_INTERVAL_MS : IDLE_POLLING_INTERVAL_MS,
    );

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
    //   - fetchCurrentOutput identity changes (cliToolId / worktreeId)
  }, [enabled, terminal.isRunning, fetchCurrentOutput]);

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
