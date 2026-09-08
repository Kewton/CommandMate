/**
 * Tests for terminal-split-config (Issue #728, 2x2 grid in Issue #2421)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_SPLITS,
  MAX_SPLITS,
  GRID_SPLIT_COUNT,
  GRID_ROW_COUNT,
  DEFAULT_GRID_ROW_HEIGHTS,
  MIN_GRID_ROW_PX,
  isGridLayout,
  isValidRowHeights,
  resolveRowHeights,
  TERMINAL_SPLITS_STORAGE_KEY_PREFIX,
  getTerminalSplitsStorageKey,
  DEFAULT_SPLIT_CONFIG,
  isValidSplitConfig,
  normalizeSplitConfig,
} from '@/config/terminal-split-config';

describe('terminal-split-config', () => {
  describe('constants', () => {
    // Issue #2421 raised the ceiling from 3 to 4. The value is pinned as a
    // literal on purpose: MAX_SPLITS is a contract with `src/app/globals.css`,
    // whose static `::highlight()` rules must enumerate 0..MAX_SPLITS-1 (see the
    // globals.css assertions in tests/unit/lib/terminal-highlight.test.ts and
    // tests/unit/lib/chat/chat-search-namespace-2421.test.ts). Reading the
    // constant back through itself would let the two drift apart in silence.
    it('exposes MIN_SPLITS=1 and MAX_SPLITS=4', () => {
      expect(MIN_SPLITS).toBe(1);
      expect(MAX_SPLITS).toBe(4);
    });

    // Issue #2421: 4 is not just "one more split", it is the count at which the
    // container stops being a row. Pinning them equal is what keeps "the grid
    // appears exactly at the maximum" true.
    it('makes the 2x2 grid the layout of the LAST allowed split count', () => {
      expect(GRID_SPLIT_COUNT).toBe(MAX_SPLITS);
      expect(GRID_ROW_COUNT).toBe(2);
      expect(GRID_SPLIT_COUNT).toBe(GRID_ROW_COUNT * 2);
      expect(DEFAULT_GRID_ROW_HEIGHTS).toEqual([0.5, 0.5]);
      expect(MIN_GRID_ROW_PX).toBeGreaterThan(0);
    });

    it('isGridLayout is true only at GRID_SPLIT_COUNT', () => {
      expect(isGridLayout(1)).toBe(false);
      expect(isGridLayout(2)).toBe(false);
      expect(isGridLayout(3)).toBe(false);
      expect(isGridLayout(4)).toBe(true);
    });

    it('uses the worktreeId-scoped prefix', () => {
      expect(TERMINAL_SPLITS_STORAGE_KEY_PREFIX).toBe('commandmate:terminalSplits:');
    });
  });

  describe('getTerminalSplitsStorageKey', () => {
    it('builds a worktreeId-scoped key', () => {
      expect(getTerminalSplitsStorageKey('w-1')).toBe('commandmate:terminalSplits:w-1');
    });
  });

  describe('DEFAULT_SPLIT_CONFIG', () => {
    it('starts with a single claude split (primary instance) and width=1', () => {
      // Issue #869: an entry now carries instanceId; for the primary instance
      // instanceId === cliToolId.
      expect(DEFAULT_SPLIT_CONFIG.splits).toEqual([
        { cliToolId: 'claude', instanceId: 'claude' },
      ]);
      expect(DEFAULT_SPLIT_CONFIG.widths).toEqual([1]);
    });

    it('passes isValidSplitConfig', () => {
      expect(isValidSplitConfig(DEFAULT_SPLIT_CONFIG)).toBe(true);
    });
  });

  describe('isValidSplitConfig', () => {
    it('accepts a 2-split config with finite positive widths', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
          ],
          widths: [0.5, 0.5],
        }),
      ).toBe(true);
    });

    it('accepts a 3-split config', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
            { cliToolId: 'gemini', instanceId: 'gemini' },
          ],
          widths: [1, 1, 1],
        }),
      ).toBe(true);
    });

    it('accepts two splits backed by the same CLI tool (Claude × 2)', () => {
      // Issue #869: two instances of the same base tool, distinguished by instanceId.
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'claude', instanceId: 'claude-2' },
          ],
          widths: [0.5, 0.5],
        }),
      ).toBe(true);
    });

    it('rejects null and non-objects', () => {
      expect(isValidSplitConfig(null)).toBe(false);
      expect(isValidSplitConfig(undefined)).toBe(false);
      expect(isValidSplitConfig('string')).toBe(false);
      expect(isValidSplitConfig(42)).toBe(false);
    });

    // Issue #2421: 4 splits is now the 2x2 grid, so the rejected case moved to 5.
    it('accepts a 4-split (2x2 grid) config', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
            { cliToolId: 'gemini', instanceId: 'gemini' },
            { cliToolId: 'copilot', instanceId: 'copilot' },
          ],
          widths: [0.25, 0.25, 0.25, 0.25],
          rowHeights: [0.5, 0.5],
        }),
      ).toBe(true);
    });

    it('rejects when splits.length > MAX_SPLITS', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
            { cliToolId: 'gemini', instanceId: 'gemini' },
            { cliToolId: 'copilot', instanceId: 'copilot' },
            { cliToolId: 'opencode', instanceId: 'opencode' },
          ],
          widths: [1, 1, 1, 1, 1],
        }),
      ).toBe(false);
    });

    it('rejects when splits.length < MIN_SPLITS', () => {
      expect(isValidSplitConfig({ splits: [], widths: [] })).toBe(false);
    });

    it('rejects when widths.length !== splits.length', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
          ],
          widths: [1],
        }),
      ).toBe(false);
    });

    it('rejects widths with NaN', () => {
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'claude', instanceId: 'claude' }],
          widths: [Number.NaN],
        }),
      ).toBe(false);
    });

    it('rejects widths with 0 or negative numbers', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
          ],
          widths: [1, 0],
        }),
      ).toBe(false);
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
          ],
          widths: [1, -0.5],
        }),
      ).toBe(false);
    });

    it('rejects widths with Infinity', () => {
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'claude', instanceId: 'claude' }],
          widths: [Number.POSITIVE_INFINITY],
        }),
      ).toBe(false);
    });

    it('rejects unknown cliToolId values', () => {
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'unknown-tool', instanceId: 'unknown-tool' }],
          widths: [1],
        }),
      ).toBe(false);
    });

    it('rejects when splits entry is missing cliToolId', () => {
      expect(
        isValidSplitConfig({
          splits: [{ instanceId: 'claude' }],
          widths: [1],
        }),
      ).toBe(false);
    });

    it('rejects when splits entry is missing instanceId (Issue #869)', () => {
      // Pre-#869 payloads (cliToolId only) are no longer "valid" under the strict
      // guard — they must be migrated via normalizeSplitConfig first.
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'claude' }],
          widths: [1],
        }),
      ).toBe(false);
    });
  });

  describe('normalizeSplitConfig (Issue #869 migration)', () => {
    it('migrates a legacy entry (cliToolId only) to the primary instanceId', () => {
      const result = normalizeSplitConfig({
        splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
        widths: [0.5, 0.5],
      });
      expect(result).toEqual({
        splits: [
          { cliToolId: 'claude', instanceId: 'claude' },
          { cliToolId: 'codex', instanceId: 'codex' },
        ],
        widths: [0.5, 0.5],
      });
    });

    it('preserves an explicit instanceId (e.g. an additional same-tool instance)', () => {
      const result = normalizeSplitConfig({
        splits: [
          { cliToolId: 'claude', instanceId: 'claude' },
          { cliToolId: 'claude', instanceId: 'claude-2' },
        ],
        widths: [1, 1],
      });
      expect(result?.splits).toEqual([
        { cliToolId: 'claude', instanceId: 'claude' },
        { cliToolId: 'claude', instanceId: 'claude-2' },
      ]);
    });

    it('returns the normalized result unchanged when already valid', () => {
      const result = normalizeSplitConfig(DEFAULT_SPLIT_CONFIG);
      expect(result).toEqual(DEFAULT_SPLIT_CONFIG);
    });

    it('returns null for irrecoverable payloads', () => {
      expect(normalizeSplitConfig(null)).toBeNull();
      expect(normalizeSplitConfig({ splits: [], widths: [] })).toBeNull();
      expect(
        normalizeSplitConfig({ splits: [{ cliToolId: 'unknown-tool' }], widths: [1] }),
      ).toBeNull();
      expect(
        normalizeSplitConfig({
          splits: [{ cliToolId: 'claude' }],
          widths: [Number.NaN],
        }),
      ).toBeNull();
    });
  });

  // ==========================================================================
  // Issue #2421: the 2x2 grid's row heights
  // ==========================================================================

  describe('isValidRowHeights (Issue #2421)', () => {
    it('treats undefined as valid — it is what every 1-3 split config carries', () => {
      expect(isValidRowHeights(undefined)).toBe(true);
    });

    it('accepts exactly GRID_ROW_COUNT finite positive ratios', () => {
      expect(isValidRowHeights([0.5, 0.5])).toBe(true);
      expect(isValidRowHeights([0.7, 0.3])).toBe(true);
      expect(isValidRowHeights([3, 1])).toBe(true); // ratios, not percentages
    });

    it('rejects a wrong length, non-numbers, and non-positive / non-finite ratios', () => {
      expect(isValidRowHeights([0.5])).toBe(false);
      expect(isValidRowHeights([0.25, 0.25, 0.5])).toBe(false);
      expect(isValidRowHeights([])).toBe(false);
      expect(isValidRowHeights('0.5,0.5')).toBe(false);
      expect(isValidRowHeights([0.5, '0.5'])).toBe(false);
      expect(isValidRowHeights([0.5, 0])).toBe(false);
      expect(isValidRowHeights([0.5, -0.5])).toBe(false);
      expect(isValidRowHeights([0.5, Number.NaN])).toBe(false);
      expect(isValidRowHeights([0.5, Number.POSITIVE_INFINITY])).toBe(false);
    });
  });

  describe('resolveRowHeights (Issue #2421)', () => {
    it('falls back to equal rows for the absent / unusable cases', () => {
      expect(resolveRowHeights(undefined)).toEqual([0.5, 0.5]);
      expect(resolveRowHeights([0.5])).toEqual([0.5, 0.5]);
      expect(resolveRowHeights([Number.NaN, 1])).toEqual([0.5, 0.5]);
    });

    it('returns a COPY, so a caller cannot mutate the shared default', () => {
      const resolved = resolveRowHeights(undefined);
      resolved[0] = 99;
      expect(DEFAULT_GRID_ROW_HEIGHTS).toEqual([0.5, 0.5]);
      expect(resolveRowHeights(undefined)).toEqual([0.5, 0.5]);
    });

    it('passes a usable persisted pair through unchanged', () => {
      expect(resolveRowHeights([0.7, 0.3])).toEqual([0.7, 0.3]);
    });
  });

  describe('isValidSplitConfig rowHeights (Issue #2421)', () => {
    const gridSplits = [
      { cliToolId: 'claude', instanceId: 'claude' },
      { cliToolId: 'codex', instanceId: 'codex' },
      { cliToolId: 'gemini', instanceId: 'gemini' },
      { cliToolId: 'copilot', instanceId: 'copilot' },
    ];

    it('accepts a grid config with no rowHeights (equal rows are implied)', () => {
      expect(
        isValidSplitConfig({ splits: gridSplits, widths: [0.25, 0.25, 0.25, 0.25] }),
      ).toBe(true);
    });

    it('rejects a malformed rowHeights under the STRICT guard', () => {
      expect(
        isValidSplitConfig({
          splits: gridSplits,
          widths: [0.25, 0.25, 0.25, 0.25],
          rowHeights: [1],
        }),
      ).toBe(false);
    });
  });

  describe('normalizeSplitConfig grid migration (Issue #2421)', () => {
    const gridSplits = [
      { cliToolId: 'claude', instanceId: 'claude' },
      { cliToolId: 'codex', instanceId: 'codex' },
      { cliToolId: 'gemini', instanceId: 'gemini' },
      { cliToolId: 'copilot', instanceId: 'copilot' },
    ];

    /*
     * The load-bearing regression guard for this Issue (trap 3): a payload
     * written by a pre-#2421 build is one-dimensional and has no `rowHeights`.
     * If normalization rejected it, `useTerminalSplits` would log "stale state"
     * and drop the user back to a single default split — their layout deleted by
     * an upgrade. The result must come back with the SAME splits and widths and
     * no row heights invented for a layout that has no rows.
     */
    it('accepts a pre-#2421 one-dimensional payload verbatim (no rowHeights invented)', () => {
      const legacy = {
        splits: [
          { cliToolId: 'claude', instanceId: 'claude' },
          { cliToolId: 'codex', instanceId: 'codex' },
          { cliToolId: 'gemini', instanceId: 'gemini' },
        ],
        widths: [0.5, 0.25, 0.25],
      };
      const result = normalizeSplitConfig(legacy);
      expect(result).not.toBeNull();
      expect(result?.splits).toEqual(legacy.splits);
      expect(result?.widths).toEqual(legacy.widths);
      expect(result?.rowHeights).toBeUndefined();
      expect(Object.keys(result as object).sort()).toEqual(['splits', 'widths']);
    });

    it('keeps a usable rowHeights on a grid payload', () => {
      const result = normalizeSplitConfig({
        splits: gridSplits,
        widths: [0.3, 0.2, 0.3, 0.2],
        rowHeights: [0.7, 0.3],
      });
      expect(result?.rowHeights).toEqual([0.7, 0.3]);
    });

    it('copies rowHeights rather than aliasing the caller\'s array', () => {
      const rowHeights = [0.7, 0.3];
      const result = normalizeSplitConfig({
        splits: gridSplits,
        widths: [0.3, 0.2, 0.3, 0.2],
        rowHeights,
      });
      rowHeights[0] = 99;
      expect(result?.rowHeights).toEqual([0.7, 0.3]);
    });

    /*
     * Unlike `isValidSplitConfig` (the strict guard), normalization is the
     * MIGRATION path, and the row ratios are its most disposable field — they
     * fall back to equal rows. Throwing away the split assignments over them
     * would be the same "layout silently reset" failure the legacy case above
     * guards against.
     */
    it('drops an unusable rowHeights instead of rejecting the whole payload', () => {
      const result = normalizeSplitConfig({
        splits: gridSplits,
        widths: [0.25, 0.25, 0.25, 0.25],
        rowHeights: [0, Number.NaN, 5],
      });
      expect(result?.splits).toHaveLength(4);
      expect(result?.rowHeights).toBeUndefined();
    });

    it('drops rowHeights carried by a NON-grid payload (no rows to describe)', () => {
      const result = normalizeSplitConfig({
        splits: [
          { cliToolId: 'claude', instanceId: 'claude' },
          { cliToolId: 'codex', instanceId: 'codex' },
        ],
        widths: [0.5, 0.5],
        rowHeights: [0.5, 0.5],
      });
      expect(result?.splits).toHaveLength(2);
      expect(result?.rowHeights).toBeUndefined();
    });
  });
});
