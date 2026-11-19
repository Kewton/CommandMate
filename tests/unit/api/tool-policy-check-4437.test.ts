/**
 * Issue #4437 PR2 (I7c): `GET /api/worktrees/:id/tool-policy` says whether a send
 * would be refused by the tool policy, BEFORE the CLI writes anything for it, and
 * writes nothing itself. Same resolution and table as `POST /send`; with `replyTo*`
 * the relay `--reply-to` opens is asked first (rule 0, both ends).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { RELAY_TOOL_POLICY_DENIED, TOOL_POLICY_DENIED, TOOL_POLICY_DENIED_MESSAGE } from '@/lib/tool-policy/policy';
import type { Worktree } from '@/types/models';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { GET } from '@/app/api/worktrees/[id]/tool-policy/route';

const WT = 'wt-4437-check';

async function check(query: Record<string, string>, worktreeId = WT): Promise<{ status: number; body: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const url = new URL(`http://localhost:3000/api/worktrees/${worktreeId}/tool-policy`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const { NextRequest: Request } = await import('next/server');
  const response = await GET(new Request(url) as NextRequest, { params: Promise.resolve({ id: worktreeId }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Every table a write would land in, counted. */
function rowCounts(): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, { id: WT, name: 'wt', path: '/tmp/wt-4437', repositoryPath: '/tmp/repo', repositoryName: 'repo', cliToolId: 'codex' } as Worktree);
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe('GET /api/worktrees/:id/tool-policy (Issue #4437, I7c)', () => {
  it.each(['session', 'agent', 'schedule', 'unknown', 'something-new'])(
    'antigravity from %s: refused with the very body of the send\'s 409',
    async (origin) => {
      const { status, body } = await check({ cliToolId: 'antigravity', instanceId: 'agy-new', origin });
      expect(status).toBe(200);
      expect(body).toMatchObject({
        allowed: false,
        refusal: {
          error: TOOL_POLICY_DENIED_MESSAGE,
          code: TOOL_POLICY_DENIED,
          sendOutcome: 'not_sent',
          policy: { tool: 'antigravity', operation: 'send', origin: origin === 'something-new' ? 'unknown' : origin, declaration: 'personal' },
        },
      });
    },
  );

  it.each([[{}], [{ origin: 'terminal' }]])('antigravity with %j (a person): allowed', async (extra) => {
    expect((await check({ cliToolId: 'antigravity', ...extra })).body).toEqual({ allowed: true, cliToolId: 'antigravity' });
  });

  it('a declared server allows it', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    expect((await check({ cliToolId: 'antigravity', origin: 'session' })).body).toEqual({ allowed: true, cliToolId: 'antigravity' });
  });

  it('another tool from session is allowed; the worktree default is resolved when no tool is named', async () => {
    expect((await check({ origin: 'session' })).body).toEqual({ allowed: true, cliToolId: 'codex' });
    expect((await check({ cliToolId: 'claude', origin: 'session' })).body).toEqual({ allowed: true, cliToolId: 'claude' });
  });

  it('a roster instance resolves to its own tool, as POST /send does', async () => {
    setAgentInstances(db, WT, [{ id: 'agy-2', cliTool: 'antigravity', alias: 'agy 2', order: 0 }]);
    expect((await check({ instanceId: 'agy-2', origin: 'session' })).body).toMatchObject({ allowed: false });
  });

  it('operation ask is carried into the refusal', async () => {
    expect((await check({ cliToolId: 'antigravity', origin: 'session', operation: 'ask' })).body.refusal.policy.operation).toBe('ask');
  });

  it('replyTo: a relay with antigravity at its from end is refused first (RELAY_TOOL_POLICY_DENIED, endpoint from)', async () => {
    const { body } = await check({ cliToolId: 'codex', origin: 'session', replyToWorktreeId: WT, replyToInstanceId: 'antigravity' });
    expect(body).toMatchObject({
      allowed: false,
      refusal: { code: RELAY_TOOL_POLICY_DENIED, policy: { endpoint: 'from', tool: 'antigravity', operation: 'relay' } },
    });
  });

  it('replyTo control: two other tools are allowed', async () => {
    expect((await check({ cliToolId: 'codex', origin: 'session', replyToWorktreeId: WT, replyToInstanceId: 'claude' })).body.allowed).toBe(true);
  });

  it('writes nothing, refused or not', async () => {
    const before = rowCounts();
    await check({ cliToolId: 'antigravity', instanceId: 'agy-new', origin: 'session' });
    await check({ cliToolId: 'codex', origin: 'session' });
    await check({ cliToolId: 'codex', origin: 'session', replyToWorktreeId: WT, replyToInstanceId: 'antigravity' });
    expect(rowCounts()).toEqual(before);
  });

  it.each([
    [{ cliToolId: 'nope' }],
    [{ instanceId: 'bad id' }],
    [{ operation: 'respond' }],
    [{ replyToWorktreeId: WT }],
    [{ replyToWorktreeId: WT, replyToInstanceId: 'bad id' }],
  ])('400 for %j', async (query) => {
    expect((await check(query)).status).toBe(400);
  });

  it('404 for an unknown worktree', async () => {
    expect((await check({}, 'no-such-wt')).status).toBe(404);
  });
});
