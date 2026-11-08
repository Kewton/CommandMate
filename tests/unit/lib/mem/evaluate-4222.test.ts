/**
 * close_when evaluation (Issue #4222, design `docs/design/mem-close-when-4222.md` §1・§2・§4・§5・§9).
 *
 * The deciders against `tests/fixtures/mem/close-when-eval-v1.json`, then the whole
 * evaluation through `mem check` / `mem list` on a file DB under `os.tmpdir()`, with
 * `gh` and `git` replaced by a fake `exec` (nothing real is asked).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { createTask, type CreateTaskInput } from '@/lib/db/tasks-db';
import { createVerificationRun } from '@/lib/db/verification-db';
import { reconcileOrphanVerificationRuns } from '@/lib/verification/verification-reconciler';
import { deleteWorktreesByIds, migrateWorktreeIdPreservingChildren } from '@/lib/db/worktree-db';
import {
  compareCreation,
  decideAt,
  decideBranchDeleted,
  decideIssue,
  decidePr,
  decideRelay,
  decideSchedule,
  decideTask,
  decideVerify,
  type BranchIdentity,
  type ConditionAnswer,
} from '@/lib/mem/condition-evaluators';
import { readGhOutcome } from '@/lib/mem/github-query';
import { memCheck, memList, memUpdateItem } from '@/lib/mem/service';
import type { ExecResult } from '@/lib/mem/query-plan';
import type { TaskStatus } from '@/lib/db/tasks-db';
import type { MemCheckResponse, MemConditionView, MemListResponse } from '@/types/mem';
import { MemWorld, SHA, SHA_B, SHA_C, fail, ghPath, json, ok, type ExecCall } from './mem-4222-harness';

interface EvalFixture {
  issue: Array<{ json: unknown; expected: string[] }>;
  pr: Array<{ wanted: 'merged' | 'closed'; json: unknown; expected: string[] }>;
  ghFailures: Array<{ code: number | null; stderr: string; stdout?: string; timedOut?: boolean; missing?: boolean; expected: string }>;
  relay: Array<{ state: string; deliveryHold: string | null; pendingKind: string | null; expected: string[] }>;
  task: Array<{ status: string | null; expected: string[] }>;
  verify: Array<{ status: string | null; expected: string[] }>;
  schedule: Array<{ status: string | null; expected: string[] }>;
  branchDeleted: Array<{ identity: BranchIdentity['kind']; expected: string[] }>;
  creationOrder: Array<{ createdSeconds: number; itemCreatedAtMs: number; expected: string }>;
  at: Array<{ now: number; epochMs: number; expected: string[] }>;
}

const FIXTURE = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/mem/close-when-eval-v1.json'), 'utf8')) as EvalFixture;
const triple = (answer: ConditionAnswer) => [answer.result, answer.reason, ...(answer.outcome ? [answer.outcome] : [])];

describe('the deciders follow the fixture (§1・§2)', () => {
  it('issue / pr', () => {
    for (const row of FIXTURE.issue) expect([row.json, triple(decideIssue(row.json))]).toEqual([row.json, row.expected]);
    for (const row of FIXTURE.pr) expect([row, triple(decidePr(row.json, row.wanted))]).toEqual([row, row.expected]);
  });

  it('every gh failure is unknown with its reason (404, 401, 403, rate limit, 5xx, offline, timeout, no gh)', () => {
    for (const row of FIXTURE.ghFailures) {
      const result: ExecResult = {
        code: row.code,
        stdout: row.stdout ?? '',
        stderr: row.stderr,
        timedOut: row.timedOut ?? false,
        aborted: false,
        missing: row.missing ?? false,
        overflow: false,
      };
      const answer = readGhOutcome({ ok: true, result });
      expect([row.stderr, answer.ok ? 'ok' : answer.reason]).toEqual([row.stderr, row.expected]);
    }
  });

  it('relay: all 30 rows of state × delivery hold × pending payload', () => {
    expect(FIXTURE.relay).toHaveLength(30);
    for (const row of FIXTURE.relay) {
      const relay = {
        state: row.state,
        pendingKind: row.pendingKind,
        deliveryHold: row.deliveryHold ? { state: row.deliveryHold } : null,
      } as unknown as Parameters<typeof decideRelay>[0];
      expect([row.state, row.deliveryHold, row.pendingKind, triple(decideRelay(relay))]).toEqual([
        row.state,
        row.deliveryHold,
        row.pendingKind,
        row.expected,
      ]);
    }
    expect(triple(decideRelay(null))).toEqual(['unknown', 'relay_not_found']);
  });

  it('session (task / verify / schedule), the deleted branch, the creation order and at', () => {
    for (const row of FIXTURE.task) expect([row.status, triple(decideTask(row.status as TaskStatus | null))]).toEqual([row.status, row.expected]);
    for (const row of FIXTURE.verify) expect([row.status, triple(decideVerify(row.status))]).toEqual([row.status, row.expected]);
    for (const row of FIXTURE.schedule) expect([row.status, triple(decideSchedule(row.status))]).toEqual([row.status, row.expected]);
    for (const row of FIXTURE.branchDeleted) {
      const identity = (row.identity === 'same' ? { kind: 'same', tip: SHA } : { kind: row.identity }) as BranchIdentity;
      expect([row.identity, triple(decideBranchDeleted(identity))]).toEqual([row.identity, row.expected]);
    }
    for (const row of FIXTURE.creationOrder) expect(compareCreation(row.createdSeconds, row.itemCreatedAtMs)).toBe(row.expected);
    for (const row of FIXTURE.at) expect(triple(decideAt(row.now, row.epochMs))).toEqual(row.expected);
  });
});

// ---------------------------------------------------------------------------
// Through the service
// ---------------------------------------------------------------------------

const world = new MemWorld();
beforeEach(() => {
  world.open('mem-eval-4222-');
  world.worktree('wt-1', [
    { id: 'claude', cliTool: 'claude' },
    { id: 'codex-2', cliTool: 'codex' },
  ]);
  world.setMode('on');
});
afterEach(() => world.close());

const check = async (worktreeId = 'wt-1') => {
  const outcome = await memCheck(world.db, { via: 'worktree', worktreeId }, { instanceId: 'codex-2' }, world.deps());
  return outcome;
};
const resultsOf = async (worktreeId = 'wt-1'): Promise<Record<string, MemConditionView>> => {
  const outcome = await check(worktreeId);
  expect(outcome.status).toBe(200);
  const out: Record<string, MemConditionView> = {};
  for (const entry of (outcome.body as MemCheckResponse).results) out[entry.itemId] = entry.condition;
  return out;
};
const records = () => world.count('SELECT COUNT(*) n FROM mem_close_records');
const notices = () => world.count('SELECT COUNT(*) n FROM mem_notices');

/** A gh that answers issue n as `answers[n]`. */
const issueGh = (answers: Record<number, Partial<ExecResult>>) => (call: ExecCall) => {
  const match = /issues\/(\d+)$/.exec(ghPath(call) ?? '');
  return match && answers[Number(match[1])] ? answers[Number(match[1])] : fail(1, 'gh: Not Found (HTTP 404)');
};

describe('issue / pr through mem check', () => {
  it('closed → met and closed, with one end record and one notice; open → not met; 404 → unknown', async () => {
    world.fake.handler = issueGh({ 1: json({ state: 'closed', state_reason: 'completed' }), 2: json({ state: 'open' }) });
    const closed = await world.add('next', 'issue:#1');
    const open = await world.add('next', 'issue:#2');
    const missing = await world.add('next', 'issue:#3');
    const results = await resultsOf();
    expect(results[closed.id]).toMatchObject({ result: 'met', reason: 'issue-closed', outcome: 'success', closed: true });
    expect(results[open.id]).toMatchObject({ result: 'not-met', reason: 'issue-open', closed: false });
    expect(results[missing.id]).toMatchObject({ result: 'unknown', reason: 'not_found', closed: false });
    expect(world.itemState(closed.id)).toBe('closed');
    expect(world.itemState(open.id)).toBe('open');
    expect(world.itemState(missing.id)).toBe('open');
    expect(records()).toBe(1);
    expect(notices()).toBe(1);
    const record = world.db.prepare('SELECT * FROM mem_close_records').get() as Record<string, unknown>;
    expect(record).toMatchObject({ item_id: closed.id, condition_type: 'issue', end_reason: 'issue-closed', outcome: 'success', trigger: 'check' });
    expect(JSON.parse(record.observation_json as string)).toMatchObject({ source: 'issue', facts: { state: 'closed', stateReason: 'completed' } });
    expect(world.db.prepare('SELECT close_reason, updated_by FROM mem_items WHERE id = ?').get(closed.id)).toEqual({
      close_reason: 'condition',
      updated_by: 'server',
    });
  });

  it.each([
    ['unauthenticated', fail(1, 'gh: Bad credentials (HTTP 401)')],
    ['forbidden', fail(1, 'gh: Forbidden (HTTP 403)')],
    ['rate_limited', fail(1, 'gh: API rate limit exceeded (HTTP 403)')],
    ['offline', fail(1, 'error connecting to api.github.com')],
    ['query_timeout', { code: null, timedOut: true } as Partial<ExecResult>],
  ])('%s → unknown, open, nothing written', async (reason, answer) => {
    world.fake.handler = () => answer;
    const item = await world.add('next', 'issue:#7');
    const results = await resultsOf();
    expect(results[item.id]).toMatchObject({ result: 'unknown', reason, closed: false });
    expect(world.itemState(item.id)).toBe('open');
    expect(records() + notices()).toBe(0);
  });

  it('10 issues with different numbers → 8 queries, 2 query_budget_exhausted (and they stay open)', async () => {
    world.fake.handler = () => json({ state: 'closed', state_reason: 'completed' });
    const items = [];
    for (let n = 1; n <= 10; n += 1) items.push(await world.add('next', `issue:#${n}`));
    const results = await resultsOf();
    expect(world.fake.count((call) => call.file === 'gh')).toBe(8);
    const exhausted = items.filter((item) => results[item.id].reason === 'query_budget_exhausted');
    expect(exhausted).toHaveLength(2);
    // The oldest first: the last two are the ones left.
    expect(exhausted.map((item) => item.id)).toEqual(items.slice(8).map((item) => item.id));
    for (const item of exhausted) expect(world.itemState(item.id)).toBe('open');
  });

  it('(control) 3 items on the same issue → 1 query, all three closed', async () => {
    world.fake.handler = () => json({ state: 'closed', state_reason: 'completed' });
    const items = [await world.add('next', 'issue:#5'), await world.add('waiting', 'issue:#5'), await world.add('external', 'issue:#5')];
    const results = await resultsOf();
    expect(world.fake.count((call) => call.file === 'gh')).toBe(1);
    for (const item of items) expect(results[item.id].closed).toBe(true);
    expect(notices()).toBe(3);
  });

  it('a host that is neither github.com nor origin’s → no gh at all, unknown host_not_allowed; origin’s host is asked', async () => {
    world.fake.handler = (call) =>
      call.file === 'git' && call.args[0] === 'remote' ? ok('git@ghe.example.com:acme/app.git\n') : json({ state: 'open' });
    const other = await world.add('next', 'issue:evil.example.com/a/b#1');
    const own = await world.add('next', 'issue:ghe.example.com/acme/app#2');
    const results = await resultsOf();
    expect(results[other.id]).toMatchObject({ result: 'unknown', reason: 'host_not_allowed' });
    expect(results[own.id]).toMatchObject({ result: 'not-met', reason: 'issue-open' });
    const gh = world.fake.calls.filter((call) => call.file === 'gh');
    expect(gh.map((call) => call.args[2])).toEqual(['ghe.example.com']);
  });

  it('pr: merged and closed states', async () => {
    world.fake.handler = (call) =>
      /pulls\/10$/.test(ghPath(call) ?? '')
        ? json({ state: 'closed', merged_at: null })
        : json({ state: 'closed', merged_at: '2026-11-08T00:00:00Z' });
    const wantsMerge = await world.add('next', 'pr:#10');
    const wantsClose = await world.add('next', 'pr:#10?state=closed');
    const merged = await world.add('next', 'pr:#11');
    const results = await resultsOf();
    expect(results[wantsMerge.id]).toMatchObject({ result: 'not-met', reason: 'pr-closed-unmerged' });
    expect(results[wantsClose.id]).toMatchObject({ result: 'met', reason: 'pr-closed', outcome: 'failure', closed: true });
    expect(results[merged.id]).toMatchObject({ result: 'met', reason: 'pr-merged', outcome: 'success', closed: true });
  });
});

describe('mode off / derived (§4)', () => {
  it('check answers disabled and asks nothing; list in derived evaluates nothing; on again closes', async () => {
    world.fake.handler = () => json({ state: 'closed', state_reason: 'completed' });
    const item = await world.add('next', 'issue:#1');
    for (const mode of ['off', 'derived'] as const) {
      world.setMode(mode);
      const outcome = await check();
      expect(outcome.status).toBe(409);
      expect((outcome.body as { code: string }).code).toBe('disabled');
    }
    const listed = await memList(world.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, world.deps());
    expect(listed.status).toBe(200);
    expect((listed.body as MemListResponse).conditions).toBeUndefined();
    world.setMode('off');
    expect((await memList(world.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, world.deps())).status).toBe(409);
    expect(world.fake.calls).toHaveLength(0);
    expect(records() + notices()).toBe(0);
    expect(world.itemState(item.id)).toBe('open');
    world.setMode('on');
    expect((await resultsOf())[item.id].closed).toBe(true);
  });

  it('set to off while the query is out → not closed; the next evaluation in on closes', async () => {
    const item = await world.add('next', 'issue:#1');
    world.fake.handler = () => {
      world.setMode('off');
      return json({ state: 'closed', state_reason: 'completed' });
    };
    const first = await resultsOf();
    expect(first[item.id]).toMatchObject({ result: 'met', closed: false });
    expect(records() + notices()).toBe(0);
    world.setMode('on');
    world.fake.handler = () => json({ state: 'closed', state_reason: 'completed' });
    expect((await resultsOf())[item.id].closed).toBe(true);
  });

  it('mem list in on carries the conditions and closes what is met', async () => {
    world.fake.handler = () => json({ state: 'closed', state_reason: 'completed' });
    const item = await world.add('next', 'issue:#1');
    const listed = await memList(world.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, world.deps());
    const body = listed.body as MemListResponse;
    expect(body.conditions?.[item.id]).toMatchObject({ result: 'met', closed: true });
    expect(body.items.map((entry) => entry.id)).not.toContain(item.id);
  });
});

describe('decisions (§5) and the race with E', () => {
  const met = () => json({ state: 'closed', state_reason: 'completed' });

  it('an open or recorded decision is not closed: unreflected, nothing written', async () => {
    world.fake.handler = met;
    const open = await world.add('decision', 'issue:#1');
    const recorded = await world.add('decision', 'issue:#1');
    world.db.prepare("UPDATE mem_items SET state = 'recorded' WHERE id = ?").run(recorded.id);
    const results = await resultsOf();
    for (const id of [open.id, recorded.id]) {
      expect(results[id]).toMatchObject({ result: 'met', closed: false, unreflected: true });
      expect(world.itemState(id)).not.toBe('closed');
    }
    expect(records() + notices()).toBe(0);
  });

  it('(control) a promoted decision closes, with its record and notice', async () => {
    world.fake.handler = met;
    const decision = await world.add('decision', 'issue:#1');
    world.db.prepare("UPDATE mem_items SET state = 'promoted', version = version + 1 WHERE id = ?").run(decision.id);
    expect((await resultsOf())[decision.id]).toMatchObject({ closed: true });
    expect(records()).toBe(1);
    expect(notices()).toBe(1);
  });

  it('E promotes during the query (version + 1) → not closed this time; the next evaluation closes; E after B → 409', async () => {
    const decision = await world.add('decision', 'issue:#1');
    world.db.prepare("UPDATE mem_items SET state = 'recorded', version = version + 1 WHERE id = ?").run(decision.id);
    world.fake.handler = () => {
      world.db.prepare("UPDATE mem_items SET state = 'promoted', version = version + 1 WHERE id = ?").run(decision.id);
      return met();
    };
    const first = await resultsOf();
    expect(first[decision.id]).toMatchObject({ result: 'met', closed: false, unreflected: true });
    expect(world.itemState(decision.id)).toBe('promoted');
    world.fake.handler = met;
    expect((await resultsOf())[decision.id].closed).toBe(true);
    const late = await memUpdateItem(world.db, 'wt-1', decision.id, { instanceId: 'claude', ifVersion: 2, text: 'late' }, world.deps());
    expect(late.status).toBe(409);
  });

  it('a version change of a waiting item during the query → not closed', async () => {
    const item = await world.add('next', 'issue:#1');
    world.fake.handler = () => {
      world.db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(item.id);
      return met();
    };
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'met', closed: false });
    expect(records()).toBe(0);
  });
});

describe('session, worktree, relay, at and unknown shapes (§1.5〜§1.8)', () => {
  const taskInput = (status: TaskStatus): CreateTaskInput => ({
    worktreeId: 'wt-1',
    cliToolId: 'claude',
    contract: { title: 't', goal: 'g' } as unknown as CreateTaskInput['contract'],
    status,
  });

  it('a task alive but held up (running, waiting_input) is not met, also after a restart; succeeded closes', async () => {
    const running = createTask(world.db, taskInput('running'));
    const waiting = createTask(world.db, taskInput('waiting_input'));
    const done = createTask(world.db, taskInput('succeeded'));
    const a = await world.add('next', `session:task:${running.id}`);
    const b = await world.add('next', `session:task:${waiting.id}`);
    const c = await world.add('next', `session:task:${done.id}`);
    const { resetMemServerBootId } = await import('@/lib/mem/process-boot');
    resetMemServerBootId();
    const results = await resultsOf();
    expect(results[a.id]).toMatchObject({ result: 'not-met', reason: 'task-running' });
    expect(results[b.id]).toMatchObject({ result: 'not-met', reason: 'task-running' });
    expect(results[c.id]).toMatchObject({ result: 'met', reason: 'task-succeeded', outcome: 'success', closed: true });
  });

  it('a verify run left running is closed as error at start-up → met (failure); a schedule run recovered → met (failure)', async () => {
    const run = createVerificationRun(world.db, { worktreeId: 'wt-1', trigger: 'manual' as never });
    const now = Date.now();
    world.db
      .prepare(`INSERT INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at) VALUES ('s1', 'wt-1', 'n', 'm', ?, ?)`)
      .run(now, now);
    world.db
      .prepare(`INSERT INTO execution_logs (id, schedule_id, worktree_id, message, status, started_at, created_at) VALUES ('log-1', 's1', 'wt-1', 'm', 'running', ?, ?)`)
      .run(now, now);
    const verify = await world.add('next', `session:verify:${run.id}`);
    const schedule = await world.add('next', 'session:schedule:log-1');
    const before = await resultsOf();
    expect(before[verify.id]).toMatchObject({ result: 'not-met', reason: 'verify-running' });
    expect(before[schedule.id]).toMatchObject({ result: 'not-met', reason: 'schedule-running' });
    reconcileOrphanVerificationRuns(world.db);
    // What `recoverRunningLogs()` (job-executor.ts) runs at start-up.
    world.db.prepare("UPDATE execution_logs SET status = 'failed', completed_at = ? WHERE status = 'running'").run(Date.now());
    const after = await resultsOf();
    expect(after[verify.id]).toMatchObject({ result: 'met', reason: 'verify-error', outcome: 'failure', closed: true });
    expect(after[schedule.id]).toMatchObject({ result: 'met', reason: 'schedule-failed', outcome: 'failure', closed: true });
  });

  it('a session value stored before #4222 (no namespace) and an unknown schema are unknown and stay open', async () => {
    const legacy = await world.add('next', 'at:2099-01-01T00:00+00:00');
    world.db
      .prepare('UPDATE mem_items SET close_when = ? WHERE id = ?')
      .run(JSON.stringify({ schema: 1, type: 'session', sessionId: 'run-42', sessionGeneration: null }), legacy.id);
    const future = await world.add('next', 'at:2099-01-01T00:00+00:00');
    world.db.prepare('UPDATE mem_items SET close_when = ? WHERE id = ?').run('{"schema":2,"type":"issue"}', future.id);
    const results = await resultsOf();
    expect(results[legacy.id]).toMatchObject({ result: 'unknown', reason: 'session_kind_unknown' });
    expect(results[future.id]).toMatchObject({ result: 'unknown', reason: 'schema_unknown' });
  });

  it('worktree: a rename is not met, a delete is met; at: past met, future not met; relay missing unknown', async () => {
    world.worktree('wt-2');
    world.worktree('wt-3');
    const renamed = await world.add('next', 'worktree:wt-2');
    const deleted = await world.add('next', 'worktree:wt-3');
    const past = await world.add('next', 'at:2020-01-01T00:00+00:00');
    const future = await world.add('next', 'at:2099-01-01T00:00+00:00');
    const relay = await world.add('next', 'relay:relay-none');
    world.db.transaction(() => migrateWorktreeIdPreservingChildren(world.db, 'wt-2', 'wt-2b'))();
    deleteWorktreesByIds(world.db, ['wt-3']);
    const results = await resultsOf();
    expect(results[renamed.id]).toMatchObject({ result: 'not-met', reason: 'worktree-alive' });
    expect(results[deleted.id]).toMatchObject({ result: 'met', reason: 'worktree-deleted', closed: true });
    expect(results[past.id]).toMatchObject({ result: 'met', reason: 'time-passed', closed: true });
    expect(results[future.id]).toMatchObject({ result: 'not-met', reason: 'time-not-yet' });
    expect(results[relay.id]).toMatchObject({ result: 'unknown', reason: 'relay_not_found' });
    expect(world.fake.calls).toHaveLength(0);
  });

  it('a `now` slot closed by its condition moves to mem_items as `condition`', async () => {
    const { memWriteNow } = await import('@/lib/mem/service');
    const written = await memWriteNow(world.db, 'wt-1', { instanceId: 'claude', text: 'now', closeWhen: 'at:2020-01-01T00:00+00:00' }, world.deps());
    const id = (written.body as { item: { id: string } }).item.id;
    expect((await resultsOf())[id].closed).toBe(true);
    expect(world.db.prepare('SELECT state, close_reason FROM mem_items WHERE id = ?').get(id)).toEqual({ state: 'closed', close_reason: 'condition' });
    expect(world.count('SELECT COUNT(*) n FROM session_notes WHERE mem_item_id = ?', id)).toBe(0);
    expect(notices()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// branch with a fake git (§1.4・§9.2)
// ---------------------------------------------------------------------------

interface FakeRepo {
  local: Record<string, string>;
  remote: Record<string, string> | 'offline';
  /** [ancestor, descendant] pairs that are ancestry (equal is always). */
  ancestry: Array<[string, string]>;
  created?: Record<string, number>;
  pulls?: unknown[];
  holdLsRemote?: Promise<void>;
}

function gitOf(repo: FakeRepo) {
  return async (call: ExecCall) => {
    if (call.file === 'gh') {
      if (/\/pulls\?/.test(ghPath(call) ?? '')) return json(repo.pulls ?? []);
      return fail(1, 'gh: Not Found (HTTP 404)');
    }
    const [command, ...rest] = call.args;
    if (command === 'rev-parse') {
      const ref = rest[2].replace(/\^\{commit\}$/, '').replace(/^refs\/heads\//, '');
      return repo.local[ref] ? ok(`${repo.local[ref]}\n`) : fail(1);
    }
    if (command === 'reflog') {
      const name = rest[rest.length - 1].replace(/^refs\/heads\//, '');
      const seconds = repo.created?.[name];
      return seconds === undefined ? fail(128, 'no reflog') : ok(`${name}@{${seconds}}\tbranch: Created from HEAD\n`);
    }
    if (command === 'merge-base') {
      const [, a, b] = rest;
      return a === b || repo.ancestry.some(([x, y]) => x === a && y === b) ? ok('') : fail(1);
    }
    if (command === 'ls-remote') {
      // P1-1: the shared query lists every head; a narrowed one would be a bug.
      if (call.args.length !== 3) throw new Error(`ls-remote with refs: ${call.args.join(' ')}`);
      await repo.holdLsRemote;
      if (repo.remote === 'offline') return fail(128, 'fatal: unable to access');
      return ok(Object.entries(repo.remote).map(([name, sha]) => `${sha}\trefs/heads/${name}`).join('\n'));
    }
    if (command === 'remote') return ok('git@github.com:Kewton/CommandMate.git\n');
    return fail(2, 'unexpected');
  };
}

describe('branch (fake git)', () => {
  it('merged into another ref than `into` → not met; into `into` → met', async () => {
    const develop = await world.add('next', 'branch:feature/x?merged=develop');
    const main = await world.add('next', 'branch:feature/x?merged=main');
    world.fake.handler = gitOf({
      local: { 'feature/x': SHA_B, develop: SHA, main: SHA_C },
      remote: {},
      ancestry: [
        [SHA, SHA_B],
        [SHA_B, SHA_C],
      ],
    });
    const results = await resultsOf();
    expect(results[develop.id]).toMatchObject({ result: 'not-met', reason: 'not-merged' });
    expect(results[main.id]).toMatchObject({ result: 'met', reason: 'branch-merged', closed: true });
  });

  it('a new branch with no commits yet, whose tip is in develop → not met (no-new-commits)', async () => {
    const item = await world.add('next', 'branch:feature/x?merged=develop');
    world.fake.handler = gitOf({ local: { 'feature/x': SHA, develop: SHA_B }, remote: {}, ancestry: [[SHA, SHA_B]] });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'not-met', reason: 'no-new-commits' });
  });

  it('deleted locally (ref gone) → met; still there → not met', async () => {
    const item = await world.add('next', 'branch:feature/x?deleted');
    world.fake.handler = gitOf({ local: { 'feature/x': SHA }, remote: {}, ancestry: [] });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'not-met', reason: 'branch-present' });
    world.fake.handler = gitOf({ local: {}, remote: {}, ancestry: [] });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'met', reason: 'branch-deleted', closed: true });
  });

  it('remote: ls-remote exit 128 → unknown offline; listed without the ref → met, whatever the local tracking ref says', async () => {
    const item = await world.add('next', 'branch:feature/x?deleted&scope=remote');
    world.fake.handler = gitOf({ local: { 'origin/feature/x': SHA }, remote: 'offline', ancestry: [] });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'unknown', reason: 'offline' });
    world.fake.handler = gitOf({ local: { 'origin/feature/x': SHA }, remote: { develop: SHA_B }, ancestry: [] });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'met', reason: 'branch-deleted', closed: true });
  });

  it('P1-1: two evaluations at once share one ls-remote of every head; the ref one does not ask is not read as gone', async () => {
    world.worktree('wt-2');
    const x = await world.add('next', 'branch:feature/x?deleted&scope=remote');
    const y = await world.add('next', 'branch:feature/y?deleted&scope=remote');
    let release!: () => void;
    const repo: FakeRepo = {
      local: {},
      remote: { 'feature/y': SHA },
      ancestry: [],
      holdLsRemote: new Promise<void>((resolve) => (release = resolve)),
    };
    world.fake.handler = gitOf(repo);
    const first = check('wt-1');
    const second = check('wt-2');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(world.fake.count((call) => call.args[0] === 'ls-remote')).toBe(1);
    for (const outcome of [a, b]) {
      const byId = Object.fromEntries((outcome.body as MemCheckResponse).results.map((entry) => [entry.itemId, entry.condition]));
      expect(byId[y.id]).toMatchObject({ result: 'not-met' });
      expect(byId[x.id].result).toBe('met');
    }
    expect(world.itemState(y.id)).toBe('open');
    expect(world.itemState(x.id)).toBe('closed');
  });

  it('squash merge seen on GitHub: a PR merged after the item, head = the branch tip, descendant of the baseline → met', async () => {
    world.clock = () => Date.parse('2026-11-08T00:00:00Z');
    const item = await world.add('next', 'branch:feature/x?merged=develop&scope=remote');
    world.clock = null;
    const repo: FakeRepo = {
      local: {},
      remote: { 'feature/x': SHA_B, develop: SHA_C },
      ancestry: [[SHA, SHA_B]],
      pulls: [{ merged_at: '2026-11-08T01:00:00Z', head: { sha: SHA_B } }],
    };
    world.fake.handler = gitOf(repo);
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'met', reason: 'branch-merged-pr', closed: true });
  });

  it('(control) a merged PR whose head is the baseline → not met', async () => {
    world.clock = () => Date.parse('2026-11-08T00:00:00Z');
    const item = await world.add('next', 'branch:feature/x?merged=develop&scope=remote');
    world.clock = null;
    world.fake.handler = gitOf({
      local: {},
      remote: { 'feature/x': SHA_B, develop: SHA_C },
      ancestry: [[SHA, SHA_B]],
      pulls: [{ merged_at: '2026-11-08T01:00:00Z', head: { sha: SHA } }],
    });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'not-met', reason: 'not-merged' });
  });

  it('P2-2: an older PR of the same name (merged before the item), or one whose head is not the branch’s now → not met', async () => {
    world.clock = () => Date.parse('2026-11-08T00:00:00Z');
    const item = await world.add('next', 'branch:feature/x?merged=develop&scope=remote');
    world.clock = null;
    world.fake.handler = gitOf({
      local: {},
      remote: { 'feature/x': SHA_B, develop: SHA_C },
      ancestry: [[SHA, SHA_B]],
      pulls: [
        { merged_at: '2026-11-07T00:00:00Z', head: { sha: SHA_B } },
        { merged_at: '2026-11-08T01:00:00Z', head: { sha: 'd'.repeat(40) } },
      ],
    });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'not-met', reason: 'not-merged' });
  });

  it('(control) the branch deleted after a merge (gone) with a PR merged after the item from a descendant → met', async () => {
    world.clock = () => Date.parse('2026-11-08T00:00:00Z');
    const item = await world.add('next', 'branch:feature/x?merged=develop&scope=remote');
    world.clock = null;
    world.fake.handler = gitOf({
      local: {},
      remote: { develop: SHA_C },
      ancestry: [[SHA, SHA_B]],
      pulls: [{ merged_at: '2026-11-08T01:00:00Z', head: { sha: SHA_B } }],
    });
    expect((await resultsOf())[item.id]).toMatchObject({ result: 'met', reason: 'branch-merged-pr' });
  });

  it('2nd review ②: a branch created in the same second as the item → unknown (branch-order-uncertain), never same', async () => {
    world.clock = () => 1_794_100_000_400;
    const deleted = await world.add('next', 'branch:feature/x?deleted');
    const merged = await world.add('next', 'branch:feature/x?merged=develop');
    world.clock = null;
    const repo: FakeRepo = { local: { 'feature/x': SHA_B, develop: SHA_C }, remote: {}, ancestry: [[SHA, SHA_B], [SHA_B, SHA_C]], created: { 'feature/x': 1_794_100_000 } };
    world.fake.handler = gitOf(repo);
    const results = await resultsOf();
    expect(results[deleted.id]).toMatchObject({ result: 'unknown', reason: 'branch-order-uncertain' });
    expect(results[merged.id]).toMatchObject({ result: 'unknown', reason: 'branch-order-uncertain', closed: false });
    // (control) a second earlier: certainly before → same, by the ancestry.
    repo.created = { 'feature/x': 1_794_099_999 };
    const again = await resultsOf();
    expect(again[deleted.id]).toMatchObject({ result: 'not-met', reason: 'branch-present' });
    expect(again[merged.id]).toMatchObject({ result: 'met', reason: 'branch-merged' });
  });

  it('a recreated local branch (created after the item) → deleted met, merged not counted', async () => {
    world.clock = () => 1_794_100_000_400;
    const deleted = await world.add('next', 'branch:feature/x?deleted');
    const merged = await world.add('next', 'branch:feature/x?merged=develop');
    world.clock = null;
    world.fake.handler = gitOf({ local: { 'feature/x': SHA_B, develop: SHA_C }, remote: {}, ancestry: [[SHA, SHA_B], [SHA_B, SHA_C]], created: { 'feature/x': 1_794_100_001 } });
    const results = await resultsOf();
    expect(results[deleted.id]).toMatchObject({ result: 'met', reason: 'branch-recreated' });
    expect(results[merged.id]).toMatchObject({ result: 'unknown', closed: false });
  });
});
