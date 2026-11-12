/**
 * Issue #4290 (3): the history reader's CODEX_HOME follows the safe-directory rule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveCodexHome } from '@/lib/hooks/sources/codex/history';

describe('[#4290] history resolveCodexHome follows the safe-directory rule', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4290-h-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const dflt = () => path.join(os.homedir(), '.codex');

  it('refuses /proc, /sys and /dev and uses the default (red before the fix)', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/proc/self/x' })).toBe(dflt());
    expect(resolveCodexHome({ CODEX_HOME: '/sys/x' })).toBe(dflt());
    expect(resolveCodexHome({ CODEX_HOME: '/dev/x' })).toBe(dflt());
  });

  it('refuses a symlink into a virtual filesystem (Linux only)', () => {
    if (!fs.existsSync('/proc/self')) return;
    const link = path.join(root, 'link');
    fs.symlinkSync('/proc/self', link);
    expect(resolveCodexHome({ CODEX_HOME: link })).toBe(dflt());
  });

  it('keeps a normal temp dir, an absolute value and the unset / empty defaults', () => {
    expect(resolveCodexHome({ CODEX_HOME: root })).toBe(root);
    expect(resolveCodexHome({})).toBe(dflt());
    expect(resolveCodexHome({ CODEX_HOME: '' })).toBe(dflt());
  });

  it('absolutises a relative value against the reading cwd, as getCodexHome does', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    expect(resolveCodexHome({ CODEX_HOME: 'rel' })).toBe(path.join(root, 'rel'));
  });
});
