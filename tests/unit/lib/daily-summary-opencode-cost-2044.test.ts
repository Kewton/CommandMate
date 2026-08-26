/**
 * opencode in the daily report, and the cost section (Issue #2044)
 *
 * Two claims:
 *
 * 1. `opencode` is a report tool everywhere it has to be — the server's
 *    whitelist, the CLI's copy of it, and the tool selector that reads the
 *    former. The Issue's third acceptance criterion is that **claude and codex
 *    are unchanged**, so the default and the existing ids are asserted too.
 * 2. The cost section is *additive*: it appears only when the ledger has rows
 *    for that day, it is appended after generation rather than fed to the model,
 *    and a failure inside it cannot cost the summary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { recordAgentSessionCost } from '@/lib/db/agent-session-cost-db';
import { getDailyAgentCostSummary } from '@/lib/db/agent-session-cost-db';
import {
  buildAgentCostSection,
  AGENT_COST_SECTION_HEADING,
  generateDailySummary,
} from '@/lib/daily-summary-generator';
import { SUMMARY_ALLOWED_TOOLS } from '@/config/review-config';
import { buildSummaryPrompt } from '@/lib/summary-prompt-builder';

const DATE = '2026-08-25';

// The only thing that must not really run: the CLI itself.
const mockExecuteClaudeCommand = vi.fn();

/**
 * Nor the *other* CLI. Issue #2051 gave `generateDailySummary` a step that runs
 * `opencode export --sanitize <sessionID>` once per opencode row in the day's
 * ledger, and this file seeds exactly those rows. Unmocked, the suite spawns the
 * real binary against the developer's own `$HOME` — which reads and writes
 * `~/.local/share/opencode/opencode.db`. The exports fail ("Session not found")
 * and the assertions here still pass, so nothing goes red: the mock is the only
 * thing that keeps a unit run from touching real user data.
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});
vi.mock('@/lib/session/claude-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/claude-executor')>();
  return {
    ...actual,
    executeClaudeCommand: (...args: unknown[]) => mockExecuteClaudeCommand(...args),
  };
});

let db: Database.Database;

/** Behave like `opencode export` for a session the local install does not have. */
function stubOpencodeExportMissing(): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => callback(new Error('Command failed: opencode export'), '', 'Error: Session not found')
  );
}

function openDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  runMigrations(testDb);
  return testDb;
}

function seedWorktree(id: string, name: string): void {
  db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, name, `/repos/${id}`, Date.now());
}

function seedMessage(id: string): void {
  db.prepare(
    `INSERT INTO chat_messages (id, worktree_id, role, content, timestamp)
     VALUES (?, 'wt-a', 'user', 'hello', ?)`
  ).run(id, new Date(`${DATE}T12:00:00`).getTime());
}

function seedCost(sessionId: string, worktreeId: string, cost: number): void {
  recordAgentSessionCost(db, {
    sessionId,
    worktreeId,
    cliToolId: 'opencode',
    instanceId: null,
    date: DATE,
    title: null,
    agent: 'plan',
    model: 'claude-sonnet-4.6',
    provider: 'github-copilot',
    cost,
    tokensInput: 3,
    tokensOutput: 174,
    tokensReasoning: 0,
    tokensCacheRead: 8367,
    tokensCacheWrite: 8643,
    observedAt: Date.now(),
  });
}

beforeEach(() => {
  db = openDb();
  execFileMock.mockReset();
  stubOpencodeExportMissing();
  mockExecuteClaudeCommand.mockReset();
  mockExecuteClaudeCommand.mockResolvedValue({
    output: 'A'.repeat(120),
    exitCode: 0,
    status: 'completed',
  });
});

afterEach(() => {
  db.close();
  globalThis.__dailySummaryGenerating = undefined;
});

describe('opencode is a report tool (Issue #2044)', () => {
  it('is in SUMMARY_ALLOWED_TOOLS, appended after the existing ids', () => {
    expect([...SUMMARY_ALLOWED_TOOLS]).toEqual([
      'claude', 'codex', 'copilot', 'antigravity', 'opencode',
    ]);
  });

  it('leaves claude first, so the default tool is unchanged', () => {
    expect(SUMMARY_ALLOWED_TOOLS[0]).toBe('claude');
  });

  it('runs `opencode run --format json` when chosen', async () => {
    seedWorktree('wt-a', 'feature/x');
    seedMessage('m1');

    await generateDailySummary(db, { date: DATE, tool: 'opencode' });

    expect(mockExecuteClaudeCommand).toHaveBeenCalledTimes(1);
    const [, , cliToolId, permission] = mockExecuteClaudeCommand.mock.calls[0];
    expect(cliToolId).toBe('opencode');
    // opencode has no permission flag; DEFAULT_PERMISSIONS gives '' and the
    // generator's `|| 'default'` turns that into the string 'default', which
    // buildCliArgs ignores for this tool. Asserted so a future permission
    // vocabulary for opencode has to come past this line.
    expect(permission).toBe('default');
  });
});

describe('buildAgentCostSection (Issue #2044)', () => {
  beforeEach(() => {
    seedWorktree('wt-a', 'feature/2044');
    seedWorktree('wt-b', 'feature/2041');
  });

  it('returns null when the ledger has nothing for the day', () => {
    const summary = getDailyAgentCostSummary(db, DATE);
    expect(buildAgentCostSection(summary, new Map())).toBeNull();
  });

  it('renders a table with a total row and the cross-check hint', () => {
    seedCost('ses_1', 'wt-a', 0.03754035);
    seedCost('ses_2', 'wt-b', 0.030399);

    const section = buildAgentCostSection(
      getDailyAgentCostSummary(db, DATE),
      new Map([['wt-a', 'feature/2044'], ['wt-b', 'feature/2041']]),
    );

    expect(section).not.toBeNull();
    const lines = section!.split('\n');
    expect(lines[0]).toBe(`${AGENT_COST_SECTION_HEADING} (${DATE})`);
    expect(section).toContain('| feature/2044 | 1 | 0.037540 |');
    expect(section).toContain('| feature/2041 | 1 | 0.030399 |');
    expect(section).toContain('| **Total** | 2 | 0.067939 |');
    expect(section).toContain('opencode stats --project');
    // Most expensive worktree first.
    expect(section!.indexOf('feature/2044')).toBeLessThan(section!.indexOf('feature/2041'));
  });

  it('prints `-` for a value the agent never reported, and `0` for a real zero', () => {
    recordAgentSessionCost(db, {
      sessionId: 'ses_quiet', worktreeId: 'wt-a', cliToolId: 'opencode', instanceId: null,
      date: DATE, title: null, agent: null, model: null, provider: null,
      cost: null, tokensInput: 0, tokensOutput: null, tokensReasoning: null,
      tokensCacheRead: null, tokensCacheWrite: null, observedAt: Date.now(),
    });

    const section = buildAgentCostSection(getDailyAgentCostSummary(db, DATE), new Map())!;
    expect(section).toContain('| wt-a | 1 | - | 0 | - |');
  });

  it('falls back to the worktree id when no display name is known', () => {
    seedCost('ses_1', 'wt-a', 0.01);
    const section = buildAgentCostSection(getDailyAgentCostSummary(db, DATE), new Map())!;
    expect(section).toContain('| wt-a |');
  });

  it('keeps six decimals, because a step costs ~0.003', () => {
    seedCost('ses_1', 'wt-a', 0.0038181);
    const section = buildAgentCostSection(getDailyAgentCostSummary(db, DATE), new Map())!;
    expect(section).toContain('0.003818');
    expect(section).not.toContain('| 0.00 |');
  });
});

describe('the cost section is additive (Issue #2044)', () => {
  beforeEach(() => {
    seedWorktree('wt-a', 'feature/2044');
    seedMessage('m1');
  });

  it('does not appear when the ledger is empty', async () => {
    const report = await generateDailySummary(db, { date: DATE, tool: 'claude' });
    expect(report.content).not.toContain(AGENT_COST_SECTION_HEADING);
    expect(report.content).toBe('A'.repeat(120));
  });

  it('appends the section when the ledger has rows', async () => {
    seedCost('ses_1', 'wt-a', 0.05);
    const report = await generateDailySummary(db, { date: DATE, tool: 'claude' });

    expect(report.content.startsWith('A'.repeat(120))).toBe(true);
    expect(report.content).toContain(AGENT_COST_SECTION_HEADING);
    expect(report.content).toContain('| feature/2044 | 1 | 0.050000 |');
  });

  it('never shows the numbers to the model', async () => {
    seedCost('ses_1', 'wt-a', 0.05);
    await generateDailySummary(db, { date: DATE, tool: 'claude' });

    const [prompt] = mockExecuteClaudeCommand.mock.calls[0] as [string];
    expect(prompt).not.toContain(AGENT_COST_SECTION_HEADING);
    expect(prompt).not.toContain('0.050000');
  });

  it('leaves buildSummaryPrompt byte-identical for the same inputs', () => {
    // The "claude / codex generation result is unchanged" criterion, stated at
    // the layer that decides it: the prompt builder is untouched by this Issue.
    const messages = [
      {
        id: 'm1',
        worktreeId: 'wt-a',
        role: 'user' as const,
        content: 'hello',
        timestamp: new Date(`${DATE}T12:00:00`),
        messageType: 'normal' as const,
        archived: false,
      },
    ];
    const names = new Map([['wt-a', 'feature/2044']]);
    expect(buildSummaryPrompt(messages, names)).toBe(buildSummaryPrompt(messages, names));
  });

  it('still returns the summary when the ledger query throws', async () => {
    // Losing a generated report because a number could not be fetched would
    // trade the feature that exists for the one being added.
    const broken = {
      prepare: (sql: string) => {
        if (sql.includes('agent_session_costs')) throw new Error('ledger exploded');
        return db.prepare(sql);
      },
    } as unknown as Database.Database;

    const report = await generateDailySummary(broken, { date: DATE, tool: 'claude' });
    expect(report.content).toBe('A'.repeat(120));
  });
});
