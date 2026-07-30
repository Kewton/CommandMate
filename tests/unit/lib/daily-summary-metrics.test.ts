/**
 * Daily report × Eval metrics integration (Issue #1551, Phase 4).
 *
 * `summary-prompt-builder` and `vibe-metrics` are deliberately NOT mocked. The
 * only claim worth making about this wiring is that rows in a real database
 * become real numbers inside the prompt string the AI receives, and a mocked
 * builder would reduce that to "some object was passed to some function".
 *
 * The assertions match on the interpolated values, never on the key names
 * alone: a section rendering `total=` with nothing after it still contains
 * every label, so label-matching would pass on an empty section.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

const mockExecuteClaudeCommand = vi.fn();
vi.mock('@/lib/session/claude-executor', () => ({
  executeClaudeCommand: (...args: unknown[]) => mockExecuteClaudeCommand(...args),
  MAX_MESSAGE_LENGTH: 10000,
}));

vi.mock('@/lib/db/chat-db', () => ({
  getMessagesByDateRange: () => [
    {
      id: 'msg-1',
      worktreeId: 'wt-1',
      role: 'user',
      content: 'implement the loader',
      timestamp: new Date(),
      messageType: 'normal',
      archived: false,
    },
  ],
}));

vi.mock('@/lib/db/daily-report-db', () => ({
  saveDailyReport: (_db: unknown, input: Record<string, unknown>) => ({
    ...input,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
}));

vi.mock('@/lib/db/worktree-db', () => ({
  getWorktrees: () => [{ id: 'wt-1', name: 'feature/loader' }],
}));

vi.mock('@/lib/db/db-repository', () => ({ getAllRepositories: () => [] }));
vi.mock('@/lib/git/git-utils', () => ({ collectRepositoryCommitLogs: async () => new Map() }));
vi.mock('@/lib/git/github-api', () => ({ collectIssueInfos: async () => [] }));
vi.mock('@/lib/utils', () => ({
  withTimeout: (promise: Promise<unknown>) => promise,
}));

import { generateDailySummary } from '@/lib/daily-summary-generator';

const TARGET_DATE = '2026-04-02';
const PREVIOUS_DATE = '2026-04-01';

function dayStart(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

let db: Database.Database;
let taskSeq = 0;
let runSeq = 0;

function seedTask(status: string, at: number): void {
  const id = `task-${++taskSeq}`;
  db.prepare(`
    INSERT INTO tasks (id, worktree_id, cli_tool_id, instance_id, title, goal,
                       contract_path, contract_json, status,
                       last_verification_run_id, created_at, updated_at)
    VALUES (?, 'wt-1', 'claude', NULL, 'a task', 'do it', NULL, '{}', ?, NULL, ?, ?)
  `).run(id, status, at, at);
}

function seedRun(status: string, at: number): number {
  const id = ++runSeq;
  db.prepare(`
    INSERT INTO verification_runs (id, worktree_id, instance_id, task_id, trigger,
                                   status, base_ref, started_at, finished_at)
    VALUES (?, 'wt-1', NULL, NULL, 'manual', ?, NULL, ?, NULL)
  `).run(id, status, at);
  return id;
}

function seedGate(runId: number, gateId: string, status: string, at: number): void {
  db.prepare(`
    INSERT INTO verification_gate_results (run_id, gate_id, command, status,
                                           exit_code, duration_ms, log_tail, started_at)
    VALUES (?, ?, 'npm run x', ?, NULL, NULL, NULL, ?)
  `).run(runId, gateId, status, at);
}

function seedEvent(
  taskId: string,
  event: string,
  fromStatus: string,
  toStatus: string | null,
  at: number
): void {
  db.prepare(`
    INSERT INTO task_events (task_id, event, from_status, to_status, payload_json, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(taskId, event, fromStatus, toStatus, at);
}

/**
 * A day's worth of activity: 3 tasks (2 succeeded), 4 runs (3 passed), a run
 * whose `unit` gate failed twice, 2 human answers and 5 auto answers, and one
 * task that failed and was re-instructed once.
 */
function seedActivity(date: string): void {
  const noon = dayStart(date) + 12 * 60 * 60 * 1000;

  seedTask('succeeded', noon);
  seedTask('succeeded', noon);
  seedTask('failed', noon);

  seedRun('passed', noon);
  seedRun('passed', noon);
  seedRun('passed', noon);
  const failedRun = seedRun('failed', noon);
  seedGate(failedRun, 'unit', 'failed', noon);
  seedGate(failedRun, 'unit', 'failed', noon);
  seedGate(failedRun, 'lint', 'skipped', noon);

  for (let i = 0; i < 2; i++) {
    seedEvent(`ev-${date}`, 'prompt_answered_human', 'waiting_input', 'running', noon);
  }
  for (let i = 0; i < 5; i++) {
    seedEvent(`ev-${date}`, 'prompt_answered_auto', 'waiting_input', 'running', noon);
  }

  seedEvent(`retry-${date}`, 'verify_failed', 'verifying', 'failed', noon);
  seedEvent(`retry-${date}`, 'message_sent', 'failed', 'running', noon);
}

/** The prompt string generateDailySummary handed to the AI. */
function capturedPrompt(): string {
  return String(mockExecuteClaudeCommand.mock.calls[0][0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__dailySummaryGenerating = undefined;
  db = new Database(':memory:');
  runMigrations(db);
  taskSeq = 0;
  runSeq = 0;
  mockExecuteClaudeCommand.mockResolvedValue({
    output: 'x'.repeat(200),
    exitCode: 0,
    status: 'completed',
  });
});

afterEach(() => {
  db.close();
  globalThis.__dailySummaryGenerating = undefined;
});

describe('generateDailySummary — verification_metrics section', () => {
  it('interpolates the seeded counts into the prompt', async () => {
    seedActivity(TARGET_DATE);

    await generateDailySummary(db, { date: TARGET_DATE, tool: 'claude' });
    const prompt = capturedPrompt();

    expect(prompt).toContain('<verification_metrics>');
    expect(prompt).toContain('Period: last 1 day(s)');
    // 3 tasks, 2 of them succeeded: 2/3 = 66.666..% -> 66.7%
    expect(prompt).toContain(
      'Tasks: total=3 succeeded=2 failed=1 not_started=0 cancelled=0 success_rate=66.7%'
    );
    // 4 runs, 3 passed: 75.0%
    expect(prompt).toContain(
      'Verification: runs=4 passed=3 failed=1 not_started=0 pass_rate=75.0%'
    );
    // `lint` was skipped, not failed, so it must not appear.
    expect(prompt).toContain('Gate failures: unit=2');
    expect(prompt).not.toContain('lint');
    expect(prompt).toContain('Intervention: human_responses=2 auto_answered=5');
    // One task reached `failed`, one re-instruction: 1.0
    expect(prompt).toContain('Retry loops: avg_per_failed_task=1.0');
    expect(prompt).toContain('</verification_metrics>');
  });

  it('omits the section on a day with no recorded activity', async () => {
    await generateDailySummary(db, { date: TARGET_DATE, tool: 'claude' });

    expect(capturedPrompt()).not.toContain('verification_metrics');
  });

  // The window follows `date`, not the clock. A report regenerated for last
  // Tuesday must describe last Tuesday.
  it('anchors the window to the requested date, not to now', async () => {
    seedActivity(PREVIOUS_DATE);

    await generateDailySummary(db, { date: TARGET_DATE, tool: 'claude' });
    expect(capturedPrompt()).not.toContain('verification_metrics');

    vi.clearAllMocks();
    mockExecuteClaudeCommand.mockResolvedValue({
      output: 'x'.repeat(200),
      exitCode: 0,
      status: 'completed',
    });

    await generateDailySummary(db, { date: PREVIOUS_DATE, tool: 'claude' });
    expect(capturedPrompt()).toContain('Tasks: total=3 succeeded=2');
  });

  it('reports only the requested day when neighbouring days also have activity', async () => {
    seedActivity(TARGET_DATE);
    // Six extra tasks the day before: a leaking window would report total=9.
    for (let i = 0; i < 6; i++) {
      seedTask('succeeded', dayStart(PREVIOUS_DATE) + 60_000);
    }

    await generateDailySummary(db, { date: TARGET_DATE, tool: 'claude' });

    expect(capturedPrompt()).toContain('Tasks: total=3 succeeded=2');
    expect(capturedPrompt()).not.toContain('total=9');
  });

  it('still generates a report on a database without the Phase 1-3 tables', async () => {
    db.exec('DROP TABLE verification_gate_results');
    db.exec('DROP TABLE verification_runs');
    db.exec('DROP TABLE task_events');
    db.exec('DROP TABLE tasks');

    const report = await generateDailySummary(db, { date: TARGET_DATE, tool: 'claude' });

    expect(report).toBeDefined();
    expect(capturedPrompt()).not.toContain('verification_metrics');
  });
});
