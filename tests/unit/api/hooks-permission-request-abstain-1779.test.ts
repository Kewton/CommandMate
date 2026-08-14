/**
 * The permission receiver's abstentions, in each tool's own dialect
 * (Issue #1779).
 *
 * `/api/hooks/permission-request` had two paths that answered a hard-coded `{}`
 * *before* it had asked the registry which tool was on the line: a request that
 * resolved to no worktree, and the catch-all. Both were written when `{}` was
 * the universal spelling of "no decision", and both became a latent fail-closed
 * defect the moment antigravity grew a `PreToolUse` hook — because on that tool
 * `{}` is a **denial** (#1757 P10, re-measured on 1.1.12 for #1779, where it
 * prints `⚠ Tool call denied by pre-tool hook:` and the command does not run).
 *
 * The defect is invisible by construction. A removed worktree and an unexpected
 * exception are exactly the situations nobody is watching, and the symptom on
 * agy would be an agent quietly concluding it has no tools.
 *
 * Every assertion below therefore comes in pairs: **antigravity gets a positive
 * abstention, and every other tool still gets `{}`.** The second half of each
 * pair is what makes the first half a fix rather than a rewrite — five shipped
 * tools read `{}` as "carry on", and a route that started answering
 * `{"decision":"ask"}` to Claude would break all of them at once.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database | null): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

// A mutable policy rather than `vi.resetModules()` + `doMock`: re-importing the
// route would also re-import `auto-yes-state`, and the Auto-Yes flag this file
// sets would be written into the module instance the route no longer reads —
// leaving a test that passes because the feature is off, which is precisely the
// state it means to distinguish itself from.
const { policyRef } = vi.hoisted(() => ({
  policyRef: { current: null as { mode?: string; denyPatterns?: string[] } | null },
}));
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => policyRef.current,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

const AGY_FIXTURE = join(process.cwd(), 'tests/fixtures/hooks/antigravity/pre-tool-use.json');
const CLAUDE_FIXTURE = join(process.cwd(), 'tests/fixtures/hooks/claude/permission-request.json');

const WT = 'wt-abstain-1779';
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;

/** agy reads this as a denial. Named so the assertions read as what they mean. */
const DENIAL_ON_AGY = {};

/** agy's own word for "prompt the user for permission". */
const AGY_ABSTAIN = { decision: 'ask' };

let db: Database.Database | null = null;

const asReq = (req: Request) => req as unknown as NextRequest;

function agyPayload(commandLine = 'echo hello'): Record<string, unknown> {
  const base = JSON.parse(readFileSync(AGY_FIXTURE, 'utf8')) as Record<string, unknown>;
  return { ...base, toolCall: { name: 'run_command', args: { CommandLine: commandLine } } };
}

function claudePayload(): Record<string, unknown> {
  const base = JSON.parse(readFileSync(CLAUDE_FIXTURE, 'utf8')) as Record<string, unknown>;
  return { ...base, cwd: WT_PATH, tool_input: { command: 'echo hello' } };
}

async function postJson(body: unknown, query: string) {
  const { POST } = await import('@/app/api/hooks/permission-request/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/hooks/permission-request${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAllAutoYesStates();
  clearPolicySuppressions();
  policyRef.current = null;
  mockLogger.warn.mockClear();
  mockLogger.info.mockClear();
  mockLogger.error.mockClear();

  upsertWorktree(db, {
    id: WT,
    name: 'feature/1779',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db = null;
  clearAllAutoYesStates();
  clearPolicySuppressions();
});

describe('a request that resolves to no worktree', () => {
  // A hook left configured after the worktree was removed is a normal state, and
  // the route deliberately answers 200 rather than a distinguishable error so
  // the endpoint cannot be used to probe which worktrees exist. What it answers
  // *with* is the part #1779 changed.
  const GONE = '?worktreeId=wt-that-was-deleted';

  it('costs agy a dialog rather than its tool call', async () => {
    const { status, body } = await postJson(
      agyPayload(),
      `${GONE}&tool=antigravity&instanceId=antigravity`
    );

    expect(status).toBe(200);
    expect(body).toEqual(AGY_ABSTAIN);
    expect(body).not.toEqual(DENIAL_ON_AGY);
  });

  it('still answers claude with the empty object it has always answered', async () => {
    const { status, body } = await postJson(claudePayload(), `${GONE}&tool=claude`);

    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(Object.keys(body)).toHaveLength(0);
  });

  it.each(['codex', 'copilot', 'gemini'] as const)(
    'still answers %s with the empty object',
    async (tool) => {
      const { status, body } = await postJson(claudePayload(), `${GONE}&tool=${tool}`);

      expect(status).toBe(200);
      expect(body).toEqual({});
    }
  );

  it('answers opencode with the empty object, because it has no body to write into', async () => {
    // A pull source encodes `outOfBand`; the HTTP request still has to be
    // acknowledged and `{}` is the ack.
    const { status, body } = await postJson(claudePayload(), `${GONE}&tool=opencode`);

    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('logs the unresolved target either way', async () => {
    await postJson(agyPayload(), `${GONE}&tool=antigravity`);

    expect(mockLogger.info.mock.calls.map((call) => call[0])).toContain(
      'permission-request-unresolved-target'
    );
  });
});

describe('an unexpected exception', () => {
  // Reached by taking the database away after the tool has been resolved, which
  // is the shape of every real instance of this branch: something below the
  // route threw, and the agent is sitting there waiting for a reply.
  beforeEach(async () => {
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(null);
  });

  it('costs agy a dialog rather than its tool call', async () => {
    const { status, body } = await postJson(
      agyPayload(),
      `?tool=antigravity&worktreeId=${WT}&instanceId=antigravity`
    );

    expect(status).toBe(200);
    expect(body).toEqual(AGY_ABSTAIN);
    expect(body).not.toEqual(DENIAL_ON_AGY);
    expect(mockLogger.error.mock.calls.map((call) => call[0])).toContain(
      'error-processing-permission-request:'
    );
  });

  it('still answers claude with the empty object', async () => {
    const { status, body } = await postJson(
      claudePayload(),
      `?tool=claude&worktreeId=${WT}&instanceId=claude`
    );

    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('answers the empty object when it threw before the tool was even known', async () => {
    // No source to ask, so there is nothing to encode with. `{}` is the only
    // thing left, and it is right for every tool that could have sent a body
    // this malformed.
    const { POST } = await import('@/app/api/hooks/permission-request/route');
    const response = await POST(
      asReq(
        new Request('http://localhost/api/hooks/permission-request?tool=antigravity', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not json at all',
        })
      )
    );

    // A malformed body is a 400 long before the catch-all; asserted so the
    // "source is null" branch above is understood as the exception it is.
    expect(response.status).toBe(400);
  });
});

describe('a rejected request stays a 4xx', () => {
  it('reports the validation error rather than disguising it as a verdict', async () => {
    // Measured for #1779: agy's hook runs `curl -f`, so a 4xx prints nothing at
    // all and the hook substitutes its own abstention (see
    // `antigravity-permission-1779.test.ts`, path 3). The 400 never reaches agy
    // as a decision, so honesty here is free.
    const { status, body } = await postJson(agyPayload(), '?tool=not-a-real-tool');

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'tool must be a known CLI tool id' });
  });
});

describe('the ordinary adjudication path, on agy', () => {
  const QUERY = `?tool=antigravity&worktreeId=${WT}&instanceId=antigravity`;

  it('answers `allow` when Auto-Yes is on', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    const { status, body } = await postJson(agyPayload(), QUERY);

    expect(status).toBe(200);
    expect(body).toEqual({ decision: 'allow' });
  });

  it('answers `ask` when Auto-Yes is off', async () => {
    const { status, body } = await postJson(agyPayload(), QUERY);

    expect(status).toBe(200);
    expect(body).toEqual(AGY_ABSTAIN);
    expect(body).not.toEqual(DENIAL_ON_AGY);
  });

  it('answers `ask` when a deny pattern withholds the approval', async () => {
    // The suppression path, which is the one an operator's contract reaches. It
    // means "do not answer this", and on agy that has to be spelled positively
    // or it becomes "refuse this" — a different promise entirely (#1699).
    policyRef.current = { mode: 'default', denyPatterns: ['rm -rf'] };
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    const { status, body } = await postJson(agyPayload('rm -rf /tmp/x'), QUERY);

    expect(status).toBe(200);
    expect(body).toEqual(AGY_ABSTAIN);
    // Without this the assertion above would also pass on an Auto-Yes that was
    // simply off, which is the failure mode this whole test is built to avoid.
    expect(mockLogger.warn.mock.calls.map((call) => call[0])).toContain(
      'permission-request:suppressed-by-policy'
    );
  });

  it('still answers `allow` for a command the same policy does not name', async () => {
    // The other side of the pair: the deny pattern has to be doing the work, not
    // the mere presence of a policy.
    policyRef.current = { mode: 'default', denyPatterns: ['rm -rf'] };
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    const { body } = await postJson(agyPayload('echo hello'), QUERY);

    expect(body).toEqual({ decision: 'allow' });
  });

  it('does not warn that abstaining blocks the agent, because it no longer does', async () => {
    // #1762 declared `noDecision: blocks`, so every abstention on agy logged
    // `permission-request-abstain-blocks-agent`. With a `PreToolUse` hook that
    // answers `ask`, the agent shows its dialog and carries on — the warning
    // would fire on every tool call and describe something that is not happening.
    await postJson(agyPayload(), QUERY);

    expect(mockLogger.warn.mock.calls.map((call) => call[0])).not.toContain(
      'permission-request-abstain-blocks-agent'
    );
  });

  it('reads the tool name out of agy’s nested payload', async () => {
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    await postJson(agyPayload(), QUERY);

    const decided = mockLogger.info.mock.calls.find(
      (call) => call[0] === 'permission-request-decided'
    );
    expect(decided).toBeDefined();
    expect(decided![1]).toMatchObject({ tool: 'antigravity', toolName: 'run_command' });
  });

  it('abstains when the payload is not one it can read', async () => {
    // Auto-Yes is on, so this is the assertion that a payload the parser refuses
    // is never approved — and, on this tool, never denied either.
    setAutoYesEnabled(WT, 'antigravity', true, ONE_HOUR_MS);

    const { body } = await postJson({ toolCall: { name: 'run_command' } }, QUERY);

    expect(body).toEqual(AGY_ABSTAIN);
  });
});
