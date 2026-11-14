/**
 * T-I, the settings and identification rows (Issue #4367 PR1a, docs/design/flow-metrics-4367.md
 * §7.4 I1〜I10). Identification git is answered by a fake, except I10, which makes a linked
 * worktree under `os.tmpdir()` with the real git (no network, no gh).
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRunBounded } from '../../../../scripts/flow/runner.mjs';
import { parseGithubRemote, readFlowConfig, readRawFlowConfig } from '../../../../scripts/flow/config.mjs';
import { TempDirs, fakeRun, type Call, type FakeGit } from './flow-fakes';

const temps = new TempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  temps.cleanup();
});

function withYaml(text: string | null): string {
  const root = temps.make();
  if (text !== null) {
    fs.mkdirSync(path.join(root, '.commandmate'));
    fs.writeFileSync(path.join(root, '.commandmate', 'flow.yaml'), text);
  }
  return root;
}

function identify(root: string, git: FakeGit = {}, extra: { tz?: string; deadlineMono?: number } = {}) {
  const calls: Call[] = [];
  const run = fakeRun(git, () => ({ status: 1, stderr: 'no gh here' }), calls);
  const runBounded = makeRunBounded({ run, monoNow: () => 0 });
  const result = readFlowConfig(root, { runBounded, env: {}, deadlineMono: extra.deadlineMono ?? 30_000, tz: extra.tz ?? 'UTC' });
  return { result, calls };
}

describe('T-I: settings and identification (§7.4)', () => {
  it('I1 no flow.yaml, origin/develop exists: base develop, exclude ⊇ {develop, main, master}', () => {
    const { result } = identify(withYaml(null), { develop: true });
    expect(result).toMatchObject({ repo: 'Kewton/CommandMate', slug: 'kewton.commandmate', base: 'develop', tz: 'UTC' });
    expect((result as { exclude: string[] }).exclude).toEqual(expect.arrayContaining(['develop', 'main', 'master']));
  });

  it('I2 no develop, origin/HEAD → main: base main', () => {
    const { result } = identify(withYaml(null), { develop: false, originHead: 'refs/remotes/origin/main' });
    expect(result).toMatchObject({ base: 'main' });
  });

  it('I3 neither: error (base cannot be decided)', () => {
    const { result } = identify(withYaml(null), { develop: false, originHead: null });
    expect(result).toEqual({ error: expect.stringContaining('cannot decide the base') });
  });

  it('I4 base: trunk, exclude: [release]: {release, trunk, main, master}', () => {
    const { result, calls } = identify(withYaml('base: trunk\nexclude: [release]\n'));
    expect(result).toMatchObject({ base: 'trunk' });
    expect([...(result as { exclude: string[] }).exclude].sort()).toEqual(['main', 'master', 'release', 'trunk']);
    expect(calls.some((c) => c.args.includes('refs/remotes/origin/develop'))).toBe(false);
  });

  it.each([
    ['broken YAML', 'base: [unclosed\n'],
    ['version 2', 'version: 2\n'],
    ['a list at the top', '- a\n'],
  ])('I5 %s: error', (_name, text) => {
    expect(identify(withYaml(text)).result).toHaveProperty('error');
  });

  it('I5 over 64 KB: error', () => {
    expect(identify(withYaml(`# ${'x'.repeat(64 * 1024)}\n`)).result).toEqual({ error: expect.stringContaining('over 65536 bytes') });
  });

  it('I5 EACCES: error, not the defaults', () => {
    const root = withYaml('base: develop\n');
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).endsWith('flow.yaml')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (real as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    expect(identify(root).result).toEqual({ error: expect.stringContaining('EACCES') });
  });

  it.each([
    ['unknownKey', 'unknown key "unknownKey"'],
    ['alerts', 'PR-A'],
    // X9 (#4368 PR1): `wip` is a known key now; a non-mapping is still refused and named.
    ['wip', '#4368'],
    ['train', '#4369 adds it'],
    ['ledger', 'PR-L'],
    ['intervalSec', 'PR-S'],
  ])('I6 key %s: error naming it', (key, said) => {
    const { result } = identify(withYaml(`${key}: 1\n`));
    expect((result as { error: string }).error).toContain(key);
    expect((result as { error: string }).error).toContain(said);
  });

  it.each([
    ['not a list', 'exclude: release\n'],
    ['65 entries', `exclude: [${Array.from({ length: 65 }, (_, i) => `b${i}`).join(', ')}]\n`],
    ['a number', 'exclude: [1]\n'],
  ])('I7 exclude %s: error', (_name, text) => {
    expect(identify(withYaml(text)).result).toHaveProperty('error');
  });

  it('I7 (negative) 64 entries are accepted', () => {
    const text = `exclude: [${Array.from({ length: 64 }, (_, i) => `b${i}`).join(', ')}]\n`;
    expect(identify(withYaml(text)).result).not.toHaveProperty('error');
  });

  it.each([
    'git@github.com:Kewton/CommandMate.git',
    'https://github.com/Kewton/CommandMate',
    'https://github.com/Kewton/CommandMate.git',
    'ssh://git@github.com/Kewton/CommandMate.git',
  ])('I8 origin %s: Kewton/CommandMate, slug kewton.commandmate', (origin) => {
    expect(parseGithubRemote(origin)).toBe('Kewton/CommandMate');
    expect(identify(withYaml(null), { origin }).result).toMatchObject({ repo: 'Kewton/CommandMate', slug: 'kewton.commandmate' });
  });

  it.each([
    ['not GitHub', 'git@gitlab.com:Kewton/CommandMate.git'],
    ['a GitHub look-alike host', 'https://github.com.evil.example/Kewton/CommandMate'],
    ['no origin', null],
  ])('I9 origin %s: error', (_name, origin) => {
    expect(identify(withYaml(null), { origin }).result).toHaveProperty('error');
  });

  it('not a git repository: error', () => {
    expect(identify(withYaml(null), { isRepo: false }).result).toEqual({ error: expect.stringContaining('not a git repository') });
  });

  it('repo: in flow.yaml wins and origin is not asked', () => {
    const { result, calls } = identify(withYaml('repo: Other/Thing\n'), { origin: 'git@gitlab.com:x/y.git' });
    expect(result).toMatchObject({ repo: 'Other/Thing', slug: 'other.thing' });
    expect(calls.some((c) => c.args.join(' ') === 'remote get-url origin')).toBe(false);
  });

  it('tz: --tz wins over tz: in flow.yaml; a bad tz: is an error', () => {
    expect(identify(withYaml('tz: Asia/Tokyo\n'), {}, { tz: 'UTC' }).result).toMatchObject({ tz: 'UTC' });
    const root = withYaml('tz: Asia/Tokyo\n');
    const runBounded = makeRunBounded({ run: fakeRun({}, () => ({ status: 1 })), monoNow: () => 0 });
    expect(readFlowConfig(root, { runBounded, env: {}, deadlineMono: 30_000 })).toMatchObject({ tz: 'Asia/Tokyo' });
    expect(identify(withYaml('tz: Mars/Olympus\n')).result).toHaveProperty('error');
  });

  it('every identification call carries cwd = the repo root and a 10 s cap', () => {
    const root = withYaml(null);
    const { calls } = identify(root, { develop: false, originHead: 'refs/remotes/origin/main' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.cmd).toBe('git');
      expect(c.options.cwd).toBe(root);
      expect(c.options.timeout).toBeLessThanOrEqual(10_000);
    }
  });

  it('I10 a linked worktree (real git under tmpdir) reaches the same scope as the main one', () => {
    const main = temps.make('flow-4367-main-');
    const linked = path.join(temps.make('flow-4367-linked-'), 'wt');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    git(main, 'init', '-q', '-b', 'develop');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'remote', 'add', 'origin', 'git@github.com:Kewton/CommandMate.git');
    git(main, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(main, 'worktree', 'add', '-q', '-b', 'feature/x', linked);
    const real = makeRunBounded({ monoNow: () => 0 });
    const scopeOf = (root: string) => readFlowConfig(root, { runBounded: real, env: {}, deadlineMono: 30_000, tz: 'UTC' });
    const fromMain = scopeOf(main);
    expect(fromMain).toMatchObject({ repo: 'Kewton/CommandMate', base: 'develop', slug: 'kewton.commandmate' });
    expect(scopeOf(linked)).toEqual(fromMain);
  });
});

describe('#4368 PR1: the wip section in the shared reader (X9, flow-wip-4368.md §11.7)', () => {
  it('F1 a #4367-only flow.yaml reads exactly as before (no wip key in the result)', () => {
    const { result } = identify(withYaml('base: develop\nexclude: [release]\n'));
    expect(result).not.toHaveProperty('wip');
    expect(result).toMatchObject({ repo: 'Kewton/CommandMate', base: 'develop' });
  });

  it('F2 wip: { total: 8 } is accepted and carried as wip.total', () => {
    const { result } = identify(withYaml('wip:\n  total: 8\n'));
    expect(result).toMatchObject({ base: 'develop', wip: { total: 8 } });
  });

  it('F3 wip.active is refused and names PR2a', () => {
    const { result } = identify(withYaml('wip:\n  total: 8\n  active: 5\n'));
    expect((result as { error: string }).error).toContain('wip.active');
    expect((result as { error: string }).error).toContain('PR2a');
  });

  it.each([
    ['an unknown key', 'wip:\n  totl: 8\n'],
    ['0', 'wip:\n  total: 0\n'],
    ['1.5', 'wip:\n  total: 1.5\n'],
    ['a string', 'wip:\n  total: "8"\n'],
    ['.inf', 'wip:\n  total: .inf\n'],
    ['1001', 'wip:\n  total: 1001\n'],
    ['empty', 'wip:\n'],
    ['a list', 'wip: [8]\n'],
  ])('F4 wip %s: error', (_name, text) => {
    expect(identify(withYaml(text)).result).toHaveProperty('error');
  });

  it('F4 (negative) the bounds 1 and 1000 are accepted', () => {
    expect(identify(withYaml('wip:\n  total: 1\n')).result).toMatchObject({ wip: { total: 1 } });
    expect(identify(withYaml('wip:\n  total: 1000\n')).result).toMatchObject({ wip: { total: 1000 } });
  });

  it.each([
    ['alerts', 'PR-A'],
    ['train', '#4369 adds it'],
  ])('F5 %s is still refused', (key, said) => {
    expect((identify(withYaml(`${key}: 1\n`)).result as { error: string }).error).toContain(said);
  });

  it('F6 readRawFlowConfig reads the file only: no git, and off when the section is absent', () => {
    expect(readRawFlowConfig(withYaml(null))).toEqual({ settings: {}, wip: null });
    expect(readRawFlowConfig(withYaml('base: develop\n'))).toMatchObject({ wip: null });
    expect(readRawFlowConfig(withYaml('wip:\n  total: 3\n'))).toMatchObject({ wip: { total: 3 } });
    expect(readRawFlowConfig(withYaml('wip:\n  active: 3\n'))).toEqual({ error: expect.stringContaining('PR2a') });
  });
});
