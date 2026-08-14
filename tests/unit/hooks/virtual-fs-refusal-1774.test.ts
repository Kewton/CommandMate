/**
 * The real `/proc` path, through the real predicate, to the real fail-open
 * behaviour (Issue #1774).
 *
 * `virtual-fs-resolver-guards-1774.test.ts` proves each of the five settings is
 * wired to the guard, using a sentinel path so nothing in it could hang.
 * This file closes the loop for the entry points that take the path as an
 * **argument**, where a genuine `/proc` value can be used: passing one of these
 * paths as data is exactly what
 * `tests/unit/guards/no-procfs-env-fixtures.test.ts` permits, and what it bans
 * is assigning one to an environment variable. Nothing here creates a
 * directory — that is the whole point, and each assertion is that the call
 * returned rather than that it wrote something.
 *
 * If any of these ever regressed, this file would not fail on Linux — it would
 * hang. That is a deliberate trade: the alternative is not testing the real
 * path at all, and each of these calls is guarded *before* the mkdir it fronts,
 * so a regression is caught by the assertions in the sibling file first.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// `vi.hoisted` so the mock exists by the time `vi.mock` is lifted to the top.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import { getHookSettingsDirectory } from '@/lib/hooks/hook-settings-generator';
import { getCodexHome } from '@/lib/hooks/sources/codex/hooks-config';
import { writeJsonObjectFile } from '@/lib/hooks/sources/gemini/shared-config-tree';
import { writeAntigravityHooksConfig } from '@/lib/hooks/sources/antigravity/hooks-config';

/** The literal value that hung PR #1773 for 5h31m. */
const PROCFS_PATH = '/proc/definitely-not-writable/cmate';

describe('a real /proc path is refused before any mkdir (Issue #1774)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSafeDirectoryWarnings();
  });

  it('getHookSettingsDirectory falls back to ~/.commandmate/hooks', () => {
    expect(getHookSettingsDirectory({ directory: PROCFS_PATH })).toBe(
      join(homedir(), '.commandmate', 'hooks')
    );
    expect(existsSync(PROCFS_PATH)).toBe(false);
  });

  it('getCodexHome falls back to ~/.codex', () => {
    expect(getCodexHome({ codexHome: '/proc/definitely-not-writable/codex' })).toBe(
      join(homedir(), '.codex')
    );
  });

  it('the same is true for /sys and /dev', () => {
    expect(getHookSettingsDirectory({ directory: '/sys/kernel/cmate' })).toBe(
      join(homedir(), '.commandmate', 'hooks')
    );
    expect(getCodexHome({ codexHome: '/dev/cmate' })).toBe(join(homedir(), '.codex'));
  });

  it('writeJsonObjectFile throws rather than reaching mkdir', () => {
    expect(() => writeJsonObjectFile('/proc/cmate/config/hooks.json', {})).toThrow(
      /virtual filesystem/i
    );
  });

  it('writeAntigravityHooksConfig degrades to launching without hooks', () => {
    // The end of the chain: a throw from the writer is the fail-open signal
    // this caller already handles, so the refusal costs the events and nothing
    // else — a session still starts.
    expect(writeAntigravityHooksConfig({ path: '/proc/cmate/config/hooks.json' })).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'antigravity-hooks-config-write-failed',
      expect.objectContaining({ error: expect.stringMatching(/virtual filesystem/i) })
    );
  });

  it('an ordinary home-relative path is untouched', () => {
    // Over-rejection would be just as bad: it would silently move every
    // isolated test run and container deployment back onto the real home.
    const ordinary = join(homedir(), '.commandmate', 'hooks-custom');
    expect(getHookSettingsDirectory({ directory: ordinary })).toBe(ordinary);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
