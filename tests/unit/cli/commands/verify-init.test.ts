/**
 * `commandmate verify init` tests (Issue #2061)
 * @vitest-environment node
 *
 * Driven through the real commander command, so what is pinned is what a user
 * types — including the thing every other `verify` subcommand does differently:
 * `init` never opens a socket. It is the command that runs *before* a
 * repository has anything to verify, so requiring `commandmate start` first
 * would put the bootstrap behind the thing it bootstraps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createVerifyCommand } from '../../../../src/cli/commands/verify';
import { ExitCode } from '../../../../src/cli/types';
import { removeTempDir } from '../../../helpers/temp-dir';

const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const log = vi.spyOn(console, 'log').mockImplementation(() => {});
const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

const tempDirs: string[] = [];

/** A repository whose CI declares two usable steps and one install step. */
function createRepo(options: { withConfig?: string; withCi?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-init-')));
  tempDirs.push(dir);
  writeFileSync(
    dir + '/package.json',
    JSON.stringify({ name: 'fixture', scripts: { lint: 'true', 'test:unit': 'true' } })
  );
  if (options.withCi !== false) {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'jobs:',
        '  check:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Install',
        '        run: npm ci',
        '      - name: Lint',
        '        run: npm run lint',
        '      - name: Unit',
        '        run: npm run test:unit',
        '',
      ].join('\n')
    );
  }
  if (options.withConfig !== undefined) {
    mkdirSync(join(dir, '.commandmate'), { recursive: true });
    writeFileSync(join(dir, '.commandmate', 'verify.yaml'), options.withConfig);
  }
  return dir;
}

async function runInit(args: string[]): Promise<void> {
  await createVerifyCommand().parseAsync(['node', 'commandmate', 'init', ...args]);
}

const stdout = () => log.mock.calls.map((call) => String(call[0])).join('\n');
const stderr = () => errorLog.mock.calls.map((call) => String(call[0])).join('\n');

beforeEach(() => {
  exit.mockClear();
  log.mockClear();
  errorLog.mockClear();
  // A network call here would be a design regression, not a test failure to
  // work around: `init` reads files and nothing else.
  global.fetch = (() => {
    throw new Error('verify init must not make HTTP requests');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('commandmate verify init (Issue #2061)', () => {
  it('drafts gates from the CI definitions and writes the config', async () => {
    const repo = createRepo();

    await runInit(['--cwd', repo]);

    expect(exit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    const written = readFileSync(join(repo, '.commandmate', 'verify.yaml'), 'utf8');
    expect(written).toContain('- id: lint');
    expect(written).toContain('command: "npm run lint"');
    expect(written).toContain('- id: unit');
    expect(written).toContain('version: 1');
    // Provenance travels with the gate: the first question asked of a generated
    // config is "where did this come from, and may I delete it".
    expect(written).toContain('# from .github/workflows/ci.yml (job: check, step: Lint)');
  });

  it('reports what it refused, and why', async () => {
    const repo = createRepo();

    await runInit(['--cwd', repo]);

    expect(stderr()).toContain('[setup] npm ci');
  });

  it('refuses to overwrite an existing config and exits 2', async () => {
    const existing = 'version: 1\ngates:\n  - id: mine\n    command: "true"\n';
    const repo = createRepo({ withConfig: existing });

    await runInit(['--cwd', repo]);

    expect(exit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(stderr()).toContain('already exists');
    // The refusal is not the point; the bytes are.
    expect(readFileSync(join(repo, '.commandmate', 'verify.yaml'), 'utf8')).toBe(existing);
  });

  it('--dry-run prints the proposal and writes nothing', async () => {
    const repo = createRepo();

    await runInit(['--cwd', repo, '--dry-run']);

    expect(exit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(stdout()).toContain('- id: lint');
    expect(existsSync(join(repo, '.commandmate', 'verify.yaml'))).toBe(false);
  });

  it('exits 2 when nothing in the repository is draftable', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'verify-init-bare-')));
    tempDirs.push(repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));

    await runInit(['--cwd', repo]);

    expect(exit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(stderr()).toContain('no verification gates could be drafted');
    expect(existsSync(join(repo, '.commandmate', 'verify.yaml'))).toBe(false);
  });

  it('--json emits a machine-readable draft with provenance', async () => {
    const repo = createRepo();

    await runInit(['--cwd', repo, '--json', '--dry-run']);

    const payload = JSON.parse(stdout());
    expect(payload.created).toBe(false);
    expect(payload.refusedBecause).toBeNull();
    expect(payload.gates.map((gate: { id: string }) => gate.id)).toEqual(['lint', 'unit']);
    expect(payload.gates[0].source).toBe('.github/workflows/ci.yml (job: check, step: Lint)');
    expect(payload.excluded).toEqual([
      expect.objectContaining({ command: 'npm ci', reason: 'setup' }),
    ]);
  });

  it('--json stays valid JSON when the config already exists', async () => {
    const repo = createRepo({ withConfig: 'version: 1\ngates: []\n' });

    await runInit(['--cwd', repo, '--json']);

    // A consumer piping this into jq must not have to special-case the refusal.
    expect(JSON.parse(stdout()).refusedBecause).toBe('exists');
    expect(exit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });
});
