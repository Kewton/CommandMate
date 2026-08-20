/**
 * Issue #1694: `--stop-pattern` must publish *what* it matched, not only that
 * something did.
 *
 * The failure these tests guard against is operational: a build log that
 * scrolls `rm -rf` past the pattern kills Auto-Yes exactly like a real hit
 * (#1678 A-5), and `stopReason: 'stop_pattern_matched'` reads identically in
 * both cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setAutoYesEnabled,
  getAutoYesState,
  disableAutoYes,
  checkStopCondition,
  clearAllAutoYesStates,
  buildCompositeKey,
  truncateToUtf8Bytes,
  STOP_MATCH_EXCERPT_MAX_BYTES,
  STOP_MATCH_EXCERPT_TRUNCATION_MARKER,
  STOP_MATCH_EXCERPT_CONTEXT_LINES,
} from '@/lib/auto-yes-state';

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('stop-pattern excerpt (Issue #1694)', () => {
  beforeEach(() => {
    clearAllAutoYesStates();
  });

  describe('checkStopCondition stores what matched', () => {
    it('stores the matched line with its surrounding context', () => {
      const output = [
        '  ⎿  Running build...',
        '     $ npm run clean && rm -rf dist',
        '     removed 42 files',
      ].join('\n');
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'rm -rf');

      expect(checkStopCondition(buildCompositeKey('wt-1', 'claude'), output)).toBe(true);

      const state = getAutoYesState('wt-1', 'claude');
      expect(state?.stopReason).toBe('stop_pattern_matched');
      // The match itself, plus the lines that say where it came from.
      expect(state?.stopMatchedText).toContain('rm -rf dist');
      expect(state?.stopMatchedText).toContain('Running build...');
      expect(state?.stopMatchedText).toContain('removed 42 files');
    });

    it('keeps the excerpt to the configured context window', () => {
      expect(STOP_MATCH_EXCERPT_CONTEXT_LINES).toBe(1);
      const output = [
        'far above',
        'line before',
        'boom happened here',
        'line after',
        'far below',
      ].join('\n');
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'boom');

      checkStopCondition(buildCompositeKey('wt-1', 'claude'), output);

      const excerpt = getAutoYesState('wt-1', 'claude')?.stopMatchedText;
      expect(excerpt).toBe('line before\nboom happened here\nline after');
      expect(excerpt).not.toContain('far above');
      expect(excerpt).not.toContain('far below');
    });

    it('stores the excerpt for an alias instance under its own key', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'FATAL', 'claude-2');

      checkStopCondition(buildCompositeKey('wt-1', 'claude', 'claude-2'), 'FATAL: disk full');

      expect(getAutoYesState('wt-1', 'claude', 'claude-2')?.stopMatchedText).toContain(
        'FATAL: disk full'
      );
      // The primary instance never fired, so it has nothing to show.
      expect(getAutoYesState('wt-1', 'claude')).toBeNull();
    });
  });

  describe('the excerpt is bounded, and says so when it was cut', () => {
    it('truncates an oversized match and marks the truncation', () => {
      const huge = `head marker\n${'x'.repeat(5000)}\ntail`;
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'head marker[\\s\\S]*');

      checkStopCondition(buildCompositeKey('wt-1', 'claude'), huge);

      const excerpt = getAutoYesState('wt-1', 'claude')?.stopMatchedText ?? '';
      expect(utf8Bytes(excerpt)).toBeLessThanOrEqual(STOP_MATCH_EXCERPT_MAX_BYTES);
      expect(excerpt.endsWith(STOP_MATCH_EXCERPT_TRUNCATION_MARKER)).toBe(true);
      // Truncated, not merely short: the input really was longer.
      expect(excerpt.length).toBeLessThan(huge.length);
      expect(excerpt).toContain('head marker');
    });

    it('measures the budget in bytes, so a multibyte frame cannot overrun it', () => {
      // Well under STOP_MATCH_EXCERPT_MAX_BYTES *characters*, well over it in
      // UTF-8 bytes (3 bytes per character).
      const japanese = '停止パターンに一致しました。'.repeat(25);
      expect(japanese.length).toBeLessThan(STOP_MATCH_EXCERPT_MAX_BYTES);
      expect(utf8Bytes(japanese)).toBeGreaterThan(STOP_MATCH_EXCERPT_MAX_BYTES);
      setAutoYesEnabled('wt-1', 'claude', true, undefined, '停止パターン[\\s\\S]*');

      checkStopCondition(buildCompositeKey('wt-1', 'claude'), japanese);

      const excerpt = getAutoYesState('wt-1', 'claude')?.stopMatchedText ?? '';
      expect(utf8Bytes(excerpt)).toBeLessThanOrEqual(STOP_MATCH_EXCERPT_MAX_BYTES);
      expect(excerpt.endsWith(STOP_MATCH_EXCERPT_TRUNCATION_MARKER)).toBe(true);
    });

    it('leaves a fitting excerpt untouched and unmarked', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');

      checkStopCondition(buildCompositeKey('wt-1', 'claude'), 'a fatal error occurred');

      const excerpt = getAutoYesState('wt-1', 'claude')?.stopMatchedText;
      expect(excerpt).toBe('a fatal error occurred');
      expect(excerpt).not.toContain(STOP_MATCH_EXCERPT_TRUNCATION_MARKER);
    });
  });

  describe('truncateToUtf8Bytes', () => {
    it('returns the input unchanged when it already fits', () => {
      expect(truncateToUtf8Bytes('short', 100)).toBe('short');
    });

    it('never splits a multi-byte character', () => {
      // 'あ' is 3 bytes; the budget deliberately lands mid-character.
      const marker = STOP_MATCH_EXCERPT_TRUNCATION_MARKER;
      const budget = utf8Bytes(marker) + 4;
      const result = truncateToUtf8Bytes('あ'.repeat(20), budget);

      expect(result).toBe(`あ${marker}`);
      expect(result).not.toContain('�');
      expect(utf8Bytes(result)).toBeLessThanOrEqual(budget);
    });

    it('never splits a surrogate pair', () => {
      const marker = STOP_MATCH_EXCERPT_TRUNCATION_MARKER;
      // '🔥' is 4 bytes / 2 UTF-16 code units.
      const result = truncateToUtf8Bytes('🔥'.repeat(10), utf8Bytes(marker) + 5);

      expect(result).toBe(`🔥${marker}`);
      expect(result).not.toContain('�');
    });

    it('degrades to the marker alone when the budget cannot hold anything else', () => {
      expect(truncateToUtf8Bytes('anything', 1)).toBe(STOP_MATCH_EXCERPT_TRUNCATION_MARKER);
    });
  });

  describe('no excerpt when the pattern did not fire', () => {
    it('leaves stopMatchedText unset while auto-yes is running', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');

      expect(checkStopCondition(buildCompositeKey('wt-1', 'claude'), 'all good')).toBe(false);

      const state = getAutoYesState('wt-1', 'claude');
      expect(state?.enabled).toBe(true);
      expect(state?.stopMatchedText).toBeUndefined();
    });

    it('leaves stopMatchedText unset on a manual disable', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');

      const state = setAutoYesEnabled('wt-1', 'claude', false);

      expect(state.stopReason).toBeUndefined();
      expect(state.stopMatchedText).toBeUndefined();
    });

    it('clears a previous excerpt when the state is disabled for another reason', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');
      checkStopCondition(buildCompositeKey('wt-1', 'claude'), 'an error happened');
      expect(getAutoYesState('wt-1', 'claude')?.stopMatchedText).toBeDefined();

      // The excerpt is evidence for one specific stop; a later expiry must not
      // inherit it and read as a pattern hit that never happened.
      const expired = disableAutoYes('wt-1', 'claude', 'expired');

      expect(expired.stopReason).toBe('expired');
      expect(expired.stopMatchedText).toBeUndefined();
    });

    it('starts clean when auto-yes is re-enabled after a stop', () => {
      setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');
      checkStopCondition(buildCompositeKey('wt-1', 'claude'), 'an error happened');

      const restarted = setAutoYesEnabled('wt-1', 'claude', true, undefined, 'error');

      expect(restarted.stopReason).toBeUndefined();
      expect(restarted.stopMatchedText).toBeUndefined();
    });
  });
});
