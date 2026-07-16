/**
 * useGitPaneNetworkOps (Issue #783, Phase 5/5)
 *
 * Owns the network I/O for the three git network operations (fetch / pull /
 * push) plus the 3-value progress state, the in-flight operation tag, the
 * conflictFiles channel, a friendly error message, and abort().
 *
 * Responsibility boundary (DR1-006 / §7.1.1):
 * - OWNS: (1) POST to /git/{fetch,pull,push} with an AbortController,
 *   (2) the progressState (idle/running/error) + error + conflict + conflictFiles,
 *   (3) abort().
 * - DOES NOT OWN: the cascade. The cascade is INJECTED via `onCascade(op)`. After
 *   every settle (success / error / abort / conflict) the hook calls
 *   onCascade(op) so the caller re-fetches Status/Commits/Branches. This keeps
 *   the dependency direction correct (the hook never imports GitPane's fetch
 *   functions).
 *
 * Abort semantics (DR1-009 / §6.3): abort() only cancels the client fetch; the
 * server git keeps running, so abort means "result unknown". We therefore still
 * call onCascade(op) on abort to re-sync the real git state, and return
 * progressState to idle (never stuck on running).
 *
 * Pull conflict (DR1-010 / §5): a PullResponse with `conflict: true` is HTTP 200
 * (success) but is a "quasi-error" in the UI. We surface conflict + conflictFiles
 * on a channel SEPARATE from progressState (progressState stays idle, not error).
 *
 * Error classification (§3.4 / DR4-003): the backend never returns raw stderr. We
 * read `{ reason }` from the JSON body and expose it as a machine-readable
 * `errorReason` tag. Issue #1277: this hook produces NO user-facing prose — the
 * rendering component translates `errorReason` (auth_failed ->
 * `git.network.authFailedGuidance`; protected_branch ->
 * `git.danger.protectedBranchWarning`) and falls back to the server's fixed
 * `error` string, then to `git.network.failed`, when `errorReason` is null.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GitNetworkOperation,
  GitNetworkProgressState,
  PullResponse,
} from '@/types/git';

/**
 * Machine-readable failure classification (Issue #1277). The hook never renders
 * prose; the consuming component maps this tag to a localized message.
 */
export type GitNetworkErrorReason = 'auth_failed' | 'protected_branch' | null;

export interface FetchOpts {
  remote?: string;
  prune?: boolean;
}

export interface PullOpts {
  remote?: string;
  branch?: string;
  rebase?: boolean;
  ffOnly?: boolean;
}

export interface PushOpts {
  remote?: string;
  branch?: string;
  force?: boolean;
  forceWithLease?: boolean;
  setUpstream?: boolean;
}

export interface UseGitPaneNetworkOpsOptions {
  /**
   * Injected cascade (DR1-006). Called after EVERY settle (success / error /
   * abort / conflict) with the operation tag so the caller re-fetches the
   * dependent sections (Status/Commits/Branches/etc.).
   */
  onCascade?: (op: GitNetworkOperation) => void;
}

export interface UseGitPaneNetworkOpsReturn {
  /** The in-flight operation, or null when idle. */
  operation: GitNetworkOperation | null;
  /** 3-value progress state (DR1-004). */
  progressState: GitNetworkProgressState;
  /**
   * The server's fixed `error` string, or null. NOT localized — it is only a
   * fallback for failures the hook could not classify (see `errorReason`).
   */
  error: string | null;
  /**
   * Classified failure reason (Issue #1277), or null when the failure was not
   * one of the known reasons. The RENDERING component translates this.
   */
  errorReason: GitNetworkErrorReason;
  /** Pull conflict flag (HTTP 200 quasi-error, DR1-010). */
  conflict: boolean;
  /** Files in conflict after a pull (empty unless conflict). */
  conflictFiles: string[];
  runFetch: (opts: FetchOpts) => Promise<void>;
  runPull: (opts: PullOpts) => Promise<void>;
  runPush: (opts: PushOpts) => Promise<void>;
  /** Abort the in-flight request (still triggers onCascade to re-sync). */
  abort: () => void;
}

/**
 * Classify a server `{ reason }` body into a machine-readable tag (Issue #1277).
 * Unknown reasons return null, which makes the consumer fall back to the
 * server's fixed `error` string (then to a generic localized message).
 */
function classifyReason(reason: unknown): GitNetworkErrorReason {
  if (reason === 'auth_failed') return 'auth_failed';
  if (reason === 'protected_branch') return 'protected_branch';
  return null;
}

/**
 * The backend never returns raw stderr (DR4-003), so its `error` string is a
 * fixed, safe fallback. Returns null when absent/empty.
 */
function serverErrorString(serverError: unknown): string | null {
  return typeof serverError === 'string' && serverError.length > 0 ? serverError : null;
}

export function useGitPaneNetworkOps(
  worktreeId: string,
  options: UseGitPaneNetworkOpsOptions = {},
): UseGitPaneNetworkOpsReturn {
  const { onCascade } = options;

  const [operation, setOperation] = useState<GitNetworkOperation | null>(null);
  const [progressState, setProgressState] = useState<GitNetworkProgressState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<GitNetworkErrorReason>(null);
  const [conflict, setConflict] = useState(false);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  // Keep the latest onCascade in a ref so the run* callbacks stay referentially
  // stable across renders (their identity should not depend on the parent
  // re-passing a fresh onCascade each render).
  const onCascadeRef = useRef(onCascade);
  useEffect(() => {
    onCascadeRef.current = onCascade;
  }, [onCascade]);

  // Abort any in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const run = useCallback(
    async (
      op: GitNetworkOperation,
      endpoint: string,
      body: Record<string, unknown>,
    ): Promise<void> => {
      // A new op clears the previous error / conflict channels.
      setError(null);
      setErrorReason(null);
      setConflict(false);
      setConflictFiles([]);
      setOperation(op);
      setProgressState('running');

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/git/${endpoint}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setErrorReason(classifyReason(data?.reason));
          setError(serverErrorString(data?.error));
          setProgressState('error');
          return;
        }

        const data: PullResponse = await response.json().catch(() => ({ success: true }));
        if (op === 'pull' && data?.conflict) {
          // HTTP 200 quasi-error (DR1-010): conflict + conflictFiles on a
          // channel separate from progressState (which returns to idle).
          setConflict(true);
          setConflictFiles(Array.isArray(data.conflictFiles) ? data.conflictFiles : []);
        }
        setProgressState('idle');
      } catch (err) {
        // Abort means "result unknown" (DR1-009): return to idle, not error.
        if (err instanceof Error && err.name === 'AbortError') {
          setProgressState('idle');
        } else {
          // No server body to fall back on: the consumer renders the generic
          // localized `git.network.failed` message (Issue #1277).
          setError(null);
          setErrorReason(null);
          setProgressState('error');
        }
      } finally {
        setOperation(null);
        abortRef.current = null;
        // Always re-sync the real git state (DR1-009), even on abort/error.
        onCascadeRef.current?.(op);
      }
    },
    [worktreeId],
  );

  const runFetch = useCallback(
    (opts: FetchOpts) => {
      const body: Record<string, unknown> = { prune: opts.prune === true };
      if (opts.remote !== undefined) body.remote = opts.remote;
      return run('fetch', 'fetch', body);
    },
    [run],
  );

  const runPull = useCallback(
    (opts: PullOpts) => {
      const body: Record<string, unknown> = {
        rebase: opts.rebase === true,
        ffOnly: opts.ffOnly === true,
      };
      if (opts.remote !== undefined) body.remote = opts.remote;
      if (opts.branch !== undefined) body.branch = opts.branch;
      return run('pull', 'pull', body);
    },
    [run],
  );

  const runPush = useCallback(
    (opts: PushOpts) => {
      const body: Record<string, unknown> = {
        force: opts.force === true,
        forceWithLease: opts.forceWithLease === true,
        setUpstream: opts.setUpstream === true,
      };
      if (opts.remote !== undefined) body.remote = opts.remote;
      if (opts.branch !== undefined) body.branch = opts.branch;
      return run('push', 'push', body);
    },
    [run],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    operation,
    progressState,
    error,
    errorReason,
    conflict,
    conflictFiles,
    runFetch,
    runPull,
    runPush,
    abort,
  };
}
