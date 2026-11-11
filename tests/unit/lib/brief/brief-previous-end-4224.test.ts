/**
 * I18: the line after an unplanned end (Issue #4224, D2 design §7, X-a〜X-g and X-j).
 *
 * `終わる前の更新を確認できない（この instance の最終更新は N 時間前）` is the first line of
 * the data — right after C's fixed 4 lines — when the branch is `on`, the boundary is a
 * process's (`launch` / `auto_restart`), an earlier conversation of this instance is on
 * record, and no "update before the end" is (G / F write that; until then never). It
 * never says the update was skipped or forgotten. It is required: a budget it does not
 * enter makes no brief (`skipReason: 'over_limit'`).
 *
 * Built through C's real provider (`createMemBriefProvider`) on #4222's world.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemBriefProvider } from '@/lib/brief/provider';
import { previousEndLead, previousEndLine, readPreEndUpdate, readPreviousEnd, PREVIOUS_END_LINE_MAX_BYTES } from '@/lib/brief/previous-end';
import { fitText } from '@/lib/brief/fit';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { openBoundary, readInstanceLifetime, BOUNDARY_RETAINED_ROWS } from '@/lib/db/session-brief-db';
import { getInstanceIncarnation, getOrCreateWorktreeIncarnation, startInstanceIncarnation } from '@/lib/mem/incarnation';
import type { BriefBoundaryKind, BriefRequest } from '@/lib/session/brief-provider';
import { BRIEF_TEXT_FIXED_LINES } from '@/types/brief';
import { BriefWorld, bytes, resetBriefMemory } from './brief-4223-harness';

const HOUR = 3_600_000;
const world = new BriefWorld();
const LEAD = /^終わる前の更新を確認できない（/;

function request(over: { kind?: BriefBoundaryKind; mode?: 'on' | 'derived'; maxLines?: number; maxBytes?: number; openedAt?: number; worktreeId?: string } = {}): BriefRequest {
  const worktreeId = over.worktreeId ?? 'wt-1';
  const lifetime = readInstanceLifetime(world.db, worktreeId, 'claude');
  return {
    target: {
      worktreeId,
      worktreeIncarnation: getOrCreateWorktreeIncarnation(world.db, worktreeId),
      cliToolId: 'claude',
      instanceId: 'claude',
      instanceIncarnation: lifetime.incarnation,
      instanceOnRoster: lifetime.onRoster,
    },
    membership: { repositoryId: world.repo, readRepositoryIds: [world.repo], branch: 'feature/x', detached: false, mode: over.mode ?? 'on' },
    boundary: { id: 'b-1', kind: over.kind ?? 'launch', late: false, openedAt: over.openedAt ?? Date.now() },
    budget: { maxBytes: over.maxBytes ?? 4096, maxLines: over.maxLines ?? 240 },
    now: Date.now(),
  };
}

async function build(over: Parameters<typeof request>[0] = {}) {
  const state = createMemBriefProvider(() => world.db, world.briefDeps());
  return state.provider.build(request(over));
}

/** The first line of the data (after the fixed 4), or null when the brief is empty. */
const firstDataLine = (body: string): string | null => (body === '' ? null : body.split('\n')[4] ?? null);

const userTurn = (at: number, instanceId = 'claude') =>
  world.message({ instanceId, cliToolId: 'claude', role: 'user', content: 'earlier work', at });

const setUpdatedAt = (itemId: string, at: number) => world.db.prepare('UPDATE mem_items SET updated_at = ? WHERE id = ?').run(at, itemId);

beforeEach(() => {
  resetBriefMemory();
  world.open('brief-previous-end-4224-');
  world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
  world.setMode('on');
});
afterEach(() => {
  world.close();
  resetBriefMemory();
});

describe('X-a / X-b when the line is drawn, and what it says', () => {
  it('X-a an earlier conversation, an update 3 h 5 min ago: the first data line says 3 時間前', async () => {
    const item = await world.add('note', undefined, { text: 'do it' });
    setUpdatedAt(item.id, Date.now() - 3 * HOUR - 5 * 60_000);
    userTurn(Date.now() - 4 * HOUR);
    const built = await build();
    expect(firstDataLine(built.body)).toBe('終わる前の更新を確認できない（この instance の最終更新は 3 時間前）');
  });

  it('X-a negative: no earlier conversation and no update of this instance (a first launch): no line', async () => {
    const built = await build();
    expect(built.body).not.toBe('');
    expect(built.body).not.toMatch(/終わる前の更新/);
  });

  it('X-b a conversation but no update of this instance: この instance の更新の記録なし', async () => {
    userTurn(Date.now() - HOUR);
    expect(firstDataLine((await build()).body)).toBe('終わる前の更新を確認できない（この instance の更新の記録なし）');
  });

  it.each(['reset', 'resume', 'explicit'] as const)('X-b negative: a %s boundary (a conversation step) draws no line', async (kind) => {
    userTurn(Date.now() - HOUR);
    expect((await build({ kind })).body).not.toMatch(/終わる前の更新/);
  });

  it('auto_restart is a process boundary too', async () => {
    userTurn(Date.now() - HOUR);
    expect(firstDataLine((await build({ kind: 'auto_restart' })).body)).toMatch(LEAD);
  });
});

describe('X-c / X-d the wording and the reader', () => {
  const asserts = (line: string): boolean => /更新せず|忘れ|しなかった/.test(line);

  it('X-c the line never asserts (a version that says 更新せずに is caught by the check)', () => {
    for (const at of [null, Date.now() - 72 * HOUR, Date.now() - 10_000]) {
      const line = previousEndLine(at, Date.now());
      expect(asserts(line)).toBe(false);
      expect(bytes(line)).toBeLessThanOrEqual(PREVIOUS_END_LINE_MAX_BYTES);
    }
    expect(asserts('更新せずに終わった（72 時間前）')).toBe(true);
    expect(previousEndLine(Date.now() - 30 * 60_000, Date.now())).toContain('1 時間未満');
  });

  it('X-c negative: derived draws no line', async () => {
    userTurn(Date.now() - HOUR);
    world.setMode('derived');
    expect((await build({ mode: 'derived' })).body).not.toMatch(/終わる前の更新/);
  });

  it('X-d the reader says not_recorded until G / F write; a recorded answer draws no line', () => {
    expect(readPreEndUpdate(world.db, { worktreeId: 'wt-1', instanceId: 'claude', before: Date.now() })).toBe('not_recorded');
    const facts = { hadConversation: true, lastUpdateAt: Date.now() - HOUR };
    const input = { mode: 'on' as const, kind: 'launch' as const, openedAt: Date.now(), now: Date.now() };
    expect(previousEndLead(input, facts, 'not_recorded')).toMatch(LEAD);
    expect(previousEndLead(input, facts, 'recorded')).toBeNull();
  });
});

describe('X-e the earlier conversation is not read from the ledger (P2-3)', () => {
  it('25 resets (past the 20 retained rows) and then a launch: the line is drawn', async () => {
    userTurn(Date.now() - 2 * HOUR);
    const lifetime = readInstanceLifetime(world.db, 'wt-1', 'claude');
    for (let i = 0; i < BOUNDARY_RETAINED_ROWS + 5; i += 1) {
      openBoundary(world.db, { worktreeId: 'wt-1', instanceId: 'claude', cliToolId: 'claude', lifetime, kind: 'reset', evidence: 'hook', openedAt: Date.now() - HOUR });
    }
    expect(world.count("SELECT COUNT(*) n FROM session_brief_boundaries WHERE kind = 'launch'")).toBe(0);
    expect(firstDataLine((await build()).body)).toMatch(LEAD);
  });

  it('negative: the conversation of an earlier worktree under the same id (deleted, made again) is not counted', async () => {
    userTurn(Date.now() - 2 * HOUR);
    deleteWorktreesByIds(world.db, ['wt-1']);
    world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
    expect((await build()).body).not.toMatch(/終わる前の更新/);
  });
});

describe('X-f the author and the time (P2-4, 2nd review ②)', () => {
  const ISSUE_CLOSED = () => ({ code: 0, stdout: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });

  it('an item written 72 h ago and closed by this very build still reads 72 時間前 (read before the evaluation)', async () => {
    const item = await world.add('next', 'issue:#1');
    setUpdatedAt(item.id, Date.now() - 72 * HOUR);
    world.fake.handler = ISSUE_CLOSED;
    const built = await build();
    expect(world.itemState(item.id)).toBe('closed');
    expect(firstDataLine(built.body)).toBe('終わる前の更新を確認できない（この instance の最終更新は 72 時間前）');
    // Positive control: read after the evaluation (the close overwrote it as the server's), it is gone.
    expect(readPreviousEnd(world.db, { worktreeId: 'wt-1', instanceId: 'claude', before: Date.now() + 1 }).lastUpdateAt).toBeNull();
  });

  it('a `now` the agent updated 1 h ago is counted (1 時間前, not 1 時間未満)', async () => {
    userTurn(Date.now() - 5 * HOUR);
    const incarnation = startInstanceIncarnation(world.db, 'wt-1', 'claude', 'claude');
    world.db
      .prepare(
        `INSERT INTO session_notes (worktree_id, instance_id, note, updated_at, version, mem_incarnation, created_by, updated_by, created_at)
         VALUES ('wt-1', 'claude', 'doing x', ?, 1, ?, 'agent', 'agent', ?)`
      )
      .run(Date.now() - HOUR - 60_000, incarnation, Date.now() - 2 * HOUR);
    expect(firstDataLine((await build()).body)).toBe('終わる前の更新を確認できない（この instance の最終更新は 1 時間前）');
  });

  it('negative: an item only a person edited is not this instance’s update', async () => {
    const item = await world.add('note', undefined);
    world.db.prepare("UPDATE mem_items SET updated_by = 'human', updated_by_instance = NULL WHERE id = ?").run(item.id);
    userTurn(Date.now() - HOUR);
    expect(firstDataLine((await build()).body)).toBe('終わる前の更新を確認できない（この instance の更新の記録なし）');
  });
});

describe('X-g the line is required (P2-5)', () => {
  beforeEach(() => userTurn(Date.now() - HOUR));

  it('5 lines left: no brief, skipReason over_limit (a version that drops the line and attaches is refused)', async () => {
    const built = await build({ maxLines: BRIEF_TEXT_FIXED_LINES });
    expect(built).toMatchObject({ body: '', includedNoticeIds: [], skipReason: 'over_limit' });
  });

  it('negative: 6 lines left: the fixed part and the line, nothing else', async () => {
    await world.add('note', undefined);
    const built = await build({ maxLines: BRIEF_TEXT_FIXED_LINES + 1 });
    const lines = built.body.split('\n');
    expect(lines).toHaveLength(BRIEF_TEXT_FIXED_LINES + 1);
    expect(lines[4]).toMatch(LEAD);
    expect(built.skipReason).toBeUndefined();
  });

  it('negative: room enough: the line first, the entries after it', async () => {
    await world.add('note', undefined);
    const lines = (await build()).body.split('\n');
    expect(lines[4]).toMatch(LEAD);
    expect(lines.length).toBeGreaterThan(BRIEF_TEXT_FIXED_LINES + 1);
  });

  it('the text minimum (1,024 bytes) holds the fixed part and the line', async () => {
    const built = await build({ maxBytes: 1024 });
    expect(firstDataLine(built.body)).toMatch(LEAD);
    expect(bytes(built.body)).toBeLessThanOrEqual(1024);
  });

  it('fitText without a lead is unchanged by the rule (no leadUnfit, entries cut as before)', () => {
    const model = { fixed: { mode: 'on' as const, worktreeId: 'w', instanceId: 'i', cliToolId: 'claude', repositoryId: 'r', repositoryIdBytes: 1, branch: null, detached: true, boundaryKind: null, generatedAt: 'g', readAll: 'x' }, items: [], sources: [] };
    expect(fitText(model, { maxBytes: 4096, trailingNewline: false, maxLines: BRIEF_TEXT_FIXED_LINES }).leadUnfit).toBeUndefined();
    expect(fitText({ ...model, lead: 'L' }, { maxBytes: 4096, trailingNewline: false, maxLines: BRIEF_TEXT_FIXED_LINES }).leadUnfit).toBe(true);
  });
});

describe('X-j the instance’s lifetime and author by B / D1’s rule (2nd review ②)', () => {
  it('a lazy incarnation (the first roster save of an existing primary) does not hide the conversation before it', async () => {
    userTurn(Date.now() - 3 * HOUR);
    world.db.prepare("UPDATE mem_instance_incarnations SET issued_by = 'lazy', created_at = ? WHERE worktree_id = 'wt-1'").run(Date.now() - HOUR);
    if (!getInstanceIncarnation(world.db, 'wt-1', 'claude')) startInstanceIncarnation(world.db, 'wt-1', 'claude', 'claude', Date.now() - HOUR, 'lazy');
    expect(firstDataLine((await build()).body)).toMatch(LEAD);
  });

  it('negative: an instance made again by the roster (issued roster) does not count the conversation before it', async () => {
    userTurn(Date.now() - 3 * HOUR);
    startInstanceIncarnation(world.db, 'wt-1', 'claude', 'claude', Date.now() - HOUR, 'roster');
    expect((await build()).body).not.toMatch(/終わる前の更新/);
  });

  it('the same-named primary of another worktree on the branch: its update is not this instance’s', async () => {
    world.worktree('wt-2', [{ id: 'claude', cliTool: 'claude' }]);
    const other = await world.add('note', undefined, { worktreeId: 'wt-2', text: 'theirs' });
    setUpdatedAt(other.id, Date.now() - HOUR);
    userTurn(Date.now() - 2 * HOUR);
    expect(firstDataLine((await build()).body)).toBe('終わる前の更新を確認できない（この instance の更新の記録なし）');
  });
});

/**
 * Issue #4227 pr3c (codex P2-2, PM return 4; design mem-ui-4227 §0.0b S-C): D2's X4 reads the
 * hand-off's record through `readPreEndUpdate`. A conversation that ended through the hand-off as
 * `confirmed` right before the new launch draws no line in the brief `buildBrief` makes; the same
 * end `unconfirmed` draws D2's line as before. Positive control: with `readPreEndUpdate` answering
 * `not_recorded` (the stub before pr3c) the first case fails.
 */
describe('[#4227 S-C] buildBrief reads the hand-off’s confirmed end (X4 wired)', () => {
  function endedThroughHandoff(outcome: 'confirmed' | 'unconfirmed'): void {
    const lifetime = readInstanceLifetime(world.db, 'wt-1', 'claude');
    const previous = openBoundary(world.db, { worktreeId: 'wt-1', instanceId: 'claude', cliToolId: 'claude', lifetime, kind: 'launch', evidence: 'launch', openedAt: Date.now() - 3 * HOUR });
    const at = Date.now() - 2 * HOUR;
    world.db
      .prepare(
        `INSERT INTO mem_handoff_requests (id, repository_id, branch, detached, target_worktree_id, target_worktree_incarnation,
           instance_id, cli_tool_id, instance_incarnation, instance_on_roster, boundary_id, state, outcome,
           agent_deadline_at, expires_at, ended_at, created_at, updated_at, version)
         VALUES ('req-s-c', ?, 'feature/x', 0, 'wt-1', ?, 'claude', 'claude', ?, 1, ?, 'ended', ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(world.repo, getOrCreateWorktreeIncarnation(world.db, 'wt-1'), lifetime.incarnation, previous.id, outcome, at, at + 14 * 24 * HOUR, at, at - HOUR, at);
  }

  it('confirmed right before this launch: no "cannot be confirmed" line', async () => {
    userTurn(Date.now() - 4 * HOUR);
    endedThroughHandoff('confirmed');
    expect(readPreEndUpdate(world.db, { worktreeId: 'wt-1', instanceId: 'claude', before: Date.now() })).toBe('recorded');
    const built = await build();
    expect(built.body).not.toBe('');
    expect(built.body).not.toMatch(/終わる前の更新を確認できない/);
  });

  it('(negative control) unconfirmed: D2’s line as before', async () => {
    userTurn(Date.now() - 4 * HOUR);
    endedThroughHandoff('unconfirmed');
    expect(firstDataLine((await build()).body)).toMatch(LEAD);
  });
});
