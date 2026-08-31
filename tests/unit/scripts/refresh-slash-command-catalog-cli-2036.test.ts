/**
 * `scripts/refresh-slash-command-catalog.ts --opencode-port` end to end (Issue #2036)
 *
 * `runner-args.test.ts` pins the parsing; this file pins the part only a real
 * invocation can show — that the flag is in `--help`, that a malformed port
 * stops the run instead of quietly degrading it, and that a port on the command
 * line becomes an actual `GET /command` request to loopback.
 *
 * ## Why there is no opencode here
 *
 * The endpoint is the contract, not the process behind it. Standing up a real
 * opencode server on the developer's machine would create sessions, occupy a
 * port the operator did not choose, and make the verdict depend on a build of
 * someone else's CLI. So the server is a five-line `http.createServer` stub that
 * answers the 1.18.22 body shape measured in
 * `docs/design/opencode-server-live-verification.md` §12. What is being proven
 * is the wiring the Issue found missing, and the wiring ends at the socket.
 *
 * The stub runs in THIS process, so the run that talks to it uses async `spawn`
 * rather than `spawnSync` — a synchronous child blocks the event loop the
 * server needs to answer on. The two runs that need no server use `spawnSync`,
 * which is also what puts this file in the Issue #1950 real-subprocess budget
 * family (tests/setup.ts reads the markers off the source).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const SCRIPT = path.join(REPO_ROOT, 'scripts/refresh-slash-command-catalog.ts');

/** The three files a `--write` may touch. `--check` must leave all three alone. */
const WRITABLE_FILES = [
  'src/config/slash-commands-catalog.json',
  'locales/en/worktree.json',
  'locales/ja/worktree.json',
];

/** Plus the one file NO mode may ever touch (Issue #2026: human-only). */
const ATTESTATIONS_FILE = 'src/config/slash-commands-attestations.json';

function snapshot(files: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')])
  );
}

/** Every remote source off, so a run's only possible network peer is the stub. */
const OFFLINE = ['--check', '--skip-claude', '--skip-codex', '--skip-antigravity'];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSync(args: string[]): RunResult {
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  });
  assertSubprocessCompleted(result, `refresh-slash-command-catalog ${args.join(' ')}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SCRIPT, ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`refresh-slash-command-catalog ${args.join(' ')} exceeded its guard`));
    }, REAL_SHELL_SUBPROCESS_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(guard);
      resolve({ status, stdout, stderr });
    });
  });
}

describe('--help (Issue #2036)', () => {
  it('exits 0 and documents --opencode-port', () => {
    const result = runSync(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--opencode-port <port>');
    expect(result.stdout).toContain('http://127.0.0.1:<port>');
    // The report itself must NOT be produced: --help does no work.
    expect(result.stdout).not.toContain('Slash-command catalog reconcile');
  });

  it('answers -h the same way', () => {
    expect(runSync(['-h']).stdout).toContain('--opencode-port');
  });
});

describe('a malformed --opencode-port stops the run (Issue #2036)', () => {
  it('exits 2 with the flag named and the value echoed', () => {
    const before = snapshot([...WRITABLE_FILES, ATTESTATIONS_FILE]);
    // `--write` on purpose: the usage check has to happen before any file is
    // opened, or a typo'd port would still rewrite the catalog from the other
    // three providers under a report claiming opencode was consulted.
    const result = runSync(['--write', '--opencode-port', 'banana']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--opencode-port expects an integer TCP port in 1-65535');
    expect(result.stderr).toContain('"banana"');
    expect(result.stdout).not.toContain('Slash-command catalog reconcile');
    expect(snapshot([...WRITABLE_FILES, ATTESTATIONS_FILE])).toEqual(before);
  });

  it('rejects 0 and 65536, the two off-by-ones a range check is for', () => {
    for (const port of ['0', '65536']) {
      const result = runSync(['--opencode-port', port]);
      expect(result.status, port).toBe(2);
    }
  });

  it('rejects the flag typed with nothing after it', () => {
    const result = runSync(['--opencode-port']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('requires a port number');
  });
});

describe('without the flag the run is what the weekly workflow already sees', () => {
  it('reports opencode as skipped and writes nothing', () => {
    const before = snapshot([...WRITABLE_FILES, ATTESTATIONS_FILE]);
    const result = runSync(OFFLINE);

    expect(result.status).toBe(0);
    // Verbatim the `source-warning:` line .github/workflows/catalog-drift.yml
    // acts on. Issue #2036 must not change it: the workflow passes no port.
    expect(result.stdout).toContain(
      '! opencode provider skipped: no loopback port given'
    );
    // The report shape check-report.ts parses is intact.
    expect(result.stdout).toContain('Slash-command catalog reconcile');
    expect(result.stdout).toContain('(check mode');
    expect(snapshot([...WRITABLE_FILES, ATTESTATIONS_FILE])).toEqual(before);
  });
});

describe('--opencode-port reaches loopback (Issue #2036)', () => {
  let server: http.Server;
  let port: number;
  const requested: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requested.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          // A name the shipped catalog cannot already carry, so its arrival in
          // the report is proof the body was read rather than a coincidence.
          {
            name: 'cm-2036-probe',
            description: 'Issue 2036 loopback probe command',
            source: 'command',
            hints: [],
          },
          // Dropped by the provider: a Skill is a per-project file (#1503).
          { name: 'cm-2036-skill', description: 'a Skill', source: 'skill', hints: [] },
        ])
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches GET /command and folds the answer into the report', async () => {
    const before = snapshot([...WRITABLE_FILES, ATTESTATIONS_FILE]);
    const result = await runAsync([...OFFLINE, '--opencode-port', String(port)]);

    expect(result.status).toBe(0);
    expect(requested).toContain('GET /command');
    // The warning the Issue quoted is gone — the socket the types described has
    // something plugged into it now.
    expect(result.stdout).not.toContain('no loopback port given');
    expect(result.stdout).toContain('+ [opencode] /cm-2036-probe');
    expect(result.stdout).not.toContain('cm-2036-skill');
    // `--check` still writes nothing, the flag notwithstanding.
    expect(snapshot([...WRITABLE_FILES, ATTESTATIONS_FILE])).toEqual(before);
  });
});
