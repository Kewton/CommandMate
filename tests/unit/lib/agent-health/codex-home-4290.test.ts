/**
 * Issue #4290 (3): one CODEX_HOME for the agent-health parent, its children and
 * the history reader.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildChildEnv } from '@/lib/agent-health/tmux-command';
import { getCodexHome } from '@/lib/hooks/sources/codex/hooks-config';
import { resolveCodexHome } from '@/lib/hooks/sources/codex/history';

describe('[#4290] CODEX_HOME handed to agent-health children', () => {
  let root: string;
  let parentCwd: string;
  let probeCwd: string;
  const savedEnv = process.env.CODEX_HOME;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4290-'));
    parentCwd = path.join(root, 'parent');
    fs.mkdirSync(parentCwd);
    probeCwd = path.join(root, 'probe');
    fs.mkdirSync(probeCwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedEnv;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('pins a relative CODEX_HOME to the parent cwd, not the probe cwd (red before the fix)', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(parentCwd);
    const base = { PATH: '/usr/bin', CODEX_HOME: 'rel-home' };
    const env = buildChildEnv(base);
    expect(env.CODEX_HOME).toBe(path.join(parentCwd, 'rel-home'));
    // A child whose cwd is the probe worktree sees the same directory.
    expect(path.resolve(probeCwd, env.CODEX_HOME as string)).toBe(env.CODEX_HOME);
    // The parent's own environment is untouched.
    expect(base.CODEX_HOME).toBe('rel-home');
  });

  it('matches getCodexHome(), which the backup/check/restore of config files uses', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(parentCwd);
    process.env.CODEX_HOME = './nested/home';
    expect(buildChildEnv(process.env).CODEX_HOME).toBe(getCodexHome());
  });

  it('also normalises a relative value that arrives as an override', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(parentCwd);
    expect(buildChildEnv({}, { CODEX_HOME: 'ov' }).CODEX_HOME).toBe(path.join(parentCwd, 'ov'));
  });

  it('falls back to the getCodexHome default for an empty value', () => {
    delete process.env.CODEX_HOME;
    const env = buildChildEnv({ CODEX_HOME: '' });
    expect(env.CODEX_HOME).toBe(getCodexHome());
    expect(env.CODEX_HOME).toBe(path.join(os.homedir(), '.codex'));
  });

  it('falls back to the default for a virtual filesystem value', () => {
    expect(buildChildEnv({ CODEX_HOME: '/proc/self/codex' }).CODEX_HOME).toBe(
      path.join(os.homedir(), '.codex')
    );
  });

  it('keeps an absolute value, a temp dir, and an unset value as they were', () => {
    const abs = path.join(root, 'abs-home');
    expect(buildChildEnv({ CODEX_HOME: abs }).CODEX_HOME).toBe(abs);
    expect(buildChildEnv({ PATH: '/usr/bin' })).not.toHaveProperty('CODEX_HOME');
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

describe('[#4290] main order: launch cwd -> chdir to the repo root -> child env', () => {
  let root: string;
  let launch: string;
  let repoRoot: string;
  const originalCwd = process.cwd();
  const savedEnv = process.env.CODEX_HOME;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4290-m-')));
    launch = path.join(root, 'launch');
    repoRoot = path.join(root, 'repo');
    fs.mkdirSync(launch);
    fs.mkdirSync(repoRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    const { resetLaunchCodexHome } = await import('../../../../scripts/agent-health/tool-table');
    resetLaunchCodexHome();
    if (savedEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedEnv;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function trustPath(guarded: { trustState: unknown[] } | undefined): string | undefined {
    const first = guarded?.trustState[0];
    return typeof first === 'string' ? first : (first as { path: string } | undefined)?.path;
  }

  /** The same three steps as scripts/agent-health/main.ts. */
  async function runMainOrder(codexHome: string | undefined) {
    const { pinLaunchCodexHome, TOOL_PROBE_SPECS } = await import('../../../../scripts/agent-health/tool-table');
    if (codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = codexHome;
    process.chdir(launch);
    const launchCwd = process.cwd();
    pinLaunchCodexHome(process.env, launchCwd);
    process.chdir(repoRoot);
    const childEnv = buildChildEnv(process.env, {}, launchCwd);
    const guarded = TOOL_PROBE_SPECS.codex.guardedFiles?.();
    return { childEnv, guarded };
  }

  it('a relative CODEX_HOME means <launch cwd>/isolated for the child and the guarded files', async () => {
    const { childEnv, guarded } = await runMainOrder('./isolated');
    const expected = path.join(launch, 'isolated');
    expect(childEnv.CODEX_HOME).toBe(expected);
    expect(trustPath(guarded)).toBe(path.join(expected, 'config.toml'));
    expect(guarded?.hookConfig?.[0]).toBe(path.join(expected, 'hooks.json'));
    expect(process.env.CODEX_HOME).toBe('./isolated');
  });

  it('an absolute value and an unset value behave as before', async () => {
    const abs = path.join(root, 'abs');
    const a = await runMainOrder(abs);
    expect(a.childEnv.CODEX_HOME).toBe(abs);
    expect(trustPath(a.guarded)).toBe(path.join(abs, 'config.toml'));
    const u = await runMainOrder(undefined);
    expect(u.childEnv).not.toHaveProperty('CODEX_HOME');
    expect(trustPath(u.guarded)).toBe(path.join(os.homedir(), '.codex', 'config.toml'));
  });

  it('main.ts reads the launch cwd and pins before it chdirs', () => {
    const src = fs.readFileSync(path.join(originalCwd, 'scripts/agent-health/main.ts'), 'utf8');
    const iPin = src.indexOf('pinLaunchCodexHome(process.env, launchCwd)');
    const iChdir = src.indexOf('process.chdir(REPO_ROOT)');
    expect(iPin).toBeGreaterThan(-1);
    expect(iPin).toBeLessThan(iChdir);
    expect(src).toMatch(/launchCwd\s*\);/);
  });
});
