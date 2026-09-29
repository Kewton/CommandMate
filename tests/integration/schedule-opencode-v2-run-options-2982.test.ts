/**
 * A CMATE.md OpenCode V2 schedule reaches `execFile` with the options its CLI
 * Tool column names (Issue #2982).
 *
 * Starts at a real CMATE.md file (written under `os.tmpdir()`, never the
 * repository) and ends at the argv `child_process.execFile` receives, through
 * the real `parseSchedulesSection`, `executeSchedule`,
 * `resolveScheduleExecuteOptions`, `executeClaudeCommand` and `buildCliArgs`.
 * Only `child_process`, the V2 binary lookup and the database are substituted.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const { mockLogger, mockResolveOpencodeV2 } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
  mockResolveOpencodeV2: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ createLogger: vi.fn(() => mockLogger) }));
vi.mock('@/lib/cli-tools/opencode-executable', () => ({
  OPENCODE_V2_BINARY_NAME: 'opencode2',
  resolveOpencodeV2Executable: mockResolveOpencodeV2,
}));

import { execFile } from 'child_process';
import { executeSchedule, type ScheduleState } from '@/lib/job-executor';
import { parseCmateFile, parseSchedulesSection } from '@/lib/cmate-parser';
import { validateSchedulesSection } from '@/lib/cmate-validator';
import type { ScheduleEntry } from '@/types/cmate';

const mockedExecFile = vi.mocked(execFile);

type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const M = Module as unknown as ModuleWithLoad;
const originalLoad = M._load;

let worktreeDir: string;
let runCalls: Array<{ sql: string; args: unknown[] }>;

function installDbStub(): void {
  M._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.endsWith('db-instance')) {
      return {
        getDbInstance: () => ({
          prepare: (sql: string) => ({
            run: (...args: unknown[]) => {
              runCalls.push({ sql, args });
              return { changes: 1 };
            },
            get: () =>
              sql.includes('FROM worktrees') ? { path: worktreeDir, vibe_local_model: null } : undefined,
          }),
        }),
      };
    }
    return originalLoad.call(Module, request, parent, isMain);
  };
}

function capturedInvocation(): { command: string; argv: string[] } {
  expect(mockedExecFile, 'execFile was never called').toHaveBeenCalledTimes(1);
  const [command, argv] = mockedExecFile.mock.calls[0] as unknown as [string, string[]];
  return { command, argv };
}

/** Write CMATE.md into the temporary worktree and read it back as the scheduler would. */
function schedulesFromFile(cliTool: string): { rows: string[][]; entries: ScheduleEntry[] } {
  const path = join(worktreeDir, 'CMATE.md');
  writeFileSync(
    path,
    `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| nightly | 0 3 * * * | Review today's diff | ${cliTool} | true | |
`,
  );
  const rows = parseCmateFile(readFileSync(path, 'utf-8')).get('Schedules') ?? [];
  return { rows, entries: parseSchedulesSection(rows) };
}

async function runSchedule(entry: ScheduleEntry): Promise<void> {
  const state: ScheduleState = {
    scheduleId: 'sch-2982',
    worktreeId: 'wt-2982',
    cronJob: undefined as unknown as ScheduleState['cronJob'],
    isExecuting: false,
    entry,
  };
  await executeSchedule(state);
}

beforeEach(() => {
  worktreeDir = mkdtempSync(join(tmpdir(), 'cm-2982-worktree-'));
  runCalls = [];
  mockedExecFile.mockReset();
  mockedExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (e: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(null, 'ok', '');
    return { stdin: { end: vi.fn() }, on: vi.fn(), pid: undefined } as unknown as ChildProcess;
  }) as unknown as typeof execFile);
  mockResolveOpencodeV2.mockReset();
  mockResolveOpencodeV2.mockResolvedValue({
    executable: { path: '/opt/homebrew/bin/opencode2', version: '2.0.18', generation: 'v2' },
    probed: [],
  });
  installDbStub();
});

afterEach(() => {
  M._load = originalLoad;
  vi.clearAllMocks();
  rmSync(worktreeDir, { recursive: true, force: true });
});

describe('a CMATE.md opencode-v2 schedule launches with its own arguments (Issue #2982)', () => {
  it('opencode-v2 --model <provider/model> --agent plan → -m <provider/model> --agent plan', async () => {
    const { rows, entries } = schedulesFromFile('opencode-v2 --model anthropic/claude-sonnet-4-5 --agent plan');
    expect(validateSchedulesSection(rows)).toEqual([]);
    expect(entries).toHaveLength(1);

    await runSchedule(entries[0]);

    expect(capturedInvocation()).toEqual({
      command: '/opt/homebrew/bin/opencode2',
      argv: [
        'run', '--standalone', '--format', 'json',
        '-m', 'anthropic/claude-sonnet-4-5',
        '--agent', 'plan',
        '--', "Review today's diff",
      ],
    });
    const update = runCalls.find((call) => call.sql.includes('UPDATE execution_logs SET status'));
    expect(update?.args[0]).toBe('completed');
  });

  it('sends --variant as -m model#variant (never as a --variant flag)', async () => {
    const { entries } = schedulesFromFile(
      'opencode-v2 --model anthropic/claude-sonnet-4-5 --variant high --continue --title "nightly review"',
    );
    await runSchedule(entries[0]);

    const { argv } = capturedInvocation();
    expect(argv).toEqual([
      'run', '--standalone', '--format', 'json',
      '-m', 'anthropic/claude-sonnet-4-5#high',
      '-c',
      '--title', 'nightly review',
      '--', "Review today's diff",
    ]);
    expect(argv).not.toContain('--variant');
  });

  it('runs bare when the column names no options (positive control for the argv shape)', async () => {
    const { entries } = schedulesFromFile('opencode-v2');
    await runSchedule(entries[0]);
    expect(capturedInvocation().argv).toEqual([
      'run', '--standalone', '--format', 'json', '--', "Review today's diff",
    ]);
  });

  it('skips a row whose variant has no model (negative control: nothing is executed)', () => {
    const { rows, entries } = schedulesFromFile('opencode-v2 --variant high');
    expect(validateSchedulesSection(rows)).toHaveLength(1);
    expect(entries).toEqual([]);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });
});
