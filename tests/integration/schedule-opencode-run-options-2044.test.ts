/**
 * A CMATE.md schedule reaches `execFile` with the arguments it asked for
 * (Issue #2044).
 *
 * ## Why this test exists separately from the parser suite
 *
 * `tests/unit/lib/cmate-opencode-run-options-2044.test.ts` proves the column
 * grammar: text in, options out, argv out. It stayed green through the first
 * pass of #2044 — during which `executeSchedule()` did **not** call the resolver
 * and a scheduled `opencode --agent plan --variant high` ran with no agent and
 * no variant. A suite that verifies both ends of a wire proves nothing about
 * the wire.
 *
 * So this one starts at `executeSchedule(state)` — the scheduler's actual entry
 * point, the function `croner` fires — and ends at the arguments
 * `child_process.execFile` receives. Only `child_process` and the database are
 * substituted; `resolveScheduleExecuteOptions`, `resolveScheduleCommandOptions`,
 * `executeClaudeCommand` and `buildCliArgs` are all the real ones.
 *
 * ## The frozen argv table
 *
 * Issue #2044's third acceptance criterion is that the other tools are
 * unchanged. `EXPECTED_ARGV` writes each one out as a literal rather than
 * deriving it, because a derived expectation moves with the code it is meant to
 * pin. Every entry below is what these tools produced before #2044 touched
 * anything — opencode's is the only line that changed, and it changed in both
 * directions this Issue cares about (`--format json`, and the run options).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'module';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({ createLogger: vi.fn(() => mockLogger) }));

import { execFile } from 'child_process';
import { executeSchedule, type ScheduleState } from '@/lib/job-executor';
import { parseCmateFile } from '@/lib/cmate-parser';
import { parseSchedulesSection } from '@/lib/cmate-parser';
import type { ScheduleEntry } from '@/types/cmate';

const mockedExecFile = vi.mocked(execFile);

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/**
 * job-executor reaches the DB through a lazy CJS `require('./db/db-instance')`,
 * which `vi.mock` does not intercept. Patching `Module._load` is how
 * `tests/unit/lib/job-executor.test.ts` substitutes it, and this file follows
 * the same route rather than inventing a second one.
 */
type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const M = Module as unknown as ModuleWithLoad;
const originalLoad = M._load;

/** Every `run()` the scheduler issued, so a swallowed failure cannot hide. */
let runCalls: Array<{ sql: string; args: unknown[] }>;

function installDbStub(vibeLocalModel: string | null): void {
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
              sql.includes('FROM worktrees')
                ? { path: '/repos/wt-2044', vibe_local_model: vibeLocalModel }
                : undefined,
          }),
        }),
      };
    }
    return originalLoad.call(Module, request, parent, isMain);
  };
}

function makeMockChild(): ChildProcess {
  return { stdin: { end: vi.fn() }, on: vi.fn(), pid: undefined } as unknown as ChildProcess;
}

/** Let `executeClaudeCommand` resolve: invoke execFile's callback with stdout. */
function resolveExecFileWith(stdout: string): void {
  mockedExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (e: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(null, stdout, '');
    return makeMockChild();
  }) as unknown as typeof execFile);
}

/** The (command, argv) pair the single execFile call received. */
function capturedInvocation(): { command: string; argv: string[] } {
  expect(mockedExecFile, 'execFile was never called').toHaveBeenCalledTimes(1);
  const [command, argv] = mockedExecFile.mock.calls[0] as unknown as [string, string[]];
  return { command, argv };
}

/** The status `updateExecutionLog` wrote, so a caught exception is visible. */
function loggedStatus(): unknown {
  const update = runCalls.find((call) => call.sql.includes('UPDATE execution_logs SET status'));
  return update?.args[0];
}

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    name: 'nightly',
    cronExpression: '0 3 * * *',
    message: 'do something',
    cliToolId: 'claude',
    enabled: true,
    permission: '',
    ...overrides,
  };
}

function stateFor(e: ScheduleEntry): ScheduleState {
  return {
    scheduleId: 'sch-2044',
    worktreeId: 'wt-2044',
    cronJob: undefined as unknown as ScheduleState['cronJob'],
    isExecuting: false,
    entry: e,
  };
}

async function runSchedule(e: ScheduleEntry): Promise<void> {
  await executeSchedule(stateFor(e));
}

beforeEach(() => {
  runCalls = [];
  mockedExecFile.mockReset();
  resolveExecFileWith('ok');
  installDbStub(null);
});

afterEach(() => {
  M._load = originalLoad;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The acceptance criterion, from the scheduler's entry point
// ---------------------------------------------------------------------------

const CMATE_WITH_OPENCODE = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| nightly | 0 3 * * * | Review today's diff | opencode --agent plan --variant high | true | |
`;

describe('a CMATE.md opencode schedule launches with its own arguments (Issue #2044)', () => {
  it('reaches execFile with --agent plan --variant high', async () => {
    const entries = parseSchedulesSection(parseCmateFile(CMATE_WITH_OPENCODE).get('Schedules') ?? []);
    expect(entries).toHaveLength(1);

    await runSchedule(entries[0]);

    expect(capturedInvocation()).toEqual({
      command: 'opencode',
      argv: ['run', '--format', 'json', '--agent', 'plan', '--variant', 'high', "Review today's diff"],
    });
    expect(loggedStatus(), 'the run did not complete').toBe('completed');
  });

  it('carries every option the column can express', async () => {
    const cmate = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| nightly | 0 3 * * * | go | opencode --model github-copilot/claude-sonnet-4.6 --agent plan --variant high --continue --title "nightly review" | true | |
`;
    const entries = parseSchedulesSection(parseCmateFile(cmate).get('Schedules') ?? []);
    expect(entries).toHaveLength(1);

    await runSchedule(entries[0]);

    expect(capturedInvocation().argv).toEqual([
      'run', '--format', 'json',
      '-m', 'github-copilot/claude-sonnet-4.6',
      '--agent', 'plan',
      '--variant', 'high',
      '-c',
      '--title', 'nightly review',
      'go',
    ]);
  });

  it('runs bare when the column names no options', async () => {
    await runSchedule(entry({ cliToolId: 'opencode', message: 'go' }));
    expect(capturedInvocation().argv).toEqual(['run', '--format', 'json', 'go']);
  });

  it('extracts the answer out of the JSON stream it asked for', async () => {
    // Not a second extraction test — the point is that the `--format json` this
    // path adds and the decoding `executeClaudeCommand` applies are the same
    // decision, so a schedule's execution log holds prose rather than events.
    resolveExecFileWith(
      [
        '{"type":"step_start","part":{"messageID":"msg_a","type":"step-start"}}',
        '{"type":"text","part":{"messageID":"msg_a","type":"text","text":"reviewed 3 files"}}',
        '{"type":"step_finish","part":{"messageID":"msg_a","cost":0.004}}',
      ].join('\n'),
    );

    await runSchedule(entry({ cliToolId: 'opencode', message: 'go' }));

    const update = runCalls.find((call) => call.sql.includes('UPDATE execution_logs SET status'));
    expect(update?.args[1]).toBe('reviewed 3 files');
  });
});

// ---------------------------------------------------------------------------
// Every other tool is byte-identical
// ---------------------------------------------------------------------------

/**
 * What each tool produced before this Issue existed. Literals on purpose.
 */
const EXPECTED_ARGV: ReadonlyArray<{
  name: string;
  entry: Partial<ScheduleEntry>;
  vibeLocalModel?: string | null;
  command: string;
  argv: string[];
}> = [
  {
    name: 'claude',
    entry: { cliToolId: 'claude', permission: 'acceptEdits' },
    command: 'claude',
    argv: ['-p', 'do something', '--output-format', 'text', '--permission-mode', 'acceptEdits'],
  },
  {
    // Pre-existing and untouched by #2044: `buildCliArgs` writes
    // `permission ?? 'acceptEdits'`, and `''` is not nullish, so an empty
    // permission reaches claude as an empty `--permission-mode` value. It does
    // not arise from a real CMATE.md row — `parseSchedulesSection()` fills
    // `DEFAULT_PERMISSIONS.claude` for an empty cell (asserted below) — but it
    // is what this entry point does with the string, and pinning the real
    // behaviour is the point of a byte-identity table.
    name: 'claude (empty permission string)',
    entry: { cliToolId: 'claude', permission: '' },
    command: 'claude',
    argv: ['-p', 'do something', '--output-format', 'text', '--permission-mode', ''],
  },
  {
    name: 'codex',
    entry: { cliToolId: 'codex', permission: 'workspace-write' },
    command: 'codex',
    argv: ['exec', 'do something', '--sandbox', 'workspace-write'],
  },
  {
    name: 'codex (danger-full-access)',
    entry: { cliToolId: 'codex', permission: 'danger-full-access' },
    command: 'codex',
    argv: ['exec', 'do something', '--sandbox', 'danger-full-access'],
  },
  {
    name: 'gemini',
    entry: { cliToolId: 'gemini', permission: '' },
    command: 'gemini',
    argv: ['-p', 'do something'],
  },
  {
    name: 'copilot',
    entry: { cliToolId: 'copilot', permission: 'allow-all-tools', model: 'gpt-5' },
    command: 'gh',
    argv: ['copilot', '--model', 'gpt-5', '-p', 'do something', '--allow-all-tools'],
  },
  {
    name: 'copilot (no model)',
    entry: { cliToolId: 'copilot', permission: 'yolo' },
    command: 'gh',
    argv: ['copilot', '-p', 'do something', '--yolo'],
  },
  {
    name: 'antigravity',
    entry: { cliToolId: 'antigravity', permission: '--dangerously-skip-permissions' },
    command: 'agy',
    argv: ['-p', 'do something', '--dangerously-skip-permissions'],
  },
  {
    name: 'vibe-local (model from the DB)',
    entry: { cliToolId: 'vibe-local', permission: '' },
    vibeLocalModel: 'qwen3:8b',
    command: 'vibe-local',
    argv: ['--model', 'qwen3:8b', '-p', 'do something', '-y'],
  },
  {
    name: 'vibe-local (no DB model)',
    entry: { cliToolId: 'vibe-local', permission: '' },
    vibeLocalModel: null,
    command: 'vibe-local',
    argv: ['-p', 'do something', '-y'],
  },
];

describe('the other tools launch exactly as they did (Issue #2044)', () => {
  it.each(EXPECTED_ARGV)('$name', async ({ entry: overrides, vibeLocalModel, command, argv }) => {
    installDbStub(vibeLocalModel ?? null);

    await runSchedule(entry(overrides));

    expect(capturedInvocation()).toEqual({ command, argv });
    expect(loggedStatus()).toBe('completed');
  });

  it('does not hand opencode options to a tool that has no such flags', async () => {
    // The row could not be written this way through CMATE.md — the parser
    // refuses it — but the resolver is exported and reachable, so the gate is
    // asserted where it lives rather than assumed from the grammar.
    await runSchedule(
      entry({ cliToolId: 'copilot', permission: 'allow-all-tools', agent: 'plan', variant: 'high', title: 't' }),
    );
    expect(capturedInvocation().argv).toEqual([
      'copilot', '-p', 'do something', '--allow-all-tools',
    ]);
  });

  it('gives an empty claude Permission cell the parser default, not an empty flag', async () => {
    // The companion to the table row above: a real row never reaches the
    // executor with `permission: ''` for claude, because the parser resolves it.
    const cmate = `## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| nightly | 0 3 * * * | do something | claude | true | |
`;
    const entries = parseSchedulesSection(parseCmateFile(cmate).get('Schedules') ?? []);
    expect(entries[0].permission).toBe('acceptEdits');

    await runSchedule(entries[0]);
    expect(capturedInvocation().argv).toEqual([
      '-p', 'do something', '--output-format', 'text', '--permission-mode', 'acceptEdits',
    ]);
  });

  it('lets the CMATE.md model win over the DB one for a tool that has both', async () => {
    // Disjoint today (vibe-local is in neither Set), asserted so the order
    // survives a tool later being given both sources.
    installDbStub('from-db');
    await runSchedule(entry({ cliToolId: 'copilot', permission: 'yolo', model: 'from-cmate' }));
    expect(capturedInvocation().argv).toContain('from-cmate');
    expect(capturedInvocation().argv).not.toContain('from-db');
  });
});
