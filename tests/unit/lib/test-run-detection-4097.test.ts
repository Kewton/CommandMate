/**
 * One rule for "is this a test run", used by all three places that ask
 * (Issue #4097).
 *
 * `getDbInstance`'s guard moved to "inside a Vitest worker, or `NODE_ENV=test`"
 * in #4086, while the cost sampler and the session archive kept reading `VITEST`.
 * The daemon hands its environment to the server it starts, so a production
 * server launched from a shell where `VITEST` was left behind opened its real
 * database and then silently stopped saving costs and retiring old sessions.
 *
 * The positive cases are real child processes because nothing inside a Vitest
 * worker can be outside a Vitest worker. Their databases sit under the
 * worktree's gitignored `data/`, since `validateDbPath` rejects every temp dir;
 * the children get a built-from-nothing environment, so the calling shell's
 * `CM_DB_PATH` never reaches them.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const detection = vi.hoisted(() => ({ underTest: undefined as boolean | undefined }));

// A pass-through until a test sets `detection.underTest`: that is the one way a
// test reaches a production branch.
vi.mock('@/lib/test-run-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/test-run-detection')>();
  return {
    ...actual,
    isUnderTest: (...args: Parameters<typeof actual.isUnderTest>) =>
      detection.underTest ?? actual.isUnderTest(...args),
  };
});

import { runMigrations } from '@/lib/db/db-migrations';
import {
  startAgentSessionCostSampler,
  stopAgentSessionCostSampler,
} from '@/lib/db/agent-session-cost-sampler';
import { isInsideVitestWorker as reexported } from '@/lib/db/db-instance';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const src = (relative: string): string => JSON.stringify(path.join(REPO_ROOT, 'src', relative));

let sandbox: string;
let probeDir: string;
let dbPath: string;

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-run-4097-')));
  fs.mkdirSync(path.join(sandbox, 'home'));
  probeDir = path.join(REPO_ROOT, 'data', `prod-probe-4097-${path.basename(sandbox)}`);
  dbPath = path.join(probeDir, 'db.sqlite');
  detection.underTest = undefined;
});

afterEach(() => {
  stopAgentSessionCostSampler();
  vi.unstubAllEnvs();
  detection.underTest = undefined;
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Built from nothing, so a variable of the calling shell cannot reach a child. */
type ChildEnv = Record<string, string | undefined>;

function runProcess(
  command: string,
  args: string[],
  env: ChildEnv,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/** Runs a script with tsx and returns what it printed on its `REPORT ` line. */
async function runChild<T>(body: string[], env: ChildEnv): Promise<T> {
  const script = path.join(sandbox, `child-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(script, [...body, ''].join('\n'));
  const { code, out, err } = await runProcess(TSX, [script], env);
  const line = out.split('\n').find((l) => l.startsWith('REPORT '));
  if (code !== 0 || !line) {
    throw new Error(`child exited ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  }
  return JSON.parse(line.slice('REPORT '.length)) as T;
}

function childEnv(overrides: ChildEnv): ChildEnv {
  return {
    PATH: process.env.PATH,
    HOME: path.join(sandbox, 'home'),
    TMPDIR: sandbox,
    CM_DB_PATH: dbPath,
    ...overrides,
  };
}

/** `VITEST` left behind in the shell, production server: the reported environment. */
const inheritedProduction = (): ChildEnv =>
  childEnv({ VITEST: 'true', VITEST_POOL_ID: '1', NODE_ENV: 'production' });

/** A test's own child: guarded, so its database has to be under the owned root. */
const testChild = (overrides: ChildEnv = {}): ChildEnv =>
  childEnv({ NODE_ENV: 'test', CM_TEST_DB_ROOT: probeDir, ...overrides });

/** Reads what the child left on disk, after it has exited. */
function readDb<T>(sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

describe('[#4097] the rule', () => {
  it('outside a worker: NODE_ENV=test only; VITEST alone never counts', async () => {
    const { isUnderTest } = await vi.importActual<typeof import('@/lib/test-run-detection')>(
      '@/lib/test-run-detection',
    );
    const outside = (env: Record<string, string>): boolean => isUnderTest(env, false);

    expect(outside({})).toBe(false);
    expect(outside({ NODE_ENV: 'production' })).toBe(false);
    expect(outside({ NODE_ENV: 'development' })).toBe(false);
    expect(outside({ VITEST: 'true' })).toBe(false);
    expect(outside({ VITEST: 'true', NODE_ENV: 'production' })).toBe(false);
    expect(outside({ NODE_ENV: 'test' })).toBe(true);
    expect(outside({ NODE_ENV: ' test ' })).toBe(true);
  });

  it('inside a worker: always, whatever the environment says', async () => {
    const { isUnderTest } = await vi.importActual<typeof import('@/lib/test-run-detection')>(
      '@/lib/test-run-detection',
    );
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);

    expect(isUnderTest()).toBe(true);
    for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'development' }]) {
      expect(isUnderTest(env, true)).toBe(true);
    }
  });

  it('db-instance still exports the same isInsideVitestWorker', async () => {
    const actual = await vi.importActual<typeof import('@/lib/test-run-detection')>(
      '@/lib/test-run-detection',
    );
    expect(reexported).toBe(actual.isInsideVitestWorker);
  });

  it('nothing else under src/ judges a test run on its own', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf-8');
          if (/__vitest_worker__|env\.VITEST\b|NODE_ENV\s*[!=]==\s*['"]test['"]/.test(text)) {
            offenders.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));

    expect(offenders).toEqual(['src/lib/test-run-detection.ts']);
  });
});

describe.each(['forks', 'threads'] as const)('[#4097] a real Vitest worker in the %s pool', (pool) => {
  it('is judged a test run, also after the test drops VITEST and swaps NODE_ENV', async () => {
    const reportPath = path.join(sandbox, 'report.json');
    fs.writeFileSync(
      path.join(sandbox, 'vitest.config.mjs'),
      `export default { cacheDir: ${JSON.stringify(path.join(sandbox, 'cache'))}, test: { globals: true, include: ['probe.test.ts'] } };\n`,
    );
    fs.writeFileSync(
      path.join(sandbox, 'probe.test.ts'),
      [
        "import fs from 'node:fs';",
        "import { isMainThread } from 'node:worker_threads';",
        `import { isInsideVitestWorker, isUnderTest } from ${src('lib/test-run-detection.ts')};`,
        "it('probe', () => {",
        '  const env = process.env as Record<string, string | undefined>;',
        "  env.NODE_ENV = 'production';",
        '  delete env.VITEST;',
        '  fs.writeFileSync(',
        `    ${JSON.stringify(reportPath)},`,
        '    JSON.stringify({ isMainThread, worker: isInsideVitestWorker(), underTest: isUnderTest(), vitestEnv: env.VITEST ?? null }),',
        '  );',
        '});',
        '',
      ].join('\n'),
    );

    const { code, out, err } = await runProcess(
      path.join(REPO_ROOT, 'node_modules', '.bin', 'vitest'),
      ['run', '--root', sandbox, '--config', path.join(sandbox, 'vitest.config.mjs'), `--pool=${pool}`],
      { PATH: process.env.PATH, HOME: path.join(sandbox, 'home'), TMPDIR: sandbox },
    );
    expect(code, `nested vitest\nstdout:\n${out}\nstderr:\n${err}`).toBe(0);

    expect(JSON.parse(fs.readFileSync(reportPath, 'utf-8'))).toEqual({
      // Proves the pool really is the one named: a fork's main thread, or a thread.
      isMainThread: pool === 'forks',
      worker: true,
      underTest: true,
      vitestEnv: null,
    });
  }, 120_000);
});

describe('[#4097] the sampler asks the common rule', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('starts when the rule says this is not a test run', () => {
    detection.underTest = false;

    expect(startAgentSessionCostSampler(db)).toBe(true);
  });

  it('stays off in a real worker with NODE_ENV swapped and VITEST gone', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);

    expect(startAgentSessionCostSampler(db)).toBe(false);
    expect(globalThis.__agentSessionCostSampler).toBeUndefined();
  });
});

interface SamplerReport {
  marker: boolean;
  started: boolean;
}

/**
 * The real `getDbInstance()` starts the sampler; only the minute-long interval
 * is shortened, so a tick lands within the test. The child waits for a row, or
 * for `SETTLE_MS` when no timer started.
 */
function samplerChild(): string[] {
  return [
    `import { getDbInstance, closeDbInstance, isInsideVitestWorker } from ${src('lib/db/db-instance.ts')};`,
    `import { AGENT_SESSION_COST_SAMPLE_INTERVAL_MS } from ${src('lib/db/agent-session-cost-sampler.ts')};`,
    `import { recordAgentSessionTelemetry } from ${src('lib/hooks/agent-session-telemetry.ts')};`,
    'const SETTLE_MS = 300;',
    'const realSetInterval = globalThis.setInterval;',
    '(globalThis as any).setInterval = (fn: () => void, ms: number) =>',
    '  realSetInterval(fn, ms === AGENT_SESSION_COST_SAMPLE_INTERVAL_MS ? 20 : ms);',
    'const db = getDbInstance();',
    "db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run('wt-4097', 'wt-4097', '/repos/wt-4097', Date.now());",
    "recordAgentSessionTelemetry({ worktreeId: 'wt-4097', cliToolId: 'opencode' }, {",
    "  id: 'ses_4097', title: 'probe', agent: 'plan', model: 'm', provider: 'p', cost: 0.25,",
    '  tokens: { input: 3, output: 174, reasoning: 0, cacheRead: 1, cacheWrite: 2, total: null },',
    '  at: Date.now(),',
    '} as any);',
    'const started = globalThis.__agentSessionCostSampler !== undefined;',
    'const count = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_session_costs").get() as { n: number }).n;',
    'const deadline = Date.now() + (started ? 30_000 : SETTLE_MS);',
    // tsx loads this as CommonJS, so no top-level await. The timer is unref()d:
    // this ref'd poll is what keeps the process alive for the tick.
    'const poll = setTimeout(function check() {',
    '  if (count() === 0 && Date.now() < deadline) { poll.refresh(); return; }',
    '  closeDbInstance();',
    '  console.log(`REPORT ${JSON.stringify({ marker: isInsideVitestWorker(), started })}`);',
    '}, 20);',
  ];
}

interface ArchiveRow {
  instance_id: string;
  content: string;
  archived: number;
}

/** The session change itself: the real `beginAgentSession`, no database handed in. */
function archiveChild(): string[] {
  return [
    `import { getDbInstance, closeDbInstance, isInsideVitestWorker } from ${src('lib/db/db-instance.ts')};`,
    `import { createMessage, upsertWorktree } from ${src('lib/db/index.ts')};`,
    `import { beginAgentSession } from ${src('lib/session/agent-session-lifecycle.ts')};`,
    'const db = getDbInstance();',
    "const WT = 'wt-4097';",
    "upsertWorktree(db, { id: WT, name: WT, path: '/repos/wt', repositoryPath: '/repos', repositoryName: 'repos', cliToolId: 'codex' });",
    'const seed = (content: string, instanceId: string, at: number) => createMessage(db, {',
    "  worktreeId: WT, role: 'user', content, timestamp: new Date(at), messageType: 'normal', cliToolId: 'codex', instanceId,",
    '});',
    "seed('old codex', 'codex', 1000);",
    "seed('live codex-2', 'codex-2', 2000);",
    "beginAgentSession({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' });",
    'closeDbInstance();',
    'console.log(`REPORT ${JSON.stringify({ marker: isInsideVitestWorker() })}`);',
    // The invalidate frame is detached and has no listener in this process.
    'process.exit(0);',
  ];
}

const ROWS_SQL = 'SELECT instance_id, content, archived FROM chat_messages ORDER BY instance_id';

describe('[#4097] a production child process that inherited VITEST', () => {
  it('starts the sampler and saves the sampled cost', async () => {
    const report = await runChild<SamplerReport>(samplerChild(), inheritedProduction());

    expect(report).toEqual({ marker: false, started: true });
    expect(
      readDb<{ session_id: string; worktree_id: string; cost: number }>(
        'SELECT session_id, worktree_id, cost FROM agent_session_costs',
      ),
    ).toEqual([{ session_id: 'ses_4097', worktree_id: 'wt-4097', cost: 0.25 }]);
  }, 120_000);

  it('archives the replaced instance on a session change and leaves the sibling', async () => {
    const report = await runChild<{ marker: boolean }>(archiveChild(), inheritedProduction());

    expect(report.marker).toBe(false);
    expect(readDb<ArchiveRow>(ROWS_SQL)).toEqual([
      { instance_id: 'codex', content: 'old codex', archived: 1 },
      { instance_id: 'codex-2', content: 'live codex-2', archived: 0 },
    ]);
  }, 120_000);
});

describe.each([
  ['NODE_ENV=test', {}],
  ['NODE_ENV=test with VITEST', { VITEST: 'true' }],
] as const)('[#4097] a child outside the worker with %s', (_label, overrides) => {
  it('does not start the sampler', async () => {
    const report = await runChild<SamplerReport>(samplerChild(), testChild(overrides));

    expect(report).toEqual({ marker: false, started: false });
    expect(readDb('SELECT session_id FROM agent_session_costs')).toEqual([]);
  }, 120_000);

  it('does not reach for the implicit database on a session change', async () => {
    const report = await runChild<{ marker: boolean }>(archiveChild(), testChild(overrides));

    expect(report.marker).toBe(false);
    expect(readDb<ArchiveRow>(ROWS_SQL).map((row) => row.archived)).toEqual([0, 0]);
  }, 120_000);
});
