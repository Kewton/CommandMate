/**
 * Tests for scripts/run-lint-sh-if-changed.mjs (Issue #3478).
 *
 * PR #3405 passed every local gate and then went red in CI's Lint job on
 * shellcheck (SC2034 / SC1091 / SC2174): `npm run lint:sh` was a CI step that
 * nothing local ran. The `lint-sh` verify gate runs this script, which runs
 * `lint:sh` only when the branch touches a `.sh` file.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  CI_SHELLCHECK_VERSION,
  DEFAULT_BASE,
  listChangedFiles,
  main,
  parseArgs,
  parseShellcheckVersion,
  selectShellScripts,
} from '../../../scripts/run-lint-sh-if-changed.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = process.cwd();

describe('parseArgs', () => {
  it('defaults --base to origin/develop', () => {
    expect(DEFAULT_BASE).toBe('origin/develop');
    expect(parseArgs([])).toEqual({ base: 'origin/develop' });
  });

  it('accepts --base <ref> and --base=<ref>', () => {
    expect(parseArgs(['--base', 'main'])).toEqual({ base: 'main' });
    expect(parseArgs(['--base=origin/main'])).toEqual({ base: 'origin/main' });
  });

  it('rejects a missing ref and unknown arguments', () => {
    expect(() => parseArgs(['--base'])).toThrow('--base requires a ref');
    expect(() => parseArgs(['--verbose'])).toThrow('unknown argument');
  });
});

describe('selectShellScripts', () => {
  it('keeps only .sh paths', () => {
    expect(
      selectShellScripts(['scripts/a.sh', 'scripts/a.mjs', 'docs/x.md', '.claude/lib/b.sh', 'shell.txt'])
    ).toEqual(['scripts/a.sh', '.claude/lib/b.sh']);
  });
});

describe('parseShellcheckVersion', () => {
  it('reads the version line of `shellcheck --version`', () => {
    const output = [
      'ShellCheck - shell script analysis tool',
      'version: 0.11.0',
      'license: GNU General Public License, version 3',
    ].join('\n');
    expect(parseShellcheckVersion(output)).toBe('0.11.0');
    expect(parseShellcheckVersion('garbage')).toBeNull();
  });

  it('pins the same version as CI', () => {
    const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci-pr.yml'), 'utf-8');
    expect(ci).toContain(`SHELLCHECK_VERSION: '${CI_SHELLCHECK_VERSION}'`);
  });
});

describe('main (decisions)', () => {
  const setup = (changed: string[], version: string | null = CI_SHELLCHECK_VERSION, lintExit = 0) => {
    const logs: string[] = [];
    const warnings: string[] = [];
    const lintSh = vi.fn(() => lintExit);
    const shellcheckVersion = vi.fn(() => version);
    const listChanged = vi.fn(() => changed);
    const run = (argv: string[] = []) =>
      main(argv, {
        cwd: '/repo',
        listChanged,
        shellcheckVersion,
        lintSh,
        log: (m: string) => logs.push(m),
        warn: (m: string) => warnings.push(m),
      });
    return { run, logs, warnings, lintSh, shellcheckVersion, listChanged };
  };

  it('does nothing and exits 0 when no .sh changed (negative control)', () => {
    const s = setup(['src/a.ts', 'docs/b.md']);
    expect(s.run()).toBe(0);
    expect(s.lintSh).not.toHaveBeenCalled();
    expect(s.shellcheckVersion).not.toHaveBeenCalled();
    expect(s.logs.join('\n')).toContain('shellcheck skipped');
  });

  it('passes --base through to the diff', () => {
    const s = setup([]);
    s.run(['--base', 'origin/main']);
    expect(s.listChanged).toHaveBeenCalledWith({ cwd: '/repo', base: 'origin/main' });
  });

  it('runs lint:sh and returns its exit code when a .sh changed (positive control)', () => {
    const s = setup(['scripts/x.sh'], CI_SHELLCHECK_VERSION, 1);
    expect(s.run()).toBe(1);
    expect(s.lintSh).toHaveBeenCalledWith('/repo');
    expect(s.warnings).toEqual([]);
  });

  it('warns and still lints when the installed version differs from CI', () => {
    const s = setup(['scripts/x.sh'], '0.9.0', 0);
    expect(s.run()).toBe(0);
    expect(s.lintSh).toHaveBeenCalledTimes(1);
    expect(s.warnings.join('\n')).toMatch(/WARNING: shellcheck 0\.9\.0 .*CI pins 0\.11\.0/);
  });

  it('warns that the change was NOT linted and exits 0 when shellcheck is missing', () => {
    const s = setup(['scripts/x.sh'], null);
    expect(s.run()).toBe(0);
    expect(s.lintSh).not.toHaveBeenCalled();
    expect(s.warnings.join('\n')).toContain('NOT linted');
  });

  it('fails closed when the diff cannot be computed', () => {
    const s = setup([]);
    s.listChanged.mockImplementation(() => {
      throw new Error('unknown revision');
    });
    expect(s.run()).toBe(1);
    expect(s.lintSh).not.toHaveBeenCalled();
  });

  it('exits 2 on a bad argument', () => {
    expect(setup([]).run(['--nope'])).toBe(2);
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' });

describe('listChangedFiles (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lint-sh-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(repo, 'keep.sh'), 'echo keep\n');
    fs.writeFileSync(path.join(repo, 'gone.sh'), 'echo gone\n');
    fs.writeFileSync(path.join(repo, 'old.sh'), 'echo old-name-content-long-enough\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'branch', 'base');
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  it('lists added, modified, renamed and deleted files, but not uncommitted ones', () => {
    fs.writeFileSync(path.join(repo, 'keep.sh'), 'echo changed\n');
    fs.writeFileSync(path.join(repo, 'added.sh'), 'echo added\n');
    fs.rmSync(path.join(repo, 'gone.sh'));
    git(repo, 'mv', 'old.sh', 'new.sh');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'change');
    fs.writeFileSync(path.join(repo, 'dirty.sh'), 'echo dirty\n');

    expect(listChangedFiles({ cwd: repo, base: 'base' }).sort()).toEqual(
      ['added.sh', 'gone.sh', 'keep.sh', 'new.sh'].sort()
    );
  });

  it('throws when the base ref does not exist', () => {
    expect(() => listChangedFiles({ cwd: repo, base: 'no-such-ref' })).toThrow();
  });
});

const hasShellcheck = spawnSync('shellcheck', ['--version']).status === 0;

/**
 * End to end against a real shellcheck and the repository's own `lint:sh`
 * line. shellcheck is not part of `npm ci`, so this is skipped where it is not
 * installed (lint-sh-scope.test.ts explains why the unit suite must not need it).
 */
describe.skipIf(!hasShellcheck)('end to end with real shellcheck', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lint-sh-e2e-'));
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'lint-sh-fixture', private: true, scripts: { 'lint:sh': pkg.scripts['lint:sh'] } })
    );
    for (const dir of ['scripts', 'tests/scripts', '.claude/lib']) {
      fs.mkdirSync(path.join(repo, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(repo, 'scripts', 'ok.sh'), '#!/bin/sh\necho ok\n');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'branch', 'base');
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  const quiet = { log: () => {}, warn: () => {} };

  it('fails on an added .sh with SC2034', () => {
    fs.writeFileSync(path.join(repo, 'scripts', 'bad.sh'), '#!/bin/sh\nunused=1\necho ok\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'add bad.sh');
    expect(main(['--base', 'base'], { cwd: repo, ...quiet })).not.toBe(0);
  });

  it('passes without running shellcheck when no .sh changed, even if a .sh is dirty', () => {
    fs.writeFileSync(path.join(repo, 'README.md'), 'docs\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'docs only');
    // Uncommitted and in lint:sh's scope: it would fail if shellcheck ran.
    fs.writeFileSync(path.join(repo, 'scripts', 'bad.sh'), '#!/bin/sh\nunused=1\n');
    const lintSh = vi.fn(() => 1);
    expect(main(['--base', 'base'], { cwd: repo, lintSh, ...quiet })).toBe(0);
    expect(lintSh).not.toHaveBeenCalled();
  });
});
