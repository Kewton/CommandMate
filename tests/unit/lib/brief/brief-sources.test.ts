/**
 * The brief's sources one by one (Issue #4223, design §1): the derived state S1〜S6・S9
 * read from their own stores, attributed to the instance (I16), the conversation by
 * `reply`'s rule (I17), auto-yes per instance and never the aggregate, the relay ranks,
 * and the run record's adapter.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { writeFileSync } from 'fs';
import { buildCompositeKey, peekAutoYesState, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { getMessages } from '@/lib/db/chat-db';
import { listTasks } from '@/lib/db/tasks-db';
import { issueOfBranch, runFileNamesIssue } from '@/lib/brief/sources';
import { observeStatusEvidence } from '@/lib/session/status-evidence';
import { observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import { pickLatestReply, replyCandidates } from '@/cli/utils/reply-ledger';
import type { BriefJson } from '@/types/brief';
import { BriefWorld, resetBriefMemory } from './brief-4223-harness';

const world = new BriefWorld();

beforeEach(() => {
  resetBriefMemory();
  world.open('brief-sources-4223-');
  world.worktree('wt-1', [
    { id: 'claude', cliTool: 'claude' },
    { id: 'codex', cliTool: 'codex' },
  ]);
  world.setMode('on');
});
afterEach(() => {
  world.close();
  resetBriefMemory();
});

const json = async (extra: Parameters<BriefWorld['brief']>[1] = {}) =>
  JSON.parse((await world.brief({ format: 'json', all: '1' }, extra)).stdout) as BriefJson;
const entriesOf = (brief: BriefJson, source: string) => brief.entries.filter((entry) => entry.source === source);

describe('S1 the state the monitoring observed (no detection)', () => {
  it('the latched status and an open wait, the wait at rank 1', async () => {
    const now = Date.now();
    observeStatusEvidence(buildCompositeKey('wt-1', 'claude', 'claude'), { status: 'running', reason: 'hook_x', evidence: 'positive' }, now);
    observeWaitingEdge({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex', waiting: true, now });
    const brief = await json();
    const [claude, codex] = ['claude', 'codex'].map((id) => entriesOf(brief, 'state').find((entry) => entry.id === id)!);
    expect(claude).toMatchObject({ rank: 6, fields: { status: 'running', observed: new Date(now).toISOString() } });
    expect(codex).toMatchObject({ rank: 1, fields: { observed: 'none', waiting: new Date(now).toISOString() } });
    expect(brief.sources.find((source) => source.id === 'state')!.status).toBe('ok');
  });

  it('nothing observed is observed=none, not "could not be read"', async () => {
    const brief = await json();
    expect(brief.sources.find((source) => source.id === 'state')!.status).toBe('unobserved');
    expect(entriesOf(brief, 'state').every((entry) => entry.fields.observed === 'none')).toBe(true);
  });
});

describe('S2 auto-yes per instance, never the aggregate', () => {
  it('another instance’s grant is not this instance’s; an expired grant reads expired without being rewritten', async () => {
    setAutoYesEnabled('wt-1', 'codex', true, 3_600_000, undefined, 'codex');
    setAutoYesEnabled('wt-1', 'claude', true, 3_600_000, undefined, 'claude');
    const later = Date.now() + 2 * 3_600_000;
    setAutoYesEnabled('wt-1', 'codex', true, 10_800_000, undefined, 'codex');
    const brief = await json({ now: () => later });
    const own = entriesOf(brief, 'auto-yes').find((entry) => entry.id === 'claude')!;
    const other = entriesOf(brief, 'auto-yes').find((entry) => entry.id === 'codex')!;
    expect(own).toMatchObject({ rank: 6, fields: { enabled: false, stop: 'expired' } });
    expect(other).toMatchObject({ rank: 10, fields: { enabled: true, mode: 'recommended' } });
    // Read, not rewritten: the stored grant is still the enabled one.
    expect(peekAutoYesState('wt-1', 'claude', 'claude')?.enabled).toBe(true);
  });

  it('no state for the instance reads disabled; a contract with mode off reads blocked', async () => {
    world.task({ title: 'locked', autoYesMode: 'off' });
    const own = entriesOf(await json(), 'auto-yes').find((entry) => entry.id === 'claude')!;
    expect(own.fields).toMatchObject({ enabled: false, contract: 'blocked' });
  });
});

describe('S3 relays at this instance’s ends', () => {
  it('a prompt is rank 1, a held payload rank 3, the rest rank 10', async () => {
    for (const id of ['wt-2', 'wt-3', 'wt-4', 'wt-5']) world.worktree(id, null);
    const prompt = world.relay({ worktreeId: 'wt-2', instanceId: 'codex' }, { worktreeId: 'wt-1', instanceId: 'claude' }, 'prompt');
    const held = world.relay({ worktreeId: 'wt-1', instanceId: 'claude' }, { worktreeId: 'wt-3', instanceId: 'codex' });
    world.db.prepare("UPDATE session_relays SET pending_kind = 'reply' WHERE id = ?").run(held);
    const plain = world.relay({ worktreeId: 'wt-1', instanceId: 'claude' }, { worktreeId: 'wt-4', instanceId: 'claude' });
    world.relay({ worktreeId: 'wt-1', instanceId: 'codex' }, { worktreeId: 'wt-5', instanceId: 'claude' }); // another instance's
    const rows = entriesOf(await json(), 'relay');
    expect(rows.map((row) => [row.id, row.rank, row.fields.dir])).toEqual([
      [prompt, 1, 'owed'],
      [held, 3, 'awaiting'],
      [plain, 10, 'awaiting'],
    ]);
    expect(rows[0].fields.peer).toBe('wt-2/codex');
  });
});

describe('I16 S4・S5 belong to the instance', () => {
  it('another instance’s and a removed instance’s contracts are not this one’s; the worktree’s verify is scope=worktree', async () => {
    const base = Date.now();
    const own = world.task({ instanceId: null, title: 'primary, old shape', updatedAt: base });
    const codex = world.task({ cliToolId: 'codex', instanceId: 'codex', title: 'codex work', updatedAt: base + 10 });
    world.task({ cliToolId: 'codex', instanceId: 'codex-2', title: 'removed instance', updatedAt: base + 20 });
    // The positive control: the worktree's newest task is the removed instance's.
    expect(listTasks(world.db, 'wt-1', 1)[0].instanceId).toBe('codex-2');
    world.verify('codex');
    const mine = world.verify('claude');
    const shared = world.verify(null);
    const brief = await json();
    const tasks = entriesOf(brief, 'task');
    expect(tasks.find((entry) => entry.rank === 6)).toMatchObject({ id: own, fields: { instance: 'claude' }, text: 'primary, old shape' });
    expect(tasks.find((entry) => entry.rank === 10)).toMatchObject({ id: codex, fields: { instance: 'codex' } });
    expect(JSON.stringify(brief)).not.toContain('removed instance');
    const verifies = entriesOf(brief, 'verify');
    expect(verifies.map((entry) => [entry.id, entry.rank, entry.fields.scope])).toEqual([
      [String(mine), 6, 'instance'],
      [String(shared), 10, 'worktree'],
    ]);
  });
});

describe('I17 S9 by reply’s rule: a reference, never the body', () => {
  it('no turn row → no_turn_yet; the newest of several turns wins; a later user row does not move it', async () => {
    const t = Date.UTC(2026, 10, 9, 1, 0, 0);
    world.message({ instanceId: 'claude', cliToolId: 'claude', role: 'user', content: 'MARKER-user', at: t });
    world.message({ instanceId: 'claude', cliToolId: 'claude', role: 'assistant', content: 'MARKER-scrape', at: t + 1000 });
    let row = entriesOf(await json(), 'transcript').find((entry) => entry.id === 'claude')!;
    expect(row.fields).toMatchObject({ unavailable: 'no_turn_yet' });

    world.message({ instanceId: 'claude', cliToolId: 'claude', role: 'assistant', content: 'MARKER-turn-a', at: t + 2000, requestId: 'claude-turn:a' });
    world.message({ instanceId: 'claude', cliToolId: 'claude', role: 'assistant', content: 'MARKER-turn-b', at: t + 5000, requestId: 'claude-turn:b' });
    world.message({ instanceId: 'claude', cliToolId: 'claude', role: 'user', content: 'MARKER-later', at: t + 9000 });
    const brief = await json();
    row = entriesOf(brief, 'transcript').find((entry) => entry.id === 'claude')!;
    expect(row.fields).toMatchObject({ last: new Date(t + 5000).toISOString(), read: 'commandmate reply wt-1 --instance claude' });
    expect(JSON.stringify(brief)).not.toContain('MARKER');
    // The positive control: the rows as the DB answers them (newest first) pick the oldest turn.
    const rows = getMessages(world.db, 'wt-1', { instanceId: 'claude', limit: 30 }).map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
    })) as unknown as Parameters<typeof replyCandidates>[0];
    expect(pickLatestReply(replyCandidates(rows, 0), true)?.at).toBe(new Date(t + 2000).toISOString());
  });

  it('a tool without a transcript reader says so, and the rest of the brief is there', async () => {
    world.db.prepare("UPDATE agent_instances SET cli_tool_id = 'copilot' WHERE worktree_id = 'wt-1' AND instance_id = 'codex'").run();
    const brief = await json();
    expect(entriesOf(brief, 'transcript').find((entry) => entry.id === 'codex')!.fields).toMatchObject({ unavailable: 'no_transcript_reader' });
    expect(entriesOf(brief, 'state').length).toBe(2);
  });
});

describe('S6 the run record adapter', () => {
  it('reads only the Issue of the branch, from files whose range names it, the newest record', async () => {
    world.head = { ...world.head, branch: 'feature/4223-brief' };
    world.runLog('2026-11-08', '4220-4225', [
      { issue: 4223, stage: 'dispatch', result: 'ok', at: '2026-11-08T01:00:00.000Z' },
      { issue: 4224, stage: 'merge', result: 'ok', at: '2026-11-08T09:00:00.000Z' },
    ]);
    world.runLog('2026-11-09', '4223', [{ issue: 4223, stage: 'verify', result: 'fail', at: '2026-11-09T02:00:00.000Z', note: 'NOTE-MARKER' }]);
    world.runLog('2026-11-09', '4224', [{ issue: 4223, stage: 'merge', result: 'ok', at: '2026-11-09T05:00:00.000Z' }]);
    const run = entriesOf(await json({ now: () => Date.parse('2026-11-09T06:00:00.000Z') }), 'run');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      rank: 6,
      id: '#4223',
      fields: { issue: 4223, stage: 'verify', result: 'fail', read: 'node scripts/orchestrate/run-log.mjs status --run-dir workspace/orchestration/runs/2026-11-09 --issues 4223' },
    });
    expect(JSON.stringify(run)).not.toContain('NOTE-MARKER');
  });

  it('a file over 1 MiB is too_large; a branch without an Issue reads nothing', async () => {
    world.head = { ...world.head, branch: 'feature/4223-brief' };
    const file = world.runLog('2026-11-09', '4223', []);
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    let brief = await json({ now: () => Date.parse('2026-11-09T06:00:00.000Z') });
    expect(brief.sources.find((source) => source.id === 'run')).toMatchObject({ status: 'unsupported', reason: 'too_large' });
    world.head = { ...world.head, branch: 'main' };
    brief = await json();
    expect(brief.sources.find((source) => source.id === 'run')!.status).toBe('absent');
  });

  it('the names', () => {
    expect(issueOfBranch('feature/4223-x')).toBe(4223);
    expect(issueOfBranch('fix/12-y')).toBe(12);
    expect(issueOfBranch('feat/4223-x')).toBeNull();
    expect(runFileNamesIssue('run-4220-4225.jsonl', 4223)).toBe(true);
    expect(runFileNamesIssue('run-4220,4223.jsonl', 4223)).toBe(true);
    expect(runFileNamesIssue('run-4224.jsonl', 4223)).toBe(false);
    expect(runFileNamesIssue('plan-4223.md', 4223)).toBe(false);
  });
});
