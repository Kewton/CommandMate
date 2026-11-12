/**
 * H23 (pr3f): the invariant S-B-commit for the screen's strict choice (Issue #4227, design
 * `docs/design/mem-ui-4227.md` §3.2 and §11.22 #23, PM `pm-return-4227-pr3e.md`).
 *
 * A `full` / `decline` send goes one road: the final reading's predicate → `commitStrict(kind)` →
 * the `text` of its answer, and nothing else, is typed. The answer is one value — `{ type: 'type',
 * text }` or `{ type: 'abort', reason }` — and every failure of the commit is an abort: a write that
 * throws, a write that changes no row, a write the guard withholds, a reservation that fails. Before
 * the body nothing is used up: `decline` and `empty` claim the shown row A, the delivery's outcome
 * settles it, and `not_sent` puts it back to `pending`. When that putting back fails too, the claim
 * stays this process's (`liveClaims`): the next strict send is 409 `claimed`, never A used up unsent.
 *
 * Table 2: kind × the commit's failure × tool. The writers a kind's commit calls come from
 * {@link STRICT_COMMIT_RULES} (`COMMIT_WRITERS` below `satisfies Record<StrictKind, …>`); a writer is
 * failed at one seam — a partial mock of the ledger (`session-brief-db`), the provider's `reserve`, and
 * the write gate's verdict ({@link setBriefWriteVerdictForTest}). Every row checks the report against
 * the ledger with one function ({@link expectReportMatchesLedger}).
 *
 * Positive controls (red before pr3f, recorded in the commit): E1 empty × `skipBoundary` throws, E2
 * empty × `skipBoundary` changes no row (both: the body typed, A left `pending`, reported
 * `skipped(empty)`), E3 empty × not sent (A used up unsent), I2 decline × not sent × the putting back
 * fails (the next decline found A `unknown` and typed — A used up, never typed).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: vi.fn(async () => ({ waiting: false })),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => globalThis.__briefTools?.[id] }) },
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  isSessionRunning: vi.fn(async () => true),
}));
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: vi.fn(() => ({ text: '', state: 'empty' })),
}));

/** The one seam the ledger's writers are failed at: `<writer>` → how it fails (once armed). */
const failing = vi.hoisted(() => ({
  writers: {} as Record<string, 'throws' | 'changes0' | undefined>,
  /** `settleBoundaryClaim(…, 'not_sent', …)` — the putting back — throws. */
  putBack: false,
  /** pr3g (N3): the putting back changes no row (answers false, writes nothing). */
  putBackChanges0: false,
}));
vi.mock('@/lib/db/session-brief-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/session-brief-db')>();
  const armed =
    <A extends unknown[], R>(name: string, real: (...args: A) => R, none: R) =>
    (...args: A): R => {
      const how = failing.writers[name];
      if (how === 'throws') throw new Error(`SQLITE_BUSY: ${name} (injected)`);
      if (how === 'changes0') return none;
      return real(...args);
    };
  return {
    ...actual,
    claimBoundary: armed('claimBoundary', actual.claimBoundary, false),
    fillBoundaryIncarnation: armed('fillBoundaryIncarnation', actual.fillBoundaryIncarnation, false),
    skipBoundary: armed('skipBoundary', actual.skipBoundary, false),
    settleDeclinedClaim: armed('settleDeclinedClaim', actual.settleDeclinedClaim, false),
    settleBoundaryClaim: (...args: Parameters<typeof actual.settleBoundaryClaim>) => {
      if (failing.putBack && args[3] === 'not_sent') throw new Error('SQLITE_IOERR: putting back (injected)');
      if (failing.putBackChanges0 && args[3] === 'not_sent') return false;
      return actual.settleBoundaryClaim(...args);
    },
  };
});

import {
  FAKE_BRIEF,
  WT,
  bindWorld,
  closeWorld,
  delivered,
  failNextSend,
  fakeProvider,
  launch,
  makeWorld,
  send,
  type BoundaryTool,
  type Sent,
  type SendOptions,
  type World,
} from './session-brief-4274-harness';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { getBoundaryById, getCurrentBoundary, readInstanceLifetime } from '@/lib/db/session-brief-db';
import {
  STRICT_COMMIT_RULES,
  resetLiveBriefClaimsForTest,
  setBriefWriteVerdictForTest,
  type BriefReport,
  type BriefWriteSite,
  type StrictKind,
} from '@/lib/session/session-brief';
import type { BriefProvider, BriefRequest } from '@/lib/session/brief-provider';
import { sendUserMessage } from '@/lib/session/send-user-message';
import type { BriefRequestPin } from '@/lib/session/session-brief';
import type Database from 'better-sqlite3';

type BriefReservation = Parameters<NonNullable<BriefProvider['reserve']>>[0];

let world: World;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
  addAgentInstance(world.db, WT, { id: 'claude', cliTool: 'claude', alias: '', order: 0 });
  failing.writers = {};
  failing.putBack = false;
  failing.putBackChanges0 = false;
});
afterEach(() => {
  failing.writers = {};
  failing.putBack = false;
  failing.putBackChanges0 = false;
  setBriefWriteVerdictForTest?.(undefined);
  closeWorld(world);
});

type Tool = Extract<BoundaryTool, 'claude' | 'command-code'>;
const TOOLS: Tool[] = ['claude', 'command-code'];

function shown(tool: Tool): string {
  const row = getCurrentBoundary(world.db, WT, tool);
  if (!row) throw new Error('no boundary');
  return row.id;
}
const rowOf = (id: string) => getBoundaryById(world.db, id);

function setUp(tool: Tool): string {
  if (tool !== 'claude') addAgentInstance(world.db, WT, { id: tool, cliTool: tool, alias: '', order: 1 });
  launch(tool);
  return shown(tool);
}

function expectAborted(result: Sent['result'], reason: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe('brief_choice');
  if (result.stage !== 'brief_choice') return;
  expect(result.reason).toBe(reason);
}

/**
 * The report against the ledger (root-cause §4: one function for every row). What the send said
 * about A is what A is: used up as reported, back to `pending` when not sent, still claimed when
 * the putting back failed, untouched by an abort.
 */
function expectReportMatchesLedger(report: BriefReport | null, a: string, aborted: boolean): void {
  const row = rowOf(a)!;
  if (aborted) {
    expect(report).toBeNull();
    return;
  }
  expect(report).not.toBeNull();
  switch (report!.state) {
    case 'attached':
      expect(row.state).toBe('sent');
      break;
    case 'skipped':
      expect(row.state).toBe('skipped');
      expect(row.skipReason).toBe(report!.reason);
      break;
    case 'not_sent':
      expect(row.state).toBe(report!.reason === 'claim_held' ? 'claimed' : 'pending');
      break;
    case 'consumed':
      expect(['sent', 'skipped', 'unknown']).toContain(row.state);
      break;
    case 'unknown':
      expect(['unknown', 'skipped']).toContain(row.state);
      break;
    default: {
      const unknownState: never = report!.state;
      throw new Error(`unknown report: ${String(unknownState)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Positive controls: red before pr3f (E1・E2・E3・I2)
// ---------------------------------------------------------------------------

/** `full`'s brief comes out empty; any other send gets the brief. */
const emptyForFull = (): void =>
  void fakeProvider({
    build: vi.fn((request: BriefRequest) => ({
      body: request.detail === 'full' ? '' : FAKE_BRIEF,
      includedNoticeIds: [],
      mode: request.membership.mode,
    })),
  });

describe('H23 (pr3f) positive controls: empty and the putting back, before the commit was one value', () => {
  it.each(TOOLS)('E1 %s: empty × skipBoundary throws → what is typed matches what A is', async (tool) => {
    const a = setUp(tool);
    emptyForFull();
    failing.writers.skipBoundary = 'throws';
    const { result, report } = await send(tool, 'x', { briefDetail: 'full', briefBoundary: a });
    // Before pr3f: ok, `x` typed, reported skipped(empty) — and A still `pending`.
    if (!result.ok) {
      expect(delivered(world, tool)).toEqual([]);
      expect(rowOf(a)?.state).toBe('pending');
    }
    expectReportMatchesLedger(report, a, !result.ok && result.stage === 'brief_choice');
  });

  it.each(TOOLS)('E2 %s: empty × skipBoundary changes no row → what is typed matches what A is', async (tool) => {
    const a = setUp(tool);
    emptyForFull();
    failing.writers.skipBoundary = 'changes0';
    const { result, report } = await send(tool, 'x', { briefDetail: 'full', briefBoundary: a });
    expectReportMatchesLedger(report, a, !result.ok && result.stage === 'brief_choice');
  });

  it.each(TOOLS)('E3 %s: empty × the body not sent → A back to pending (not used up unsent)', async (tool) => {
    const a = setUp(tool);
    emptyForFull();
    failNextSend(world, tool, 'not-sent');
    const { result, report } = await send(tool, 'x', { briefDetail: 'full', briefBoundary: a });
    expect(result.ok).toBe(false);
    expect(delivered(world, tool)).toEqual([]);
    expect(rowOf(a)?.state).toBe('pending');
    expect(report).toEqual({ state: 'not_sent', boundaryId: a });
  });

  it.each(TOOLS)('I2 %s: decline × not sent × the putting back fails → the next decline is 409 claimed, A never used up unsent', async (tool) => {
    const a = setUp(tool);
    fakeProvider();
    failNextSend(world, tool, 'not-sent');
    failing.putBack = true;
    const first = await send(tool, 'x', { brief: 'decline', briefBoundary: a });
    expect(first.result.ok).toBe(false);
    expect(delivered(world, tool)).toEqual([]);
    expect(rowOf(a)?.state).toBe('claimed');
    expect(first.report).toEqual({ state: 'not_sent', reason: 'claim_held', boundaryId: a });
    failing.putBack = false;
    // Before pr3f: the token left `liveClaims`, the next plan settled A `unknown` and typed (consumed).
    const again = await send(tool, 'x', { brief: 'decline', briefBoundary: a });
    expectAborted(again.result, 'claimed');
    expect(delivered(world, tool)).toEqual([]);
    expect(rowOf(a)?.state).toBe('claimed');
  });

  it('I2 (the risk kept, design §3.2): after a restart the held claim is recovered as `unknown` (asked again by the person)', async () => {
    const a = setUp('claude');
    fakeProvider();
    failNextSend(world, 'claude', 'not-sent');
    failing.putBack = true;
    await send('claude', 'x', { brief: 'decline', briefBoundary: a });
    failing.putBack = false;
    resetLiveBriefClaimsForTest();
    // The next plan settles the claim no process holds as `unknown` (D1's recovery): used up.
    const again = await send('claude', 'x', { brief: 'decline', briefBoundary: a });
    expect(rowOf(a)?.state).toBe('unknown');
    expect(again.report).toEqual({ state: 'consumed', boundaryId: a });
  });
});

// ---------------------------------------------------------------------------
// Table 2: kind × the commit's failure × tool
// ---------------------------------------------------------------------------

type Writer = 'reserve' | 'claimBoundary';
/** The writers each kind's commit calls, from the rule's sites (a site added there fails the check below). */
const WRITER_OF_SITE = { 'claim.reserve': 'reserve', 'claim.row': 'claimBoundary' } as const satisfies Partial<Record<BriefWriteSite, Writer>>;
const COMMIT_WRITERS = {
  brief: ['reserve', 'claimBoundary'],
  decline: ['claimBoundary'],
  empty: ['claimBoundary'],
  used_up: [],
} as const satisfies Record<StrictKind, readonly Writer[]>;
const KINDS = Object.keys(COMMIT_WRITERS) as StrictKind[];

type Failure =
  | { kind: 'none' }
  | { kind: 'throws'; writer: Writer }
  | { kind: 'changes0'; writer: Writer }
  | { kind: 'withheld'; site: keyof typeof WRITER_OF_SITE }
  | { kind: 'delivery_not_sent' }
  | { kind: 'put_back_fails' };

const nameOf = (failure: Failure): string =>
  failure.kind === 'throws' || failure.kind === 'changes0' ? `${failure.writer} ${failure.kind}` : failure.kind === 'withheld' ? `${failure.site} withheld` : failure.kind;

function failuresOf(kind: StrictKind): Failure[] {
  const writers: readonly Writer[] = COMMIT_WRITERS[kind];
  const claims = STRICT_COMMIT_RULES[kind].claims;
  return [
    { kind: 'none' },
    ...writers.flatMap((writer): Failure[] => [
      { kind: 'throws', writer },
      { kind: 'changes0', writer },
    ]),
    ...STRICT_COMMIT_RULES[kind].writes.map((site): Failure => ({ kind: 'withheld', site })),
    { kind: 'delivery_not_sent' },
    ...(claims ? [{ kind: 'put_back_fails' } as Failure] : []),
  ];
}

interface Row {
  kind: StrictKind;
  failure: Failure;
  tool: Tool;
}
const ROWS: Row[] = KINDS.flatMap((kind) => failuresOf(kind).flatMap((failure) => TOOLS.map((tool) => ({ kind, failure, tool }))));

/** The reservation's seam: the provider's `reserve` answers, throws, or answers nothing. */
const reserving: { how: 'answers' | 'throws' | 'changes0' } = { how: 'answers' };

/** The world in which the plan reads this kind; the choice sent. */
async function arrange(kind: StrictKind, tool: Tool): Promise<SendOptions> {
  reserving.how = 'answers';
  const reserve = vi.fn((request: BriefReservation) => {
    if (reserving.how === 'throws') throw new Error('reserve failed (injected)');
    if (reserving.how === 'changes0') return null;
    return { body: request.body, includedNoticeIds: [...request.includedNoticeIds] };
  });
  switch (kind) {
    case 'brief':
      fakeProvider({ reserve });
      return { briefDetail: 'full' };
    case 'decline':
      fakeProvider({ reserve });
      return { brief: 'decline' };
    case 'empty':
      emptyForFull();
      return { briefDetail: 'full' };
    case 'used_up':
      fakeProvider({ reserve });
      await send(tool, 'first');
      return { briefDetail: 'full' };
    default: {
      const unknownKind: never = kind;
      throw new Error(`unknown kind: ${String(unknownKind)}`);
    }
  }
}

/** What a kind types and reports when nothing failed (the design's table (b)). */
function expectAsChosen(kind: StrictKind, sent: Sent, a: string, tool: Tool): void {
  expect(sent.result.ok).toBe(true);
  const last = delivered(world, tool).at(-1);
  if (kind === 'brief') {
    expect(last).toBe(`${FAKE_BRIEF}\n\nx`);
    expect(sent.report).toEqual({ state: 'attached', boundaryId: a });
  } else {
    expect(last).toBe('x');
    expect(sent.report).toEqual(
      kind === 'used_up'
        ? { state: 'consumed', boundaryId: a }
        : { state: 'skipped', reason: kind === 'decline' ? 'declined' : 'empty', boundaryId: a }
    );
  }
}

const abortReasonOf = (failure: Failure): string => {
  if (failure.kind === 'withheld') return 'incarnation_changed';
  if (failure.kind === 'changes0' && failure.writer === 'reserve') return 'reservation_conflict';
  return 'claim_failed';
};

describe('H23 (pr3f) table 2: kind × the commit’s failure × {claude, command-code}', () => {
  it('the writers of each kind are the rule’s sites', () => {
    for (const kind of KINDS) {
      expect([...COMMIT_WRITERS[kind]]).toEqual(STRICT_COMMIT_RULES[kind].writes.map((site) => WRITER_OF_SITE[site]));
    }
    // brief: 7 failures (none, 2 writers × 2, 2 sites, not sent, put back) — decline / empty: 6 + 1 — used_up: 2.
    expect(ROWS).toHaveLength((9 + 6 + 6 + 2) * TOOLS.length);
  });

  it.each(ROWS.map((row) => [`${row.tool}: ${row.kind} × ${nameOf(row.failure)}`, row] as const))('%s', async (_name, row) => {
    const { kind, failure, tool } = row;
    const a = setUp(tool);
    const options = await arrange(kind, tool);
    const before = delivered(world, tool).length;
    const stateBefore = rowOf(a)!.state;
    if (failure.kind === 'throws' || failure.kind === 'changes0') {
      if (failure.writer === 'reserve') reserving.how = failure.kind;
      else failing.writers[failure.writer] = failure.kind;
    }
    if (failure.kind === 'withheld') setBriefWriteVerdictForTest((site) => (site === failure.site ? 'incarnation_changed' : null));
    if (failure.kind === 'delivery_not_sent' || failure.kind === 'put_back_fails') failNextSend(world, tool, 'not-sent');
    if (failure.kind === 'put_back_fails') failing.putBack = true;

    const sent = await send(tool, 'x', { ...options, briefBoundary: a });
    failing.writers = {};
    failing.putBack = false;
    setBriefWriteVerdictForTest(undefined);

    switch (failure.kind) {
      case 'none':
        expectAsChosen(kind, sent, a, tool);
        expectReportMatchesLedger(sent.report, a, false);
        return;
      case 'throws':
      case 'changes0':
      case 'withheld':
        expectAborted(sent.result, abortReasonOf(failure));
        // Nothing typed, A as it was (pending), nothing reported.
        expect(delivered(world, tool)).toHaveLength(before);
        expect(rowOf(a)?.state).toBe(stateBefore);
        expectReportMatchesLedger(sent.report, a, true);
        return;
      case 'delivery_not_sent':
        expect(sent.result.ok).toBe(false);
        if (!sent.result.ok) expect(sent.result.stage).not.toBe('brief_choice');
        expect(delivered(world, tool)).toHaveLength(before);
        // Nothing used up unsent (empty too); a row used up before stays as it was.
        expect(rowOf(a)?.state).toBe(stateBefore);
        expect(sent.report).toEqual(kind === 'used_up' ? { state: 'consumed', boundaryId: a } : { state: 'not_sent', boundaryId: a });
        expectReportMatchesLedger(sent.report, a, false);
        return;
      case 'put_back_fails': {
        expect(delivered(world, tool)).toHaveLength(before);
        expect(rowOf(a)?.state).toBe('claimed');
        expect(sent.report).toEqual({ state: 'not_sent', reason: 'claim_held', boundaryId: a });
        expectReportMatchesLedger(sent.report, a, false);
        // The claim is still this process's: the next strict send stops, A is not used up unsent.
        const again = await send(tool, 'x', { ...options, briefBoundary: a });
        expectAborted(again.result, 'claimed');
        expect(delivered(world, tool)).toHaveLength(before);
        expect(rowOf(a)?.state).toBe('claimed');
        return;
      }
      default: {
        const unknownFailure: never = failure;
        throw new Error(`unknown failure: ${String(unknownFailure)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Table 2, added rows (pr3g, PM Claude P3-4): M06・M10・N3 — each red under its mutation
// ---------------------------------------------------------------------------

describe('H23 (pr3g) table 2 added rows: the transaction, the reservation told back, the putting back that changes no row', () => {
  const CLAIMING: Extract<StrictKind, 'brief' | 'decline'>[] = ['brief', 'decline'];

  it.each(CLAIMING.flatMap((kind) => TOOLS.map((tool) => [`${tool}: ${kind}`, kind, tool] as const)))(
    'M06 %s × A with no incarnation × claimBoundary changes no row → the incarnation filled in the same transaction is rolled back',
    async (_name, kind, tool) => {
      const a = setUp(tool);
      const options = await arrange(kind, tool);
      // A opened before the instance had an incarnation; the one it has now was issued late (`lazy`) for this tool.
      world.db.prepare('UPDATE session_brief_boundaries SET instance_incarnation = NULL WHERE id = ?').run(a);
      world.db.prepare(`UPDATE mem_instance_incarnations SET issued_by = 'lazy' WHERE worktree_id = ? AND instance_id = ?`).run(WT, tool);
      expect(rowOf(a)?.instanceIncarnation).toBeNull();
      expect(readInstanceLifetime(world.db, WT, tool).incarnation).not.toBeNull();
      failing.writers.claimBoundary = 'changes0';
      const sent = await send(tool, 'x', { ...options, briefBoundary: a });
      failing.writers = {};
      expectAborted(sent.result, 'claim_failed');
      expect(delivered(world, tool)).toEqual([]);
      expect(rowOf(a)?.state).toBe('pending');
      // The fill ran (the instance has an incarnation) and went back with the claim: one transaction.
      expect(rowOf(a)?.instanceIncarnation).toBeNull();
    }
  );

  it.each((['throws', 'changes0'] as const).flatMap((how) => TOOLS.map((tool) => [`${tool}: brief × claimBoundary ${how}`, how, tool] as const)))(
    'M10 %s after the reservation → the provider is told `discarded` with what it reserved',
    async (_name, how, tool) => {
      const a = setUp(tool);
      const reserve = vi.fn((request: BriefReservation) => ({ body: request.body, includedNoticeIds: [...request.includedNoticeIds] }));
      const provider = fakeProvider({ reserve });
      failing.writers.claimBoundary = how;
      const sent = await send(tool, 'x', { briefDetail: 'full', briefBoundary: a });
      failing.writers = {};
      expectAborted(sent.result, 'claim_failed');
      expect(delivered(world, tool)).toEqual([]);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(provider.settle).toHaveBeenCalledTimes(1);
      expect(provider.settle).toHaveBeenCalledWith({ boundaryId: a, outcome: 'discarded', includedNoticeIds: ['n1'] });
    }
  );

  it.each((['brief', 'decline', 'empty'] as const).flatMap((kind) => TOOLS.map((tool) => [`${tool}: ${kind}`, kind, tool] as const)))(
    'N3 %s × not sent × the putting back changes no row → the claim is held (claim_held), the next strict send is 409 claimed',
    async (_name, kind, tool) => {
      const a = setUp(tool);
      const options = await arrange(kind, tool);
      failNextSend(world, tool, 'not-sent');
      failing.putBackChanges0 = true;
      const sent = await send(tool, 'x', { ...options, briefBoundary: a });
      failing.putBackChanges0 = false;
      expect(delivered(world, tool)).toEqual([]);
      expect(rowOf(a)?.state).toBe('claimed');
      expect(sent.report).toEqual({ state: 'not_sent', reason: 'claim_held', boundaryId: a });
      expectReportMatchesLedger(sent.report, a, false);
      const again = await send(tool, 'x', { ...options, briefBoundary: a });
      expectAborted(again.result, 'claimed');
      expect(delivered(world, tool)).toEqual([]);
      expect(rowOf(a)?.state).toBe('claimed');
    }
  );
});

// ---------------------------------------------------------------------------
// Narrowed (PM decision 5): a command with a strict choice stops at the service too
// ---------------------------------------------------------------------------

describe('H23 (pr3f) a command with a strict choice (the route answers 400; the service stops it)', () => {
  it.each([
    ['full', { briefDetail: 'full' }],
    ['decline', { brief: 'decline' }],
  ] as const)('%s × `/model`: 409 slash_command, nothing typed, nothing written', async (_name, choice) => {
    const a = setUp('claude');
    fakeProvider();
    const before = JSON.stringify(rowOf(a));
    const { result } = await send('claude', '/model', { ...choice, briefBoundary: a });
    expectAborted(result, 'slash_command');
    expect(delivered(world, 'claude')).toEqual([]);
    expect(JSON.stringify(rowOf(a))).toBe(before);
  });

  it('negative: `/model` with no choice (auto) is typed as before, A left pending', async () => {
    const a = setUp('claude');
    fakeProvider();
    const { result } = await send('claude', '/model');
    expect(result.ok).toBe(true);
    expect(delivered(world, 'claude')).toEqual(['/model']);
    expect(rowOf(a)?.state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// The service's type (PM decision 5): a strict choice names its boundary
// ---------------------------------------------------------------------------

describe('H23 (pr3f) the send service’s type: a strict choice names the boundary it was chosen for', () => {
  it('decline / full without briefBoundary do not compile; with it, and auto / short without, do', () => {
    // Never called: the check is the compiler's (`npx tsc --noEmit`); an unused `@ts-expect-error` fails it.
    const typeOnly = (db: Database.Database, pin: BriefRequestPin): void => {
      const base = { worktreeId: WT, content: 'x', cliToolId: 'claude' as const, briefPin: pin };
      // @ts-expect-error decline without its boundary
      void sendUserMessage(db, { ...base, brief: 'decline' });
      // @ts-expect-error full without its boundary
      void sendUserMessage(db, { ...base, brief: 'auto', briefDetail: 'full' });
      void sendUserMessage(db, { ...base, brief: 'decline', briefBoundary: 'b-1' });
      void sendUserMessage(db, { ...base, brief: 'auto', briefDetail: 'full', briefBoundary: 'b-1' });
      void sendUserMessage(db, { ...base, brief: 'auto' });
      void sendUserMessage(db, { ...base, brief: 'auto', briefDetail: 'short' });
    };
    expect(typeof typeOnly).toBe('function');
  });
});
