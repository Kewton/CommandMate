/**
 * Issue #4191: `resolveSafeAbsoluteDirectory`, the form of the resolver for a
 * path another process will be handed. Pure: nothing is created on disk.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import {
  resetSafeDirectoryWarnings,
  resolveSafeAbsoluteDirectory,
  resolveSafeDirectory,
} from '@/config/safe-directory';

const FALLBACK = '/fallback/dir';
const CWD = '/srv/commandmate-package-root';

beforeEach(() => {
  resetSafeDirectoryWarnings();
  vi.spyOn(process, 'cwd').mockReturnValue(CWD);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveSafeAbsoluteDirectory (Issue #4191)', () => {
  it('makes a relative candidate absolute against this process cwd', () => {
    expect(resolveSafeAbsoluteDirectory('data/hooks', FALLBACK, 'TEST')).toBe(join(CWD, 'data/hooks'));
    expect(resolveSafeAbsoluteDirectory('./x/../hooks', FALLBACK, 'TEST')).toBe(join(CWD, 'hooks'));
  });

  it('refuses a relative candidate whose absolute form is a virtual filesystem', () => {
    vi.mocked(process.cwd).mockReturnValue('/');
    expect(resolveSafeAbsoluteDirectory('proc/x', FALLBACK, 'TEST')).toBe(FALLBACK);
    expect(resolveSafeAbsoluteDirectory('/proc/x', FALLBACK, 'TEST')).toBe(FALLBACK);
  });

  it('keeps an absolute candidate, and unset/empty yields the fallback (negative control)', () => {
    expect(resolveSafeAbsoluteDirectory('/abs/hooks', FALLBACK, 'TEST')).toBe('/abs/hooks');
    expect(resolveSafeAbsoluteDirectory(undefined, FALLBACK, 'TEST')).toBe(FALLBACK);
    expect(resolveSafeAbsoluteDirectory('', FALLBACK, 'TEST')).toBe(FALLBACK);
  });

  it('leaves resolveSafeDirectory returning a relative value verbatim (its other callers)', () => {
    expect(resolveSafeDirectory('data/logs', FALLBACK, 'CM_LOG_DIR')).toBe('data/logs');
  });
});
