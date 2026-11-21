/**
 * Issue #4466 PR1a: the judgments and writes cut out of `send` / `tasks` /
 * `instances/roles` / `relays` / `auto-yes` and mem's writer resolution.
 *
 * Two properties the operation route (PR1b) builds on, each pinned here against a real
 * database:
 * - a read-only function writes nothing: the row count of every table and the
 *   connection's `total_changes()` are the same before and after (so an UPDATE that keeps
 *   the counts shows up too), nothing is broadcast, and a contract file it reads keeps its
 *   content (and a write the snapshot must see does show up — the measure's own control);
 * - a judge-and-write function is synchronous: what it returns is not a Promise.
 *
 * Temporary files live under `os.tmpdir()` and are removed after each test.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getOrCreateWorktreeIncarnation } from '@/lib/mem/incarnation';
import { readMemActor } from '@/lib/mem/service';
import { judgeRelayCreation, openRelay, recordOpenedRelay } from '@/lib/relay/relay-service';
import { isRelayRefusal, MAX_RELAY_ROUNDS, RELAY_ROUNDS_WINDOW_MS } from '@/lib/relay/relay-policy';
import { createRelay, markRelayDelivered } from '@/lib/db/relay-db';
import { relayRequestId } from '@/lib/db/chat-db';
import { broadcastMessage } from '@/lib/ws-server';
import { getWorktreeById } from '@/lib/db';
import {
  createTaskIfAllowed,
  findTaskWriteRefusal,
  readTaskContractForCreate,
} from '@/app/api/worktrees/[id]/tasks/task-create';
import { createInstanceRole, writeInstanceRole } from '@/app/api/worktrees/[id]/instances/roles/role-write';
import { WriteToolPolicyRefused, type WriteToolPolicyRequest } from '@/app/api/worktrees/[id]/send/write-tool-policy';
import { saveSendRole } from '@/app/api/worktrees/[id]/send/send-role';
import { refuseSendForTool } from '@/app/api/worktrees/[id]/send/send-request';
import {
  armAutoYesGrant,
  findAutoYesRelayRefusal,
  findAutoYesToolPolicyRefusal,
} from '@/app/api/worktrees/[id]/auto-yes/auto-yes-arm';

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

/** A hook run on every worktree read (the boundary test moves the clock there). */
const worktreeReads = vi.hoisted(() => ({ onRead: null as (() => void) | null }));

vi.mock('@/lib/db/worktree-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/worktree-db')>();
  return {
    ...actual,
    getWorktreeById: (...args: Parameters<typeof actual.getWorktreeById>) => {
      worktreeReads.onRead?.();
      return actual.getWorktreeById(...args);
    },
  };
});

const autoYes = vi.hoisted(() => ({
  shuttingDown: false,
  live: null as { enabled: boolean } | null,
  set: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>()),
  getAutoYesState: vi.fn(() => autoYes.live),
  setAutoYesEnabled: autoYes.set,
  startAutoYesPolling: autoYes.start,
}));

vi.mock('@/lib/auto-yes-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auto-yes-state')>()),
  isAutoYesShutdownStarted: vi.fn(() => autoYes.shuttingDown),
}));

const NOW = 1_800_000_000_000;
let db: Database.Database;
let tmp: string;
let savedDeclaration: string | undefined;

function insertWorktree(id: string, cliToolId = 'claude'): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, path.join(tmp, id), cliToolId, NOW);
}

/**
 * Row count of every table, plus the connection's `total_changes()` (key
 * `(total_changes)`, which an UPDATE moves too): the snapshot a read-only function must
 * leave unchanged.
 */
function rowCounts(): Record<string, number> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  }
  counts['(total_changes)'] = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  return counts;
}

/** A read-only function's whole check: the snapshot is unchanged and nothing was broadcast. */
function expectNothingWritten(before: Record<string, number>): void {
  expect(rowCounts()).toEqual(before);
  expect(broadcastMessage).not.toHaveBeenCalled();
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isPromise(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

const SESSION: WriteToolPolicyRequest = { origin: 'session', originEvidence: null, replyTo: null, autoYes: false };
const TERMINAL: WriteToolPolicyRequest = { origin: 'terminal', originEvidence: null, replyTo: null, autoYes: false };

beforeEach(() => {
  savedDeclaration = process.env.CM_ANTIGRAVITY_USAGE;
  delete process.env.CM_ANTIGRAVITY_USAGE;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'send-split-4466-'));
  db = new Database(':memory:');
  runMigrations(db);
  insertWorktree('wt-a');
  insertWorktree('wt-b', 'codex');
  autoYes.shuttingDown = false;
  autoYes.live = null;
  autoYes.set.mockReset().mockReturnValue({ enabled: true, enabledAt: NOW, expiresAt: NOW + 1 });
  autoYes.start.mockReset().mockReturnValue({ started: true });
  vi.mocked(broadcastMessage).mockClear();
  worktreeReads.onRead = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedDeclaration === undefined) delete process.env.CM_ANTIGRAVITY_USAGE;
  else process.env.CM_ANTIGRAVITY_USAGE = savedDeclaration;
});

describe('the snapshot itself (control)', () => {
  it('sees a write: making the worktree incarnation adds a row', () => {
    const before = rowCounts();
    getOrCreateWorktreeIncarnation(db, 'wt-a');
    expect(rowCounts()).not.toEqual(before);
  });

  it('sees an UPDATE that keeps every row count', () => {
    const before = rowCounts();
    db.prepare('UPDATE worktrees SET updated_at = updated_at + 1').run();
    expect(rowCounts()).not.toEqual(before);
  });
});

describe('read-only functions write nothing', () => {
  it('readMemActor resolves the writer without making the worktree incarnation', () => {
    const before = rowCounts();
    const reading = readMemActor(db, 'wt-a', 'claude');
    expect(isPromise(reading)).toBe(false);
    expect(reading).toMatchObject({ ok: true, instanceId: 'claude', cliToolId: 'claude', worktreeIncarnation: null });
    expectNothingWritten(before);
  });

  it('readMemActor answers the write paths\' refusals, writing nothing', () => {
    const before = rowCounts();
    expect(readMemActor(db, 'wt-none', 'claude')).toMatchObject({ ok: false, outcome: { body: { code: 'not_found' } } });
    expect(readMemActor(db, 'wt-a', '')).toMatchObject({ ok: false, outcome: { body: { code: 'target_required' } } });
    expect(readMemActor(db, 'wt-a', 'nobody')).toMatchObject({ ok: false, outcome: { body: { code: 'instance_not_found' } } });
    expectNothingWritten(before);
  });

  it('readMemActor reads an incarnation that exists', () => {
    const made = getOrCreateWorktreeIncarnation(db, 'wt-a');
    const before = rowCounts();
    expect(readMemActor(db, 'wt-a', 'claude')).toMatchObject({ ok: true, worktreeIncarnation: made });
    expectNothingWritten(before);
  });

  it('judgeRelayCreation allows or refuses without a row or a system line', () => {
    const before = rowCounts();
    const allowed = judgeRelayCreation(
      db,
      { from: { worktreeId: 'wt-a', instanceId: 'claude' }, to: { worktreeId: 'wt-b', instanceId: 'codex' }, now: NOW }
    );
    expect(isPromise(allowed)).toBe(false);
    expect(allowed.ok && !isRelayRefusal(allowed.verdict)).toBe(true);
    expect(allowed.ok && allowed.now).toBe(NOW);
    const refused = judgeRelayCreation(
      db,
      {
        from: { worktreeId: 'wt-a', instanceId: 'claude' },
        to: { worktreeId: 'wt-b', instanceId: 'agy-1' },
        toCliToolId: 'antigravity',
        now: NOW,
      }
    );
    expect(refused.ok && isRelayRefusal(refused.verdict) && refused.verdict.code).toBe('RELAY_TOOL_POLICY_DENIED');
    const missing = judgeRelayCreation(
      db,
      { from: { worktreeId: 'wt-a', instanceId: 'claude' }, to: { worktreeId: 'wt-none', instanceId: 'codex' }, now: NOW }
    );
    expect(missing).toMatchObject({ ok: false, refusal: { code: 'RELAY_WORKTREE_NOT_FOUND' } });
    expectNothingWritten(before);
  });

  it('readTaskContractForCreate reads the contract and writes nothing', () => {
    const worktreePath = path.join(tmp, 'wt-a');
    fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreePath, '.commandmate', 'tasks', 'x.yaml'),
      'version: 1\ntitle: "split"\ngoal: |\n  Split.\nscope:\n  allow:\n    - "src/**"\n',
      'utf8'
    );
    const contractFile = path.join(worktreePath, '.commandmate', 'tasks', 'x.yaml');
    const contractHash = sha256(contractFile);
    const before = rowCounts();
    const read = readTaskContractForCreate(worktreePath, '.commandmate/tasks/x.yaml');
    expect(isPromise(read)).toBe(false);
    expect(read.ok && read.value.contract.title).toBe('split');
    const bad = readTaskContractForCreate(worktreePath, '../outside.yaml');
    expect(bad.ok).toBe(false);
    expect(bad.ok ? null : bad.response.status).toBe(400);
    expectNothingWritten(before);
    expect(fs.readdirSync(path.join(worktreePath, '.commandmate', 'tasks'))).toEqual(['x.yaml']);
    expect(sha256(contractFile)).toBe(contractHash);
  });

  it('the policy judgments take the target as an argument and write nothing', () => {
    const before = rowCounts();
    const agy = { worktreeId: 'wt-a', cliToolId: 'antigravity' as const, instanceId: 'agy-1' };
    const codex = { worktreeId: 'wt-a', cliToolId: 'codex' as const, instanceId: 'codex' };
    expect(findTaskWriteRefusal(db, agy, SESSION)?.status).toBe(409);
    expect(findTaskWriteRefusal(db, codex, SESSION)).toBeNull();
    expect(findAutoYesToolPolicyRefusal(agy)?.status).toBe(409);
    expect(findAutoYesToolPolicyRefusal(codex)).toBeNull();
    const replyToAgy: WriteToolPolicyRequest = { ...TERMINAL, replyTo: { worktreeId: 'wt-a', instanceId: 'claude' } };
    expect(findAutoYesRelayRefusal(db, agy, replyToAgy)?.status).toBe(409);
    expect(findAutoYesRelayRefusal(db, codex, replyToAgy)).toBeNull();
    expect(findAutoYesRelayRefusal(db, agy, null)).toBeNull();
    expect(refuseSendForTool({ model: 'opus' }, 'codex')?.status).toBe(400);
    expect(refuseSendForTool({ brief: 'decline' }, 'gemini')?.status).toBe(400);
    expect(refuseSendForTool({}, 'claude')).toBeNull();
    expectNothingWritten(before);
  });
});

describe('judge-and-write functions are synchronous', () => {
  it('createTaskIfAllowed writes the row only when allowed', () => {
    const contract = (() => {
      const worktreePath = path.join(tmp, 'wt-a');
      fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
      fs.writeFileSync(
        path.join(worktreePath, '.commandmate', 'tasks', 'x.yaml'),
        'version: 1\ntitle: "split"\ngoal: |\n  Split.\nscope:\n  allow:\n    - "src/**"\n',
        'utf8'
      );
      const read = readTaskContractForCreate(worktreePath, '.commandmate/tasks/x.yaml');
      if (!read.ok) throw new Error('fixture contract did not load');
      return read.value.contract;
    })();
    const row = { rowInstanceId: null, contractPath: '.commandmate/tasks/x.yaml', contract };
    const before = rowCounts();
    const refused = createTaskIfAllowed(
      db,
      { worktreeId: 'wt-a', cliToolId: 'antigravity', instanceId: 'agy-1' },
      SESSION,
      row
    );
    expect(isPromise(refused)).toBe(false);
    expect(refused.ok ? null : refused.response.status).toBe(409);
    expect(rowCounts()).toEqual(before);
    const created = createTaskIfAllowed(db, { worktreeId: 'wt-a', cliToolId: 'claude', instanceId: 'claude' }, SESSION, row);
    expect(isPromise(created)).toBe(false);
    expect(created.ok && created.task.cliToolId).toBe('claude');
    expect(rowCounts().tasks).toBe(before.tasks + 1);
  });

  it('recordOpenedRelay writes what openRelay writes for an allowed judgment', () => {
    const input = { from: { worktreeId: 'wt-a', instanceId: 'claude' }, to: { worktreeId: 'wt-b', instanceId: 'codex' }, now: NOW };
    const judged = judgeRelayCreation(db, input);
    if (!judged.ok || isRelayRefusal(judged.verdict)) throw new Error('expected an allowed relay');
    const before = rowCounts();
    const relay = recordOpenedRelay(db, input, judged.verdict.hops, NOW);
    expect(isPromise(relay)).toBe(false);
    expect(relay.state).toBe('pending');
    const afterRecord = rowCounts();
    expect(afterRecord.session_relays).toBe(before.session_relays + 1);
    // openRelay is the same judgment and write: a refused one adds nothing.
    const refused = openRelay(db, { ...input, to: { worktreeId: 'wt-b', instanceId: 'agy-1' }, toCliToolId: 'antigravity' });
    expect(refused.ok).toBe(false);
    expect(rowCounts()).toEqual(afterRecord);
  });

  it('openRelay takes its time after the worktrees are found, as it always did (round-trip window edge)', () => {
    const A = { worktreeId: 'wt-a', instanceId: 'claude' };
    const B = { worktreeId: 'wt-b', instanceId: 'codex' };
    // MAX_RELAY_ROUNDS replies to A's own relays: one exactly at the window's lower edge
    // for a clock that reads NOW, the rest well inside it.
    for (let i = 0; i < MAX_RELAY_ROUNDS; i += 1) {
      const at = i === 0 ? NOW - RELAY_ROUNDS_WINDOW_MS : NOW - 60_000 - i * 1_000;
      const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: at + 3_600_000, now: at - 1, bindMode: 'legacy' });
      markRelayDelivered(db, relay.id, relayRequestId(relay.id), at);
    }
    // The clock reads NOW until the first worktree read, then NOW + 1 ms: taken after the
    // existence check, the edge reply has left the window (9 < MAX) and the relay opens;
    // taken before it, the edge reply still counts and the ceiling refuses.
    let clock = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    worktreeReads.onRead = () => {
      clock = NOW + 1;
    };
    const result = openRelay(db, { from: A, to: B });
    worktreeReads.onRead = null;
    expect(result.ok ? 'opened' : result.refusal.code).toBe('opened');
  });

  it('createInstanceRole and writeInstanceRole throw a policy refusal with nothing written', () => {
    const before = rowCounts();
    let thrown: unknown = null;
    try {
      const result = createInstanceRole(db, 'wt-a', {
        instance: { id: 'agy-1', cliTool: 'antigravity' },
        role: { state: 'inherit' },
        request: SESSION,
      });
      expect(isPromise(result)).toBe(false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WriteToolPolicyRefused);
    expect(rowCounts()).toEqual(before);

    const created = createInstanceRole(db, 'wt-a', {
      instance: { id: 'codex-2', cliTool: 'codex' },
      role: { state: 'inherit' },
      request: SESSION,
    });
    expect(isPromise(created)).toBe(false);
    expect(created.instanceId).toBe('codex-2');

    const worktree = getWorktreeById(db, 'wt-a');
    if (!worktree) throw new Error('worktree missing');
    const written = writeInstanceRole(db, 'wt-a', worktree, { instanceId: 'codex-2', role: { state: 'none' }, request: SESSION });
    expect(isPromise(written)).toBe(false);
  });

  it('saveSendRole is synchronous and writes nothing for a send naming no role or a malformed one', () => {
    const worktree = getWorktreeById(db, 'wt-a');
    if (!worktree) throw new Error('worktree missing');
    const target = { worktree, cliToolId: 'claude' as const, rosterInstanceId: 'claude', instanceId: undefined };
    const recordNotSent = vi.fn();
    const before = rowCounts();
    const none = saveSendRole(db, {}, target, recordNotSent);
    expect(isPromise(none)).toBe(false);
    expect(none).toMatchObject({ ok: true, value: { saved: false } });
    const bad = saveSendRole(db, { role: 42 as unknown as string }, target, recordNotSent);
    expect(isPromise(bad)).toBe(false);
    expect(bad.ok).toBe(false);
    expect(recordNotSent).toHaveBeenCalledWith('role-launch-refused');
    expect(rowCounts()).toEqual(before);
  });

  it('armAutoYesGrant judges after the last await and arms with nothing in between', () => {
    const target = { worktreeId: 'wt-a', cliToolId: 'claude' as const, instanceId: 'claude' };
    const input = { onlyIfOff: false, duration: 3_600_000 as const, stopPattern: undefined, answerMode: undefined, relayRefusal: () => null };

    autoYes.shuttingDown = true;
    const shut = armAutoYesGrant(target, input);
    expect(isPromise(shut)).toBe(false);
    expect(shut.kind).toBe('shutting-down');

    autoYes.shuttingDown = false;
    autoYes.live = { enabled: true };
    expect(armAutoYesGrant(target, { ...input, onlyIfOff: true }).kind).toBe('already-on');

    const refusedBody = new Response(null, { status: 409 });
    expect(armAutoYesGrant(target, { ...input, relayRefusal: () => refusedBody as never }).kind).toBe('relay-refused');
    expect(autoYes.set).not.toHaveBeenCalled();
    expect(autoYes.start).not.toHaveBeenCalled();

    const armed = armAutoYesGrant(target, input);
    expect(isPromise(armed)).toBe(false);
    expect(armed).toMatchObject({ kind: 'armed', pollingStarted: true });
    expect(autoYes.set).toHaveBeenCalledWith('wt-a', 'claude', true, 3_600_000, undefined, 'claude');
    expect(autoYes.start).toHaveBeenCalledWith('wt-a', 'claude', 'claude');
  });
});
