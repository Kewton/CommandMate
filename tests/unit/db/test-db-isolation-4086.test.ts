/**
 * Issue #4086: the suite must never open the database the calling shell names.
 *
 * A worker's tmux session inherits the server's `CM_DB_PATH=<production db>`,
 * and a test that reached the real `getDbInstance()` opened that file, set WAL
 * and ran this checkout's migrations on it (production went to v63 under a v62
 * server). These tests stand a fake "protected" database up in a temp
 * directory and watch the open function: it must never be handed that path.
 * The real production database is never touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const openSpy = vi.hoisted(() => ({ calls: [] as string[], throwOnOpen: false }));

// The stand-in "protected" databases live under os.tmpdir(), which the real
// validateDbPath rejects as a system directory (/var, /tmp). The real
// production path is not under one, so it passes validation and reaches the
// open — which is the incident. To reproduce that faithfully with a temp
// stand-in, validation is a pass-through here; the setup path is checked
// against the real validator separately below.
vi.mock('@/lib/db/db-path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/db-path-resolver')>();
  return { ...actual, validateDbPath: (p: string) => path.resolve(p) };
});

vi.mock('@/lib/db/abi-recovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/abi-recovery')>();
  return {
    ...actual,
    openDatabaseWithAbiRecovery: (dbPath: string) => {
      openSpy.calls.push(path.resolve(dbPath));
      if (openSpy.throwOnOpen) throw new Error(`[4086 probe] would have opened ${dbPath}`);
      return actual.openDatabaseWithAbiRecovery(dbPath);
    },
  };
});

import {
  getDbInstance,
  closeDbInstance,
  assertTestDatabasePathIsolated,
  isInsideVitestWorker,
} from '@/lib/db/db-instance';
import { getDefaultDbPath } from '@/lib/db/db-path-resolver';
import { CURRENT_SCHEMA_VERSION } from '@/lib/db/migrations/runner';
import {
  DEFAULT_TEST_DB_ROOT,
  TEST_DB_ENV_KEYS,
  TEST_DB_ROOT_ENV,
  closeOpenTestDatabases,
  isolateTestDatabaseEnv,
  removeTestDatabaseDir,
  testDatabaseLocationFor,
} from '@tests/helpers/test-db-isolation';

const REPO_ROOT = path.resolve(__dirname, '../../..');

let sandbox: string;

/** A stand-in for the production database: a real sqlite file with a marker. */
function makeProtectedDb(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.exec("CREATE TABLE protected_marker (v TEXT); INSERT INTO protected_marker VALUES ('do-not-touch');");
  db.close();
  return hashFile(filePath);
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function expectUntouched(filePath: string, hash: string): void {
  expect(openSpy.calls).not.toContain(path.resolve(filePath));
  expect(hashFile(filePath)).toBe(hash);
  expect(fs.existsSync(`${filePath}-wal`)).toBe(false);
  expect(fs.existsSync(`${filePath}-shm`)).toBe(false);
}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-db-4086-')));
  openSpy.calls = [];
  openSpy.throwOnOpen = false;
});

afterEach(() => {
  closeDbInstance();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('[#4086] tests/setup.ts points this process at its own temp database', () => {
  it('CM_DB_PATH is the per-pid test path and the deprecated aliases are gone', () => {
    expect(process.env.CM_DB_PATH).toBe(testDatabaseLocationFor(process.pid).dbPath);
    expect(process.env.CM_DB_PATH).toBe(
      path.join(REPO_ROOT, 'data', 'test-db', `${process.pid}-w${process.env.VITEST_POOL_ID}`, 'cm.db')
    );
    expect(process.env[TEST_DB_ROOT_ENV]).toBe(DEFAULT_TEST_DB_ROOT);
    expect(process.env.MCBD_DB_PATH).toBeUndefined();
    expect(process.env.DATABASE_PATH).toBeUndefined();
  });

  it('the setup path passes the real validateDbPath (a temp-dir path would not)', async () => {
    const actual = await vi.importActual<typeof import('@/lib/db/db-path-resolver')>(
      '@/lib/db/db-path-resolver'
    );
    expect(actual.validateDbPath(process.env.CM_DB_PATH!)).toBe(process.env.CM_DB_PATH);
    // Why the setup path is not under os.tmpdir(): every test that calls the
    // real getEnv() would throw `Invalid CM_DB_PATH`.
    expect(() => actual.validateDbPath(path.join(os.tmpdir(), 'cm.db'))).toThrow(/system directory/);
  });
});

describe('[#4086] an inherited database variable never reaches the open function', () => {
  it('control: without the isolation, the inherited CM_DB_PATH is what gets opened', () => {
    const protectedPath = path.join(sandbox, 'prod', 'db.sqlite');
    makeProtectedDb(protectedPath);
    vi.stubEnv('CM_DB_PATH', protectedPath);

    getDbInstance();

    // Proves the spy sees the path: this is the 2026-11-01 incident in miniature.
    expect(openSpy.calls).toEqual([protectedPath]);
  });

  const combos: Array<ReadonlyArray<(typeof TEST_DB_ENV_KEYS)[number]>> = [
    ['CM_DB_PATH'],
    ['MCBD_DB_PATH'],
    ['DATABASE_PATH'],
    ['CM_DB_PATH', 'MCBD_DB_PATH'],
    ['CM_DB_PATH', 'DATABASE_PATH'],
    ['MCBD_DB_PATH', 'DATABASE_PATH'],
    ['CM_DB_PATH', 'MCBD_DB_PATH', 'DATABASE_PATH'],
  ];

  it.each(combos.map((keys) => [keys.join(' + '), keys] as const))(
    '%s set to the protected database',
    (_label, keys) => {
      const protectedPath = path.join(sandbox, 'prod', 'db.sqlite');
      const hash = makeProtectedDb(protectedPath);
      for (const key of TEST_DB_ENV_KEYS) vi.stubEnv(key, undefined);
      for (const key of keys) vi.stubEnv(key, protectedPath);

      const location = isolateTestDatabaseEnv(process.env, { root: sandbox });
      getDbInstance();

      expect(openSpy.calls).toEqual([location.dbPath]);
      expectUntouched(protectedPath, hash);
    }
  );
});

describe('[#4086] with no database variable, the install default is not used', () => {
  it('the HOME and cwd defaults are left alone and the temp database is opened', () => {
    const home = path.join(sandbox, 'home');
    const cwd = path.join(sandbox, 'cwd');
    const homeDefault = path.join(home, '.commandmate', 'data', 'cm.db');
    const cwdDefault = path.join(cwd, 'data', 'cm.db');
    const homeHash = makeProtectedDb(homeDefault);
    const cwdHash = makeProtectedDb(cwdDefault);
    for (const key of TEST_DB_ENV_KEYS) vi.stubEnv(key, undefined);
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    // Control: the resolver really would answer one of the fake defaults here.
    expect([homeDefault, cwdDefault]).toContain(getDefaultDbPath());

    const location = isolateTestDatabaseEnv(process.env, { root: path.join(sandbox, 'tmp') });
    getDbInstance();

    expect(openSpy.calls).toEqual([location.dbPath]);
    expectUntouched(homeDefault, homeHash);
    expectUntouched(cwdDefault, cwdHash);
  });
});

describe('[#4086] getDbInstance refuses a non-temp path under Vitest', () => {
  it('throws before opening (and before WAL / migrations) for a path outside the temp dir', () => {
    openSpy.throwOnOpen = true;
    // The directory exists, so a missing guard would not even mkdir anything;
    // the open itself is replaced by a throwing probe.
    const outside = path.join(REPO_ROOT, 'cm-4086-guard-probe.db');
    vi.stubEnv('CM_DB_PATH', outside);

    expect(() => getDbInstance()).toThrow(/outside the temp directory/);
    expect(openSpy.calls).toEqual([]);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('negative control: a test-chosen temp database other than the setup one still migrates', () => {
    const explicit = path.join(sandbox, 'explicit', 'other.db');
    vi.stubEnv('CM_DB_PATH', explicit);

    const db = getDbInstance();

    expect(openSpy.calls).toEqual([explicit]);
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('accepts the setup root named by CM_TEST_DB_ROOT, rejects its siblings', () => {
    const root = path.join(REPO_ROOT, 'data', 'test-db');
    const env = { VITEST: 'true', [TEST_DB_ROOT_ENV]: root };
    expect(() => assertTestDatabasePathIsolated(path.join(root, '123', 'cm.db'), env)).not.toThrow();
    expect(() =>
      assertTestDatabasePathIsolated(path.join(REPO_ROOT, 'data', 'cm.db'), env)
    ).toThrow(/outside the temp directory/);
    expect(() =>
      assertTestDatabasePathIsolated(path.join(REPO_ROOT, 'data', 'test-db-other', 'cm.db'), env)
    ).toThrow(/outside the temp directory/);
  });

  it('accepts both the literal and the physical form of the temp dir, rejects ../ escapes', () => {
    const literal = path.join(os.tmpdir(), 'x', 'cm.db');
    const physical = path.join(fs.realpathSync(os.tmpdir()), 'x', 'cm.db');
    const env = { VITEST: 'true' };
    expect(() => assertTestDatabasePathIsolated(literal, env)).not.toThrow();
    expect(() => assertTestDatabasePathIsolated(physical, env)).not.toThrow();
    expect(() =>
      assertTestDatabasePathIsolated(path.join(os.tmpdir(), '..', 'escape', 'cm.db'), env)
    ).toThrow(/outside the temp directory/);
  });

  it('outside Vitest: active only with NODE_ENV=test; VITEST alone does not count', () => {
    const prod = path.join(REPO_ROOT, 'data', 'db.sqlite');
    const outside = (env: Record<string, string>) =>
      () => assertTestDatabasePathIsolated(prod, env, os.tmpdir(), false);
    expect(outside({ NODE_ENV: 'production' })).not.toThrow();
    expect(outside({ NODE_ENV: 'development' })).not.toThrow();
    expect(outside({ VITEST: 'true' })).not.toThrow();
    expect(outside({ VITEST: 'true', NODE_ENV: 'production' })).not.toThrow();
    expect(outside({ NODE_ENV: 'test' })).toThrow(/outside the temp directory/);
  });

  it('inside the Vitest worker the marker is present and decides, not the environment', () => {
    expect(isInsideVitestWorker()).toBe(true);
    const prod = path.join(REPO_ROOT, 'data', 'db.sqlite');
    for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development' }, {}]) {
      expect(() => assertTestDatabasePathIsolated(prod, env)).toThrow(/outside the temp directory/);
    }
  });

  it('a test that swaps NODE_ENV to production (and drops VITEST) is still guarded', () => {
    openSpy.throwOnOpen = true;
    const outside = path.join(REPO_ROOT, 'cm-4086-production-probe.db');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('CM_DB_PATH', outside);

    expect(() => getDbInstance()).toThrow(/outside the temp directory/);
    expect(openSpy.calls).toEqual([]);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('a connection opened while NODE_ENV is swapped to production is still handed to the closer', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CM_DB_PATH', path.join(sandbox, 'swapped', 'cm.db'));
    closeOpenTestDatabases();

    const db = getDbInstance();
    expect(globalThis.__commandmateTestDbClosers?.size).toBe(1);
    closeOpenTestDatabases();

    expect(db.open).toBe(false);
  });

  it('a production child process outside Vitest that inherited VITEST opens its real path; NODE_ENV=test is refused', async () => {
    // Not under the temp dir nor CM_TEST_DB_ROOT, so only the on-switch decides.
    const probeDir = path.join(REPO_ROOT, 'data', `prod-probe-4086-${path.basename(sandbox)}`);
    const dbPath = path.join(probeDir, 'db.sqlite');
    const script = path.join(sandbox, 'prod-child.ts');
    fs.writeFileSync(
      script,
      [
        `import { getDbInstance, closeDbInstance, isInsideVitestWorker } from ${JSON.stringify(path.join(REPO_ROOT, 'src/lib/db/db-instance.ts'))};`,
        'let opened = false; let error = "";',
        'try { getDbInstance(); opened = true; closeDbInstance(); } catch (e) { error = String(e); }',
        'console.log(`REPORT ${JSON.stringify({ marker: isInsideVitestWorker(), opened, error })}`);',
        '',
      ].join('\n')
    );
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = (nodeEnv: 'production' | 'test'): NodeJS.ProcessEnv => ({
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: sandbox,
      VITEST: 'true',
      VITEST_POOL_ID: '1',
      NODE_ENV: nodeEnv,
      CM_DB_PATH: dbPath,
    });
    try {
      const prod = (await runChild(script, env('production'))) as unknown as ProdChildReport;
      expect(prod).toEqual({ marker: false, opened: true, error: '' });
      expect(fs.existsSync(dbPath)).toBe(true);
      fs.rmSync(probeDir, { recursive: true, force: true });

      const test = (await runChild(script, env('test'))) as unknown as ProdChildReport;
      expect(test.marker).toBe(false);
      expect(test.opened).toBe(false);
      expect(test.error).toMatch(/outside the temp directory/);
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }, 120_000);
});

interface ProdChildReport {
  marker: boolean;
  opened: boolean;
  error: string;
}

describe('[#4086] connections are closed and temp files removed at the end', () => {
  it('closeOpenTestDatabases closes what getDbInstance opened; the dir can then be removed', () => {
    const location = isolateTestDatabaseEnv(process.env, { root: sandbox });
    const db = getDbInstance();
    expect(fs.existsSync(location.dbPath)).toBe(true);

    closeOpenTestDatabases();
    removeTestDatabaseDir(location.dir);

    expect(db.open).toBe(false);
    expect(fs.existsSync(location.dir)).toBe(false);
  });
});

interface ChildReport {
  pid: number;
  dbPath: string;
  version: number;
  openAfterClose: boolean;
  dirExistsAfterCleanup: boolean;
}

function runChild(script: string, env: NodeJS.ProcessEnv): Promise<ChildReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [script], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('REPORT '));
      if (code !== 0 || !line) {
        reject(new Error(`child exited ${code}\nstdout:\n${out}\nstderr:\n${err}`));
        return;
      }
      resolve(JSON.parse(line.slice('REPORT '.length)) as ChildReport);
    });
  });
}

describe('[#4086] two test processes in parallel', () => {
  it('each uses its own database, closes it and removes it', async () => {
    const tmpRoot = path.join(sandbox, 'tmp');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const protectedPath = path.join(sandbox, 'prod', 'db.sqlite');
    const hash = makeProtectedDb(protectedPath);

    const script = path.join(sandbox, 'child.ts');
    fs.writeFileSync(
      script,
      [
        "import fs from 'node:fs';",
        `import { isolateTestDatabaseEnv, closeOpenTestDatabases, removeTestDatabaseDir } from ${JSON.stringify(path.join(REPO_ROOT, 'tests/helpers/test-db-isolation.ts'))};`,
        // getEnv() is read when getDbInstance() runs, not at import time.
        `import { getDbInstance } from ${JSON.stringify(path.join(REPO_ROOT, 'src/lib/db/db-instance.ts'))};`,
        'const location = isolateTestDatabaseEnv();',
        'const db = getDbInstance();',
        "const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;",
        'closeOpenTestDatabases();',
        'const openAfterClose = db.open;',
        'removeTestDatabaseDir(location.dir);',
        'console.log(`REPORT ${JSON.stringify({ pid: process.pid, dbPath: location.dbPath, version, openAfterClose, dirExistsAfterCleanup: fs.existsSync(location.dir) })}`);',
        '',
      ].join('\n')
    );

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: tmpRoot,
      VITEST: 'true',
      NODE_ENV: 'test',
      CM_DB_PATH: protectedPath,
      MCBD_DB_PATH: protectedPath,
      DATABASE_PATH: protectedPath,
    };
    const [a, b] = await Promise.all([runChild(script, env), runChild(script, env)]);

    expect(a.pid).not.toBe(b.pid);
    expect(a.dbPath).not.toBe(b.dbPath);
    for (const report of [a, b]) {
      // The children are not Vitest workers (no VITEST_POOL_ID): pid only.
      expect(report.dbPath).toBe(testDatabaseLocationFor(report.pid, DEFAULT_TEST_DB_ROOT, null).dbPath);
      expect(report.version).toBe(CURRENT_SCHEMA_VERSION);
      expect(report.openAfterClose).toBe(false);
      expect(report.dirExistsAfterCleanup).toBe(false);
    }
    expect(hashFile(protectedPath)).toBe(hash);
    expect(fs.existsSync(`${protectedPath}-wal`)).toBe(false);
  }, 120_000);
});

interface ThreadReport {
  mode: 'distinct' | 'same';
  aPath: string;
  bPath: string;
  bFileExistsAfterACleanup: boolean;
  bRowsAfterACleanup: number | string;
  pids: number[];
}

/**
 * `--pool=threads`: every worker is a thread of one process, so the pid is the
 * same. Two worker threads (one process) each run what tests/setup.ts runs —
 * isolate, getDbInstance, and at the end close + remove — with worker A
 * finishing while worker B still holds its connection.
 */
function runThreads(sandboxDir: string, mode: 'distinct' | 'same'): Promise<ThreadReport> {
  const workerTs = path.join(sandboxDir, `thread-worker-${mode}.ts`);
  const bootCjs = path.join(sandboxDir, `thread-boot-${mode}.cjs`);
  const mainCjs = path.join(sandboxDir, `thread-main-${mode}.cjs`);
  fs.writeFileSync(
    workerTs,
    [
      "import fs from 'node:fs';",
      "import { parentPort } from 'node:worker_threads';",
      `import { isolateTestDatabaseEnv, closeOpenTestDatabases, removeTestDatabaseDir } from ${JSON.stringify(path.join(REPO_ROOT, 'tests/helpers/test-db-isolation.ts'))};`,
      `import { getDbInstance } from ${JSON.stringify(path.join(REPO_ROOT, 'src/lib/db/db-instance.ts'))};`,
      'const location = isolateTestDatabaseEnv();',
      'const db = getDbInstance();',
      "db.exec('CREATE TABLE IF NOT EXISTS t4086 (v TEXT)');",
      "parentPort!.on('message', (m: string) => {",
      "  if (m === 'check') {",
      '    let rows: number | string;',
      "    try { db.prepare('INSERT INTO t4086 VALUES (?)').run('b'); rows = (db.prepare('SELECT COUNT(*) AS n FROM t4086').get() as { n: number }).n; } catch (e) { rows = String(e); }",
      "    parentPort!.postMessage({ type: 'checked', exists: fs.existsSync(location.dbPath), rows });",
      "  } else if (m === 'finish') {",
      '    closeOpenTestDatabases();',
      '    removeTestDatabaseDir(location.dir);',
      "    parentPort!.postMessage({ type: 'finished' });",
      '  }',
      '});',
      "parentPort!.postMessage({ type: 'opened', dbPath: location.dbPath, pid: process.pid });",
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    bootCjs,
    "const { workerData } = require('node:worker_threads');\nrequire(workerData.tsxApi).require(workerData.file, __filename);\n"
  );
  fs.writeFileSync(
    mainCjs,
    `
const { Worker } = require('node:worker_threads');
const [boot, file, tsxApi, mode] = process.argv.slice(2);
const ids = mode === 'same' ? ['1', '1'] : ['1', '2'];
const spawnWorker = (id) => new Worker(boot, { workerData: { tsxApi, file }, env: { ...process.env, VITEST_POOL_ID: id } });
const next = (w, type) => new Promise((resolve, reject) => {
  const onMsg = (m) => { if (m.type === type) { w.off('message', onMsg); resolve(m); } };
  w.on('message', onMsg); w.once('error', reject);
});
(async () => {
  // Opened one after the other (two first-time migrations of one file would
  // just race into SQLITE_BUSY), then alive at the same time.
  const a = spawnWorker(ids[0]);
  const oa = await next(a, 'opened');
  const b = spawnWorker(ids[1]);
  const ob = await next(b, 'opened');
  const workers = [a, b];
  a.postMessage('finish'); await next(a, 'finished');
  b.postMessage('check'); const checked = await next(b, 'checked');
  b.postMessage('finish'); await next(b, 'finished');
  for (const w of workers) await w.terminate();
  console.log('REPORT ' + JSON.stringify({ mode, aPath: oa.dbPath, bPath: ob.dbPath, bFileExistsAfterACleanup: checked.exists, bRowsAfterACleanup: checked.rows, pids: [oa.pid, ob.pid] }));
})().catch((e) => { console.error(e); process.exit(1); });
`
  );
  const tsxApi = require.resolve('tsx/cjs/api', { paths: [REPO_ROOT] });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainCjs, bootCjs, workerTs, tsxApi, mode], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(sandboxDir, 'home'),
        TMPDIR: sandboxDir,
        NODE_ENV: 'test',
        VITEST: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      // A crashed child cannot run its own cleanup; its directories carry its pid.
      for (const entry of fs.existsSync(DEFAULT_TEST_DB_ROOT) ? fs.readdirSync(DEFAULT_TEST_DB_ROOT) : []) {
        if (entry.startsWith(`${child.pid}-w`)) removeTestDatabaseDir(path.join(DEFAULT_TEST_DB_ROOT, entry));
      }
      const line = out.split('\n').find((l) => l.startsWith('REPORT '));
      if (code !== 0 || !line) {
        reject(new Error(`threads child exited ${code}\nstdout:\n${out}\nstderr:\n${err}`));
        return;
      }
      resolve(JSON.parse(line.slice('REPORT '.length)) as ThreadReport);
    });
  });
}

describe('[#4086] two worker threads in one process (--pool=threads: same pid)', () => {
  it('control: with the same worker id they would share one database, and A removes it under B', async () => {
    fs.mkdirSync(path.join(sandbox, 'home'), { recursive: true });
    const report = await runThreads(sandbox, 'same');

    expect(report.pids[0]).toBe(report.pids[1]);
    expect(report.aPath).toBe(report.bPath);
    expect(report.bFileExistsAfterACleanup).toBe(false);
  }, 120_000);

  it('with distinct VITEST_POOL_ID each thread keeps its own database until its own end', async () => {
    fs.mkdirSync(path.join(sandbox, 'home'), { recursive: true });
    const report = await runThreads(sandbox, 'distinct');

    expect(report.pids[0]).toBe(report.pids[1]);
    expect(report.aPath).not.toBe(report.bPath);
    expect(report.aPath).toBe(testDatabaseLocationFor(report.pids[0], DEFAULT_TEST_DB_ROOT, '1').dbPath);
    expect(report.bPath).toBe(testDatabaseLocationFor(report.pids[1], DEFAULT_TEST_DB_ROOT, '2').dbPath);
    expect(report.bFileExistsAfterACleanup).toBe(true);
    expect(report.bRowsAfterACleanup).toBe(1);
    expect(fs.existsSync(path.dirname(report.bPath))).toBe(false);
  }, 120_000);
});
