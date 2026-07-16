/**
 * Unit tests for the update lock (Issue #1198).
 *
 * Uses a real temp directory rather than an fs mock: the guarantee under test
 * is O_EXCL atomicity, which a mock would define away.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = { path: '' };

vi.mock('@/cli/utils/install-context', () => ({
  ensureConfigDir: vi.fn(() => configDir.path),
}));

import {
  acquireUpdateLock,
  releaseUpdateLock,
  getUpdateLockPath,
  UPDATE_LOCK_TIMEOUT_MS,
  UPDATE_LOCK_FILENAME,
} from '@/lib/app-update/update-lock';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  configDir.path = mkdtempSync(join(tmpdir(), 'cm-update-lock-'));
});

afterEach(() => {
  rmSync(configDir.path, { recursive: true, force: true });
});

describe('getUpdateLockPath', () => {
  it('resolves inside the config directory', () => {
    expect(getUpdateLockPath()).toBe(join(configDir.path, UPDATE_LOCK_FILENAME));
  });
});

describe('acquireUpdateLock', () => {
  it('acquires when no lock exists and writes the lock file', () => {
    expect(acquireUpdateLock(NOW)).toBe(true);
    expect(existsSync(getUpdateLockPath())).toBe(true);

    const data = JSON.parse(readFileSync(getUpdateLockPath(), 'utf-8'));
    expect(data.startedAt).toBe(NOW);
    expect(data.pid).toBe(process.pid);
  });

  it('refuses a second acquisition while the lock is fresh', () => {
    expect(acquireUpdateLock(NOW)).toBe(true);
    expect(acquireUpdateLock(NOW + 1000)).toBe(false);
  });

  it('still refuses right at the timeout boundary', () => {
    expect(acquireUpdateLock(NOW)).toBe(true);
    expect(acquireUpdateLock(NOW + UPDATE_LOCK_TIMEOUT_MS)).toBe(false);
  });

  it('reclaims a lock older than the timeout', () => {
    expect(acquireUpdateLock(NOW)).toBe(true);

    const later = NOW + UPDATE_LOCK_TIMEOUT_MS + 1;
    expect(acquireUpdateLock(later)).toBe(true);

    // The reclaim must re-stamp, otherwise the next caller would reclaim again.
    const data = JSON.parse(readFileSync(getUpdateLockPath(), 'utf-8'));
    expect(data.startedAt).toBe(later);
  });

  it.each([
    ['malformed JSON', 'not json at all'],
    ['missing startedAt', '{"pid":1}'],
    ['non-numeric startedAt', '{"startedAt":"soon"}'],
  ])('reclaims an unusable lock (%s) instead of blocking forever', (_label, contents) => {
    writeFileSync(getUpdateLockPath(), contents);
    expect(acquireUpdateLock(NOW)).toBe(true);
  });

  it('defaults to the current time when none is given', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      expect(acquireUpdateLock()).toBe(true);
      expect(JSON.parse(readFileSync(getUpdateLockPath(), 'utf-8')).startedAt).toBe(NOW);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('releaseUpdateLock', () => {
  it('removes the lock and allows a fresh acquisition', () => {
    expect(acquireUpdateLock(NOW)).toBe(true);
    releaseUpdateLock();

    expect(existsSync(getUpdateLockPath())).toBe(false);
    expect(acquireUpdateLock(NOW + 1)).toBe(true);
  });

  it('is a no-op when no lock is held', () => {
    expect(() => releaseUpdateLock()).not.toThrow();
  });
});
