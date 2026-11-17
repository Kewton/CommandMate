/**
 * Issue #4436: the daily summary runs `<tool> -p` unattended, so it is a
 * `schedule` operation for the tool policy. Under the default declaration
 * (`personal`) antigravity is refused before anything is launched; the API
 * answers 409 `{ code: TOOL_POLICY_DENIED, error, reason, links }`. Other tools,
 * and antigravity with a declaration, run exactly once as before.
 *
 * The CLI is a spy (no `agy` runs, nothing under `~/.gemini` is read).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  ANTIGRAVITY_CONSUMER_TERMS,
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_URL,
  TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED_MESSAGE,
  USAGE_DECLARATION_ENV,
} from '@/lib/tool-policy/policy';
import { SUMMARY_ALLOWED_TOOLS } from '@/config/review-config';

const DATE = '2026-08-25';

const mockExecuteClaudeCommand = vi.fn();
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});
vi.mock('@/lib/session/claude-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/claude-executor')>();
  return { ...actual, executeClaudeCommand: (...args: unknown[]) => mockExecuteClaudeCommand(...args) };
});

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { generateDailySummary, ToolPolicyDeniedError } from '@/lib/daily-summary-generator';
import { POST } from '@/app/api/daily-summary/route';

const savedDeclaration = process.env[USAGE_DECLARATION_ENV];
function declare(value: string | undefined): void {
  if (value === undefined) delete process.env[USAGE_DECLARATION_ENV];
  else process.env[USAGE_DECLARATION_ENV] = value;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run('wt-a', 'feature/x', '/repos/wt-a', Date.now());
  db.prepare(
    "INSERT INTO chat_messages (id, worktree_id, role, content, timestamp) VALUES ('m1', 'wt-a', 'user', 'hello', ?)"
  ).run(new Date(`${DATE}T12:00:00`).getTime());
  execFileMock.mockReset();
  execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, so: string, se: string) => void) =>
    cb(new Error('not run in this test'), '', '')
  );
  mockExecuteClaudeCommand.mockReset();
  mockExecuteClaudeCommand.mockResolvedValue({ output: 'A'.repeat(120), exitCode: 0, status: 'completed' });
  declare(undefined);
  globalThis.__dailySummaryGenerating = undefined;
});

afterEach(() => {
  declare(savedDeclaration);
  globalThis.__dailySummaryGenerating = undefined;
  db.close();
});

const DECLARATIONS: Array<[string, string | undefined, boolean]> = [
  ['unset (personal)', undefined, false],
  ['personal', 'personal', false],
  ['api-key', 'api-key', true],
  ['enterprise', 'enterprise', true],
];

describe('Issue #4436: generateDailySummary under the tool policy', () => {
  for (const tool of SUMMARY_ALLOWED_TOOLS) {
    for (const [label, value, unlocks] of DECLARATIONS) {
      const runs = tool !== 'antigravity' || unlocks;
      it(`4436 I1/I2/I3: ${tool} with the declaration ${label} ${runs ? 'runs once' : 'is refused (0 runs)'}`, async () => {
        declare(value);
        const pending = generateDailySummary(db, { date: DATE, tool });
        if (runs) {
          await expect(pending).resolves.toMatchObject({ date: DATE, generatedByTool: tool });
          expect(mockExecuteClaudeCommand).toHaveBeenCalledTimes(1);
          expect(mockExecuteClaudeCommand.mock.calls[0][2]).toBe(tool);
        } else {
          await expect(pending).rejects.toBeInstanceOf(ToolPolicyDeniedError);
          expect(mockExecuteClaudeCommand).not.toHaveBeenCalled();
          expect(execFileMock).not.toHaveBeenCalled();
          // The concurrency flag is not left behind by a refusal.
          expect(globalThis.__dailySummaryGenerating).toBeUndefined();
          const saved = db.prepare('SELECT COUNT(*) AS n FROM daily_reports').get() as { n: number };
          expect(saved.n).toBe(0);
        }
      });
    }
  }

  it('4436 I1: the refusal carries the code, the reason and the FAQ link', async () => {
    const error = await generateDailySummary(db, { date: DATE, tool: 'antigravity' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolPolicyDeniedError);
    const denied = error as InstanceType<typeof ToolPolicyDeniedError>;
    expect(denied.decision).toMatchObject({
      allowed: false,
      code: TOOL_POLICY_DENIED,
      reason: ANTIGRAVITY_CONSUMER_TERMS,
      operation: 'schedule',
      links: { faq: ANTIGRAVITY_FAQ_URL },
    });
    expect(denied.message).toBe(TOOL_POLICY_DENIED_MESSAGE);
  });
});

describe('Issue #4436: POST /api/daily-summary answers 409 for a refused tool', () => {
  function post(body: unknown): Promise<Response> {
    const request = new NextRequest('http://localhost:3000/api/daily-summary', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return POST(request) as Promise<Response>;
  }

  it('4436 I1: antigravity without a declaration is 409 { code, error, reason, links } and runs nothing', async () => {
    const response = await post({ date: DATE, tool: 'antigravity' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: TOOL_POLICY_DENIED,
      error: TOOL_POLICY_DENIED_MESSAGE,
      reason: ANTIGRAVITY_CONSUMER_TERMS,
      links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
    });
    expect(mockExecuteClaudeCommand).not.toHaveBeenCalled();
  });

  it('4436 I2: antigravity with CM_ANTIGRAVITY_USAGE=api-key generates as before', async () => {
    declare('api-key');
    const response = await post({ date: DATE, tool: 'antigravity' });
    expect(response.status).toBe(200);
    expect(mockExecuteClaudeCommand).toHaveBeenCalledTimes(1);
  });

  it('4436 I3: claude is unchanged', async () => {
    const response = await post({ date: DATE, tool: 'claude' });
    expect(response.status).toBe(200);
    expect(mockExecuteClaudeCommand).toHaveBeenCalledTimes(1);
  });
});

describe('Issue #4436 I1a: the daily summary runs the tool it judged', () => {
  it('4436 I1a: params.tool switched to antigravity after the judgement (during collection) still runs claude, never agy', async () => {
    const params: { date: string; tool: string } = { date: DATE, tool: 'claude' };
    const pending = generateDailySummary(db, params as Parameters<typeof generateDailySummary>[1]);
    // The generator is past its judgement and into its first await.
    params.tool = 'antigravity';
    await expect(pending).resolves.toMatchObject({ generatedByTool: 'claude' });
    expect(mockExecuteClaudeCommand).toHaveBeenCalledTimes(1);
    expect(mockExecuteClaudeCommand.mock.calls[0][2]).toBe('claude');
  });

  it('4436 I1a (control): with CM_ANTIGRAVITY_USAGE=api-key antigravity runs as before', async () => {
    declare('api-key');
    await expect(generateDailySummary(db, { date: DATE, tool: 'antigravity' })).resolves.toMatchObject({
      generatedByTool: 'antigravity',
    });
    expect(mockExecuteClaudeCommand.mock.calls[0][2]).toBe('antigravity');
  });
});
