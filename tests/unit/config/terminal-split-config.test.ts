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
    it('starts with a single claude split and width=1', () => {
      expect(DEFAULT_SPLIT_CONFIG.splits).toEqual([{ cliToolId: 'claude' }]);
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
          splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
          widths: [0.5, 0.5],
        }),
      ).toBe(true);
    });

    it('accepts a 3-split config', () => {
      expect(
        isValidSplitConfig({
          splits: [
            { cliToolId: 'claude' },
            { cliToolId: 'codex' },
            { cliToolId: 'gemini' },
          ],
          widths: [1, 1, 1],
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
            { cliToolId: 'claude' },
            { cliToolId: 'codex' },
            { cliToolId: 'gemini' },
            { cliToolId: 'copilot' },
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
          splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
          widths: [1],
        }),
      ).toBe(false);
    });

    it('rejects widths with NaN', () => {
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'claude' }],
          widths: [Number.NaN],
        }),
      ).toBe(false);
    });

    it('rejects widths with 0 or negative numbers', () => {
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
          widths: [1, 0],
        }),
      ).toBe(false);
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
          widths: [1, -0.5],
        }),
      ).toBe(false);
    });

    it('rejects widths with Infinity', () => {
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'claude' }],
          widths: [Number.POSITIVE_INFINITY],
        }),
      ).toBe(false);
    });

    it('rejects unknown cliToolId values', () => {
      expect(
        isValidSplitConfig({
          splits: [{ cliToolId: 'unknown-tool' }],
          widths: [1],
        }),
      ).toBe(false);
    });

    it('rejects when splits entry is missing cliToolId', () => {
      expect(
        isValidSplitConfig({
          splits: [{}],
          widths: [1],
        }),
      ).toBe(false);
    });
  });
});
