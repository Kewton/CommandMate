/**
 * Issue #4577: unit-related runs the union of the related set and the text-scan
 * set ONCE, split into at most 4 groups by LPT over vitest's own recorded file
 * durations, each group a serial `vitest run <files>` in its own short TMPDIR.
 *
 * Invariants (docs: the #4577 design, I1-I5):
 *   I1 a failing test fails the gate however the set is split (real vitest)
 *   I2 nothing failing passes the gate however the set is split (real vitest)
 *   I3 a non-zero / signalled / unspawnable group, or a group that ran fewer
 *      files than it was given, never turns into a pass
 *   I4 the groups partition the union exactly, whatever the duration cache holds
 *   I5 how one group is run: CI inherited untouched, no worker / shard flags,
 *      one short TMPDIR per group
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import {
  SHARD_TMP_PREFIX,
  main as mainSharded,
  readDurationCache,
  splitLpt,
  unionSets,
} from '../../../scripts/run-related-unit-tests.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'run-related-unit-tests.mjs');
const REAL_VITEST_TIMEOUT_MS = 180_000;

type Env = Record<string, string | undefined>;

interface GroupCall {
  cmd: string;
  args: string[];
  cwd: string;
  env: Env;
  logPath: string;
}

interface GroupOutcome {
  code: number | null;
  signal: string | null;
  error?: Error;
}

/** Writes the vitest json report a group would have written for `files` (relative to `root`). */
function writeReport(args: string[], root: string, files: string[], failed: string[] = []): void {
  const flag = args.find((a) => a.startsWith('--outputFile.json='));
  if (!flag) throw new Error(`no --outputFile.json= in ${args.join(' ')}`);
  const reportPath = flag.slice('--outputFile.json='.length);
  const testResults = files.map((file) => ({
    name: path.join(root, file),
    status: failed.includes(file) ? 'failed' : 'passed',
    message: '',
    assertionResults: [
      { fullName: `case of ${file}`, status: failed.includes(file) ? 'failed' : 'passed' },
    ],
  }));
  fs.writeFileSync(reportPath, JSON.stringify({ testResults }));
}

/** The files a group was handed: everything after `run` up to the first flag. */
function groupFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args.slice(1)) {
    if (a.startsWith('--')) break;
    out.push(a);
  }
  return out;
}

/** A child vitest must not believe it is a worker of this one. */
function childEnv(): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST') && k !== 'TEST' && k !== 'TINYPOOL_WORKER_ID') env[k] = v;
  }
  return env;
}

/** A small vitest project in a temp dir: only the vitest package is linked, so its cache stays here. */
function makeProbe(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules', 'vitest'), path.join(root, 'node_modules', 'vitest'));
  fs.symlinkSync(path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), path.join(root, 'node_modules', '.bin', 'vitest'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cm-4577-probe', type: 'module', private: true }));
  // The default include (no `include`): an include is resolved under `--dir`, as in the repository's config.
  fs.writeFileSync(path.join(root, 'vitest.config.mjs'), 'export default { test: {} };\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', timeout: 60_000 }).trim();
}

/** git init + one commit of everything. Returns the commit. */
function commitAll(root: string, message: string): string {
  if (!fs.existsSync(path.join(root, '.git'))) {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Test User');
    git(root, 'config', 'user.email', 'test@example.com');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs the gate script the way the gate does: a child whose stdout and stderr are pipes. */
function runCli(
  root: string,
  env: Env,
  args: string[] = ['--base', 'HEAD'],
  onStart: (pid: number) => void = () => undefined,
  detached = false,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: root, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (child.pid) onStart(child.pid);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/** A test file findTextScanTests picks up (it names readFileSync( and process.cwd()). */
const SCAN_MARK = '// readFileSync( process.cwd() — picked up by findTextScanTests\n';

function writeCache(root: string, body: string): void {
  const dir = path.join(root, 'node_modules', '.vite', 'vitest', 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), body);
}

function cacheBody(durations: Record<string, number>): string {
  return JSON.stringify({
    version: '4.1.2',
    results: Object.entries(durations).map(([file, duration]) => [`:${file}`, { duration, failed: false }]),
  });
}

describe('unionSets (I4: the union of the two sets, overlap once)', () => {
  it('dedupes the overlap and counts each side', () => {
    const u = unionSets(['tests/unit/b.test.ts', 'tests/unit/a.test.ts'], ['tests/unit/a.test.ts', 'tests/unit/c.test.ts']);
    expect(u.files).toEqual(['tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/unit/c.test.ts']);
    expect([u.related, u.textscan, u.overlap]).toEqual([2, 2, 1]);
  });
});

describe('splitLpt (I4)', () => {
  const files = Array.from({ length: 8 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);

  function assertPartition(groups: string[][], all: string[]): void {
    const flat = groups.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.slice().sort()).toEqual(all.slice().sort());
    expect(groups.every((g) => g.length > 0)).toBe(true);
  }

  it('assigns longest first to the lightest group (the textbook table)', () => {
    const durations = new Map(files.map((f, i) => [f, (i + 1) * 1000]));
    const { groups, expectedMs } = splitLpt(files, durations, 4);
    // f8 f1 | f7 f2 | f6 f3 | f5 f4 : every load is 9000ms.
    expect(groups.map((g) => g.slice().sort())).toEqual([
      ['tests/unit/f1.test.ts', 'tests/unit/f8.test.ts'],
      ['tests/unit/f2.test.ts', 'tests/unit/f7.test.ts'],
      ['tests/unit/f3.test.ts', 'tests/unit/f6.test.ts'],
      ['tests/unit/f4.test.ts', 'tests/unit/f5.test.ts'],
    ]);
    expect(expectedMs).toEqual([9000, 9000, 9000, 9000]);
  });

  it('gives an unrecorded file the median of the recorded ones', () => {
    const durations = new Map([
      [files[0], 100],
      [files[1], 300],
    ]);
    const { defaultWeight, known } = splitLpt(files, durations, 4);
    expect(defaultWeight).toBe(200);
    expect(known).toBe(2);
  });

  it('uses N = min(4, |set|)', () => {
    expect(splitLpt(files.slice(0, 3), new Map(), 4).groups).toHaveLength(3);
    expect(splitLpt(files, new Map(), 4).groups).toHaveLength(4);
    expect(splitLpt(files, new Map(), 1).groups).toEqual([files]);
    expect(splitLpt([], new Map(), 4).groups).toEqual([]);
  });

  it.each([
    ['all recorded', new Map(files.map((f, i) => [f, i * 37 + 5]))],
    ['some unrecorded', new Map([[files[2], 5000]])],
    ['nothing recorded', new Map<string, number>()],
    ['only stale paths recorded', new Map([['tests/unit/gone.test.ts', 9999]])],
    ['a zero duration recorded', new Map([[files[0], 500], [files[1], 0], [files[2], 0]])],
    ['every duration zero', new Map(files.map((f) => [f, 0]))],
  ])('partitions the set exactly: %s', (_label, durations) => {
    const { groups } = splitLpt(files, durations, 4);
    expect(groups).toHaveLength(4);
    assertPartition(groups, files);
  });
});

describe('splitLpt never leaves a group empty (I4)', () => {
  it.each<[string, string[], Array<[string, number]>, number]>([
    ['one heavy file and two of 0ms', ['a', 'b', 'c'], [['a', 500], ['b', 0], ['c', 0]], 3],
    ['three files all 0ms', ['a', 'b', 'c'], [['a', 0], ['b', 0], ['c', 0]], 3],
    ['two of five recorded, both 0ms (the median default is 0 too)', ['a', 'b', 'c', 'd', 'e'], [['a', 0], ['b', 0]], 4],
  ])('%s', (_label, set, recorded, groupCount) => {
    const { groups } = splitLpt(set, new Map(recorded), 4);
    expect(groups).toHaveLength(groupCount);
    expect(groups.every((g) => g.length > 0)).toBe(true);
    expect(groups.flat().sort()).toEqual(set);
  });
});

describe('readDurationCache (I4: a missing or broken cache never throws)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-cache-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it('reads the per-file durations, dropping the project prefix', () => {
    writeCache(root, cacheBody({ 'tests/unit/a.test.ts': 1500, 'tests/unit/b.test.ts': 20 }));
    const c = readDurationCache({ root });
    expect(c.status).toBe('ok');
    expect(c.durations.get('tests/unit/a.test.ts')).toBe(1500);
    expect(c.durations.get('tests/unit/b.test.ts')).toBe(20);
  });

  it('reports missing when there is no cache', () => {
    const c = readDurationCache({ root });
    expect(c.status).toBe('missing');
    expect(c.durations.size).toBe(0);
  });

  it.each([
    ['not JSON', '{"version": "4.1.2", "results": [[":tests/unit/a.te'],
    ['wrong shape', JSON.stringify({ version: '4.1.2', results: 'nope' })],
    ['no version', JSON.stringify({ results: [] })],
  ])('reports corrupt and no durations: %s', (_label, body) => {
    writeCache(root, body);
    const c = readDurationCache({ root });
    expect(c.status).toBe('corrupt');
    expect(c.durations.size).toBe(0);
  });
});

/** mainSharded with every outside effect replaced. */
function harness(root: string, opts: {
  related?: string[];
  textscan?: string[];
  outcome?: (i: number, call: GroupCall) => GroupOutcome;
  report?: (i: number, call: GroupCall, files: string[]) => void;
  baseEnv?: Env;
  maxGroups?: number;
  collectSet?: () => Promise<string[]>;
  extra?: Record<string, unknown>;
}) {
  const calls: GroupCall[] = [];
  const logs: string[] = [];
  const outs: string[] = [];
  const tmpBase = path.join(root, 'g');
  const run = () =>
    mainSharded(['--base', 'origin/develop'], {
      root,
      log: (m: string) => logs.push(m),
      out: (m: string) => outs.push(m),
      baseEnv: opts.baseEnv ?? { CI: 'true', PATH: process.env.PATH },
      maxGroups: opts.maxGroups,
      tmpBase,
      collectChangedFiles: () => ({ mergeBase: 'mb123', files: ['src/x.ts'] }),
      findTextScanTests: () => opts.textscan ?? [],
      collectSet: opts.collectSet ?? (async () => opts.related ?? []),
      runGroup: async (call: GroupCall) => {
        const i = calls.length;
        calls.push(call);
        fs.writeFileSync(call.logPath, `log of group ${i + 1}\n`);
        const files = groupFiles(call.args);
        if (opts.report) opts.report(i, call, files);
        else writeReport(call.args, root, files);
        return opts.outcome ? opts.outcome(i, call) : { code: 0, signal: null };
      },
      ...opts.extra,
    });
  return { run, calls, logs, outs, tmpBase };
}

describe('mainSharded: never turns a bad group into a pass (I3)', () => {
  let root: string;
  const FILES = Array.from({ length: 8 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-i3-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it.each<[string, number, Parameters<typeof harness>[1]]>([
    ['one group exits 1', 1, { outcome: (i) => ({ code: i === 1 ? 1 : 0, signal: null }) }],
    ['one group is killed by a signal', 1, { outcome: (i) => ({ code: i === 2 ? null : 0, signal: i === 2 ? 'SIGKILL' : null }) }],
    ['one group fails to spawn', 1, { outcome: (i) => (i === 0 ? { code: null, signal: null, error: new Error('spawn ENOENT') } : { code: 0, signal: null }) }],
    ['one group ran fewer files than it was given', 1, { report: (i, call, files) => writeReport(call.args, root, i === 3 ? files.slice(1) : files) }],
    ['one group ran more files than it was given', 1, { report: (i, call, files) => writeReport(call.args, root, i === 2 ? [...files, 'tests/unit/extra.test.ts'] : files) }],
    ['one group wrote no report', 1, { report: (i, call, files) => { if (i !== 0) writeReport(call.args, root, files); } }],
    ['the LAST group fails (not only the first counts)', 1, { outcome: (i) => ({ code: i === 3 ? 1 : 0, signal: null }) }],
    ['the FIRST group fails (not only the last counts)', 1, { outcome: (i) => ({ code: i === 0 ? 1 : 0, signal: null }) }],
    ['every group exits 0 and ran all its files', 0, {}],
  ])('%s -> exit %i', async (_label, expected, opts) => {
    const h = harness(root, { related: FILES, ...opts });
    expect(await h.run()).toBe(expected);
    expect(h.calls).toHaveLength(4);
  });

  it('returns 2 without running anything when the set cannot be collected', async () => {
    const h = harness(root, {
      collectSet: async () => {
        throw new Error('vitest would not start');
      },
    });
    expect(await h.run()).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('runs the union once: every file in exactly one group, overlap once', async () => {
    const h = harness(root, { related: FILES.slice(0, 6), textscan: FILES.slice(4) });
    expect(await h.run()).toBe(0);
    const handed = h.calls.flatMap((c) => groupFiles(c.args));
    expect(handed.slice().sort()).toEqual(FILES);
    expect(h.logs).toContain('run-related-unit-tests: set related=6 textscan=4 overlap=2 union=8');
  });

  it('runs nothing and passes when the union is empty', async () => {
    const h = harness(root, {});
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('prints each group log after all groups ended, in group order', async () => {
    const h = harness(root, { related: FILES });
    await h.run();
    const joined = h.outs.join('');
    const idx = [1, 2, 3, 4].map((i) => joined.indexOf(`log of group ${i}`));
    expect(idx.every((n) => n >= 0)).toBe(true);
    expect(idx).toEqual(idx.slice().sort((a, b) => a - b));
  });
});

describe('mainSharded: the cache shapes only the split, never the set (I4)', () => {
  let root: string;
  const FILES = Array.from({ length: 7 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-i4-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it.each<[string, string, () => void]>([
    ['ok', 'ok', () => writeCache(root, cacheBody({ [FILES[0]]: 900, [FILES[1]]: 10 }))],
    ['missing', 'missing', () => undefined],
    ['corrupt', 'corrupt', () => writeCache(root, '{not json')],
    ['ok (only stale paths recorded)', 'ok', () => writeCache(root, cacheBody({ 'tests/unit/stale.test.ts': 777 }))],
  ])('cache=%s: all files run, each once', async (_title, status, setup) => {
    setup();
    const h = harness(root, { related: FILES });
    expect(await h.run()).toBe(0);
    const handed = h.calls.flatMap((c) => groupFiles(c.args));
    expect(handed.slice().sort()).toEqual(FILES);
    expect(new Set(handed).size).toBe(handed.length);
    expect(h.logs.some((l) => l.startsWith(`run-related-unit-tests: split=lpt groups=4 cache=${status} `))).toBe(true);
  });
});

describe('mainSharded: how one group is run (I5)', () => {
  let root: string;
  const FILES = Array.from({ length: 5 }, (_, i) => `tests/unit/f${i + 1}.test.ts`);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-i5-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it.each([
    ['inherited CI=true', { CI: 'true' }],
    ['inherited CI absent', {}],
  ])('%s: CI is passed through untouched, NODE_ENV=test', async (_label, baseEnv) => {
    const h = harness(root, { related: FILES, baseEnv });
    await h.run();
    for (const call of h.calls) {
      expect(call.env.CI).toBe((baseEnv as Env).CI);
      expect('CI' in call.env).toBe('CI' in baseEnv);
      expect(call.env.NODE_ENV).toBe('test');
    }
  });

  it('adds no worker / parallelism / shard flags and runs `vitest run <files>`', async () => {
    const h = harness(root, { related: FILES });
    await h.run();
    for (const call of h.calls) {
      expect(call.cmd).toBe(path.join(root, 'node_modules', '.bin', 'vitest'));
      expect(call.args[0]).toBe('run');
      expect(call.args).toContain('--passWithNoTests');
      expect(call.args.some((a) => /^--(maxWorkers|no-file-parallelism|fileParallelism|shard)/.test(a))).toBe(false);
      expect(call.cwd).toBe(root);
    }
  });

  it('gives every group its own TMPDIR under the short base, and removes them', async () => {
    const h = harness(root, { related: FILES });
    await h.run();
    const dirs = h.calls.map((c) => c.env.TMPDIR as string);
    expect(new Set(dirs).size).toBe(h.calls.length);
    for (const d of dirs) {
      expect(d.startsWith(h.tmpBase)).toBe(true);
      expect(fs.existsSync(d)).toBe(false);
    }
  });

  it('the default base is short enough for a macOS unix socket under it (104 bytes)', () => {
    // mkdtemp adds 6 characters; the real-tmux tests then add about 50 more.
    expect(SHARD_TMP_PREFIX).toBe('/tmp/cms');
  });
});

describe('mainSharded: launching the groups', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-launch-'));
  });
  afterEach(() => {
    removeTempDir(root);
  });

  it('does not launch a group that holds no files', async () => {
    const files = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/unit/c.test.ts'];
    const h = harness(root, {
      related: files,
      extra: {
        split: () => ({ groups: [[files[0], files[1]], [], [files[2]]], expectedMs: [0, 0, 0], defaultWeight: 1, known: 0 }),
      },
    });
    expect(await h.run()).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.every((c) => groupFiles(c.args).length > 0)).toBe(true);
    expect(h.logs).toContain('run-related-unit-tests: group 2/3 files=0 skipped');
  });

  it('creates every TMPDIR before starting any group; a failure starts none and removes what it made', async () => {
    const made: string[] = [];
    const h = harness(root, {
      related: Array.from({ length: 6 }, (_, i) => `tests/unit/f${i}.test.ts`),
      extra: {
        mkdtemp: (prefix: string) => {
          if (made.length === 2) throw new Error('ENOSPC');
          const dir = fs.mkdtempSync(prefix);
          made.push(dir);
          return dir;
        },
      },
    });
    expect(await h.run()).toBe(2);
    expect(h.calls).toEqual([]);
    expect(made).toHaveLength(2);
    for (const d of made) expect(fs.existsSync(d)).toBe(false);
  });

  it('hands the groups the environment as it was before the related set was collected', async () => {
    const KEY = 'CM_4577_SET_BY_VITEST';
    try {
      const calls: GroupCall[] = [];
      const code = await mainSharded(['--base', 'origin/develop'], {
        root,
        log: () => undefined,
        out: () => undefined,
        tmpBase: path.join(root, 'g'),
        collectChangedFiles: () => ({ mergeBase: 'mb', files: ['src/x.ts'] }),
        findTextScanTests: () => [],
        // createVitest writes into process.env (NODE_ENV, MODE, PROD, ...): stand-in for it.
        collectSet: async () => {
          process.env[KEY] = 'leaked';
          return ['tests/unit/a.test.ts'];
        },
        runGroup: async (call: GroupCall) => {
          calls.push(call);
          writeReport(call.args, root, groupFiles(call.args));
          return { code: 0, signal: null };
        },
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].env[KEY]).toBeUndefined();
    } finally {
      delete process.env[KEY];
    }
  });
});

/**
 * I1 / I2 with the real vitest: a small project in a temp dir. Only its own
 * 7-8 files run; the repository's tests/unit is never touched.
 */
describe('mainSharded with the real vitest (I1 positive / I2 negative control)', () => {
  let root: string;
  const PASSING = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `tests/unit/${n}.test.ts`);
  const FAILING = 'tests/unit/fail.test.ts';
  const FAIL_LINE = `run-related-unit-tests: failed ${FAILING} > known failing 4577`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-real-'));
    // Only the vitest package is linked: vitest's own cache (node_modules/.vite)
    // then lands in this temp dir, never in the repository's node_modules.
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync(path.join(REPO, 'node_modules', 'vitest'), path.join(root, 'node_modules', 'vitest'));
    fs.symlinkSync(path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), path.join(root, 'node_modules', '.bin', 'vitest'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cm-4577-probe', type: 'module', private: true }));
    fs.writeFileSync(path.join(root, 'vitest.config.mjs'), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
    fs.mkdirSync(path.join(root, 'tests', 'unit'), { recursive: true });
    for (const f of PASSING) {
      fs.writeFileSync(path.join(root, f), `import { it, expect } from 'vitest';\nit('ok ${path.basename(f)}', () => { expect(1).toBe(1); });\n`);
    }
    fs.writeFileSync(path.join(root, FAILING), "import { it, expect } from 'vitest';\nit('known failing 4577', () => { expect(1).toBe(2); });\n");
  });
  afterEach(() => {
    removeTempDir(root);
  });

  async function runReal(files: string[], maxGroups: number) {
    const logs: string[] = [];
    const code = await mainSharded(['--base', 'origin/develop'], {
      root,
      log: (m: string) => logs.push(m),
      out: () => undefined,
      baseEnv: childEnv(),
      maxGroups,
      tmpBase: path.join(root, 'g'),
      collectChangedFiles: () => ({ mergeBase: 'mb', files: ['src/x.ts'] }),
      findTextScanTests: () => [],
      collectSet: async () => files,
    });
    return { code, logs };
  }

  const ALL = [...PASSING, FAILING];
  // Heavy: the failing file alone in the first group.
  const HEAVY = () => cacheBody({ ...Object.fromEntries(PASSING.map((f) => [f, 100])), [FAILING]: 100_000 });
  // Light: the failing file is placed last, into a light group (not the heavy first one).
  const LIGHT = () => cacheBody({ ...Object.fromEntries(PASSING.map((f, i) => [f, i === 0 ? 10_000 : 1000 * i])), [FAILING]: 1 });

  it('the two recorded shapes put the failing file in the heavy first group / in a later light group', () => {
    writeCache(root, HEAVY());
    expect(splitLpt(ALL, readDurationCache({ root }).durations, 4).groups[0]).toEqual([FAILING]);
    writeCache(root, LIGHT());
    const light = splitLpt(ALL, readDurationCache({ root }).durations, 4).groups;
    expect(light.findIndex((g) => g.includes(FAILING))).toBeGreaterThan(0);
  });

  // Asserts only the verdict, so it stays green whatever the split is (the split
  // must not decide pass / fail): the shape of the split is pinned just above.
  it(
    'one group (today\'s shape) and 4 LPT groups with the failing file heavy or light all exit 1 and name it',
    async () => {
      const one = await runReal(ALL, 1);
      writeCache(root, HEAVY());
      const heavy = await runReal(ALL, 4);
      writeCache(root, LIGHT());
      const light = await runReal(ALL, 4);
      for (const r of [one, heavy, light]) {
        expect(r.code).toBe(1);
        expect(r.logs).toContain(FAIL_LINE);
      }
    },
    REAL_VITEST_TIMEOUT_MS,
  );

  it(
    'main reads the recorded durations and splits by them (the failing file heavy, then light)',
    async () => {
      writeCache(root, HEAVY());
      const heavy = await runReal(ALL, 4);
      expect(heavy.logs).toContain('run-related-unit-tests: split=lpt groups=4 cache=ok known=8/8 default-weight=100ms');
      expect(heavy.logs.some((l) => /^run-related-unit-tests: group 1\/4 files=1 .* ran=1 exit=1$/.test(l))).toBe(true);

      writeCache(root, LIGHT());
      const light = await runReal(ALL, 4);
      expect(light.logs.some((l) => l.startsWith('run-related-unit-tests: split=lpt groups=4 cache=ok known=8/8 '))).toBe(true);
      const groupLines = light.logs.filter((l) => / group \d\/4 /.test(l));
      expect(groupLines[0]).toMatch(/ exit=0$/);
      expect(groupLines.slice(1).some((l) => / exit=1$/.test(l))).toBe(true);
    },
    REAL_VITEST_TIMEOUT_MS,
  );

  it(
    'negative control: without the failing file, 1 group and 4 groups both exit 0',
    async () => {
      const one = await runReal(PASSING, 1);
      const four = await runReal(PASSING, 4);
      expect([one.code, four.code]).toEqual([0, 0]);
      expect(four.logs.some((l) => l.includes(' failed '))).toBe(false);
    },
    REAL_VITEST_TIMEOUT_MS,
  );
});

/**
 * The script as the gate runs it: a child process, stdout and stderr piped, the
 * default TMPDIR base. Small git projects in temp dirs; the change is a README
 * (non-source), so the set is the text-scan tests and vitest/node is not loaded.
 */
describe('the gate script as a child process (stdout piped)', () => {
  let root: string;
  let privateTmp: string;
  beforeEach(() => {
    privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-cli-tmp-'));
  });
  afterEach(() => {
    if (root) removeTempDir(root);
    removeTempDir(privateTmp);
  });

  it(
    'delivers every group output and the closing summary past 64 KB, through the default short TMPDIR',
    async () => {
      const files: Record<string, string> = {};
      for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        files[`tests/unit/${n}.test.ts`] =
          "import { it, expect } from 'vitest';\n" + SCAN_MARK +
          `it('noisy ${n}', () => {\n  console.log('TMPDIR_IS=' + process.env.TMPDIR);\n` +
          "  for (let i = 0; i < 400; i++) console.log('x'.repeat(100) + ' ' + i);\n  expect(1).toBe(1);\n});\n";
      }
      files['tests/unit/fail.test.ts'] =
        "import { it, expect } from 'vitest';\n" + SCAN_MARK + "it('known failing 4577', () => { expect(1).toBe(2); });\n";
      root = makeProbe('cm-4577-cli-', files);
      commitAll(root, 'probe');
      fs.writeFileSync(path.join(root, 'README.md'), 'changed\n');

      const r = await runCli(root, { ...childEnv(), CI: 'true', TMPDIR: privateTmp });
      expect(r.code).toBe(1);
      expect(r.stdout.length).toBeGreaterThan(2 * 65_536);
      for (const i of [1, 2, 3, 4]) expect(r.stdout).toContain(`--- run-related-unit-tests: group ${i}/4 ---`);
      expect(r.stdout).toContain('run-related-unit-tests: failed tests/unit/fail.test.ts > known failing 4577');
      expect(r.stdout.trimEnd().split('\n').pop()).toBe('run-related-unit-tests: result exit=1 groups=4 union=9');

      // The default base: short (a macOS unix socket allows 104 bytes), one per group, removed.
      const dirs = [...new Set([...r.stdout.matchAll(/TMPDIR_IS=(\S+)/g)].map((m) => m[1]))];
      expect(dirs).toHaveLength(4);
      for (const d of dirs) {
        expect(d.startsWith(SHARD_TMP_PREFIX)).toBe(true);
        expect(d.length).toBeLessThanOrEqual(SHARD_TMP_PREFIX.length + 6);
        expect(fs.existsSync(d)).toBe(false);
      }
      expect(fs.readdirSync(privateTmp)).toEqual([]);
    },
    REAL_VITEST_TIMEOUT_MS,
  );

  it(
    'a SIGTERM stops the groups and removes every TMPDIR and the work dir',
    async () => {
      const marks = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-marks-'));
      try {
        const files: Record<string, string> = {};
        for (const n of ['a', 'b', 'c', 'd']) {
          files[`tests/unit/${n}.test.ts`] =
            "import { it } from 'vitest';\nimport fs from 'fs';\n" + SCAN_MARK +
            `it('waits ${n}', async () => {\n` +
            `  fs.writeFileSync(process.env.MARK_DIR + '/${n}.json', JSON.stringify({ tmpdir: process.env.TMPDIR, pid: process.pid, ppid: process.ppid }));\n` +
            '  await new Promise((r) => setTimeout(r, 120_000));\n}, 200_000);\n';
        }
        root = makeProbe('cm-4577-sig-', files);
        commitAll(root, 'probe');
        fs.writeFileSync(path.join(root, 'README.md'), 'changed\n');

        let pid = 0;
        const done = runCli(root, { ...childEnv(), CI: 'true', TMPDIR: privateTmp, MARK_DIR: marks }, ['--base', 'HEAD'], (p) => (pid = p));
        expect(await waitFor(() => fs.readdirSync(marks).length === 4, 90_000)).toBe(true);
        const seen = fs.readdirSync(marks).map((f) => JSON.parse(fs.readFileSync(path.join(marks, f), 'utf-8')) as { tmpdir: string; pid: number; ppid: number });
        for (const m of seen) expect(fs.existsSync(m.tmpdir)).toBe(true);

        process.kill(pid, 'SIGTERM');
        const r = await done;
        expect(r.signal).toBe('SIGTERM');
        for (const m of seen) expect(fs.existsSync(m.tmpdir)).toBe(false);
        expect(fs.readdirSync(privateTmp)).toEqual([]);
        const pids = seen.flatMap((m) => [m.pid, m.ppid]);
        expect(await waitFor(() => pids.every((p) => !alive(p)), 20_000)).toBe(true);
      } finally {
        removeTempDir(marks);
      }
    },
    REAL_VITEST_TIMEOUT_MS,
  );
});

/**
 * The related set from vitest's Node API is the set the CLI picks: a small git
 * project, one committed src change (changed form) and one traced file (related form).
 */
/**
 * Stopped the way the gate stops it (src/lib/verification/gate-runner.ts): the
 * script is the leader of its own process group, and the gate signals the GROUP
 * — SIGTERM, then SIGKILL after 5 s (SIGKILL_GRACE_MS). Nothing of the groups'
 * vitest may outlive that: the group signal must reach every vitest and worker.
 */
describe('the gate script stopped through its process group, as the gate does', () => {
  let root: string;
  let privateTmp: string;
  let marks: string;
  let seen: Array<{ tmpdir: string; pid: number; ppid: number }> = [];
  beforeEach(() => {
    privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-grp-tmp-'));
    marks = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4577-grp-marks-'));
    seen = [];
    const files: Record<string, string> = {};
    for (const n of ['a', 'b', 'c', 'd']) {
      files[`tests/unit/${n}.test.ts`] =
        "import { it } from 'vitest';\nimport fs from 'fs';\n" + SCAN_MARK +
        `it('waits ${n}', async () => {\n` +
        `  fs.writeFileSync(process.env.MARK_DIR + '/${n}.json', JSON.stringify({ tmpdir: process.env.TMPDIR, pid: process.pid, ppid: process.ppid }));\n` +
        '  await new Promise((r) => setTimeout(r, 120_000));\n}, 200_000);\n';
    }
    root = makeProbe('cm-4577-grp-', files);
    commitAll(root, 'probe');
    fs.writeFileSync(path.join(root, 'README.md'), 'changed\n');
  });
  afterEach(() => {
    // Whatever a red run leaves behind is this test's own: stop it, remove it.
    for (const m of seen) {
      for (const target of [-m.ppid, m.ppid, m.pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      fs.rmSync(m.tmpdir, { recursive: true, force: true });
    }
    removeTempDir(root);
    removeTempDir(privateTmp);
    removeTempDir(marks);
  });

  /** Processes whose command line names the probe project (each group's vitest). */
  function probeProcesses(): number {
    const out = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf-8', timeout: 30_000 });
    const real = fs.realpathSync(root);
    return out.split('\n').filter((l) => l.includes(real) || l.includes(root)).length;
  }

  async function startAndWait(): Promise<{ pid: number; done: Promise<CliResult> }> {
    let pid = 0;
    const done = runCli(root, { ...childEnv(), CI: 'true', TMPDIR: privateTmp, MARK_DIR: marks }, ['--base', 'HEAD'], (p) => (pid = p), true);
    expect(await waitFor(() => fs.readdirSync(marks).length === 4, 90_000)).toBe(true);
    seen = fs.readdirSync(marks).map((f) => JSON.parse(fs.readFileSync(path.join(marks, f), 'utf-8')) as { tmpdir: string; pid: number; ppid: number });
    expect(probeProcesses()).toBe(4);
    return { pid, done };
  }

  const gone = () => seen.every((m) => !alive(m.pid) && !alive(m.ppid)) && probeProcesses() === 0;

  it(
    'group SIGTERM, then group SIGKILL after 5 s: no vitest, no worker, no TMPDIR is left',
    async () => {
      const { pid, done } = await startAndWait();
      process.kill(-pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // the whole group already ended
      }
      await done;
      expect(await waitFor(gone, 10_000)).toBe(true);
      for (const m of seen) expect(fs.existsSync(m.tmpdir)).toBe(false);
      expect(fs.readdirSync(privateTmp)).toEqual([]);
    },
    REAL_VITEST_TIMEOUT_MS,
  );

  it(
    'group SIGKILL with no SIGTERM first: no vitest, no worker is left (the TMPDIRs cannot be removed)',
    async () => {
      const { pid, done } = await startAndWait();
      process.kill(-pid, 'SIGKILL');
      const r = await done;
      expect(r.signal).toBe('SIGKILL');
      expect(await waitFor(gone, 10_000)).toBe(true);
      // SIGKILL runs no handler: the 4 group TMPDIRs and the work dir stay (removed by afterEach).
      expect(seen.filter((m) => fs.existsSync(m.tmpdir))).toHaveLength(4);
      expect(fs.readdirSync(privateTmp).filter((d) => d.startsWith('cm-related-shards-'))).toHaveLength(1);
    },
    REAL_VITEST_TIMEOUT_MS,
  );
});

describe('collectRelatedSet with the real vitest picks what the CLI picks', () => {
  let root: string;
  afterEach(() => {
    if (root) removeTempDir(root);
  });

  function collectInChild(mode: 'related' | 'full', mergeBase: string, traced: string[]): string[] {
    const code =
      `import { collectRelatedSet } from ${JSON.stringify(SCRIPT)};\n` +
      `const r = await collectRelatedSet({ root: process.cwd(), mode: ${JSON.stringify(mode)}, mergeBase: ${JSON.stringify(mergeBase)}, traced: ${JSON.stringify(traced)} });\n` +
      'process.stdout.write(JSON.stringify(r));\n';
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: childEnv() as NodeJS.ProcessEnv, encoding: 'utf-8', timeout: 120_000 });
    return JSON.parse(out) as string[];
  }

  function rel(abs: string): string {
    return path.relative(fs.realpathSync(root), abs).split(path.sep).join('/');
  }

  it(
    'changed: <base> matches `vitest list tests/unit --changed <base>`, related: [file] matches `vitest related --dir tests/unit`',
    async () => {
      root = makeProbe('cm-4577-set-', {
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 2;\n',
        'tests/unit/a.test.ts': "import { it, expect } from 'vitest';\nimport { a } from '../../src/a';\nit('a', () => { expect(a).toBe(1); });\n",
        'tests/unit/b.test.ts': "import { it, expect } from 'vitest';\nimport { b } from '../../src/b';\nit('b', () => { expect(b).toBe(2); });\n",
        'tests/unit/c.test.ts': "import { it, expect } from 'vitest';\nit('c', () => { expect(3).toBe(3); });\n",
        'tests/integration/a.test.ts': "import { it, expect } from 'vitest';\nimport { a } from '../../src/a';\nit('ia', () => { expect(a).toBe(1); });\n",
      });
      const base = commitAll(root, 'base');
      fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1; // changed\n');
      commitAll(root, 'change a');

      const vitest = path.join(root, 'node_modules', '.bin', 'vitest');
      const listed = JSON.parse(
        execFileSync(vitest, ['list', 'tests/unit', '--changed', base, '--filesOnly', '--json'], { cwd: root, env: childEnv() as NodeJS.ProcessEnv, encoding: 'utf-8', timeout: 120_000 }),
      ) as Array<{ file: string }>;
      const cliChanged = listed.map((f) => rel(f.file)).sort();
      expect(cliChanged).toEqual(['tests/unit/a.test.ts']);
      expect(collectInChild('related', base, [])).toEqual(cliChanged);

      const report = path.join(root, 'related.json');
      execFileSync(vitest, ['related', '--run', '--dir', 'tests/unit', 'src/b.ts', '--reporter=json', `--outputFile=${report}`], { cwd: root, env: childEnv() as NodeJS.ProcessEnv, encoding: 'utf-8', timeout: 120_000 });
      const ran = (JSON.parse(fs.readFileSync(report, 'utf-8')) as { testResults: Array<{ name: string }> }).testResults;
      const cliRelated = ran.map((t) => rel(t.name)).sort();
      expect(cliRelated).toEqual(['tests/unit/b.test.ts']);
      expect(collectInChild('full', base, ['src/b.ts'])).toEqual(cliRelated);
    },
    REAL_VITEST_TIMEOUT_MS,
  );
});
