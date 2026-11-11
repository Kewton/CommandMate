/**
 * Issue #4288 PR1b — the tables of docs/design/run-lock-machine-lock-4288.md §2 (the upstream stage:
 * the table is written and reviewed before the implementation; "赤から緑にする" is the next contract).
 *
 * What this file is now: the three tables of §2 as data, built from enumerations, so that a cell left
 * out is a type error (`satisfies Record<…>`), and the invariants of §1 checked over every row (pure
 * table checks — they pass today and keep the table honest while it is reviewed). What it is not yet:
 * a test of the implementation. The places that will drive the real run-lock (src/lib/agent-health/
 * run-lock.ts, scripts/uat/run-lock.sh, scripts/uat/run-server.sh, scripts/agent-health/daily.sh on
 * top of scripts/lib/machine-lock.sh) are `it.todo`, one per caller of each table; the PR1b contract
 * replaces each with an `it.each` over the same rows that sets the record up in an os.tmpdir() lock and
 * asserts the cell.
 *
 * Tables (row counts are pinned below and written in the design doc §2.5):
 *   A. record shape × caller × observation (3 values) → result      14 × 8 × 3 = 336 rows
 *   B. D9 handover stage × flow × event → child / other taker         6 × 2 × 2 =  24 rows
 *   C. UAT `down`: the leader × the rest of its group → signals, lock 4 × 4     =  16 rows
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------- enumerations (table A)

/** The record the caller finds (§2.1). "own" = the token is one of the caller's (T0, T1, or the inherited one). */
const SHAPES = [
  'none', // no <lock>, no moved-aside record, no ticket ahead
  'ticket-ahead', // no <lock>; a live-looking ticket of someone else is ahead in <lock>.queue
  'ownerless-young', // <lock> with no owner, empty, mtime ≤ 60 s
  'ownerless-old', // <lock> with no owner, empty, mtime > 60 s
  'unreadable', // <lock>/owner cannot be read (EIO, EACCES, a pgid= that is not a number)
  'corrupt', // <lock>/owner read, but no pid= or no token=
  'own-self', // own token, recorded pid = the caller itself, no pgid= (TS main.ts, daily before the handover, UAT up's T0, cleanup)
  'own-self-g', // own token T1, recorded pid = the caller itself, pgid=G of its child (daily after the handover)
  'own-other', // own token, recorded pid ≠ the caller, no pgid= (TS `pid` option, bash `run_lock_acquire <label> <pid≠$$>`, the inheritor's T0)
  'own-other-g', // own token T1, recorded pid ≠ the caller, pgid=G (UAT T1: pid = the server = G's leader; the inheritor's daily T1)
  'foreign', // another token, no pgid= (also an older record without host=)
  'foreign-g', // another token with pgid=
  'aside-own', // no <lock>; a <lock>.gone-* record under an own token
  'aside-foreign', // no <lock>; a <lock>.gone-* record under another token
] as const;
type Shape = (typeof SHAPES)[number];

/** The operations PR1b puts on run-lock (§2.1). */
const CALLERS = [
  'ts-acquire', // acquireRunLock without CM_RUN_LOCK_TOKEN (main.ts by hand, tests)
  'ts-inherit', // acquireRunLock with CM_RUN_LOCK_TOKEN (run.ts under daily.sh, D8)
  'ts-release', // the handle's release() (sync JS release; needs-head → releaseAsHead inside)
  'sh-acquire', // run_lock_acquire (daily.sh, UAT up, cleanup)
  'sh-inherit', // run_lock_acquire under CM_RUN_LOCK_TOKEN (a bash child of daily's run, D8)
  'sh-release-held', // lock_release_held (D12): daily EXIT, up's trap before the handover, cleanup
  'sh-hand-off', // run_lock_set_pid → lock_hand_off (D4/D9): UAT up, daily.sh
  'sh-release-as-head', // lock_release_as_head (D5): UAT down, up's trap after the handover, needs-head
] as const;
type Caller = (typeof CALLERS)[number];

/**
 * The one observation the cell turns on (§2.1 の「観測するもの」): holderState of the record
 * (pid, then G) for a foreign / own-other record; G for own-self-g and own-other-g under
 * lock_release_held; the caller's own kill -0 for own-self in bash; the ticket's holder for
 * ticket-ahead; the listing / lstat / mtime of the shape for none and ownerless-* (alive and gone
 * then both mean "observed"); nothing for unreadable and corrupt (the three are the same).
 */
const OBSERVATIONS = ['alive', 'gone', 'unknown'] as const;
type Obs = (typeof OBSERVATIONS)[number];

const RESULTS = [
  'acquired',
  'recovered-acquired', // the head moved a dead holder's lock aside, checked its token, deleted it, took the lock
  'expired-acquired', // the head rmdir'd an owner-less empty <lock> past 60 s (D3), took the lock
  'reclaimed-acquired', // the head deleted a dead moved-aside record (§2.7), took the lock
  'refused',
  'inherited',
  'released',
  'needs-head',
  'deferred',
  'kept',
  'missing',
  'unknown',
  'not-head',
  'handed',
  'stage-token',
  'refused-arg',
] as const;
type Result = (typeof RESULTS)[number];

/** What the canonical <lock> (and the caller's own moved-aside record) looks like after the operation. */
type After =
  | 'mine' // the caller holds <lock> under its new record
  | 'removed' // the caller removed <lock>
  | 'unchanged'
  | 'restored' // a live moved-aside record was put back into <lock> (§2.7)
  | 'aside-removed' // <lock> unchanged; the caller's own moved-aside record removed
  | 't1'; // the record is now T1 = <T0>-g<G> with pgid=G

/** needs-head → the caller runs D5; deferred / not-head / unknown → left to the next head. */
type Next = 'D5' | 'next-head';

type Cell = { result: Result; after: After; next?: Next } | { unreachable: string };
type ByObs = Record<Obs, Cell>;

const c = (result: Result, after: After, next?: Next): Cell => (next ? { result, after, next } : { result, after });
const all = (cell: Cell): ByObs => ({ alive: cell, gone: cell, unknown: cell });
const by = (alive: Cell, gone: Cell, unknown: Cell): ByObs => ({ alive, gone, unknown });
const never = (why: string): Cell => ({ unreachable: why });

const FRESH_TOKEN = '取得の token は毎回新しい（T0 は run_id・daily-$$-…・<label>-<pid>-<乱数>）ので、自分の token の記録は取得の前に無い';
const NOT_THE_PID = '継ぐ者は記録の pid ではない（記録の pid は親の daily.sh か UAT のサーバー）';
const NO_PGID_IN_TS = 'TS（run-lock.ts）は pgid を書かない（D9 は bash の daily と UAT だけ）';
const NODE_SELF = 'Node は自分の pid を観測しない（process.pid は呼び手そのもの。sync の release は pid の一致だけを見る）';

// ---------------------------------------------------------------- table A (§2.2)

/** TS and bash take the lock with the same rules (one machine-lock); the wording differs, not the cell. */
const ACQUIRE = {
  none: by(c('acquired', 'mine'), c('acquired', 'mine'), c('refused', 'unchanged')),
  'ticket-ahead': by(c('refused', 'unchanged'), c('acquired', 'mine'), c('refused', 'unchanged')),
  'ownerless-young': all(c('refused', 'unchanged')),
  'ownerless-old': by(c('expired-acquired', 'mine'), c('expired-acquired', 'mine'), c('refused', 'unchanged')),
  unreadable: all(c('refused', 'unchanged')),
  corrupt: all(c('refused', 'unchanged')),
  'own-self': all(never(FRESH_TOKEN)),
  'own-self-g': all(never(FRESH_TOKEN)),
  'own-other': all(never(FRESH_TOKEN)),
  'own-other-g': all(never(FRESH_TOKEN)),
  foreign: by(c('refused', 'unchanged'), c('recovered-acquired', 'mine'), c('refused', 'unchanged')),
  'foreign-g': by(c('refused', 'unchanged'), c('recovered-acquired', 'mine'), c('refused', 'unchanged')),
  'aside-own': all(never(FRESH_TOKEN)),
  'aside-foreign': by(c('refused', 'restored'), c('reclaimed-acquired', 'mine'), c('refused', 'restored')),
} satisfies Record<Shape, ByObs>;

/** D8: the owner is read once before the acquisition; a live record under the inherited token is the parent's. */
const INHERIT = {
  none: ACQUIRE.none,
  'ticket-ahead': ACQUIRE['ticket-ahead'],
  'ownerless-young': ACQUIRE['ownerless-young'],
  'ownerless-old': ACQUIRE['ownerless-old'],
  unreadable: all(c('refused', 'unchanged')),
  corrupt: all(c('refused', 'unchanged')),
  'own-self': all(never(NOT_THE_PID)),
  'own-self-g': all(never(NOT_THE_PID)),
  'own-other': by(c('inherited', 'unchanged'), c('recovered-acquired', 'mine'), c('refused', 'unchanged')),
  'own-other-g': by(
    c('inherited', 'unchanged'),
    never('継ぐ者は G の中に居る（daily の子）ので、記録の pid と G がともに ESRCH にはならない'),
    c('refused', 'unchanged')
  ),
  foreign: ACQUIRE.foreign,
  'foreign-g': ACQUIRE['foreign-g'],
  'aside-own': by(c('inherited', 'unchanged'), c('reclaimed-acquired', 'mine'), c('refused', 'unchanged')),
  'aside-foreign': ACQUIRE['aside-foreign'],
} satisfies Record<Shape, ByObs>;

const TABLE_A = {
  'ts-acquire': ACQUIRE,
  'ts-inherit': INHERIT,
  'ts-release': {
    none: all(c('kept', 'unchanged')),
    'ticket-ahead': all(c('kept', 'unchanged')),
    'ownerless-young': all(c('kept', 'unchanged')),
    'ownerless-old': all(c('kept', 'unchanged')),
    unreadable: all(c('deferred', 'unchanged', 'next-head')),
    corrupt: all(c('kept', 'unchanged')),
    'own-self': by(c('released', 'removed'), never(NODE_SELF), never(NODE_SELF)),
    'own-self-g': all(never(NO_PGID_IN_TS)),
    'own-other': by(c('needs-head', 'unchanged', 'D5'), c('needs-head', 'unchanged', 'D5'), c('deferred', 'unchanged', 'next-head')),
    'own-other-g': all(never(NO_PGID_IN_TS)),
    foreign: all(c('kept', 'unchanged')),
    'foreign-g': all(c('kept', 'unchanged')),
    'aside-own': all(c('kept', 'aside-removed')),
    'aside-foreign': all(c('kept', 'unchanged')),
  },
  'sh-acquire': ACQUIRE,
  'sh-inherit': INHERIT,
  'sh-release-held': {
    none: all(c('kept', 'unchanged')),
    'ticket-ahead': all(c('kept', 'unchanged')),
    'ownerless-young': all(c('kept', 'unchanged')),
    'ownerless-old': all(c('kept', 'unchanged')),
    unreadable: all(c('deferred', 'unchanged', 'next-head')),
    corrupt: all(c('kept', 'unchanged')),
    'own-self': by(c('released', 'removed'), c('needs-head', 'unchanged', 'D5'), c('deferred', 'unchanged', 'next-head')),
    'own-self-g': by(c('deferred', 'unchanged', 'next-head'), c('released', 'removed'), c('deferred', 'unchanged', 'next-head')),
    'own-other': by(c('needs-head', 'unchanged', 'D5'), c('needs-head', 'unchanged', 'D5'), c('deferred', 'unchanged', 'next-head')),
    'own-other-g': by(c('deferred', 'unchanged', 'next-head'), c('needs-head', 'unchanged', 'D5'), c('deferred', 'unchanged', 'next-head')),
    foreign: all(c('kept', 'unchanged')),
    'foreign-g': all(c('kept', 'unchanged')),
    'aside-own': by(c('kept', 'unchanged'), c('kept', 'aside-removed'), c('kept', 'unchanged')),
    'aside-foreign': all(c('kept', 'unchanged')),
  },
  'sh-hand-off': {
    none: all(c('stage-token', 'unchanged')),
    'ticket-ahead': all(c('stage-token', 'unchanged')),
    'ownerless-young': all(c('stage-token', 'unchanged')),
    'ownerless-old': all(c('stage-token', 'unchanged')),
    unreadable: all(c('stage-token', 'unchanged')),
    corrupt: all(c('stage-token', 'unchanged')),
    'own-self': by(c('handed', 't1'), c('refused-arg', 'unchanged'), c('refused-arg', 'unchanged')),
    'own-self-g': all(c('stage-token', 'unchanged')),
    'own-other': all(c('refused-arg', 'unchanged')),
    'own-other-g': all(c('stage-token', 'unchanged')),
    foreign: all(c('stage-token', 'unchanged')),
    'foreign-g': all(c('stage-token', 'unchanged')),
    'aside-own': all(c('stage-token', 'unchanged')),
    'aside-foreign': all(c('stage-token', 'unchanged')),
  },
  'sh-release-as-head': {
    none: all(c('missing', 'unchanged')),
    'ticket-ahead': by(c('not-head', 'unchanged', 'next-head'), c('missing', 'unchanged'), c('not-head', 'unchanged', 'next-head')),
    'ownerless-young': all(c('missing', 'unchanged')),
    'ownerless-old': all(c('missing', 'unchanged')),
    unreadable: all(c('unknown', 'unchanged', 'next-head')),
    corrupt: all(c('kept', 'unchanged')),
    'own-self': by(c('deferred', 'unchanged', 'next-head'), c('released', 'removed'), c('deferred', 'unchanged', 'next-head')),
    'own-self-g': by(c('deferred', 'unchanged', 'next-head'), c('released', 'removed'), c('deferred', 'unchanged', 'next-head')),
    'own-other': by(c('deferred', 'unchanged', 'next-head'), c('released', 'removed'), c('deferred', 'unchanged', 'next-head')),
    'own-other-g': by(c('deferred', 'unchanged', 'next-head'), c('released', 'removed'), c('deferred', 'unchanged', 'next-head')),
    foreign: all(c('kept', 'unchanged')),
    'foreign-g': all(c('kept', 'unchanged')),
    'aside-own': by(c('missing', 'unchanged'), c('missing', 'aside-removed'), c('missing', 'unchanged')),
    'aside-foreign': all(c('missing', 'unchanged')),
  },
} satisfies Record<Caller, Record<Shape, ByObs>>;

interface RowA {
  id: string;
  caller: Caller;
  shape: Shape;
  obs: Obs;
  cell: Cell;
}

const ROWS_A: RowA[] = CALLERS.flatMap((caller) =>
  SHAPES.flatMap((shape) =>
    OBSERVATIONS.map((obs) => ({ id: `${caller}/${shape}/${obs}`, caller, shape, obs, cell: TABLE_A[caller][shape][obs] }))
  )
);

// ---------------------------------------------------------------- table B (§2.3, review-4288h P2-2)

const FLOWS = ['uat', 'daily'] as const;
type Flow = (typeof FLOWS)[number];
/** The stages of the D9 handover, in order (the pause points of verify-run.sh's handover). */
const STAGES = ['forked', 'group', 'tmp', 'published', 'signalled', 'acked'] as const;
type Stage = (typeof STAGES)[number];
const EVENTS = [
  'parent-kill9', // the parent (UAT up / daily.sh) is SIGKILLed at the stage
  'leader-dies-member-stays', // G's leader ends and another member of G goes on (UAT: the server; daily: run.ts)
] as const;
type LifeEvent = (typeof EVENTS)[number];

type LifeCell =
  | {
      record: 'T0' | 'T1';
      childStarts: boolean;
      /** a fresh acquirer while a process of G (the waiting child or a member) is still there */
      takerWhileGroupLives: 'acquires' | 'refused';
      /** a fresh acquirer after G is empty */
      takerAfterGroupEmpty: 'acquires' | 'refused';
    }
  | { unreachable: string };

const BEFORE_PUBLISH = (): LifeCell => ({ record: 'T0', childStarts: false, takerWhileGroupLives: 'acquires', takerAfterGroupEmpty: 'acquires' });
const PUBLISHED_NOT_SIGNALLED = (): LifeCell => ({ record: 'T1', childStarts: false, takerWhileGroupLives: 'refused', takerAfterGroupEmpty: 'acquires' });
const STARTED = (): LifeCell => ({ record: 'T1', childStarts: true, takerWhileGroupLives: 'refused', takerAfterGroupEmpty: 'acquires' });
const ONLY_THE_LEADER = '合図の受け取り（ack）の前の G は待っている長 1 人だけで、長と別に残るメンバーは居ない';

const LIFECYCLE_ONE_FLOW = {
  forked: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': { unreachable: ONLY_THE_LEADER } },
  group: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': { unreachable: ONLY_THE_LEADER } },
  tmp: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': { unreachable: ONLY_THE_LEADER } },
  published: { 'parent-kill9': PUBLISHED_NOT_SIGNALLED(), 'leader-dies-member-stays': { unreachable: ONLY_THE_LEADER } },
  signalled: { 'parent-kill9': STARTED(), 'leader-dies-member-stays': { unreachable: ONLY_THE_LEADER } },
  acked: { 'parent-kill9': STARTED(), 'leader-dies-member-stays': STARTED() },
} satisfies Record<Stage, Record<LifeEvent, LifeCell>>;

/** UAT and daily share the cells; what differs is whose pid the T1 record names (§2.3). */
const TABLE_B = { uat: LIFECYCLE_ONE_FLOW, daily: LIFECYCLE_ONE_FLOW } satisfies Record<Flow, Record<Stage, Record<LifeEvent, LifeCell>>>;

interface RowB {
  id: string;
  flow: Flow;
  stage: Stage;
  event: LifeEvent;
  cell: LifeCell;
}

const ROWS_B: RowB[] = FLOWS.flatMap((flow) =>
  STAGES.flatMap((stage) => EVENTS.map((event) => ({ id: `${flow}/${stage}/${event}`, flow, stage, event, cell: TABLE_B[flow][stage][event] })))
);

// ---------------------------------------------------------------- table C (§2.4, review-4288h P2-3)

/** The server recorded in uat-run.state (`server_pid` = G) when `down` runs. */
const LEADERS = [
  'alive-verified', // alive, CM_DB_PATH under the run dir, listening alone on the port, ps -o pgid= says G
  'alive-unverified', // alive, and one of those checks failed or could not be made
  'dead', // kill -0 ESRCH (stop_recorded returns 0 today, run-server.sh:110)
  'unrecorded', // no server_pid in the state (up died before recording it)
] as const;
type Leader = (typeof LEADERS)[number];
/** The rest of G (kill -0 -G, ps -A -o pid=,pgid=, and each member's CM_DB_PATH). */
const MEMBERS = [
  'none', // ESRCH: nobody else in G
  'verified', // members, every one with CM_DB_PATH under the run dir
  'unverified', // members, one of them without that (or its environment unreadable)
  'unknown', // kill -0 -G or ps could not say (EPERM, a failure)
] as const;
type Members = (typeof MEMBERS)[number];

type DownCell =
  | {
      signals: 'none' | 'leader' | 'leader+group' | 'group';
      lock: 'released' | 'kept';
      status: 'stopped' | 'stop-refused' | 'stop-refused-group';
      /** the lock part of down's exit (the shared-file check may still make it 1) */
      exit: 0 | 1;
    }
  | { unreachable: string };

const STOP_REFUSED: DownCell = { signals: 'none', lock: 'kept', status: 'stop-refused', exit: 1 };
const GROUP_LEFT: DownCell = { signals: 'none', lock: 'kept', status: 'stop-refused-group', exit: 1 };
const NO_G = 'server_pid が記録されていなければ G を名指せない（I-6: server_pid は引渡しの前に状態ファイルへ書く。書く前に up が死ねば記録は T0 のまま）';

const TABLE_C = {
  'alive-verified': {
    none: { signals: 'leader', lock: 'released', status: 'stopped', exit: 0 },
    verified: { signals: 'leader+group', lock: 'released', status: 'stopped', exit: 0 },
    unverified: { signals: 'leader+group', lock: 'released', status: 'stopped', exit: 0 },
    unknown: { signals: 'leader+group', lock: 'kept', status: 'stop-refused-group', exit: 1 },
  },
  'alive-unverified': { none: STOP_REFUSED, verified: STOP_REFUSED, unverified: STOP_REFUSED, unknown: STOP_REFUSED },
  dead: {
    none: { signals: 'none', lock: 'released', status: 'stopped', exit: 0 },
    verified: { signals: 'group', lock: 'released', status: 'stopped', exit: 0 },
    unverified: GROUP_LEFT,
    unknown: GROUP_LEFT,
  },
  unrecorded: {
    none: { signals: 'none', lock: 'released', status: 'stopped', exit: 0 },
    verified: { unreachable: NO_G },
    unverified: { unreachable: NO_G },
    unknown: { unreachable: NO_G },
  },
} satisfies Record<Leader, Record<Members, DownCell>>;

interface RowC {
  id: string;
  leader: Leader;
  members: Members;
  cell: DownCell;
}

const ROWS_C: RowC[] = LEADERS.flatMap((leader) => MEMBERS.map((members) => ({ id: `${leader}/${members}`, leader, members, cell: TABLE_C[leader][members] })));

// ---------------------------------------------------------------- the invariants (§1) over the rows

const reachable = <T extends { cell: object }>(rows: T[]): T[] => rows.filter((r) => !('unreachable' in r.cell));
const unreachableRows = <T extends { cell: object }>(rows: T[]): T[] => rows.filter((r) => 'unreachable' in r.cell);

const TAKES: readonly Result[] = ['acquired', 'recovered-acquired', 'expired-acquired', 'reclaimed-acquired'];
const RELEASE_CALLERS: readonly Caller[] = ['ts-release', 'sh-release-held', 'sh-release-as-head'];
const OWN_SHAPES: readonly Shape[] = ['own-self', 'own-self-g', 'own-other', 'own-other-g'];

/** I-1: the canonical lock is removed by a release only on the self path (D12) or by the head on a gone holder (D5). */
function removalAllowed(row: RowA): boolean {
  if (row.caller === 'ts-release' || row.caller === 'sh-release-held') return row.shape === 'own-self' || row.shape === 'own-self-g';
  if (row.caller === 'sh-release-as-head') return row.obs === 'gone' && OWN_SHAPES.includes(row.shape);
  return false;
}

describe('#4288 PR1b table A: record shape × caller × observation (docs/design/run-lock-machine-lock-4288.md §2.2)', () => {
  it('has every combination of the enumerations, 336 rows (52 unreachable, 284 reachable)', () => {
    expect(ROWS_A).toHaveLength(SHAPES.length * CALLERS.length * OBSERVATIONS.length);
    expect(ROWS_A).toHaveLength(336);
    expect(unreachableRows(ROWS_A)).toHaveLength(52);
    expect(reachable(ROWS_A)).toHaveLength(284);
    expect(new Set(ROWS_A.map((r) => r.id)).size).toBe(ROWS_A.length);
  });

  it.each(unreachableRows(ROWS_A))('$id is unreachable for a stated reason', (row) => {
    expect('unreachable' in row.cell && row.cell.unreachable.length > 0).toBe(true);
  });

  it.each(reachable(ROWS_A))('$id keeps the invariants of §1 (I-1 removal, I-2 unknown, I-3 next)', (row) => {
    if ('unreachable' in row.cell) throw new Error('filtered');
    const cell = row.cell;
    expect(RESULTS).toContain(cell.result);
    // I-1: a release removes the canonical lock only on the allowed paths; nobody else removes it.
    if (cell.after === 'removed') expect(removalAllowed(row)).toBe(true);
    if (RELEASE_CALLERS.includes(row.caller) && cell.result === 'released') expect(cell.after).toBe('removed');
    // I-2: unknown is never read as free — no take, no inheritance, no removal, no handover.
    if (row.obs === 'unknown') {
      expect([...TAKES, 'inherited', 'released', 'handed']).not.toContain(cell.result);
      expect(cell.after === 'removed' || cell.after === 'mine' || cell.after === 't1').toBe(false);
    }
    // I-3: needs-head goes to D5; deferred / not-head / unknown are left to the next head.
    if (cell.result === 'needs-head') expect(cell.next).toBe('D5');
    if (cell.result === 'deferred' || cell.result === 'not-head' || cell.result === 'unknown') expect(cell.next).toBe('next-head');
    if (cell.next === 'D5') expect(cell.result).toBe('needs-head');
    // A take leaves the caller holding <lock>; nothing else does.
    expect(TAKES.includes(cell.result)).toBe(cell.after === 'mine');
    // I-6: a handover leaves T1 on record, and only a handover does.
    expect(cell.result === 'handed').toBe(cell.after === 't1');
    if (cell.result === 'handed') expect([row.caller, row.shape, row.obs]).toEqual(['sh-hand-off', 'own-self', 'alive']);
  });

  it('TS and bash agree on every acquisition and inheritance cell (one machine-lock under both)', () => {
    expect(TABLE_A['ts-acquire']).toEqual(TABLE_A['sh-acquire']);
    expect(TABLE_A['ts-inherit']).toEqual(TABLE_A['sh-inherit']);
  });

  for (const caller of CALLERS) {
    it.todo(
      `PR1b: drive ${caller} over its ${reachable(ROWS_A.filter((r) => r.caller === caller)).length} reachable rows in an os.tmpdir() lock and assert result / after / next`
    );
  }
});

describe('#4288 PR1b table B: the D9 handover — stage × flow × event (§2.3, review-4288h P2-2)', () => {
  it('has every combination, 24 rows (10 unreachable, 14 reachable)', () => {
    expect(ROWS_B).toHaveLength(FLOWS.length * STAGES.length * EVENTS.length);
    expect(ROWS_B).toHaveLength(24);
    expect(unreachableRows(ROWS_B)).toHaveLength(10);
    expect(reachable(ROWS_B)).toHaveLength(14);
  });

  it.each(reachable(ROWS_B))('$id: the child works only after the signal, and a published G is never taken over (I-7)', (row) => {
    if ('unreachable' in row.cell) throw new Error('filtered');
    const at = STAGES.indexOf(row.stage);
    const published = at >= STAGES.indexOf('published');
    expect(row.cell.record).toBe(published ? 'T1' : 'T0');
    expect(row.cell.childStarts).toBe(at >= STAGES.indexOf('signalled'));
    // Before the publish the record names no group: the next head may recover it — the waiting
    // child withdraws and never starts (P2-2: tmp is not published). From the publish on, G holds.
    expect(row.cell.takerWhileGroupLives).toBe(published ? 'refused' : 'acquires');
    expect(row.cell.takerAfterGroupEmpty).toBe('acquires');
  });

  for (const flow of FLOWS) {
    it.todo(`PR1b: run the ${flow} handover with a fake child, stop at each stage (CM_VERIFY_TEST_HANDOFF=pause:<stage>), deliver the event, assert the row`);
  }
});

describe('#4288 PR1b table C: UAT down — the leader × the rest of its group (§2.4, review-4288h P2-3)', () => {
  it('has every combination, 16 rows (3 unreachable, 13 reachable)', () => {
    expect(ROWS_C).toHaveLength(LEADERS.length * MEMBERS.length);
    expect(ROWS_C).toHaveLength(16);
    expect(unreachableRows(ROWS_C)).toHaveLength(3);
    expect(reachable(ROWS_C)).toHaveLength(13);
  });

  it.each(reachable(ROWS_C))('$id: G is signalled only when it is shown to be the run’s, and a kept lock is never “stopped” (I-10)', (row) => {
    if ('unreachable' in row.cell) throw new Error('filtered');
    const cell = row.cell;
    if (cell.signals === 'leader+group' || cell.signals === 'leader') expect(row.leader).toBe('alive-verified');
    if (cell.signals === 'group') expect([row.leader, row.members]).toEqual(['dead', 'verified']);
    if (row.leader === 'alive-unverified') expect(cell.signals).toBe('none');
    if (row.members === 'unverified' && row.leader !== 'alive-verified') expect(cell.signals).toBe('none');
    expect(cell.lock === 'released').toBe(cell.status === 'stopped');
    expect(cell.exit).toBe(cell.lock === 'released' ? 0 : 1);
    if (cell.status === 'stop-refused-group') expect(row.leader === 'alive-unverified').toBe(false);
  });

  it.todo('PR1b: run down against a fake server (a sh that exec’s sleep, with a member in its group) for each reachable row and assert signals / lock / status / exit');
});

describe('#4288 PR1b: the table sizes written in the design doc (§2.5)', () => {
  it('376 rows in all, 311 reachable', () => {
    expect(ROWS_A.length + ROWS_B.length + ROWS_C.length).toBe(376);
    expect(reachable(ROWS_A).length + reachable(ROWS_B).length + reachable(ROWS_C).length).toBe(311);
  });
});
