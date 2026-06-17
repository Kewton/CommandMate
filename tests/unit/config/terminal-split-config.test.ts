/**
 * Tests for terminal-split-config (Issue #728)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_SPLITS,
  MAX_SPLITS,
  TERMINAL_SPLITS_STORAGE_KEY_PREFIX,
  getTerminalSplitsStorageKey,
  DEFAULT_SPLIT_CONFIG,
  isValidSplitConfig,
  normalizeSplitConfig,
} from '@/config/terminal-split-config';

describe('terminal-split-config', () => {
  describe('constants', () => {
    it('exposes MIN_SPLITS=1 and MAX_SPLITS=3', () => {
      expect(MIN_SPLITS).toBe(1);
      expect(MAX_SPLITS).toBe(3);
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

    it('rejects when splits.length > MAX_SPLITS', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
            { cliToolId: 'gemini', instanceId: 'gemini' },
            { cliToolId: 'copilot', instanceId: 'copilot' },
          ],
          widths: [1, 1, 1, 1],
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
});
