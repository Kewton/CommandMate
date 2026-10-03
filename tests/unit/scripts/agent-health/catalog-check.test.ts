/**
 * Issue #3158: scripts/agent-health/catalog-check-main.ts. npm and gh go through
 * injected stubs (no Issue is really created, updated or closed); the repository
 * and the state directory live under os.tmpdir() and are removed after each test.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Exec } from '../../../../scripts/agent-health/catalog-check-main';

const FIXTURES = path.resolve(__dirname, '../../lib/slash-command-reconcile/fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const OPENCODE_SKIP =
  'opencode provider skipped: no loopback port given (pass { port } — the TUI built-ins are not in GET /command, see the module docblock)';

/** A real capture plus the opencode skip, the way the runner prints it. */
function withOpencodeSkip(output: string): string {
  if (output.includes('Warnings (fail-soft')) {
    return output.replace(/(Warnings \(fail-soft[^\n]*\n)/, `$1  ! ${OPENCODE_SKIP}\n`);
  }
  return output.replace(/(={10,}\n\n)/, `$1Warnings (fail-soft — affected sources left untouched):\n  ! ${OPENCODE_SKIP}\n\n`);
}

const DATE = '2026-10-04';
const DRIFT_TITLE = '[catalog-drift] スラッシュコマンドカタログ 未反映 3 件';

let root: string;
let repoRoot: string;
let stateDir: string;
let lines: string[];
let calls: Array<[string, string[]]>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-catalog-check-'));
  repoRoot = path.join(root, 'repo');
  stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(repoRoot, 'src', 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'config', 'slash-commands-attestations.json'),
    JSON.stringify({
      attestations: [
        { tool: 'claude', version: '2.1.283' },
        { tool: 'codex', version: '0.159.3' },
        { tool: 'opencode', version: '1.18.22' },
      ],
    })
  );
  lines = [];
  calls = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeReport(tools: Array<{ tool: string; version: string }>): void {
  fs.mkdirSync(path.join(stateDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'reports', `${DATE}.json`), JSON.stringify({ schemaVersion: 1, tools }));
}

interface World {
  output: string;
  checkStatus?: number | null;
  open?: unknown[] | null;
  /** Exit code of every gh write. */
  ghWrite?: number;
  writeFails?: boolean;
}

function stub(world: World): Exec {
  return (command, args) => {
    calls.push([command, [...args]]);
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return world.open === null ? { status: 1, stdout: '' } : { status: 0, stdout: JSON.stringify(world.open ?? []) };
    }
    if (command === 'gh' && args[1] === 'create') {
      return { status: world.ghWrite ?? 0, stdout: 'https://github.com/Kewton/CommandMate/issues/3200\n' };
    }
    if (command === 'gh') return { status: world.ghWrite ?? 0, stdout: '' };
    return { status: null, stdout: '' };
  };
}

async function run(world: World, argv: string[] = []): Promise<number> {
  return main(['--state-dir', stateDir, ...argv], {
    exec: stub(world),
    runCheck: () => ({ status: world.checkStatus === undefined ? 0 : world.checkStatus, output: world.output }),
    now: () => new Date('2026-10-03T22:30:00Z'), // 07:30 JST on 10-04
    env: {} as NodeJS.ProcessEnv,
    homedir: path.join(root, 'home'),
    repoRoot,
    ...(world.writeFails ? { writeText: () => { throw new Error('EACCES'); } } : {}),
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(`ERR ${line}`),
  });
}

const recordFile = () => path.join(stateDir, 'catalog', `${DATE}.json`);
const record = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
const lastLine = () => lines[lines.length - 1];
const ghWrites = () => calls.filter(([command, args]) => command === 'gh' && args[1] !== 'list').map(([, args]) => args);
const kewton = (number: number, title = DRIFT_TITLE) => ({ number, title, author: { login: 'kewton' } });

describe('catalog-check main — Issue sync table', () => {
  it('drift, no open Issue: creates one labelled catalog-drift and records it', async () => {
    writeReport([{ tool: 'claude', version: '2.1.288 (Claude Code)' }]);
    const code = await run({
      output: withOpencodeSkip(fixture('check-drift-2026-08-06.txt')),
      // #2036 was written by the workflow bot: never reused.
      open: [{ number: 2036, title: 'old', author: { login: 'app/github-actions' } }],
    });
    expect(code).toBe(0);
    expect(ghWrites()).toEqual([
      [
        'issue', 'create', '--repo', 'Kewton/CommandMate', '--title', DRIFT_TITLE,
        '--body', expect.stringContaining('対応は `/catalog-reconcile` の無人実行節に従う'), '--label', 'catalog-drift',
      ],
    ]);
    const body = ghWrites()[0][7];
    expect(body).toContain('| claude | 2.1.283 | 2.1.288 |');
    expect(lastLine()).toBe(
      `AGENT_HEALTH_CATALOG date=${DATE} status=drift new=3 attestation_drift=0 version_gaps=claude:2.1.283->2.1.288 issue=3200 action=created`
    );
    expect(record()).toMatchObject({ date: DATE, status: 'drift', newCount: 3, issue: 3200, action: 'created', dryRun: false });
  });

  it('drift, open Issue with the same count: updates the body, no comment', async () => {
    const code = await run({ output: withOpencodeSkip(fixture('check-drift-2026-08-06.txt')), open: [kewton(3190)] });
    expect(code).toBe(0);
    expect(ghWrites()).toEqual([
      ['issue', 'edit', '3190', '--repo', 'Kewton/CommandMate', '--title', DRIFT_TITLE, '--body', expect.any(String)],
    ]);
    expect(lastLine()).toContain('issue=3190 action=updated');
  });

  it('drift, open Issue whose count moved: updates and comments', async () => {
    const before = '[catalog-drift] スラッシュコマンドカタログ 未反映 6 件';
    await run({ output: withOpencodeSkip(fixture('check-drift-2026-08-06.txt')), open: [kewton(3190, before)] });
    expect(ghWrites().map((args) => args[1])).toEqual(['edit', 'comment']);
    expect(ghWrites()[1]).toEqual([
      'issue', 'comment', '3190', '--repo', 'Kewton/CommandMate', '--body', expect.stringContaining(`- 前: ${before}`),
    ]);
  });

  it('attestation drift with zero new commands is drift too', async () => {
    await run({ output: withOpencodeSkip(fixture('check-attestation-drift-2026-08-24.txt')), open: [] });
    expect(ghWrites()[0][1]).toBe('create');
    expect(lastLine()).toContain('status=drift new=0 attestation_drift=1');
  });

  it('clean, open Issue: comments and closes it', async () => {
    const code = await run({ output: withOpencodeSkip(fixture('check-clean.txt')), open: [kewton(3190)] });
    expect(code).toBe(0);
    expect(ghWrites()).toEqual([
      ['issue', 'close', '3190', '--repo', 'Kewton/CommandMate', '--comment', expect.stringContaining('ずれ 0・検査不能なし')],
    ]);
    expect(lastLine()).toContain('status=clean new=0 attestation_drift=0 version_gaps=unknown issue=3190 action=closed');
  });

  it('clean, no open Issue: does nothing — the opencode skip alone is not inconclusive', async () => {
    const code = await run({ output: withOpencodeSkip(fixture('check-clean-known-warning.txt')), open: [] });
    expect(code).toBe(0);
    expect(ghWrites()).toEqual([]);
    expect(lastLine()).toContain('status=clean');
    expect(lastLine()).toContain('action=none');
    expect(record().ignoredWarnings).toHaveLength(2);
  });

  it('inconclusive: touches no Issue and puts the reason in the record and the line', async () => {
    const code = await run({ output: withOpencodeSkip(fixture('check-source-down.txt')), open: [kewton(3190)] });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(lastLine()).toMatch(/status=inconclusive .* issue=none action=none reason=".*source-warning:http 503/);
    expect(record().reason).toContain('codex enum parsed to zero commands');
  });

  it('a crashed runner is inconclusive (exit 0), a runner that could not start is exit 2', async () => {
    expect(await run({ output: fixture('check-runner-crash.txt'), checkStatus: 1 })).toBe(0);
    expect(lastLine()).toContain('status=inconclusive');
    expect(lastLine()).toContain('runner-exit-code:1');
    expect(await run({ output: '', checkStatus: null })).toBe(2);
    expect(lastLine()).toContain('を実行できなかった');
  });
});

describe('catalog-check main — versions', () => {
  it('a version gap alone stays clean and shows in the line, excluding opencode 1.x', async () => {
    writeReport([
      { tool: 'claude', version: '2.1.288 (Claude Code)' },
      { tool: 'codex', version: 'codex-cli 0.159.3' },
      { tool: 'opencode', version: '1.18.34' },
    ]);
    await run({ output: withOpencodeSkip(fixture('check-clean.txt')), open: [] });
    expect(ghWrites()).toEqual([]);
    expect(lastLine()).toBe(
      `AGENT_HEALTH_CATALOG date=${DATE} status=clean new=0 attestation_drift=0 version_gaps=claude:2.1.283->2.1.288 issue=none action=none`
    );
    expect(record().versionGaps).toEqual([{ tool: 'claude', attested: '2.1.283', local: '2.1.288' }]);
  });
});

describe('catalog-check main — failures and --dry-run', () => {
  it('--dry-run lists but neither writes to GitHub nor records', async () => {
    const code = await run({ output: withOpencodeSkip(fixture('check-drift-2026-08-06.txt')), open: [] }, ['--dry-run']);
    expect(code).toBe(0);
    expect(ghWrites()).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(lastLine()).toBe(
      `DRY_RUN AGENT_HEALTH_CATALOG date=${DATE} status=drift new=3 attestation_drift=0 version_gaps=unknown issue=none action=none dry_run=would-create`
    );
  });

  it('exit 1 when gh cannot list, create, or the record cannot be written', async () => {
    expect(await run({ output: withOpencodeSkip(fixture('check-drift-2026-08-06.txt')), open: null })).toBe(1);
    expect(lastLine()).toContain('action=none reason=');
    expect(await run({ output: withOpencodeSkip(fixture('check-drift-2026-08-06.txt')), open: [], ghWrite: 1 })).toBe(1);
    expect(lastLine()).toContain('Issue を作れなかった');
    expect(await run({ output: withOpencodeSkip(fixture('check-clean.txt')), open: [], writeFails: true })).toBe(1);
  });

  it('exit 2 on an unknown argument (no --write here)', async () => {
    expect(await run({ output: '' }, ['--write'])).toBe(2);
  });
});

describe('catalog-check main — read only', () => {
  it('leaves `git status --porcelain` of the repository unchanged', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    git('init', '-q');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
    const before = git('status', '--porcelain');
    for (const output of ['check-drift-2026-08-06.txt', 'check-clean.txt', 'check-source-down.txt']) {
      await run({ output: withOpencodeSkip(fixture(output)), open: [kewton(3190)] });
      await run({ output: withOpencodeSkip(fixture(output)), open: [] }, ['--dry-run']);
    }
    expect(git('status', '--porcelain')).toBe(before);
    expect(before).toBe('');
    expect(fs.existsSync(recordFile())).toBe(true);
  });
});
