/**
 * useTerminalSplits hook (Issue #728, instance-keyed in Issue #869)
 *
 * Independent hook that owns the PC-only "1-3 horizontal terminal split"
 * state. Persists per-worktree to localStorage; survives stale/external
 * payloads by validating with `normalizeSplitConfig` and falling back to a
 * default derived from the worktree's agent-instance roster.
 *
 * Issue #869: a split slot is identified by an `instanceId` (the tab/split
 * identity), not a bare CLI tool. This lets two instances of the SAME CLI tool
 * (e.g. claude + claude-2) live in separate splits. The backing `cliToolId` is
 * still tracked on each entry (derived from the roster) so cliTool-keyed
 * concerns — auto-yes, status — keep working unchanged. Mutual exclusion is now
 * by instanceId. For the primary instance `instanceId === cliToolId`, so the
 * pre-#869 single-instance behavior is byte-for-byte unchanged.
 *
 * Intentionally NOT folded into `useWorktreeUIState` / `LayoutState` to keep
 * the reducer scoped to VS Code-style layout (activityBar / historyPane /
 * leftPaneTab) and avoid action explosion (S3-006).
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';
import {
  DEFAULT_SPLIT_CONFIG,
  MAX_SPLITS,
  MIN_SPLITS,
  getTerminalSplitsStorageKey,
  normalizeSplitConfig,
  type TerminalSplitConfig,
  type TerminalSplitEntry,
} from '@/config/terminal-split-config';

export interface UseTerminalSplitsReturn {
  splits: TerminalSplitEntry[];
  widths: number[];
  addSplit: () => void;
  removeSplit: () => void;
  /**
   * Assign agent instance `instanceId` to split `idx`.
   *
   * Issue #786 / #869 (D-1 / S3-005): returns `true` only when the change is
   * actually applied — `false` for an out-of-range index, an unknown instance
   * id, an instance already used by another split (S1-002 collision), or
   * assigning the split its current instance (no-op). This is the single source
   * of truth the drop handler uses to decide whether to fire the success toast
   * + active-instance sync.
   */
  setSplitInstance: (idx: number, instanceId: string) => boolean;
  setSplitWidth: (widths: number[]) => void;
  /**
   * Issue #861: equalize the visible split widths so each split occupies an
   * equal share (`1 / n`, n = split count). Splits / instance assignments are
   * left untouched; only `widths` changes. Sum stays ~1.0 (n * (1/n)).
   */
  resetWidths: () => void;
  /** Returns instance ids allowed for `idx` (excludes instances used by other splits). */
  availableInstanceIds: (idx: number) => string[];
  focusedSplitIndex: number;
  setFocusedSplitIndex: (idx: number) => void;
}

function cloneDefault(): TerminalSplitConfig {
  return {
    splits: DEFAULT_SPLIT_CONFIG.splits.map(s => ({ ...s })),
    widths: [...DEFAULT_SPLIT_CONFIG.widths],
  };
}

/** Seed config from the first roster instance (falls back to the static default). */
function defaultConfigFor(instances: AgentInstance[]): TerminalSplitConfig {
  const first = instances[0];
  if (!first) return cloneDefault();
  return { splits: [{ cliToolId: first.cliTool, instanceId: first.id }], widths: [1] };
}

/**
 * Re-normalize widths so they sum to 1.0 while preserving their ratios (Issue #739).
 */
function normalizeWidths(widths: number[]): number[] {
  const sum = widths.reduce((s, w) => s + w, 0);
  return sum > 0 ? widths.map(w => w / sum) : widths.map(() => 1 / widths.length);
}

/**
 * Reconcile a split config against the live agent-instance roster (Issue #869).
 *
 * - Re-derives each split's `cliToolId` from its instance (defensive; the
 *   mapping is stable in practice).
 * - Drops splits whose `instanceId` is no longer in the roster, replacing them
 *   with an unused roster instance when one is available.
 * - Trims the split count to at most `instances.length` (cannot show more
 *   distinct instances than exist) while respecting MIN_SPLITS.
 * - Returns the SAME reference when nothing changed (referential stability so
 *   `setConfig` can bail out and avoid a re-render).
 */
function reconcileConfig(config: TerminalSplitConfig, instances: AgentInstance[]): TerminalSplitConfig {
  if (instances.length === 0) return config; // no roster info yet; leave untouched

  const toolById = new Map(instances.map(i => [i.id, i.cliTool]));
  const usedIds = new Set<string>();
  const targetCount = Math.min(
    Math.max(config.splits.length, MIN_SPLITS),
    instances.length,
    MAX_SPLITS,
  );

  const newSplits: TerminalSplitEntry[] = [];
  // First pass: keep valid, unique, in-roster splits (preserving slot order).
  for (const s of config.splits) {
    if (newSplits.length >= targetCount) break;
    const tool = toolById.get(s.instanceId);
    if (tool && !usedIds.has(s.instanceId)) {
      usedIds.add(s.instanceId);
      newSplits.push({ cliToolId: tool, instanceId: s.instanceId });
    }
  }
  // Second pass: fill remaining slots with unused roster instances.
  for (const inst of instances) {
    if (newSplits.length >= targetCount) break;
    if (!usedIds.has(inst.id)) {
      usedIds.add(inst.id);
      newSplits.push({ cliToolId: inst.cliTool, instanceId: inst.id });
    }
  }
  if (newSplits.length === 0) {
    // Roster present but nothing matched — seed from first instance.
    newSplits.push({ cliToolId: instances[0].cliTool, instanceId: instances[0].id });
  }

  const sameContent =
    newSplits.length === config.splits.length &&
    newSplits.every(
      (s, i) =>
        s.instanceId === config.splits[i].instanceId &&
        s.cliToolId === config.splits[i].cliToolId,
    );
  if (sameContent) return config;

  let widths: number[];
  if (newSplits.length === config.widths.length) {
    widths = normalizeWidths(config.widths);
  } else if (newSplits.length < config.widths.length) {
    widths = normalizeWidths(config.widths.slice(0, newSplits.length));
  } else {
    widths = Array.from({ length: newSplits.length }, () => 1 / newSplits.length);
  }
  return { splits: newSplits, widths };
}

function readInitialState(worktreeId: string, instances: AgentInstance[]): TerminalSplitConfig {
  if (typeof window === 'undefined') return reconcileConfig(defaultConfigFor(instances), instances);
  try {
    const raw = window.localStorage.getItem(getTerminalSplitsStorageKey(worktreeId));
    if (!raw) return reconcileConfig(defaultConfigFor(instances), instances);
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeSplitConfig(parsed);
    if (normalized) {
      // Self-heal widths (sum -> 1.0) then reconcile against the live roster.
      const healed = { ...normalized, widths: normalizeWidths(normalized.widths) };
      return reconcileConfig(healed, instances);
    }
    console.warn(
      `[useTerminalSplits] stale state for ${worktreeId}; falling back to default`,
    );
    return reconcileConfig(defaultConfigFor(instances), instances);
  } catch (err) {
    console.warn(
      `[useTerminalSplits] failed to parse stored state for ${worktreeId}; using default`,
      err,
    );
    return reconcileConfig(defaultConfigFor(instances), instances);
  }
}

function pickUnusedInstance(
  instances: AgentInstance[],
  used: ReadonlySet<string>,
): AgentInstance | null {
  for (const inst of instances) {
    if (!used.has(inst.id)) return inst;
  }
  return null;
}

function widthsValid(widths: unknown): widths is number[] {
  if (!Array.isArray(widths)) return false;
  for (const w of widths) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return false;
  }
  return true;
}

export function useTerminalSplits(
  worktreeId: string,
  instances: AgentInstance[],
): UseTerminalSplitsReturn {
  const [config, setConfig] = useState<TerminalSplitConfig>(() =>
    readInitialState(worktreeId, instances),
  );
  const [focusedSplitIndex, setFocusedSplitIndexRaw] = useState(0);

  // Issue #786: mirror the latest config + roster in refs so `setSplitInstance`
  // / `addSplit` can decide synchronously without depending on `config` /
  // `instances` in their useCallback deps (which would re-create the memoized
  // handlers on every change and destabilize child panes).
  const configRef = useRef(config);
  configRef.current = config;
  const instancesRef = useRef(instances);
  instancesRef.current = instances;

  // Re-read when worktreeId changes (worktree switching).
  const prevWorktreeIdRef = useRef(worktreeId);
  useEffect(() => {
    if (prevWorktreeIdRef.current === worktreeId) return;
    prevWorktreeIdRef.current = worktreeId;
    setConfig(readInitialState(worktreeId, instancesRef.current));
    setFocusedSplitIndexRaw(0);
  }, [worktreeId]);

  // Issue #869: reconcile against the roster when it changes (instances added /
  // removed). Keyed on a roster signature so the effect only runs on a real
  // roster change, not on every render. reconcileConfig returns the same
  // reference when nothing changed, so setConfig bails out (no re-render).
  const rosterSignature = useMemo(
    () => instances.map(i => `${i.id}:${i.cliTool}`).join('|'),
    [instances],
  );
  useEffect(() => {
    setConfig(prev => reconcileConfig(prev, instancesRef.current));
    // rosterSignature is the real dependency; instancesRef is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterSignature]);

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
      const used = new Set(prev.splits.map(s => s.instanceId));
      const next = pickUnusedInstance(instancesRef.current, used);
      if (!next) return prev; // no spare instance to assign
      const lastIdx = prev.widths.length - 1;
      const lastWidth = prev.widths[lastIdx];
      const halved = lastWidth / 2;
      const newWidths = [...prev.widths];
      newWidths[lastIdx] = halved;
      newWidths.push(halved);
      return {
        splits: [...prev.splits, { cliToolId: next.cliTool, instanceId: next.id }],
        widths: newWidths,
      };
    });
  }, []);

  const removeSplit = useCallback(() => {
    setConfig(prev => {
      if (prev.splits.length <= MIN_SPLITS) return prev;
      const splits = prev.splits.slice(0, -1);
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

  const setSplitInstance = useCallback((idx: number, instanceId: string): boolean => {
    const current = configRef.current;
    const roster = instancesRef.current;
    if (idx < 0 || idx >= current.splits.length) return false;
    const target = roster.find(i => i.id === instanceId);
    if (!target) return false; // unknown instance
    // No-op: assigning the split its own current instance changes nothing.
    if (current.splits[idx].instanceId === instanceId) return false;
    // Same-instance-across-splits is forbidden (S1-002).
    for (let i = 0; i < current.splits.length; i++) {
      if (i !== idx && current.splits[i].instanceId === instanceId) return false;
    }
    setConfig(prev => {
      if (idx < 0 || idx >= prev.splits.length) return prev;
      if (prev.splits[idx].instanceId === instanceId) return prev;
      for (let i = 0; i < prev.splits.length; i++) {
        if (i !== idx && prev.splits[i].instanceId === instanceId) return prev;
      }
      const splits = prev.splits.map((s, i) =>
        i === idx ? { cliToolId: target.cliTool, instanceId } : s,
      );
      return { ...prev, splits };
    });
    return true;
  }, []);

  const setSplitWidth = useCallback((newWidths: number[]) => {
    setConfig(prev => {
      if (newWidths.length !== prev.widths.length) return prev;
      if (!widthsValid(newWidths)) return prev;
      return { ...prev, widths: [...newWidths] };
    });
  }, []);

  const resetWidths = useCallback(() => {
    setConfig(prev => {
      const n = prev.splits.length;
      if (n === 0) return prev; // defensive; MIN_SPLITS=1 makes this unreachable
      return { ...prev, widths: Array.from({ length: n }, () => 1 / n) };
    });
  }, []);

  const availableInstanceIds = useCallback(
    (idx: number): string[] => {
      const usedByOthers = new Set<string>();
      for (let i = 0; i < config.splits.length; i++) {
        if (i !== idx) usedByOthers.add(config.splits[i].instanceId);
      }
      return instances.filter(inst => !usedByOthers.has(inst.id)).map(inst => inst.id);
    },
    [config.splits, instances],
  );

  const setFocusedSplitIndex = useCallback((idx: number) => {
    setFocusedSplitIndexRaw(idx);
  }, []);

  return {
    splits: config.splits,
    widths: config.widths,
    addSplit,
    removeSplit,
    setSplitInstance,
    setSplitWidth,
    resetWidths,
    availableInstanceIds,
    focusedSplitIndex,
    setFocusedSplitIndex,
  };
}
