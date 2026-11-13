/**
 * Issue #4343 (PR A): a relative CODEX_HOME is refused at agent-health's entry,
 * before both the argument-error branch and the run.
 *
 * `main` itself is driven (not only the predicate), so the three earlier P2s of
 * #4290 are pinned where they happened:
 *   ① the run chdirs to REPO_ROOT before resolving — the refusal comes first and
 *     `process.chdir` is never called;
 *   ② `prepareLaunch` re-resolving the value — no probe starts, CODEX_HOME is left as is;
 *   ③ the argument-error branch skipping the check, and nobody reading the
 *     refusal — the report carries it (scriptErrors) on that branch too.
 *
 * Nothing real runs: the run lock, the hook listener and the probes are mocks,
 * `os.homedir()` points at a temp dir, and every file lives under os.tmpdir().
 *
 * @vitest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'cm-4343-home-'));
});

const mocks = vi.hoisted(() => ({
  acquireRunLock: vi.fn(() => ({ ok: false as const, error: 'locked by the test' })),
  listenerStart: vi.fn(async () => {
    throw new Error('the listener must not start in this test');
  }),
  probeTool: vi.fn(),
  probeLimitedTool: vi.fn(),
  readVersion: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => fakeHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('@/lib/agent-health/run-lock', () => ({ acquireRunLock: mocks.acquireRunLock }));
vi.mock('../../../../scripts/agent-health/hook-listener', () => ({
  HookListener: { start: mocks.listenerStart },
}));
vi.mock('../../../../scripts/agent-health/probe-tool', () => ({
  probeTool: mocks.probeTool,
  probeLimitedTool: mocks.probeLimitedTool,
  readVersion: mocks.readVersion,
}));

const { main } = await import('../../../../scripts/agent-health/main');
const { reportDateJst } = await import('@/lib/agent-health/report');

const RELATIVE_PREFIX = '環境の誤り: CODEX_HOME が相対パス';

let dir: string;
let savedCodexHome: string | undefined;
let chdir: ReturnType<typeof vi.spyOn>;
let stdout: string[];
let stderr: string[];

const defaultReportPath = () =>
  path.join(fakeHome, '.commandmate', 'agent-health', 'reports', `${reportDateJst(new Date())}.json`);
const readReport = (file: string) =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as { tools: unknown[]; scriptErrors?: string[]; summary?: unknown };

function setCodexHome(value: string | undefined): void {
  if (value === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = value;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4343-main-'));
  savedCodexHome = process.env.CODEX_HOME;
  chdir = vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  for (const mock of Object.values(mocks)) mock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  setCodexHome(savedCodexHome);
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir)) {
    const child = path.join(dir, entry);
    if (fs.statSync(child).isDirectory()) fs.chmodSync(child, 0o700);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(fakeHome, '.commandmate'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function expectNothingStarted(): void {
  expect(mocks.acquireRunLock).not.toHaveBeenCalled();
  expect(chdir).not.toHaveBeenCalled();
  expect(mocks.listenerStart).not.toHaveBeenCalled();
  expect(mocks.probeTool).not.toHaveBeenCalled();
  expect(mocks.probeLimitedTool).not.toHaveBeenCalled();
  expect(mocks.readVersion).not.toHaveBeenCalled();
}

describe('[#4343] a relative CODEX_HOME is refused at the entry of main (red before the fix)', () => {
  it('valid arguments: exit 2, a report with tools [] and the refusal, nothing after it starts', async () => {
    setCodexHome('rel/codex');
    const out = path.join(dir, 'report.json');
    const statePath = path.join(dir, 'state.json');
    const roleFile = path.join(dir, 'role.json');
    fs.writeFileSync(roleFile, JSON.stringify({ id: 'r', body: 'b' }));
    const read = vi.spyOn(fs, 'readFileSync');

    const code = await main(['--out', out, '--state', statePath, '--role-file', roleFile]);

    expect(code).toBe(2);
    expectNothingStarted();
    expect(read.mock.calls.some(([file]) => file === roleFile)).toBe(false);
    const report = readReport(out);
    expect(report.tools).toEqual([]);
    expect(report.summary).toBeUndefined();
    expect(report.scriptErrors).toHaveLength(1);
    expect(report.scriptErrors?.[0]).toContain(RELATIVE_PREFIX);
    expect(report.scriptErrors?.[0]).toContain('"rel/codex"');
    // The state is not updated, and the value is not re-resolved for a launch (P2 ②).
    expect(fs.existsSync(statePath)).toBe(false);
    expect(process.env.CODEX_HOME).toBe('rel/codex');
  });

  it('a relative --out resolves against the cwd at startup, not REPO_ROOT (P2 ①)', async () => {
    setCodexHome('./codex');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    const code = await main(['--out', 'custom/out.json']);

    expect(code).toBe(2);
    expectNothingStarted();
    expect(readReport(path.join(dir, 'custom', 'out.json')).scriptErrors?.[0]).toContain(RELATIVE_PREFIX);
    expect(fs.existsSync(defaultReportPath())).toBe(false);
  });

  it('invalid arguments: the default report keeps both the argument error and the refusal (P2 ③)', async () => {
    setCodexHome('codex');

    const code = await main(['--no-such-flag']);

    expect(code).toBe(2);
    expectNothingStarted();
    const report = readReport(defaultReportPath());
    expect(report.tools).toEqual([]);
    expect(report.scriptErrors).toHaveLength(2);
    expect(report.scriptErrors?.[0]).toBe('引数の誤り: unknown argument: --no-such-flag');
    expect(report.scriptErrors?.[1]).toContain(RELATIVE_PREFIX);
  });

  it('a failed save prints this run\'s JSON and leaves the earlier same-day file as it was', async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only directory
    setCodexHome('rel');
    const reports = path.join(dir, 'reports');
    fs.mkdirSync(reports);
    const out = path.join(reports, `${reportDateJst(new Date())}.json`);
    fs.writeFileSync(out, '{"earlier":true}\n');
    fs.chmodSync(reports, 0o500);

    const code = await main(['--out', out]);

    expect(code).toBe(2);
    expectNothingStarted();
    expect(fs.readFileSync(out, 'utf8')).toBe('{"earlier":true}\n');
    expect(stderr.join('')).toContain(`could not write the report to ${out}`);
    const printed = JSON.parse(stdout.join('')) as { tools: unknown[]; scriptErrors: string[] };
    expect(printed.tools).toEqual([]);
    expect(printed.scriptErrors[0]).toContain(RELATIVE_PREFIX);
  });

  it('--help still prints the usage and exits 0 with a relative CODEX_HOME', async () => {
    setCodexHome('rel');
    expect(await main(['--help'])).toBe(0);
    expectNothingStarted();
    expect(stdout.join('')).toContain('--help');
    expect(fs.existsSync(defaultReportPath())).toBe(false);
  });
});

describe('[#4343] absolute, empty and unset CODEX_HOME go on to the run as before (negative control)', () => {
  it.each([
    ['an absolute value', () => dir],
    ['an empty value', () => ''],
    ['an unset value', () => undefined],
  ])('%s reaches the run lock and only its error is reported', async (_label, value) => {
    setCodexHome(value());
    const out = path.join(dir, 'report.json');

    const code = await main(['--out', out]);

    expect(code).toBe(2);
    expect(mocks.acquireRunLock).toHaveBeenCalledTimes(1);
    expect(readReport(out).scriptErrors).toEqual(['locked by the test']);
  });

  it('invalid arguments with an absolute CODEX_HOME report only the argument error', async () => {
    setCodexHome(dir);
    expect(await main(['--no-such-flag'])).toBe(2);
    expect(readReport(defaultReportPath()).scriptErrors).toEqual(['引数の誤り: unknown argument: --no-such-flag']);
    expect(mocks.acquireRunLock).not.toHaveBeenCalled();
  });
});
