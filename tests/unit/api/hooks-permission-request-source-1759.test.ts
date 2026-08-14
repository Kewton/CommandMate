/**
 * The permission receiver, as seen through `AgentEventSource` (Issue #1759).
 *
 * Two things are under test and they pull in opposite directions.
 *
 * **Nothing changed for Claude.** The verdict now travels as a `Verdict` and is
 * turned into bytes by Claude's source rather than by the route, so the risk is
 * a body that is *nearly* right. A wrong shape here is silent — Claude ignores
 * an unrecognised decision and shows the dialog, which looks exactly like a
 * working no-decision — so the bodies are asserted byte for byte, as
 * `hooks-permission-request.test.ts` already does for the untouched path.
 *
 * **Something has to change for the others.** The rule this codebase learned
 * from #1721 D5 — "when in doubt, answer `{}`; the agent carries on" — is false
 * on two of the six tools: opencode waits with no timeout (#1758 §5.5.3,
 * 10m19s measured) and antigravity reads `{}` as a denial (#1757 P10). Both
 * failures are invisible: the session stops, which is what a thinking agent
 * looks like. So abstaining on a source that blocks has to produce a record,
 * and that is what the second half of this file pins.
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

// `vi.hoisted` because `vi.mock` is hoisted above every const in this file.
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
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
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

vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');
const WT = 'wt-source-1759';
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;

let db: Database.Database;

const asReq = (req: Request) => req as unknown as NextRequest;

function bashPayload(command: string): Record<string, unknown> {
  const base = JSON.parse(readFileSync(join(FIXTURE_DIR, 'permission-request.json'), 'utf8'));
  return { ...base, cwd: WT_PATH, tool_input: { command, description: 'run a command' } };
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

/** The exact body §5.4 measured Claude executing without a dialog. */
const ALLOW_BODY = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' },
  },
};

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAllAutoYesStates();
  clearPolicySuppressions();
  mockLogger.warn.mockClear();
  mockLogger.info.mockClear();

  upsertWorktree(db, {
    id: WT,
    name: 'feature/1759',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  // Issue #1763: this used to unregister `opencode`, which stopped being a
  // free-standing stub the moment Phase 4-5 registered a real source for it —
  // every test in this file would still have passed while deleting it, and
  // under CI's `fileParallelism: false` the deletion would follow the process
  // into every later file. The blocking stub below is registered under
  // `vibe-local`, which is outside Phase 4's scope and therefore has no real
  // source to destroy.
  const { unregisterAgentEventSource } = await import('@/lib/hooks/sources');
  unregisterAgentEventSource(BLOCKING_TOOL);
});

/**
 * The tool the blocking stub is registered under.
 *
 * Deliberately not `opencode`: that tool now has a real source (#1763), and a
 * test that overwrites it and then unregisters it leaves the registry worse
 * than it found it. `vibe-local` has no Phase 4 Issue, so it stays unregistered
 * however many of #1760-#1763 land.
 */
const BLOCKING_TOOL = 'vibe-local' as const;

describe('claude still gets exactly the bytes it got before the abstraction', () => {
  it('an allow is the measured decision JSON, produced by the source', async () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR_MS);

    const { status, body } = await postJson(
      bashPayload('touch /tmp/marker'),
      `?tool=claude&worktreeId=${WT}&instanceId=claude`
    );

    expect(status).toBe(200);
    expect(body).toEqual(ALLOW_BODY);
  });

  it('an abstention is an empty object and nothing else', async () => {
    // Auto-Yes off. `{}` is what #1721 D5 measured as indistinguishable from
    // having no hook at all.
    const { status, body } = await postJson(
      bashPayload('touch /tmp/marker'),
      `?tool=claude&worktreeId=${WT}&instanceId=claude`
    );

    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(Object.keys(body)).toHaveLength(0);
  });

  it('does not warn about abstaining, because on claude it costs a dialog', async () => {
    await postJson(
      bashPayload('touch /tmp/marker'),
      `?tool=claude&worktreeId=${WT}&instanceId=claude`
    );

    const warnings = mockLogger.warn.mock.calls.map((call) => call[0]);
    expect(warnings).not.toContain('permission-request-abstain-blocks-agent');
  });
});

describe('abstaining on a source that blocks is reported (C3)', () => {
  /**
   * A source that waits forever for a verdict — opencode's measured behaviour
   * (#1758 §5.5.3), reproduced under a tool that has no source of its own.
   *
   * Registered for a tool Claude has nothing to do with, so the assertion below
   * cannot be satisfied by anything Claude-shaped. If `noDecision` stops being
   * read — hard-coded to `proceeds`, dropped from the interface, ignored at the
   * call site — this test is the one that notices, and what it is protecting is
   * an opencode session that would otherwise stop in silence.
   *
   * `vibe-local` rather than `opencode` on purpose: see {@link BLOCKING_TOOL}.
   * The stub is a *shape*, not an implementation, and it needs a slot in the
   * registry that no shipped source is using.
   *
   * @param decide - Records the verdicts the receiver hands to the source
   */
  async function registerBlockingSource(
    decide: (verdict: string) => void = () => {}
  ): Promise<void> {
    const { registerAgentEventSource, getAgentEventSource } = await import('@/lib/hooks/sources');
    // The compatibility relay, whose `parsePermissionRequest` reads the same
    // captured Claude payload the tests above post — so the only difference
    // between this request and those is which source answers it.
    const base = getAgentEventSource(BLOCKING_TOOL);
    registerAgentEventSource({
      ...base,
      cliToolId: BLOCKING_TOOL,
      transport: 'pull',
      noDecision: { kind: 'blocks' },
      parsePermissionRequest: base.parsePermissionRequest,
      encodeVerdict: () => ({ kind: 'outOfBand' }),
      decide: async (_target, _decision, verdict) => {
        decide(verdict.kind);
      },
    });
  }

  it('logs what abstaining will do to the agent', async () => {
    await registerBlockingSource();

    const { status, body } = await postJson(
      bashPayload('touch /tmp/marker'),
      `?tool=${BLOCKING_TOOL}&worktreeId=${WT}&instanceId=${BLOCKING_TOOL}`
    );

    expect(status).toBe(200);
    expect(body).toEqual({});

    const warning = mockLogger.warn.mock.calls.find(
      (call) => call[0] === 'permission-request-abstain-blocks-agent'
    );
    expect(warning, 'no warning was logged for a blocking source').toBeDefined();
    expect(warning![1]).toMatchObject({
      worktreeId: WT,
      tool: BLOCKING_TOOL,
      instanceId: BLOCKING_TOOL,
      blocksForMs: null,
    });
    expect(String(warning![1].consequence)).toContain('indefinitely');
  });

  it('does not log it when the same source is asked to allow', async () => {
    await registerBlockingSource();
    setAutoYesEnabled(WT, BLOCKING_TOOL, true, ONE_HOUR_MS);

    await postJson(
      bashPayload('touch /tmp/marker'),
      `?tool=${BLOCKING_TOOL}&worktreeId=${WT}&instanceId=${BLOCKING_TOOL}`
    );

    const warnings = mockLogger.warn.mock.calls.map((call) => call[0]);
    expect(warnings).not.toContain('permission-request-abstain-blocks-agent');
  });

  it('answers out of band without putting a verdict in the response body', async () => {
    // C2: a pull source has no response to write into. The receiver still has
    // to answer the HTTP request, and `{}` is the right thing to answer with —
    // but the verdict itself left through `decide()`.
    const decided: string[] = [];
    await registerBlockingSource((kind) => decided.push(kind));
    setAutoYesEnabled(WT, BLOCKING_TOOL, true, ONE_HOUR_MS);

    const { body } = await postJson(
      bashPayload('touch /tmp/marker'),
      `?tool=${BLOCKING_TOOL}&worktreeId=${WT}&instanceId=${BLOCKING_TOOL}`
    );

    expect(decided).toEqual(['allowOnce']);
    expect(body).toEqual({});
  });

  it('leaves the real opencode registration alone', async () => {
    // The regression this file's teardown used to cause: overwriting and then
    // deleting `opencode` passed every assertion here and quietly dropped the
    // shipped source for the rest of the process (#1763).
    const { hasAgentEventSource, getAgentEventSource } = await import('@/lib/hooks/sources');
    await registerBlockingSource();

    expect(hasAgentEventSource('opencode')).toBe(true);
    expect(getAgentEventSource('opencode').cliToolId).toBe('opencode');
  });
});
