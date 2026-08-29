/**
 * `?includeStatus=` — the additive opt-OUT switch for the tmux half of
 * `GET /api/worktrees` (Issue #2060).
 *
 * The whole safety property of #2060 lives in this function: seven call sites
 * fetch this endpoint today and none of them pass `includeStatus`, so anything
 * other than "absent means true" would silently take the status block away from
 * the sidebar, the CLI, the review tab and four others at once. These tests pin
 * that direction — not the parsing convenience around it.
 */

import { describe, it, expect } from 'vitest';
import {
  parseIncludeStatusParam,
  STATUS_OFF_VALUES,
} from '@/lib/api/worktrees-include-parser';

describe('[#2060] parseIncludeStatusParam', () => {
  describe('the default is ON, from every direction', () => {
    it('is on when the parameter is absent (null from searchParams.get)', () => {
      expect(parseIncludeStatusParam(null)).toBe(true);
    });

    it('is on when the parameter is absent (undefined, no searchParams at all)', () => {
      // `request.nextUrl?.searchParams` is undefined for a plain `Request`,
      // which is exactly what the integration tests hand the route.
      expect(parseIncludeStatusParam(undefined)).toBe(true);
    });

    it('is on for a bare `?includeStatus`, which Next.js normalises to `=`', () => {
      expect(parseIncludeStatusParam('')).toBe(true);
    });

    it('is on for a value nobody defined, rather than erroring or turning off', () => {
      expect(parseIncludeStatusParam('yes')).toBe(true);
      expect(parseIncludeStatusParam('1')).toBe(true);
      expect(parseIncludeStatusParam('review')).toBe(true);
      expect(parseIncludeStatusParam('<script>alert(1)</script>')).toBe(true);
    });
  });

  describe('the words that turn it off', () => {
    it.each([...STATUS_OFF_VALUES])('turns off for %s', (value) => {
      expect(parseIncludeStatusParam(value)).toBe(false);
    });

    it('ignores surrounding whitespace and case, as `?include=` does', () => {
      expect(parseIncludeStatusParam(' 0 ')).toBe(false);
      expect(parseIncludeStatusParam('FALSE')).toBe(false);
      expect(parseIncludeStatusParam('Off')).toBe(false);
    });

    it('does not match a value that merely CONTAINS an off word', () => {
      // A substring match would turn `?includeStatus=offline` into an opt-out.
      expect(parseIncludeStatusParam('offline')).toBe(true);
      expect(parseIncludeStatusParam('0,review')).toBe(true);
    });
  });
});
