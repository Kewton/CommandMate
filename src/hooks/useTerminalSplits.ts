/**
 * useTerminalSplits hook (Issue #728)
 *
 * Independent hook that owns the PC-only "1-3 horizontal terminal split"
 * state. Persists per-worktree to localStorage; survives stale/external
 * payloads by validating with `isValidSplitConfig` and falling back to
 * `DEFAULT_SPLIT_CONFIG`.
 *
 * Intentionally NOT folded into `useWorktreeUIState` / `LayoutState` to keep
 * the reducer scoped to VS Code-style layout (activityBar / historyPane /
 * leftPaneTab) and avoid action explosion (S3-006).
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import {
  DEFAULT_SPLIT_CONFIG,
  MAX_SPLITS,
  MIN_SPLITS,
  getTerminalSplitsStorageKey,
  isValidSplitConfig,
  type TerminalSplitConfig,
  type TerminalSplitEntry,
} from '@/config/terminal-split-config';

export interface UseTerminalSplitsReturn {
  splits: TerminalSplitEntry[];
  widths: number[];
  addSplit: () => void;
  removeSplit: () => void;
  setSplitCliTool: (idx: number, cliId: CLIToolType) => void;
  setSplitWidth: (widths: number[]) => void;
  /** Returns CLI tools allowed for `idx` (excludes tools used by other splits). */
  availableCliTools: (idx: number) => CLIToolType[];
  focusedSplitIndex: number;
  setFocusedSplitIndex: (idx: number) => void;
}

function cloneDefault(): TerminalSplitConfig {
  return {
    splits: DEFAULT_SPLIT_CONFIG.splits.map(s => ({ cliToolId: s.cliToolId })),
    widths: [...DEFAULT_SPLIT_CONFIG.widths],
  };
}

/**
 * Re-normalize widths so they sum to 1.0 while preserving their ratios (Issue #739).
 *
 * Why: a sum < 1 makes a flex child (`flex-grow: w`, `flex-basis: 0`) occupy only
 * that fraction of the container, leaving empty space. `removeSplit` slices the
 * widths array (e.g. `[0.5, 0.5]` -> `[0.5]`, sum 0.5), so the remainder must be
 * normalized. Also applied on load to self-heal localStorage states persisted by
 * the pre-fix buggy `removeSplit`.
 *
 * The `sum <= 0` fallback is length-preserving (equal distribution) to keep the
 * `widths.length === splits.length` invariant; it is unreachable on both call
 * sites (inputs are pre-validated all-positive, so sum > 0) but kept defensive.
 */
function normalizeWidths(widths: number[]): number[] {
  const sum = widths.reduce((s, w) => s + w, 0);
  return sum > 0 ? widths.map(w => w / sum) : widths.map(() => 1 / widths.length);
}

function readInitialState(worktreeId: string): TerminalSplitConfig {
  if (typeof window === 'undefined') return cloneDefault();
  try {
    const raw = window.localStorage.getItem(getTerminalSplitsStorageKey(worktreeId));
    if (!raw) return cloneDefault();
    const parsed: unknown = JSON.parse(raw);
    if (isValidSplitConfig(parsed)) {
      // Self-heal any persisted sum != 1.0 without mutating `parsed`. A valid,
      // already-normalized config (sum 1.0) passes through unchanged (w / 1 === w).
      return { ...parsed, widths: normalizeWidths(parsed.widths) };
    }
    console.warn(
      `[useTerminalSplits] stale state for ${worktreeId}; falling back to DEFAULT_SPLIT_CONFIG`,
    );
    return cloneDefault();
  } catch (err) {
    console.warn(
      `[useTerminalSplits] failed to parse stored state for ${worktreeId}; using default`,
      err,
    );
    return cloneDefault();
  }
}

function pickUnusedCliTool(used: ReadonlySet<string>): CLIToolType {
  for (const id of CLI_TOOL_IDS) {
    if (!used.has(id)) return id;
  }
  // All CLI tools are taken (cannot happen while MAX_SPLITS=3 < CLI_TOOL_IDS.length=6)
  // but keep a defensive fallback so types stay tight.
  return CLI_TOOL_IDS[0];
}

function widthsValid(widths: unknown): widths is number[] {
  if (!Array.isArray(widths)) return false;
  for (const w of widths) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return false;
  }
  return true;
}

export function useTerminalSplits(worktreeId: string): UseTerminalSplitsReturn {
  const [config, setConfig] = useState<TerminalSplitConfig>(() => readInitialState(worktreeId));
  const [focusedSplitIndex, setFocusedSplitIndexRaw] = useState(0);

  // Re-read when worktreeId changes (worktree switching).
  const prevWorktreeIdRef = useRef(worktreeId);
  useEffect(() => {
    if (prevWorktreeIdRef.current === worktreeId) return;
    prevWorktreeIdRef.current = worktreeId;
    setConfig(readInitialState(worktreeId));
    setFocusedSplitIndexRaw(0);
  }, [worktreeId]);

  // Persist on every change. Quota / unavailability is swallowed.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        getTerminalSplitsStorageKey(worktreeId),
        JSON.stringify(config),
      );
    } catch {
      /* localStorage unavailable or quota exceeded - non-fatal */
    }
  }, [config, worktreeId]);

  const addSplit = useCallback(() => {
    setConfig(prev => {
      if (prev.splits.length >= MAX_SPLITS) return prev;
      const used = new Set(prev.splits.map(s => s.cliToolId));
      const newCli = pickUnusedCliTool(used);
      const lastIdx = prev.widths.length - 1;
      const lastWidth = prev.widths[lastIdx];
      const halved = lastWidth / 2;
      const newWidths = [...prev.widths];
      newWidths[lastIdx] = halved;
      newWidths.push(halved);
      return {
        splits: [...prev.splits, { cliToolId: newCli }],
        widths: newWidths,
      };
    });
  }, []);

  const removeSplit = useCallback(() => {
    setConfig(prev => {
      if (prev.splits.length <= MIN_SPLITS) return prev;
      const splits = prev.splits.slice(0, -1);
      // Re-normalize so the remaining widths sum to 1.0 (Issue #739); otherwise
      // the sole/remaining flex children only fill a fraction of the container.
      const widths = normalizeWidths(prev.widths.slice(0, -1));
      return { splits, widths };
    });
  }, []);

  // Clamp focusedSplitIndex when splits shrink.
  useEffect(() => {
    setFocusedSplitIndexRaw(prev => {
      const max = config.splits.length - 1;
      if (prev > max) return max;
      if (prev < 0) return 0;
      return prev;
    });
  }, [config.splits.length]);

  const setSplitCliTool = useCallback((idx: number, cliId: CLIToolType) => {
    setConfig(prev => {
      if (idx < 0 || idx >= prev.splits.length) return prev;
      // Same-CLI-across-splits is forbidden (S1-002).
      for (let i = 0; i < prev.splits.length; i++) {
        if (i !== idx && prev.splits[i].cliToolId === cliId) return prev;
      }
      const splits = prev.splits.map((s, i) => (i === idx ? { cliToolId: cliId } : s));
      return { ...prev, splits };
    });
  }, []);

  const setSplitWidth = useCallback((newWidths: number[]) => {
    setConfig(prev => {
      if (newWidths.length !== prev.widths.length) return prev;
      if (!widthsValid(newWidths)) return prev;
      return { ...prev, widths: [...newWidths] };
    });
  }, []);

  const availableCliTools = useCallback(
    (idx: number): CLIToolType[] => {
      const usedByOthers = new Set<string>();
      for (let i = 0; i < config.splits.length; i++) {
        if (i !== idx) usedByOthers.add(config.splits[i].cliToolId);
      }
      return CLI_TOOL_IDS.filter(id => !usedByOthers.has(id));
    },
    [config.splits],
  );

  const setFocusedSplitIndex = useCallback((idx: number) => {
    setFocusedSplitIndexRaw(idx);
  }, []);

  return {
    splits: config.splits,
    widths: config.widths,
    addSplit,
    removeSplit,
    setSplitCliTool,
    setSplitWidth,
    availableCliTools,
    focusedSplitIndex,
    setFocusedSplitIndex,
  };
}
