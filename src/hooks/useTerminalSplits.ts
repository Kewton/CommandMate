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
 * Issue #2421: the ceiling is 4 splits, and at exactly 4 the container lays the
 * splits out as a 2x2 grid instead of a row. The hook's contribution to that is
 * `rowHeights` — the grid's two row ratios — plus the invariant that they exist
 * ONLY while the layout is a grid (`syncGridRowHeights`), which is what keeps a
 * 1-3 split payload identical to its pre-#2421 self on disk.
 *
 * Issue #2261: the hook also owns `maximizedIndex` — which single split is
 * temporarily filling the terminal row. It sits BESIDE the persisted
 * `TerminalSplitConfig` rather than inside it precisely so it is not written to
 * localStorage: a reload is supposed to come back to the user's split layout.
 *
 * Intentionally NOT folded into `useWorktreeUIState` / `LayoutState` to keep
 * the reducer scoped to VS Code-style layout (activityBar / historyPane /
 * leftPaneTab) and avoid action explosion (S3-006).
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInstance } from '@/lib/cli-tools/types';
import {
  DEFAULT_GRID_ROW_HEIGHTS,
  DEFAULT_SPLIT_CONFIG,
  GRID_ROW_COUNT,
  GRID_SPLIT_COUNT,
  MAX_SPLITS,
  MIN_SPLITS,
  getTerminalSplitsStorageKey,
  isGridLayout,
  isValidRowHeights,
  normalizeSplitConfig,
  resolveRowHeights,
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
   * Issue #2421: the two row ratios of the 2x2 grid.
   *
   * Always `GRID_ROW_COUNT` entries, even while the layout is a 1-3 split row —
   * consumers get equal rows there rather than `undefined`, which is what keeps
   * the container free of "is this a grid yet?" branching in its style math.
   * Only the grid PERSISTS them (see `TerminalSplitConfig.rowHeights`).
   */
  rowHeights: number[];
  /**
   * Issue #2421: replace the grid's row ratios. Ignores anything that is not
   * `GRID_ROW_COUNT` finite positive numbers, mirroring `setSplitWidth`.
   */
  setRowHeights: (rowHeights: number[]) => void;
  /**
   * Issue #861: equalize the visible split widths so each split occupies an
   * equal share (`1 / n`, n = split count). Splits / instance assignments are
   * left untouched; only `widths` changes. Sum stays ~1.0 (n * (1/n)).
   *
   * Issue #2421: in the grid it equalizes the ROWS too — "equalize" means the
   * user wants every pane the same size, and in a 2x2 half of that size is
   * vertical. Equal widths alone would leave a 70/30 row split standing.
   */
  resetWidths: () => void;
  /** Returns instance ids allowed for `idx` (excludes instances used by other splits). */
  availableInstanceIds: (idx: number) => string[];
  focusedSplitIndex: number;
  setFocusedSplitIndex: (idx: number) => void;
  /**
   * Issue #2261: the split currently blown up to the whole terminal row, or
   * `null` when every split shares the row as usual.
   *
   * Deliberately NOT part of {@link TerminalSplitConfig} and therefore NOT
   * persisted: "temporarily" is the requirement, so a reload comes back to the
   * split layout the user actually built. `widths` is left untouched while a
   * split is maximized, which is what makes restoring exact rather than
   * approximate — the container simply stops reading it for one render pass.
   */
  maximizedIndex: number | null;
  /**
   * Issue #2261: maximize `idx`, or restore the split layout when `idx` is
   * already the maximized split. Out-of-range indexes are ignored.
   */
  toggleMaximize: (idx: number) => void;
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
 * Issue #2421: keep `rowHeights` present exactly while the layout is a grid.
 *
 * Applied to EVERY config transition (initial read, add, remove, roster
 * reconcile, worktree switch) so the persisted payload can never carry row
 * heights for a layout that has no rows — which is what lets the 1-3 split JSON
 * stay byte-identical to what pre-#2421 builds wrote and read.
 *
 * Returns the SAME reference when nothing has to change, so callers keep the
 * `setConfig` bail-out (no re-render) they had before.
 */
function syncGridRowHeights(config: TerminalSplitConfig): TerminalSplitConfig {
  if (isGridLayout(config.splits.length)) {
    if (isValidRowHeights(config.rowHeights) && config.rowHeights !== undefined) return config;
    return { ...config, rowHeights: [...DEFAULT_GRID_ROW_HEIGHTS] };
  }
  if (config.rowHeights === undefined) return config;
  // Delete rather than set to `undefined`: `Object.keys` on the parsed payload
  // is what pins the persisted shape (#2261's persistence test).
  const { rowHeights: _dropped, ...rest } = config;
  return rest;
}

/**
 * Issue #2421: the widths a FRESH 2x2 grid starts from.
 *
 * Entering the grid changes what `widths` means — three columns become two
 * (shared by both rows), so the ratios that described the row layout no longer
 * describe anything. Rather than reinterpret them into a lopsided grid
 * (`[0.5, 0.25, 0.25]` would open the grid at a 2:1 column split), a layout-mode
 * change starts equal, the same way `resetWidths` does.
 *
 * `widths[2]` / `widths[3]` mirror `widths[0]` / `widths[1]` so each entry still
 * describes its own pane's horizontal share even though the column ratio is read
 * off the first two.
 */
function equalGridWidths(): number[] {
  return Array.from({ length: GRID_SPLIT_COUNT }, () => 1 / GRID_SPLIT_COUNT);
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
  // Issue #2421: the reconcile can trim a 4-split grid down to 3 (or grow back),
  // so the grid-only `rowHeights` invariant is re-established here too.
  return syncGridRowHeights({ ...config, splits: newSplits, widths });
}

/**
 * Load the persisted (or default) split config for a worktree WITHOUT
 * reconciling it against the roster. Widths are self-healed (sum -> 1.0) so the
 * value is render-safe, but instance assignments are preserved verbatim — alias
 * instances (e.g. `claude-2`) survive even when the caller's roster does not yet
 * contain them (Issue #898).
 */
function loadPersistedConfig(worktreeId: string, instances: AgentInstance[]): TerminalSplitConfig {
  if (typeof window === 'undefined') return defaultConfigFor(instances);
  try {
    const raw = window.localStorage.getItem(getTerminalSplitsStorageKey(worktreeId));
    if (!raw) return defaultConfigFor(instances);
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeSplitConfig(parsed);
    if (normalized) {
      // Self-heal widths (sum -> 1.0); leave splits untouched.
      // Issue #2421: `syncGridRowHeights` supplies equal rows for a persisted
      // 4-split payload that predates row heights, and strips a stray pair off a
      // 1-3 split one — neither case falls back to the default layout.
      return syncGridRowHeights({ ...normalized, widths: normalizeWidths(normalized.widths) });
    }
    console.warn(
      `[useTerminalSplits] stale state for ${worktreeId}; falling back to default`,
    );
    return defaultConfigFor(instances);
  } catch (err) {
    console.warn(
      `[useTerminalSplits] failed to parse stored state for ${worktreeId}; using default`,
      err,
    );
    return defaultConfigFor(instances);
  }
}

/**
 * Issue #898: derive the initial config, reconciling against the roster ONLY
 * when `rosterReady` is true.
 *
 * Until the worktree's REAL agent-instance roster has loaded, the caller seeds a
 * default primary-only roster (claude/codex/… — no aliases). Reconciling the
 * persisted `[claude, claude-2]` against that transient roster would evict
 * `claude-2` (it is absent) and back-fill an unrelated primary, which is exactly
 * the split-reset bug. So while `rosterReady` is false we preserve the persisted
 * config verbatim; a later reconcile pass (fired when `rosterReady` flips true)
 * fixes it against the real roster.
 */
function readInitialState(
  worktreeId: string,
  instances: AgentInstance[],
  rosterReady: boolean,
): TerminalSplitConfig {
  const loaded = loadPersistedConfig(worktreeId, instances);
  return rosterReady ? reconcileConfig(loaded, instances) : loaded;
}

/** Issue #2421: shape guard for `setRowHeights`, mirroring `widthsValid`. */
function rowHeightsValid(rowHeights: unknown): rowHeights is number[] {
  return (
    Array.isArray(rowHeights) &&
    rowHeights.length === GRID_ROW_COUNT &&
    isValidRowHeights(rowHeights)
  );
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
  /**
   * Issue #898: `true` once the REAL agent-instance roster for `worktreeId` has
   * loaded (vs. the transient seed/default roster shown before the API responds
   * or right after a sidebar worktree switch). While `false`, reconcile is
   * suppressed so persisted alias instances (`claude-2`) are not evicted against
   * an incomplete roster. Defaults to `true` for callers/tests that always pass
   * a concrete roster (pre-#898 behavior).
   */
  rosterReady: boolean = true,
): UseTerminalSplitsReturn {
  const [config, setConfig] = useState<TerminalSplitConfig>(() =>
    readInitialState(worktreeId, instances, rosterReady),
  );
  const [focusedSplitIndex, setFocusedSplitIndexRaw] = useState(0);
  // Issue #2261: transient, in-memory only — see `maximizedIndex` on the return
  // type for why it never reaches localStorage.
  const [maximizedIndex, setMaximizedIndex] = useState<number | null>(null);

  // Issue #786: mirror the latest config + roster in refs so `setSplitInstance`
  // / `addSplit` can decide synchronously without depending on `config` /
  // `instances` in their useCallback deps (which would re-create the memoized
  // handlers on every change and destabilize child panes).
  const configRef = useRef(config);
  configRef.current = config;
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  // Issue #898: read the latest rosterReady inside the worktreeId-change effect
  // without re-running it when only rosterReady flips.
  const rosterReadyRef = useRef(rosterReady);
  rosterReadyRef.current = rosterReady;

  // Re-read when worktreeId changes (worktree switching).
  const prevWorktreeIdRef = useRef(worktreeId);
  useEffect(() => {
    if (prevWorktreeIdRef.current === worktreeId) return;
    prevWorktreeIdRef.current = worktreeId;
    setConfig(readInitialState(worktreeId, instancesRef.current, rosterReadyRef.current));
    setFocusedSplitIndexRaw(0);
    // Issue #2261: a different worktree is a different set of sessions; carrying
    // "split 2 is maximized" across the switch would blow up an unrelated pane.
    setMaximizedIndex(null);
  }, [worktreeId]);

  // Issue #869: reconcile against the roster when it changes (instances added /
  // removed). Keyed on a roster signature so the effect only runs on a real
  // roster change, not on every render. reconcileConfig returns the same
  // reference when nothing changed, so setConfig bails out (no re-render).
  // Issue #898: also re-runs when `rosterReady` flips false→true so the first
  // reconcile happens once the real roster is confirmed; while false the
  // reconcile is skipped to preserve persisted alias assignments.
  const rosterSignature = useMemo(
    () => instances.map(i => `${i.id}:${i.cliTool}`).join('|'),
    [instances],
  );
  useEffect(() => {
    if (!rosterReady) return;
    setConfig(prev => reconcileConfig(prev, instancesRef.current));
    // rosterSignature is the real dependency; instancesRef is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterSignature, rosterReady]);

  // Persist on every change. Quota / unavailability is swallowed.
  // Issue #898: skip the single transient render right after a worktree switch
  // where `config` still reflects the PREVIOUS worktree (the worktreeId effect
  // above re-derives it via a fresh setConfig → re-render, which then persists
  // correctly). This avoids momentarily writing the old config under the new
  // worktreeId's storage key.
  const persistedWorktreeIdRef = useRef(worktreeId);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (persistedWorktreeIdRef.current !== worktreeId) {
      persistedWorktreeIdRef.current = worktreeId;
      return;
    }
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
    // Issue #2261: a new split the user cannot see is not a new split.
    setMaximizedIndex(null);
    setConfig(prev => {
      if (prev.splits.length >= MAX_SPLITS) return prev;
      const used = new Set(prev.splits.map(s => s.instanceId));
      const next = pickUnusedInstance(instancesRef.current, used);
      if (!next) return prev; // no spare instance to assign
      const splits = [...prev.splits, { cliToolId: next.cliTool, instanceId: next.id }];
      // Issue #2421: the 4th split is a LAYOUT-MODE change (row -> 2x2 grid), so
      // the 1-D ratios stop describing the layout and the grid opens equal
      // instead of inheriting a lopsided column split from the 3-split row.
      if (isGridLayout(splits.length)) {
        return syncGridRowHeights({ ...prev, splits, widths: equalGridWidths() });
      }
      const lastIdx = prev.widths.length - 1;
      const lastWidth = prev.widths[lastIdx];
      const halved = lastWidth / 2;
      const newWidths = [...prev.widths];
      newWidths[lastIdx] = halved;
      newWidths.push(halved);
      return syncGridRowHeights({ ...prev, splits, widths: newWidths });
    });
  }, []);

  const removeSplit = useCallback(() => {
    // Issue #2261: unconditional, so closing the LAST split while an EARLIER one
    // is maximized still restores the layout — the clamp below only catches the
    // case where the maximized index itself stopped existing.
    setMaximizedIndex(null);
    setConfig(prev => {
      if (prev.splits.length <= MIN_SPLITS) return prev;
      const splits = prev.splits.slice(0, -1);
      const widths = normalizeWidths(prev.widths.slice(0, -1));
      // Issue #2421: leaving the grid drops `rowHeights` (there are no rows to
      // describe), which is what restores the pre-#2421 payload shape.
      return syncGridRowHeights({ ...prev, splits, widths });
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
    // Issue #2261: the maximized split can also stop existing without anyone
    // pressing "remove" — the roster reconcile (#869 / #898) trims the split
    // count too. A `maximizedIndex` pointing past the end would hide EVERY
    // remaining split, so it is dropped rather than clamped to a neighbour.
    setMaximizedIndex(prev =>
      prev !== null && prev > config.splits.length - 1 ? null : prev,
    );
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
    // Issue #2261: "equalize" is the user asking to see every split at the same
    // width, which is the opposite of one split filling the row.
    setMaximizedIndex(null);
    setConfig(prev => {
      const n = prev.splits.length;
      if (n === 0) return prev; // defensive; MIN_SPLITS=1 makes this unreachable
      const widths = Array.from({ length: n }, () => 1 / n);
      // Issue #2421: in the grid, half of "same size" is vertical — equal
      // columns beside a 70/30 row split is not what the user asked for. Equal
      // widths also restore the mirror (widths[2]===widths[0]) the grid reads
      // its single column ratio through.
      if (isGridLayout(n)) {
        return { ...prev, widths, rowHeights: [...DEFAULT_GRID_ROW_HEIGHTS] };
      }
      return syncGridRowHeights({ ...prev, widths });
    });
  }, []);

  /**
   * Issue #2421: replace the grid's row ratios (the vertical resizer's writer).
   *
   * Silently ignored while the layout is not a grid: there is no row boundary to
   * move, and writing the pair would put `rowHeights` into a payload whose shape
   * this Issue promises not to change.
   */
  const setRowHeights = useCallback((next: number[]) => {
    setConfig(prev => {
      if (!isGridLayout(prev.splits.length)) return prev;
      if (!rowHeightsValid(next)) return prev;
      return { ...prev, rowHeights: [...next] };
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

  // Issue #2421: always a usable pair, so the container never branches on
  // `undefined`. Memoized on the persisted value so the array identity is stable
  // across renders that did not touch the rows.
  const rowHeights = useMemo(
    () => resolveRowHeights(config.rowHeights),
    [config.rowHeights],
  );

  // Issue #2261: same button in the split title bar and in the Action bar, so
  // one toggle rather than a maximize()/restore() pair. Reads the live split
  // count through `configRef` (not `config`) to stay referentially stable.
  const toggleMaximize = useCallback((idx: number) => {
    if (idx < 0 || idx >= configRef.current.splits.length) return;
    setMaximizedIndex(prev => (prev === idx ? null : idx));
  }, []);

  return {
    splits: config.splits,
    widths: config.widths,
    rowHeights,
    setRowHeights,
    addSplit,
    removeSplit,
    setSplitInstance,
    setSplitWidth,
    resetWidths,
    availableInstanceIds,
    focusedSplitIndex,
    setFocusedSplitIndex,
    maximizedIndex,
    toggleMaximize,
  };
}
