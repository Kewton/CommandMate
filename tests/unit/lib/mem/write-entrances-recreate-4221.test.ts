/**
 * The invariant every write of mem keeps (Issue #4221, 2nd・3rd integration review):
 * a request read before the worktree was deleted and made again under the same id
 * and path is refused, whatever the entrance and the mode; one the worktree was
 * left alone for lands.
 *
 * One table, one test each way. The table is checked against the entrances
 * themselves, enumerated from the store's side (4th review): the exported functions
 * of `src/lib/db/mem-db.ts` that INSERT / UPDATE / DELETE, and every exported
 * function of `src/lib/mem/service.ts` that reaches one of them, with or without an
 * actor. Each must be a row or a named exception; each mode of the screen's save and
 * the condition's save have rows too — so a new way in fails the first test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

/**
 * Issue #4227 G-PR2 (PM P3-a): the mutation of the D6 rows' control — the check of the
 * mark of a person's approval removed (`approvalMarkHolds` always true, and its use never
 * refused), to show it is that check that refuses a changed or used approval.
 */
const markMutation = { removed: false };
/**
 * Issue #4227 pr2c (A P3-2): one check of `approvalMarkHolds` dropped alone — the mark's
 * write fitted to the proposal (`op`), the request read as `applying` under the mark's token
 * (`request`), or the write's worktree and instance fitted to the request's (`target`) —
 * by handing the real function what makes that check pass and nothing else.
 */
const markMismatchMutation: { dropped: 'op' | 'request' | 'target' | null } = { dropped: null };
vi.mock('@/lib/db/handoff-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/handoff-db')>();
  const mutated = (...args: Parameters<typeof actual.approvalMarkHolds>): boolean => {
    const [database, mark, write] = args;
    const proposal = actual.getHandoffProposal(database, mark.proposalId);
    const request = proposal ? actual.getHandoffRequest(database, proposal.requestId) : null;
    if (!proposal || !request) return actual.approvalMarkHolds(...args);
    switch (markMismatchMutation.dropped) {
      case 'op':
        return actual.approvalMarkHolds(database, mark, { ...write, op: proposal.op, itemId: proposal.itemId });
      case 'target':
        return actual.approvalMarkHolds(database, mark, { ...write, worktreeId: request.targetWorktreeId, instanceId: request.instanceId });
      case 'request': {
        // The request read as it would be under the mark (applying, the mark's token), then put back.
        const saved = database.prepare('SELECT state, apply_token FROM mem_handoff_requests WHERE id = ?').get(request.id) as { state: string; apply_token: string | null };
        database.prepare("UPDATE mem_handoff_requests SET state = 'applying', apply_token = ? WHERE id = ?").run(mark.applyToken, request.id);
        try {
          return actual.approvalMarkHolds(...args);
        } finally {
          database.prepare('UPDATE mem_handoff_requests SET state = ?, apply_token = ? WHERE id = ?').run(saved.state, saved.apply_token, request.id);
        }
      }
      default:
        return actual.approvalMarkHolds(...args);
    }
  };
  return {
    ...actual,
    approvalMarkHolds: (...args: Parameters<typeof actual.approvalMarkHolds>) => (markMutation.removed ? true : mutated(...args)),
    consumeApprovalMark: (...args: Parameters<typeof actual.consumeApprovalMark>) => (markMutation.removed ? true : actual.consumeApprovalMark(...args)),
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { createRepository } from '@/lib/db/db-repository';
import {
  changeHandoffRequest,
  consumeApprovalMark,
  getHandoffProposal,
  insertHandoffProposal,
  insertHandoffRequest,
  setHandoffProposalState,
  type HandoffApprovalMark,
} from '@/lib/db/handoff-db';
import { closeMemItemByCondition, getMemRecord, getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { getOrCreateWorktreeIncarnation } from '@/lib/mem/incarnation';
import {
  memAddItem,
  memCloseItem,
  memPurge,
  memSettleDecisionTransition,
  memUpdateItem,
  memWriteFromScreen,
  memWriteNow,
  writeSessionNoteFromScreen,
  type MemServiceDeps,
} from '@/lib/mem/service';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import type { MemWriteResponse } from '@/types/mem';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WT = 'wt-r';
const SERVICE = path.join(process.cwd(), 'src/lib/mem/service.ts');

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;
/** Holds the next await of the request (git's `observe`, or the condition's `origin`) until released. */
let hold: { wait: Promise<void>; armed: boolean } | null;

function arm(): () => void {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  hold = { wait, armed: true };
  return release;
}
async function held(): Promise<void> {
  if (hold?.armed) {
    hold.armed = false;
    await hold.wait;
  }
}

const head: WorktreeHeadObservation = { branch: 'feature/x', detached: false, head: SHA, commonDir: '/common/.git', known: true };
const deps = (): MemServiceDeps => ({
  resolveCommonDir: async () => '/common/.git',
  pathExists: () => true,
  observe: async () => {
    await held();
    return { ...head };
  },
  git: {
    originUrl: async () => {
      await held();
      return 'git@github.com:Kewton/CommandMate.git';
    },
    refTip: async () => SHA,
  },
});

const wtPath = () => path.join(dir, 'wt-r');
function makeWorktree(): void {
  mkdirSync(wtPath(), { recursive: true });
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(
    WT,
    WT,
    wtPath(),
    rootA
  );
}
function setMode(mode: 'off' | 'derived' | 'on'): void {
  const current = getMemSettings(db, repoA);
  saveMemSettings(db, repoA, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}
const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const noteIs = (text: string) => count('SELECT COUNT(*) n FROM session_notes WHERE worktree_id = ? AND note = ?', WT, text) === 1;
const itemIs = (where: string, ...params: unknown[]) => count(`SELECT COUNT(*) n FROM mem_items WHERE ${where}`, ...params) === 1;

interface Entrance {
  /** The exported function of the service this row drives. */
  fn: string;
  mode: 'off' | 'derived' | 'on';
  /** Made before the request is read (an item to update or close). */
  before?: () => Promise<{ id: string; version: number }>;
  request: (made: { id: string; version: number } | undefined) => Promise<{ status: number; body: unknown }>;
  /** Done while the request waits, after the re-creation when there is one (mem the new worktree writes). */
  during?: () => Promise<void>;
  /** Whether the request's write is in the store. */
  landed: (made: { id: string; version: number } | undefined) => boolean;
}

const addNote = async (text: string) => {
  const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text }, deps());
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};
const screen = (mode: Entrance['mode']): Entrance => ({
  fn: 'writeSessionNoteFromScreen',
  mode,
  request: () => writeSessionNoteFromScreen(db, WT, { instanceId: 'claude', text: `screen ${mode}` }, deps()),
  landed: () => noteIs(`screen ${mode}`),
});

/** Every way in that writes mem. */
/**
 * Issue #4225 (§0.1 S1・PM): a decision recorded / promoted through A's one entrance.
 * The lifetime is read when the request arrives (before the await), as the promote
 * service does; the entrance compares it and never fixes it again.
 */
const addDecision = async (text: string) => {
  const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'decision', text, promoteTo: 'issue:#4225' }, deps());
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};
const settleDecision = (made: { id: string; version: number }, transition: 'record' | 'promote' | 'promote-record-only', version = made.version) =>
  memSettleDecisionTransition(
    db,
    { worktreeId: WT, expectedWorktreeIncarnation: getOrCreateWorktreeIncarnation(db, WT), itemId: made.id, expectedVersion: version, transition },
    deps()
  );
const recordedDecision = async (text: string) => {
  const made = await addDecision(text);
  const outcome = await settleDecision(made, 'record');
  const item = (outcome.body as MemWriteResponse).item;
  return { id: item.id, version: item.version };
};
/** Issue #4227 (S-A): a request that carries the screen's mark, as the screen's routes pass it on. */
const screenRequest = () => ({
  headers: new Headers({ 'X-CommandMate-Client': 'screen', origin: 'http://localhost', host: 'localhost' }),
  url: 'http://localhost/api/worktrees/wt-r/mem/screen/items',
});
const screenWrite = (op: 'add' | 'update' | 'close', body: Record<string, unknown>, itemId?: string) =>
  memWriteFromScreen(db, screenRequest(), WT, { op, author: 'human', ...(itemId ? { itemId } : {}), body: { instanceId: 'claude', ...body } }, deps());
/** Issue #4227 (Epic #4220 D6): an item a person added on the screen (`created_by = 'human'`, owned by `claude`). */
let humanKeys = 0;
const humanItem = async (text: string, kind: 'note' | 'next' = 'note') => {
  humanKeys += 1;
  const outcome = await screenWrite('add', {
    kind,
    text,
    key: `human-${humanKeys}`,
    expectBranch: 'feature/x',
    ...(kind === 'next' ? { closeWhen: 'issue:#4221' } : {}),
  });
  const item = (outcome.body as MemWriteResponse).item;
  expect(item.createdBy).toBe('human');
  return { id: item.id, version: item.version };
};
/**
 * Issue #4227 G-PR2 (PM P3-a): a hand-off proposal to update `made`, approved by a person
 * (the request `applying` under a decide's token, the proposal `approved` with the
 * fingerprint the person saw), confirmed through the one entrance as the proposer with
 * the mark. `tamper`: the proposal's content changed after the approval. `used`: the mark
 * was used once already. `mark: false`: a proposer with no approval at all.
 */
let proposals = 0;
/**
 * Issue #4227 pr2c (A P3-2): a mark that is the proposal's own (approved, the fingerprint the
 * person saw, unused) but does not fit the write: `proposalOp` / `proposalItemId` (the proposal
 * is of another op or item), `requestAfter` (the request no longer `applying` under the token),
 * `requestWorktree` / `requestInstance` (the request is of another worktree or instance).
 */
interface MarkMismatch {
  proposalOp?: 'close';
  proposalItemId?: string;
  requestAfter?: 'cancelled' | 'other-token';
  requestWorktree?: string;
  requestInstance?: string;
}
async function proposalWrite(
  made: { id: string; version: number },
  text: string,
  options: { tamper?: boolean; used?: boolean; mark?: boolean } & MarkMismatch = {}
) {
  proposals += 1;
  const now = Date.now();
  const token = `tok-${proposals}`;
  const requestId = `req-${proposals}`;
  insertHandoffRequest(db, {
    id: requestId,
    repositoryId: repoA,
    branch: 'feature/x',
    detached: false,
    targetWorktreeId: options.requestWorktree ?? WT,
    targetWorktreeIncarnation: getOrCreateWorktreeIncarnation(db, WT),
    instanceId: options.requestInstance ?? 'claude',
    cliToolId: 'claude',
    instanceIncarnation: null,
    instanceOnRoster: false,
    boundaryId: `boundary-${proposals}`,
    agentDeadlineAt: now + 60_000,
    expiresAt: now + 3_600_000,
    now,
  });
  changeHandoffRequest(db, requestId, null, { state: 'applying', applyToken: token }, now);
  const proposal = insertHandoffProposal(db, {
    id: `prop-${proposals}`,
    requestId,
    op: options.proposalOp ?? 'update',
    itemId: options.proposalItemId ?? made.id,
    kind: 'note',
    baseVersion: made.version,
    payload: options.proposalOp === 'close' ? { reason: text } : { text },
    authorInstanceId: 'claude',
    authorIncarnation: null,
    checkedRulesVersion: 1,
    now,
  });
  setHandoffProposalState(db, proposal.id, ['proposed'], { state: 'approved', applyToken: token, approvedFingerprint: proposal.fingerprint }, now);
  const mark: HandoffApprovalMark = { proposalId: proposal.id, applyToken: token, fingerprint: proposal.fingerprint };
  if (options.tamper) db.prepare('UPDATE mem_handoff_proposals SET base_version = base_version + 1 WHERE id = ?').run(proposal.id);
  if (options.used) expect(consumeApprovalMark(db, mark, { itemId: 'elsewhere', version: 1 }, now)).toBe(true);
  if (options.requestAfter === 'cancelled') db.prepare("UPDATE mem_handoff_requests SET state = 'cancelled', apply_token = NULL WHERE id = ?").run(requestId);
  if (options.requestAfter === 'other-token') db.prepare("UPDATE mem_handoff_requests SET apply_token = 'tok-other' WHERE id = ?").run(requestId);
  const outcome = await memWriteFromScreen(
    db,
    screenRequest(),
    WT,
    { op: 'update', author: 'proposer', itemId: made.id, body: { instanceId: 'claude', ifVersion: made.version, text }, ...(options.mark === false ? {} : { approval: mark }) },
    deps()
  );
  return { outcome, proposalId: proposal.id };
}
const decisionIs = (state: string) => (made: { id: string; version: number } | undefined) =>
  itemIs('id = ? AND state = ? AND version = ?', made!.id, state, made!.version + 1);

const ENTRANCES: Record<string, Entrance> = {
  'cli-now': {
    fn: 'memWriteNow',
    mode: 'on',
    request: () => memWriteNow(db, WT, { instanceId: 'claude', text: 'cli now' }, deps()),
    landed: () => noteIs('cli now'),
  },
  'cli-add': {
    fn: 'memAddItem',
    mode: 'on',
    request: () => memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text: 'cli add' }, deps()),
    landed: () => itemIs("text = 'cli add'"),
  },
  'cli-update': {
    fn: 'memUpdateItem',
    mode: 'on',
    before: () => addNote('to update'),
    request: (made) => memUpdateItem(db, WT, made!.id, { instanceId: 'claude', ifVersion: made!.version, text: 'cli updated' }, deps()),
    landed: (made) => itemIs("id = ? AND text = 'cli updated'", made!.id),
  },
  'cli-close': {
    fn: 'memCloseItem',
    mode: 'on',
    before: () => addNote('to close'),
    request: (made) => memCloseItem(db, WT, made!.id, { instanceId: 'claude' }, deps()),
    landed: (made) => itemIs("id = ? AND state = 'closed'", made!.id),
  },
  'screen-on': screen('on'),
  'screen-off': screen('off'),
  'screen-derived': screen('derived'),
  // The condition's save: git is asked for `origin` before the write binds it.
  'condition-add': {
    fn: 'memAddItem',
    mode: 'on',
    request: () => memAddItem(db, WT, { instanceId: 'claude', kind: 'next', text: 'cond add', closeWhen: 'issue:#4221' }, deps()),
    landed: () => itemIs("text = 'cond add'"),
  },
  'condition-update': {
    fn: 'memUpdateItem',
    mode: 'on',
    before: async () => {
      const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'next', text: 'cond', closeWhen: 'manual' }, deps());
      const item = (outcome.body as MemWriteResponse).item;
      return { id: item.id, version: item.version };
    },
    request: (made) => memUpdateItem(db, WT, made!.id, { instanceId: 'claude', ifVersion: made!.version, closeWhen: 'issue:#4221' }, deps()),
    landed: (made) => itemIs("id = ? AND close_when LIKE '%\"issue\"%'", made!.id),
  },
  // A purge named through the worktree (`commandmate mem purge`): it must not delete
  // what the worktree made again under the same id and path writes (4th review・PM).
  // Issue #4225: the three transitions of a decision (A's entrance for E).
  'decision-record': {
    fn: 'memSettleDecisionTransition',
    mode: 'on',
    before: () => addDecision('to record'),
    request: (made) => settleDecision(made!, 'record'),
    landed: decisionIs('recorded'),
  },
  'decision-promote': {
    fn: 'memSettleDecisionTransition',
    mode: 'on',
    before: () => recordedDecision('to promote'),
    request: (made) => settleDecision(made!, 'promote'),
    landed: decisionIs('promoted'),
  },
  'decision-record-only': {
    fn: 'memSettleDecisionTransition',
    mode: 'on',
    before: () => addDecision('record only'),
    request: (made) => settleDecision(made!, 'promote-record-only'),
    landed: decisionIs('promoted'),
  },
  // Issue #4227 (S-A・S-D): a person's add / edit / close from the screen, and the close
  // of a recorded decision a person confirmed is not reflected (`withdraw-recorded`).
  'screen-add': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    request: () => screenWrite('add', { kind: 'note', text: 'screen add', key: 'screen-add-1', expectBranch: 'feature/x' }),
    landed: () => itemIs("text = 'screen add' AND created_by = 'human'"),
  },
  'screen-update': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => addNote('to screen update'),
    request: (made) => screenWrite('update', { ifVersion: made!.version, text: 'screen updated' }, made!.id),
    landed: (made) => itemIs("id = ? AND text = 'screen updated' AND updated_by = 'human'", made!.id),
  },
  'screen-close': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => addNote('to screen close'),
    request: (made) => screenWrite('close', { ifVersion: made!.version }, made!.id),
    landed: (made) => itemIs("id = ? AND state = 'closed' AND updated_by = 'human'", made!.id),
  },
  'screen-close-recorded': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => recordedDecision('to withdraw'),
    request: (made) => screenWrite('close', { ifVersion: made!.version, confirmUnreflected: true }, made!.id),
    landed: (made) => itemIs("id = ? AND state = 'closed' AND close_reason = 'withdrawn'", made!.id),
  },
  // Issue #4227 (D6): a person's item through a person's entrance (the agent's entrances refuse it, below).
  'screen-update-human-item': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => humanItem('a person wrote it to update'),
    request: (made) => screenWrite('update', { ifVersion: made!.version, text: 'a person updated it' }, made!.id),
    landed: (made) => itemIs("id = ? AND text = 'a person updated it' AND created_by = 'human'", made!.id),
  },
  'screen-close-human-item': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => humanItem('a person wrote it to close'),
    request: (made) => screenWrite('close', { ifVersion: made!.version }, made!.id),
    landed: (made) => itemIs("id = ? AND state = 'closed' AND created_by = 'human'", made!.id),
  },
  // Issue #4227 G-PR2 (PM P3-a): the confirmation of a hand-off proposal a person approved
  // (`decide`'s one call), and a proposer with no approval (written as the agent it is).
  'proposal-approved-update': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => addNote('to confirm a proposal on'),
    request: async (made) => (await proposalWrite(made!, 'proposal approved')).outcome,
    landed: (made) => itemIs("id = ? AND text = 'proposal approved' AND updated_by = 'human'", made!.id),
  },
  'proposal-update': {
    fn: 'memWriteFromScreen',
    mode: 'on',
    before: () => addNote('to propose on without approval'),
    request: async (made) => (await proposalWrite(made!, 'proposal unapproved', { mark: false })).outcome,
    landed: (made) => itemIs("id = ? AND text = 'proposal unapproved' AND updated_by = 'agent'", made!.id),
  },
  'cli-purge': {
    fn: 'memPurge',
    mode: 'on',
    request: () => memPurge(db, { via: 'worktree', worktreeId: WT, branch: 'feature/x' }, { confirm: true }, deps()),
    during: async () => {
      const outcome = await memAddItem(db, WT, { instanceId: 'claude', kind: 'note', text: 'written after the request' }, deps());
      expect(outcome.status).toBe(201);
    },
    landed: () => !itemIs("text = 'written after the request'"),
  },
};

const MEM_DB = path.join(process.cwd(), 'src/lib/db/mem-db.ts');

/**
 * Ways into the service that write mem but are not refused by a re-creation of the
 * worktree, each with its reason. Kept in step with the source like the table.
 */
const NOT_BOUND_TO_A_WORKTREE_LIFETIME: Record<string, string> = {
  // None: `memPurge` was considered and is bound (an old purge named through the
  // worktree deleted what the re-created worktree wrote), so it is a row of the table.
};

interface Chunk {
  name: string;
  exported: boolean;
  body: string;
}

/** Top-level `function` / `const … =` declarations of a source, each with its text. */
function chunksOf(source: string): Chunk[] {
  const starts = [...source.matchAll(/^(export )?(?:async )?(?:function\*? (\w+)|const (\w+)\b[^=\n]*=)/gm)];
  return starts.map((match, i) => ({
    name: match[2] ?? match[3],
    exported: Boolean(match[1]),
    body: source.slice(match.index, starts[i + 1]?.index ?? source.length),
  }));
}

const calls = (body: string, names: Set<string>) => [...names].some((name) => new RegExp(`\\b${name}\\(`).test(body));

/** Names of `chunks` that do `seed`, or call (within the file) one that does. */
function closure(chunks: Chunk[], seed: (chunk: Chunk) => boolean): Set<string> {
  const found = new Set(chunks.filter(seed).map((chunk) => chunk.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const chunk of chunks) {
      if (!found.has(chunk.name) && calls(chunk.body.slice(chunk.body.indexOf('{')), found)) {
        found.add(chunk.name);
        grew = true;
      }
    }
  }
  return found;
}

/** The store's exported writes: functions of mem-db that INSERT / UPDATE / DELETE, directly or through its own helpers. */
function storeWriters(memDbSource: string): Set<string> {
  const chunks = chunksOf(memDbSource);
  const writes = closure(chunks, (chunk) => /\b(INSERT|UPDATE|DELETE)\b/.test(chunk.body));
  return new Set(chunks.filter((chunk) => chunk.exported && writes.has(chunk.name)).map((chunk) => chunk.name));
}

/** The service's exported functions that reach one of the store's writes. */
function writeEntrancesOf(serviceSource: string, writers: Set<string>): string[] {
  const chunks = chunksOf(serviceSource);
  const reach = closure(chunks, (chunk) => calls(chunk.body, writers));
  return chunks.filter((chunk) => chunk.exported && reach.has(chunk.name)).map((chunk) => chunk.name).sort();
}

const tableAndExceptions = () =>
  [...new Set([...Object.values(ENTRANCES).map((entry) => entry.fn), ...Object.keys(NOT_BOUND_TO_A_WORKTREE_LIFETIME)])].sort();

function sourcesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) return sourcesUnder(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

beforeEach(() => {
  dir = makeTempDir('mem-entrances-4221-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  rootA = path.join(dir, 'root-a');
  mkdirSync(rootA, { recursive: true });
  repoA = createRepository(db, { name: 'repo-a', path: rootA, cloneSource: 'local' }).id;
  hold = null;
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('every write of mem refuses a request the worktree’s re-creation overtook', () => {
  it('the table names every entrance (a new one fails here until it has a row)', () => {
    const writers = storeWriters(readFileSync(MEM_DB, 'utf8'));
    // The source of the check is the store's writes, not the actor (4th review P2).
    for (const known of ['replaceNowSlot', 'createMemItem', 'updateMemItem', 'closeMemItem', 'writeScreenNote', 'purgeMem']) {
      expect(writers.has(known)).toBe(true);
    }
    expect(writeEntrancesOf(readFileSync(SERVICE, 'utf8'), writers)).toEqual(tableAndExceptions());
    // A way is in the table or an exception, never both.
    const inTable = new Set(Object.values(ENTRANCES).map((entry) => entry.fn));
    expect(Object.keys(NOT_BOUND_TO_A_WORKTREE_LIFETIME).filter((name) => inTable.has(name))).toEqual([]);
    const screenModes = Object.values(ENTRANCES)
      .filter((entry) => entry.fn === 'writeSessionNoteFromScreen')
      .map((entry) => entry.mode)
      .sort();
    expect(screenModes).toEqual(['derived', 'off', 'on']);
    expect(Object.keys(ENTRANCES).filter((key) => key.startsWith('condition-')).length).toBeGreaterThan(0);
    // No way around the service: the store's writes are called from it alone.
    const storeCalls = /\b(replaceNowSlot|createMemItem|updateMemItem|closeMemItem|writeScreenNote)\(/;
    const callers = sourcesUnder(path.join(process.cwd(), 'src'))
      .filter((file) => !file.endsWith(path.join('lib', 'db', 'mem-db.ts')) && file !== SERVICE)
      .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => storeCalls.test(line) && !/^\s*(\/\/|\*)/.test(line)));
    expect(callers).toEqual([]);
  });

  it('the check catches a new way in that writes without an actor (and one through a helper)', () => {
    const writers = storeWriters(readFileSync(MEM_DB, 'utf8'));
    const service = readFileSync(SERVICE, 'utf8');
    const direct = `${service}\nexport async function memSweep(db: Database.Database): Promise<void> {\n  purgeMem(db, scope, {}, true);\n}\n`;
    expect(writeEntrancesOf(direct, writers)).toEqual([...tableAndExceptions(), 'memSweep'].sort());
    const viaHelper = `${service}\nfunction sweepHelper(db: Database.Database): void {\n  closeMemItem(db, actor, 'x', null);\n}\nexport function memSweepAll(db: Database.Database): void {\n  sweepHelper(db);\n}\n`;
    expect(writeEntrancesOf(viaHelper, writers)).toContain('memSweepAll');
    // And a new write of the store itself is a writer the check follows.
    const store = `${readFileSync(MEM_DB, 'utf8')}\nexport function eraseAll(db: Database.Database): void {\n  db.prepare('DELETE FROM mem_items').run();\n}\n`;
    expect(storeWriters(store).has('eraseAll')).toBe(true);
    // (control) a new read-only export is not a way to write.
    const reader = `${service}\nexport async function memPeek(db: Database.Database): Promise<unknown> {\n  return getMemRecord(db, 'x');\n}\n`;
    expect(writeEntrancesOf(reader, writers)).toEqual(tableAndExceptions());
  });

  it.each(Object.keys(ENTRANCES))('%s: deleted and made again (same id and path) during the await → refused, nothing written', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = entry.before ? await entry.before() : undefined;
    setMode(entry.mode);
    const release = arm();
    const pending = entry.request(made);
    await Promise.resolve();
    deleteWorktreesByIds(db, [WT]);
    makeWorktree();
    await entry.during?.();
    release();
    const outcome = await pending;
    expect(outcome.status).toBeGreaterThanOrEqual(400);
    expect(entry.landed(made)).toBe(false);
  });

  it.each(Object.keys(ENTRANCES))('%s (control): the worktree left as it was → the request lands', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = entry.before ? await entry.before() : undefined;
    setMode(entry.mode);
    const release = arm();
    const pending = entry.request(made);
    await Promise.resolve();
    await entry.during?.();
    release();
    const outcome = await pending;
    expect(outcome.status).toBeLessThan(300);
    expect(entry.landed(made)).toBe(true);
  });
});

/**
 * Issue #4225 (§0.1 S1, the PM's condition): the decision rows keep the other two
 * invariants too — no write while the branch is `off` / `derived`, and a version that
 * is not the current one is refused. Each fails if the entrance's check is removed.
 */
describe('a decision moves only when the branch is on and the version is the one approved (Issue #4225)', () => {
  const decisionRows = Object.keys(ENTRANCES).filter((key) => key.startsWith('decision-'));

  it('has the three decision rows', () => {
    expect(decisionRows.sort()).toEqual(['decision-promote', 'decision-record', 'decision-record-only']);
  });

  it.each(decisionRows.flatMap((key) => [[key, 'off'] as const, [key, 'derived'] as const]))(
    '%s with the branch %s → refused (disabled), the row unchanged',
    async (key, mode) => {
      const entry = ENTRANCES[key];
      makeWorktree();
      setMode('on');
      const made = await entry.before!();
      setMode(mode);
      const outcome = await entry.request(made);
      expect(outcome.status).toBe(409);
      expect((outcome.body as { code: string }).code).toBe('disabled');
      expect(entry.landed(made)).toBe(false);
      expect(itemIs('id = ? AND version = ?', made.id, made.version)).toBe(true);
    }
  );

  it.each(decisionRows)('%s with a version one below the current → version_conflict, nothing written', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = await entry.before!();
    const transition = key === 'decision-record' ? 'record' : key === 'decision-promote' ? 'promote' : 'promote-record-only';
    const outcome = await settleDecision(made, transition, made.version - 1);
    expect(outcome.status).toBe(409);
    expect((outcome.body as { code: string }).code).toBe('version_conflict');
    expect(itemIs('id = ? AND version = ?', made.id, made.version)).toBe(true);
  });

  it.each(decisionRows)('%s: the item updated (version + 1) during the await → version_conflict, the state unchanged', async (key) => {
    const entry = ENTRANCES[key];
    makeWorktree();
    setMode('on');
    const made = await entry.before!();
    const state = (db.prepare('SELECT state FROM mem_items WHERE id = ?').get(made.id) as { state: string }).state;
    const release = arm();
    const pending = entry.request(made);
    await Promise.resolve();
    // A person's edit (or any write) raises the version while the request waits on git.
    db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(made.id);
    release();
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect((outcome.body as { code: string }).code).toBe('version_conflict');
    expect(itemIs('id = ? AND state = ? AND version = ?', made.id, state, made.version + 1)).toBe(true);
  });

  it('a transition the table forbids (promote an open decision) → state_forbids', async () => {
    makeWorktree();
    setMode('on');
    const made = await addDecision('open still');
    const outcome = await settleDecision(made, 'promote');
    expect(outcome.status).toBe(409);
    expect((outcome.body as { code: string }).code).toBe('state_forbids');
  });

  it('a null lifetime is refused before anything is read', async () => {
    makeWorktree();
    setMode('on');
    const made = await addDecision('no lifetime');
    const outcome = await memSettleDecisionTransition(
      db,
      { worktreeId: WT, expectedWorktreeIncarnation: null, itemId: made.id, expectedVersion: made.version, transition: 'record' },
      deps()
    );
    expect(outcome.status).toBeGreaterThanOrEqual(400);
    expect(itemIs("id = ? AND state = 'open'", made.id)).toBe(true);
  });
});

/**
 * Issue #4227 (Epic #4220 D6, the PM raised it to P2): an item a person wrote is changed
 * and closed by a person only. The instance chosen as its owner does not make that
 * instance's agent its author: A's agent entrances (`mem update` / `mem close`, and the
 * condition's update) refuse it with `not_owner` (exit 55). A person's entrances and the
 * condition's close (the server's evaluation) still go through. Each agent row lands
 * if the check in `ownedBy` is removed (it did before this change); the agent's own items
 * are unchanged (the `cli-*` rows of the table above, and the control here).
 */
describe('an item a person wrote is changed and closed by a person only (Epic #4220 D6, Issue #4227)', () => {
  /**
   * Issue #4227 G-PR2 (PM P3-a): the four rows of the hand-off's confirmation. A proposal a
   * person approved is a person's entrance (lands on a person's item); a proposer with no
   * approval, a proposal changed after its approval and an approval used once already are
   * refused (`not_owner` / `not_approved`). The last two have their own request (they are
   * always refused, so they are not rows of the re-creation table); the mark is judged by the
   * stored rows only. Each is shown to rest on the check by the mutation below.
   */
  const D6_ROWS: Record<
    string,
    { refused: boolean; kind?: 'note' | 'next'; code?: string; request?: (made: { id: string; version: number }, key: string) => Promise<{ status: number; body: unknown }> }
  > = {
    'cli-update': { refused: true },
    'cli-close': { refused: true },
    'condition-update': { refused: true, kind: 'next' },
    'screen-update': { refused: false },
    'screen-close': { refused: false },
    'proposal-approved-update': { refused: false },
    'proposal-update': { refused: true },
    'proposal-changed-after-approval': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'changed after approval', { tamper: true })).outcome,
    },
    'proposal-approval-used-twice': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'second use of an approval', { used: true })).outcome,
    },
    // Issue #4227 pr2c (A P3-2): each check of `approvalMarkHolds` besides the content and the
    // use, called directly (no decide, no fence before it). Each lands without its check.
    'proposal-mark-of-another-op': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'mark of a close', { proposalOp: 'close' })).outcome,
    },
    'proposal-mark-of-another-item': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'mark of another item', { proposalItemId: 'mem-another-item' })).outcome,
    },
    'proposal-mark-request-cancelled': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'request cancelled', { requestAfter: 'cancelled' })).outcome,
    },
    'proposal-mark-request-other-token': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'request of another decide', { requestAfter: 'other-token' })).outcome,
    },
    'proposal-mark-of-another-worktree': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'request of another worktree', { requestWorktree: 'wt-another' })).outcome,
    },
    'proposal-mark-of-another-instance': {
      refused: true,
      code: 'not_approved',
      request: async (made) => (await proposalWrite(made, 'request of another instance', { requestInstance: 'codex' })).outcome,
    },
  };

  it('names the agent and the person entrances that take an item (each a row of the table above)', () => {
    for (const key of Object.keys(D6_ROWS)) expect(D6_ROWS[key].request ?? ENTRANCES[key]?.before).toBeTypeOf('function');
    const rowFns = new Set(Object.keys(D6_ROWS).filter((key) => !D6_ROWS[key].request).map((key) => ENTRANCES[key].fn));
    expect([...rowFns].sort()).toEqual(['memCloseItem', 'memUpdateItem', 'memWriteFromScreen']);
  });

  it.each(Object.keys(D6_ROWS))('%s on a person’s item', async (key) => {
    const row = D6_ROWS[key];
    makeWorktree();
    setMode('on');
    const made = await humanItem(`person ${key}`, row.kind);
    const outcome = row.request ? await row.request(made, key) : await ENTRANCES[key].request(made);
    if (row.refused) {
      expect(outcome.status).toBe(409);
      expect((outcome.body as { code: string }).code).toBe(row.code ?? 'not_owner');
      expect(itemIs("id = ? AND version = ? AND state = 'open' AND text = ?", made.id, made.version, `person ${key}`)).toBe(true);
    } else {
      expect(outcome.status).toBeLessThan(300);
      expect(ENTRANCES[key].landed(made)).toBe(true);
    }
  });

  it('(mutation, PM P3-a) without the check of the mark, a changed or used approval writes a person’s item', async () => {
    makeWorktree();
    setMode('on');
    markMutation.removed = true;
    try {
      const changed = await humanItem('person mutation changed');
      const tampered = await proposalWrite(changed, 'changed after approval', { tamper: true });
      expect(tampered.outcome.status).toBeLessThan(300);
      expect(itemIs("id = ? AND text = 'changed after approval'", changed.id)).toBe(true);
      // One open hand-off request per instance: the first one is over.
      db.prepare("UPDATE mem_handoff_requests SET state = 'cancelled', apply_token = NULL").run();
      const used = await humanItem('person mutation used');
      const twice = await proposalWrite(used, 'second use of an approval', { used: true });
      expect(twice.outcome.status).toBeLessThan(300);
      expect(itemIs("id = ? AND text = 'second use of an approval'", used.id)).toBe(true);
    } finally {
      markMutation.removed = false;
    }
  });

  /**
   * Issue #4227 pr2c (A P3-2): the mismatched marks rest on their own check of
   * `approvalMarkHolds` (op・item, the request `applying` under the token, the worktree and
   * instance). Each check is dropped alone here (`markMismatchMutation`, the rest of the
   * function kept): the write that was `not_approved` above lands.
   */
  it.each([
    ['op・item', 'op', { proposalOp: 'close' }],
    ['op・item', 'op', { proposalItemId: 'mem-another-item' }],
    ['request state and token', 'request', { requestAfter: 'cancelled' }],
    ['request state and token', 'request', { requestAfter: 'other-token' }],
    ['worktree and instance', 'target', { requestWorktree: 'wt-another' }],
    ['worktree and instance', 'target', { requestInstance: 'codex' }],
  ] as const)('(mutation, A P3-2) without the check of %s the mismatched mark %j writes', async (_name, check, mismatch) => {
    makeWorktree();
    setMode('on');
    markMismatchMutation.dropped = check;
    try {
      const made = await humanItem(`person mismatch ${JSON.stringify(mismatch)}`);
      const written = await proposalWrite(made, 'written by a mismatched mark', mismatch as MarkMismatch);
      expect(written.outcome.status).toBeLessThan(300);
    } finally {
      markMismatchMutation.dropped = null;
    }
  });

  it('(PM P3-a) the mark is used once: confirmed, the proposal is `applied` and the same mark refuses after', async () => {
    makeWorktree();
    setMode('on');
    const made = await humanItem('person once');
    const first = await proposalWrite(made, 'confirmed once');
    expect(first.outcome.status).toBeLessThan(300);
    expect(getHandoffProposal(db, first.proposalId)).toMatchObject({ state: 'applied', applyToken: null });
    const again = await memWriteFromScreen(
      db,
      screenRequest(),
      WT,
      {
        op: 'update',
        author: 'proposer',
        itemId: made.id,
        body: { instanceId: 'claude', ifVersion: made.version + 1, text: 'again with the same mark' },
        approval: { proposalId: first.proposalId, applyToken: `tok-${proposals}`, fingerprint: getHandoffProposal(db, first.proposalId)!.fingerprint },
      },
      deps()
    );
    expect((again.body as { code: string }).code).toBe('not_approved');
    expect(itemIs("id = ? AND text = 'confirmed once'", made.id)).toBe(true);
  });

  it('(control) the same agent entrances still change and close the agent’s own item', async () => {
    makeWorktree();
    setMode('on');
    const updated = await addNote('agent own update');
    const update = await memUpdateItem(db, WT, updated.id, { instanceId: 'claude', ifVersion: updated.version, text: 'agent changed own' }, deps());
    expect(update.status).toBeLessThan(300);
    const closed = await addNote('agent own close');
    const close = await memCloseItem(db, WT, closed.id, { instanceId: 'claude' }, deps());
    expect(close.status).toBeLessThan(300);
    expect(itemIs("id = ? AND state = 'closed'", closed.id)).toBe(true);
  });

  it('the condition’s close (the server’s evaluation) still closes a person’s item', async () => {
    makeWorktree();
    setMode('on');
    const made = await humanItem('person conditioned', 'next');
    const record = getMemRecord(db, made.id)!;
    const stored = (db.prepare('SELECT close_when FROM mem_items WHERE id = ?').get(made.id) as { close_when: string }).close_when;
    expect(record.createdBy).toBe('human');
    const closed = db.transaction(() => closeMemItemByCondition(db, made.id, { version: made.version, closeWhen: stored }, Date.now()))();
    expect(closed?.state).toBe('closed');
    expect(itemIs("id = ? AND state = 'closed' AND close_reason = 'condition'", made.id)).toBe(true);
  });
});
