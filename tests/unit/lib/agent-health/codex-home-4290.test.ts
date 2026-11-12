/**
 * Issue #4290 (3): agent-health refuses a relative CODEX_HOME at start; the
 * history reader follows the safe-directory rule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveCodexHome } from '@/lib/hooks/sources/codex/history';
import { codexHomeProblem, main } from '../../../../scripts/agent-health/main';

describe('[#4290] agent-health refuses a relative CODEX_HOME before doing anything', () => {
  let root: string;
  const savedEnv = process.env.CODEX_HOME;
  const workDirs = () =>
    fs.readdirSync(fs.realpathSync(os.tmpdir())).filter((n) => n.startsWith('cm-agent-health-'));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4290-m-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedEnv;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('main returns 2 for ./isolated and creates, writes and starts nothing (red at 305e5a2)', async () => {
    process.env.CODEX_HOME = './isolated';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cwd = process.cwd();
    const before = workDirs();
    const out = path.join(root, 'report.json');
    expect(await main(['--out', out])).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'CODEX_HOME must be an absolute path for agent-health; got "./isolated"'
    );
    expect(fs.existsSync(out)).toBe(false);
    expect(workDirs()).toEqual(before);
    expect(process.cwd()).toBe(cwd);
    expect(process.env.CODEX_HOME).toBe('./isolated');
  });

  it('an absolute value, an unset value and an empty value go on as before', () => {
    expect(codexHomeProblem({ CODEX_HOME: path.join(root, 'abs') })).toBeNull();
    expect(codexHomeProblem({})).toBeNull();
    expect(codexHomeProblem({ CODEX_HOME: '' })).toBeNull();
  });

  it('names a bare relative word too', () => {
    expect(codexHomeProblem({ CODEX_HOME: 'x' })).toContain('absolute path');
  });
});

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
