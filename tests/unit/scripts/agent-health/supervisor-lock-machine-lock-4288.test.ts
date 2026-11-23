/**
 * Issue #4288 PR1c — supervisor.lock on the machine-wide lock (scripts/lib/machine-lock.sh, PR1a).
 * Design: docs/design/supervisor-lock-machine-lock-4288.md (upstream stage, 4th round).
 *
 * UPSTREAM SKELETON (the design stage). This file holds the tables of the design as typed enumerations,
 * so that a cell, a result or a failure outcome left out (or one the caller cannot answer) fails the
 * typecheck (`satisfies`):
 *   - §2 the state table: record form × caller × observation of the pid → a Row (result / where the
 *     record ends / the caller's ticket / the message), a Rejected cell (the argument or context check of
 *     lib.sh refuses the call, exit 2) or an Impossible cell (no product caller reaches it);
 *   - §2.1 the group axis (pgid=) apart from the pid axis: only `none` is reachable for supervisor.lock;
 *   - §3 the failure outcomes, typed per caller: (caller × failure → result, record, ticket, message);
 *   - §5 the rejections of lib.sh and the loader rows (the PR1b ↔ PR1c contract).
 * RESULTS is composed from the result sets of the code (LRH_RESULT / LRAH_RESULT / LRO_RESULT); a test
 * below reads those sets out of machine-lock.sh and verify-run.sh and compares the two objects, made
 * apart, so a result value added to the code and not to the table (or the other way) fails here.
 *
 * The tables are checked against the invariants of §1, the code's result sets and the counts written in the
 * design (the first half of this file). The second half drives them through lib.sh / deadline-guard.sh: every
 * row of §2 (11 forms × 6 reachable callers × 3 observations) and every failure outcome of §3 is run, and the
 * end state is compared with the table's outcome column as it stands — the result, the message, the record
 * (the whole of the base except the queue: an empty <lock> left behind is a difference), the moved-aside
 * records and the caller's ticket. The only `it.todo` left are rows outside the stop premise (none now).
 *
 * How a row is driven:
 *   - bash under `set -u`, `PRODUCT_BASE=<mkdtemp under os.tmpdir()>`, `. scripts/agent-health/product/lib.sh`,
 *     the product functions only (product_lock_acquire / product_lock_release / product_lock_recover_only):
 *     never lock_release_as_head or lock_recover_only directly (they are PR1a's; the rows are about lib.sh);
 *     nothing under ~/.commandmate, no server, no tmux;
 *   - the form is written in the base (`supervisor.lock/owner` as key=value lines — a new writer's record carries
 *     the `v=1` line (PR1a-f I9), and a row that compares a record's text reads it with that line; no `v=` is an old
 *     writer's record —, `.gone-*`, `.stale.*`,
 *     `owner.tmp.<pid>`, an empty dir with `touch -t`), the observation made real (a live `sleep`, a dead
 *     pid, the test's own lstart, a reader under another TZ for F8) or injected (CM_VERIFY_TEST_KILL0_CMD,
 *     CM_VERIFY_TEST_OBS_FAULT=<point>=<ERRNO>, a `ps` shim on PATH, CM_VERIFY_TEST_HANDOFF=fault:… / pause:…);
 *   - `*-behind`: a live ticket of another pid placed ahead in `<base>/supervisor.queue/`;
 *   - `release-subshell`: `( product_lock_release )` after an acquisition in the main shell.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MACHINE_LOCK_SH = path.join(REPO_ROOT, 'scripts/lib/machine-lock.sh');
const VERIFY_RUN_SH = path.join(REPO_ROOT, '.claude/skills/cmate-verify/scripts/verify-run.sh');
const DESIGN_MD = path.join(REPO_ROOT, 'docs/design/supervisor-lock-machine-lock-4288.md');
const LIB_SH = path.join(REPO_ROOT, 'scripts/agent-health/product/lib.sh');
const DEADLINE_GUARD_SH = path.join(REPO_ROOT, 'scripts/agent-health/product/deadline-guard.sh');

// ------------------------------------------------------------------ enumerations (§2.1)

const FORMS = [
  'absent',
  'stale-old',
  'ownerless',
  'ownerless-tmp',
  'corrupt',
  'own',
  'other-plain',
  'other-lstart',
  'other-eperm',
  'other-host',
  'aside',
] as const;
type Form = (typeof FORMS)[number];

const CALLERS = [
  'acquire-head',
  'acquire-behind',
  'release-main',
  'release-subshell',
  'release-unheld',
  'guard-head',
  'guard-behind',
  'd5-head',
  'd5-behind',
] as const;
type Caller = (typeof CALLERS)[number];
/** Callers no product path reaches: a subshell's release is rejected, D5 has no product wrapper. */
type UnreachedCaller = 'release-subshell' | 'd5-head' | 'd5-behind';
type ReachableCaller = Exclude<Caller, UnreachedCaller>;

/**
 * The pid axis: kill -0 of the recorded pid, and for a record with lstart= whose kill -0 is alive or EPERM, the answer
 * of PR1a-f's machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms> (D7; design §2.1). PR1c keeps no tz
 * wrapper of its own and merges after PR1a-f.
 */
const OBS = ['alive', 'gone', 'unknown'] as const;
type Obs = (typeof OBS)[number];

/**
 * The contract of PR1a-f's machine_lock_pid_identity (its design machine-lock-owner-atomic-4288.md §4.1): one line on
 * stdout, exit code always 0, called only when kill -0 of the pid is alive or EPERM. The column of the table each answer
 * lands in, per what kill -0 said first: reused is gone (supervisor.lock has no pgid=, so G does not hold it); from
 * EPERM anything but reused stays EPERM (message eperm), from alive an unknown is unknown (message unk).
 */
const PID_IDENTITY = ['alive', 'reused', 'unknown'] as const;
type PidIdentity = (typeof PID_IDENTITY)[number];
const IDENTITY_ROWS = {
  'other-lstart': { kill0: 'alive', column: { alive: 'alive', reused: 'gone', unknown: 'unknown' }, heldMessage: 'rec', unknownMessage: 'unk' },
  'other-eperm': { kill0: 'EPERM', column: { alive: 'alive', reused: 'gone', unknown: 'unknown' }, heldMessage: 'eperm', unknownMessage: 'eperm' },
} as const satisfies Partial<Record<string, { kill0: string; column: Record<PidIdentity, Obs>; heldMessage: string; unknownMessage: string }>>;

/** The group axis, apart from the pid axis (common decision 3): supervisor.lock never records pgid= (S7). */
const GROUP_AXIS = {
  none: { reach: 'the record has no pgid= line: judged by the pid axis alone' },
  alive: { impossible: 'no writer puts pgid= in supervisor.lock (S7; a label with a newline is rejected, §5)' },
  gone: { impossible: 'as alive' },
  unknown: { impossible: 'as alive' },
} as const satisfies Record<'none' | Obs, { reach: string } | { impossible: string }>;

/** The result sets of the code, written by hand (compared below with the sets read out of the scripts). */
const CODE_RESULTS = {
  LRH: ['none', 'released', 'kept', 'deferred', 'needs-head'],
  LRAH: ['released', 'missing', 'deferred', 'kept', 'unknown', 'not-head'],
  LRO: ['removed', 'kept', 'restore-failed', 'absent', 'not-head'],
} as const;
/** lock_acquire_path answers 0 / 1 (no result variable). */
const ACQUIRE_CODE = ['acquired', 'refused'] as const;
/** What lib.sh adds of its own: rejected (exit 2, §5), unloaded (the loader failed: S9). */
const LIB_ONLY = { acquire: ['rejected'], release: ['rejected'], guard: ['rejected', 'unloaded'] } as const;

const RESULTS = {
  'acquire-head': [...ACQUIRE_CODE, ...LIB_ONLY.acquire],
  'acquire-behind': [...ACQUIRE_CODE, ...LIB_ONLY.acquire],
  'release-main': [...CODE_RESULTS.LRH, ...LIB_ONLY.release],
  'release-subshell': [...CODE_RESULTS.LRH, ...LIB_ONLY.release],
  'release-unheld': [...CODE_RESULTS.LRH, ...LIB_ONLY.release],
  'guard-head': [...CODE_RESULTS.LRO, ...LIB_ONLY.guard],
  'guard-behind': [...CODE_RESULTS.LRO, ...LIB_ONLY.guard],
  'd5-head': CODE_RESULTS.LRAH,
  'd5-behind': CODE_RESULTS.LRAH,
} as const satisfies Record<Caller, readonly string[]>;
type ResultOf<C extends Caller> = (typeof RESULTS)[C][number];

type LibFn = 'product_lock_acquire' | 'product_lock_release' | 'product_lock_recover_only' | 'lock_release_as_head';
const FN_OF = {
  'acquire-head': 'product_lock_acquire',
  'acquire-behind': 'product_lock_acquire',
  'release-main': 'product_lock_release',
  'release-subshell': 'product_lock_release',
  'release-unheld': 'product_lock_release',
  'guard-head': 'product_lock_recover_only',
  'guard-behind': 'product_lock_recover_only',
  'd5-head': 'lock_release_as_head',
  'd5-behind': 'lock_release_as_head',
} as const satisfies Record<Caller, LibFn>;

/**
 * Where the record of the form ends: stays, is removed, the caller's becomes canonical, the moved-aside
 * one is put back, or (failure rows only) the moved-aside one is kept aside and goes on holding, or this
 * acquisition's own half-made <lock> (with its owner / empty) is left.
 */
const LOCK_AFTER = ['unchanged', 'absent', 'mine', 'restored', 'aside', 'own-half-left', 'own-empty-left'] as const;
type LockAfter = (typeof LOCK_AFTER)[number];

/** The caller's own ticket: taken and retired (done), never taken, or (failure rows only) left until retirable. */
const TICKET_END = ['retired', 'none-taken', 'left-until-retirable'] as const;
type TicketEnd = (typeof TICKET_END)[number];

/**
 * The message (PRODUCT_LOCK_ERROR of a refused acquisition; the guard's stderr line when it keeps a lock a
 * person has to look at). Precedence on a refusal: loader > eperm > unk > queue > corrupt/tmp/host/aside > rec > taking.
 * eperm and unk come from the same noted unknown and never both: eperm is point=pid with errno=EPERM, unk any other
 * (design §2.2, the sources of the messages: MESSAGE_SOURCES below).
 */
const MESSAGES = ['rec', 'taking', 'queue', 'unk', 'eperm', 'corrupt', 'tmp', 'host', 'aside', 'loader'] as const;
type Message = (typeof MESSAGES)[number];
/** Messages that ask a person to look (decision 1: the form is told apart, nothing is removed). */
const PERSON_MESSAGES = ['eperm', 'corrupt', 'tmp', 'host'] as const satisfies readonly Message[];

/**
 * Where lib.sh reads the kind of a message from (design §2.2): a global the machine-lock operation left, or a
 * read made after the refusal for the message only (never for the judgement). `rank` is the precedence (1 wins);
 * kinds of the same rank are exclusive by their condition (the first in this order when two would hold).
 */
const MESSAGE_SOURCES = {
  loader: { rank: 1, from: 'PRODUCT_MACHINE_LOCK_OK (lib.sh, set once when it sources machine-lock.sh)', when: 'not 0: no machine-lock operation is called' },
  eperm: { rank: 2, from: 'LOCK_UNKNOWN (acquire) / LRO_UNKNOWN (guard): the first unknown noted in the one poll', when: 'point=pid and errno=EPERM' },
  unk: { rank: 3, from: 'LOCK_UNKNOWN / LRO_UNKNOWN, as eperm', when: 'not empty and not eperm' },
  queue: { rank: 4, from: 'la_blocker of lock_acquire_path (emptied each poll, the ticket ahead; acquire only)', when: 'not empty' },
  corrupt: { rank: 5, from: 'the read of <lock>/owner for the message', when: 'an owner with pid= or token= empty' },
  tmp: { rank: 5, from: 'the listing of <lock> for the message', when: 'no owner, and owner.tmp.* in it' },
  host: { rank: 5, from: 'the read of <lock>/owner for the message', when: 'a record whose host= is not LOCK_HOST' },
  aside: { rank: 5, from: 'LOCK_GONE_PENDING (lock_settle_gone) and the read of <lock>/owner', when: 'not empty, and no record in <lock> (the put-back failed)' },
  rec: { rank: 6, from: 'the read of <lock>/owner for the message', when: 'a record with pid= and token= (none of the above)' },
  taking: { rank: 7, from: 'none of the above (no owner; a failed ticket ln, F29, too)', when: 'otherwise' },
} as const satisfies Record<Message, { rank: number; from: string; when: string }>;

interface Row<C extends Caller> {
  readonly result: ResultOf<C>;
  readonly lock: LockAfter;
  readonly ticket: TicketEnd;
  readonly message?: Message;
}

// ------------------------------------------------------------------ rejections (§5) and loader rows (§5.2)

/** The argument and context checks of lib.sh: each answers rejected (exit 2) with PRODUCT_LOCK_ERROR, touching nothing. */
const REJECTIONS = {
  'acquire-arity': { fn: 'product_lock_acquire', check: 'not exactly one argument (the label)' },
  'acquire-label': { fn: 'product_lock_acquire', check: 'an empty label, or one with a newline (it would inject pgid= / token= lines)' },
  'acquire-while-holding': { fn: 'product_lock_acquire', check: 'this shell already holds (LOCK_HELD_PATH not empty)' },
  'release-args': { fn: 'product_lock_release', check: 'any argument' },
  'release-in-subshell': { fn: 'product_lock_release', check: 'BASH_SUBSHELL is not 0 (no product caller releases from a subshell)' },
  'recover-args': { fn: 'product_lock_recover_only', check: 'any argument' },
  'recover-while-holding': { fn: 'product_lock_recover_only', check: 'this shell holds the lock (the guard never acquires)' },
  'recover-in-subshell': { fn: 'product_lock_recover_only', check: 'BASH_SUBSHELL is not 0' },
  'base-empty': { fn: 'any', check: 'PRODUCT_BASE empty (all three)' },
} as const satisfies Record<string, { fn: LibFn | 'any'; check: string }>;
type RejectionKey = keyof typeof REJECTIONS;

interface Rejected {
  readonly rejected: RejectionKey;
}
interface Impossible {
  readonly impossible: string;
}
type Cell<C extends Caller> = Row<C> | Rejected | Impossible;
type Table = { readonly [F in Form]: { readonly [C in Caller]: { readonly [O in Obs]: Cell<C> } } };

/** The PR1b ↔ PR1c contract (common decision 4), as rows the implementation drives. */
const LOADER_ROWS = {
  'load-once': {
    setup: 'a fake run-lock.sh that sources machine-lock.sh, then lib.sh sources it again',
    loads: 1,
    acquire: 'as-table',
    guard: 'as-table',
  },
  'run-lock-load-failed': {
    setup: 'run-lock.sh sources machine-lock.sh, which fails (markers twice in a copy of verify-run.sh): run-lock.sh still defines run_lock_field / run_lock_pid_alive and its source returns 0',
    loads: 0,
    acquire: 'refused(loader)',
    guard: 'unloaded, the ledger reclaimed as today',
  },
  'old-run-lock-copy': {
    setup: "today's run-lock.sh (no machine-lock source) copied into a tmp tree with lib.sh",
    loads: 1,
    acquire: 'as-table',
    guard: 'as-table',
  },
  'lib-load-failed': {
    setup:
      "today's (old) run-lock.sh copied (it does not source machine-lock.sh) and MACHINE_LOCK_VERIFY_RUN naming a copy of verify-run.sh with the markers twice: lib.sh's own source fails, PRODUCT_MACHINE_LOCK_OK=0 (a run-lock.sh that loaded it would make lib.sh's second source return 0 at once)",
    loads: 0,
    acquire: 'refused(loader)',
    guard: 'unloaded, the ledger reclaimed as today',
  },
  'pid-alive-two-valued': {
    setup:
      'run_lock_pid_alive on a live / an ESRCH / an EPERM pid: 0 / 1 / 0 (two values, as today; 1 is kill -0 and ps -p both failing, not ESRCH alone; proc_running relies on it)',
    loads: 1,
    acquire: 'as-table',
    guard: 'as-table',
  },
} as const satisfies Record<
  string,
  { setup: string; loads: 0 | 1; acquire: 'as-table' | 'refused(loader)'; guard: 'as-table' | 'unloaded, the ledger reclaimed as today' }
>;

/** What the decisive observation of each form is, per value (§2.1). */
const OBS_MEANING = {
  absent: {
    alive: 'acquire: mkdir <lock> EEXIST (made in between) / guard: the listing of <lock> shows it',
    gone: 'acquire: mkdir created / guard: ENOENT',
    unknown: 'mkdir or the listing fails with another errno (CM_VERIFY_TEST_OBS_FAULT=mkdir-lock|lock-list=EIO)',
  },
  'stale-old': {
    alive: 'as absent: the old version\'s <lock>.stale.* is not read by the new readers (verify-run.sh lock_gone_candidates)',
    gone: 'as absent',
    unknown: 'as absent',
  },
  ownerless: {
    alive: "the empty <lock> is no older than the grace (being made): PR1a-f I3's production grace, which lib.sh passes as LOCK_OWNERLESS_GRACE_MS",
    gone: 'older than that grace of PR1a-f I3 (touch -t)',
    unknown: 'its mtime or listing cannot be read (CM_VERIFY_TEST_OBS_FAULT=ownerless-mtime=EIO)',
  },
  'ownerless-tmp': {
    alive: "<lock> and owner.tmp.<pid> are no older than PR1a-f I3's grace (the writer may be writing): waited for, told as `tmp`",
    gone: "older than that grace and the pid in the tmp name is ESRCH: the head takes the tmp and the <lock> out (PR1a-f I3), as ownerless × gone",
    unknown: 'its mtime / lstat / the writer pid cannot be read (CM_VERIFY_TEST_OBS_FAULT=ownerless-mtime=EIO): as ownerless × unknown',
  },
  corrupt: {
    alive: 'the pid left in the record is alive (must not matter)',
    gone: 'that pid is ESRCH (must not matter: a corrupt record is never recovered until PR1a-f)',
    unknown: 'kill -0 of that pid fails (must not matter)',
  },
  own: {
    alive: 'kill -0 $$ of the main shell alive',
    gone: 'ESRCH: impossible for the main shell that calls',
    unknown: 'kill -0 $$ fails twice (CM_VERIFY_TEST_KILL0_CMD)',
  },
  'other-plain': {
    alive: 'kill -0 of the recorded pid alive (no lstart= line, or an empty one: machine_lock_pid_identity is not called)',
    gone: 'ESRCH',
    unknown: 'kill -0 fails other than ESRCH and EPERM (EIO and the like); EPERM is F1 (message eperm)',
  },
  'other-lstart': {
    alive: 'kill -0 alive and machine_lock_pid_identity answers alive (the lstart texts equal, or started_at= with now − etime not later than started_at + 2 s: also when only the TZ of writer and reader differ, F8)',
    gone: 'ESRCH (the function is not called), or kill -0 alive and the function answers reused (D7)',
    unknown: 'kill -0 fails other than ESRCH and EPERM (EPERM is F1 / other-eperm), or the function answers unknown:lstart|etime:… (F6; CM_VERIFY_TEST_OBS_FAULT=lstart=EIO / etime=EIO; and F9: no started_at= and the lstart texts differ, unknown:lstart:EMISMATCH)',
  },
  'other-eperm': {
    alive: 'kill -0 EPERM and machine_lock_pid_identity answers alive: EPERM stays (message eperm)',
    gone: 'kill -0 EPERM and the function answers reused: the holder died and another user reused its pid',
    unknown: 'kill -0 EPERM and the function answers unknown:…: EPERM stays (message eperm)',
  },
  'other-host': {
    alive: 'not observed: a record of another host= is alive (lock_holder_state); kill -0 is not called',
    gone: 'not observed',
    unknown: 'not observed',
  },
  aside: {
    alive: "the moved-aside record's holder alive",
    gone: 'ESRCH',
    unknown: 'kill -0 of it fails other than ESRCH and EPERM (EIO; EPERM is F1)',
  },
} as const satisfies Record<Form, Record<Obs, string>>;

// ------------------------------------------------------------------ the table (§2.2)

const same = <const T,>(cell: T): Readonly<Record<Obs, T>> => ({ alive: cell, gone: cell, unknown: cell });

const NO_SELF_ESRCH: Impossible = { impossible: 'the main shell is the caller: kill -0 $$ cannot be ESRCH' };
const NO_GUARD_TOKEN: Impossible = { impossible: 'the guard never acquires (D6): no record carries its token' };
const NO_D5: Impossible = {
  impossible: 'no product_lock_* calls D5: needs-head is kept and recovered after the shell exits (S5)',
};
const SUBSHELL: Rejected = { rejected: 'release-in-subshell' };
const HOLDING: Rejected = { rejected: 'acquire-while-holding' };

const r = <const R extends string, const L extends LockAfter, const T extends TicketEnd, const M extends Message | undefined = undefined>(
  result: R,
  lock: L,
  ticket: T,
  message?: M,
) => (message === undefined ? { result, lock, ticket } : { result, lock, ticket, message }) as { result: R; lock: L; ticket: T; message?: M };

const ACQUIRED = r('acquired', 'mine', 'retired');
const refused = <const M extends Message>(message: M, lock: LockAfter = 'unchanged') => r('refused', lock, 'retired', message);
const QUEUE = same(refused('queue'));
const KEPT_REL = r('kept', 'unchanged', 'none-taken');
const NONE = r('none', 'unchanged', 'none-taken');
const G_KEPT = r('kept', 'unchanged', 'retired');
const gKept = <const M extends Message>(message: M) => r('kept', 'unchanged', 'retired', message);
const G_REMOVED = r('removed', 'absent', 'retired');
const NOT_HEAD = r('not-head', 'unchanged', 'retired');

/** The callers that read nothing of a record that is not theirs. */
const NOT_OURS = {
  'release-main': same(KEPT_REL),
  'release-subshell': same(SUBSHELL),
  'release-unheld': same(NONE),
  'guard-behind': same(NOT_HEAD),
  'd5-head': same(NO_D5),
  'd5-behind': same(NO_D5),
} as const;

/** A record of another token judged by the pid axis (other-plain, other-lstart). */
const OTHER = {
  ...NOT_OURS,
  'acquire-head': { alive: refused('rec'), gone: ACQUIRED, unknown: refused('unk') },
  'acquire-behind': QUEUE,
  'guard-head': { alive: G_KEPT, gone: G_REMOVED, unknown: gKept('unk') },
} as const;

/** A form only a person clears until PR1a-f (decision 1): never taken, never removed, told apart. */
const personOnly = <const M extends Message>(message: M) =>
  ({
    ...NOT_OURS,
    'acquire-head': same(refused(message)),
    'acquire-behind': QUEUE,
    'guard-head': same(gKept(message)),
  }) as const;

const ABSENT = {
  ...NOT_OURS,
  'acquire-head': { alive: refused('taking'), gone: ACQUIRED, unknown: refused('unk') },
  'acquire-behind': QUEUE,
  'guard-head': { alive: G_KEPT, gone: r('absent', 'unchanged', 'retired'), unknown: gKept('unk') },
} as const;

const TABLE = {
  absent: ABSENT,
  'stale-old': ABSENT,
  ownerless: {
    ...NOT_OURS,
    'acquire-head': { alive: refused('taking'), gone: ACQUIRED, unknown: refused('unk') },
    'acquire-behind': QUEUE,
    'guard-head': { alive: G_KEPT, gone: G_REMOVED, unknown: gKept('unk') },
  },
  // PR1a-f I3: a <lock> holding only temporaries is the head's to take out once <lock> and the tmp are older than
  // the grace and the writer pid is shown gone; younger, or with a writer that may still be there, it is waited for.
  'ownerless-tmp': {
    ...NOT_OURS,
    'acquire-head': { alive: refused('tmp'), gone: ACQUIRED, unknown: refused('unk') },
    'acquire-behind': QUEUE,
    'guard-head': { alive: gKept('tmp'), gone: G_REMOVED, unknown: gKept('unk') },
  },
  corrupt: personOnly('corrupt'),
  own: {
    'acquire-head': same(HOLDING),
    'acquire-behind': same(HOLDING),
    'release-main': {
      alive: r('released', 'absent', 'none-taken'),
      gone: NO_SELF_ESRCH,
      unknown: r('deferred', 'unchanged', 'none-taken'),
    },
    'release-subshell': same(SUBSHELL),
    'release-unheld': same(NONE),
    'guard-head': same(NO_GUARD_TOKEN),
    'guard-behind': same(NO_GUARD_TOKEN),
    'd5-head': same(NO_D5),
    'd5-behind': same(NO_D5),
  },
  'other-plain': OTHER,
  'other-lstart': OTHER,
  'other-eperm': {
    ...OTHER,
    'acquire-head': { alive: refused('eperm'), gone: ACQUIRED, unknown: refused('eperm') },
    'guard-head': { alive: gKept('eperm'), gone: G_REMOVED, unknown: gKept('eperm') },
  },
  'other-host': personOnly('host'),
  aside: {
    ...NOT_OURS,
    'acquire-head': { alive: refused('rec', 'restored'), gone: ACQUIRED, unknown: refused('unk', 'restored') },
    'acquire-behind': QUEUE,
    'guard-head': {
      alive: r('kept', 'restored', 'retired'),
      gone: r('absent', 'absent', 'retired'),
      unknown: r('kept', 'restored', 'retired', 'unk'),
    },
  },
} as const satisfies Table;

interface Entry {
  form: Form;
  caller: Caller;
  obs: Obs;
  cell: Cell<Caller>;
}
const CELLS: Entry[] = FORMS.flatMap((form) =>
  CALLERS.flatMap((caller) => OBS.map((obs) => ({ form, caller, obs, cell: (TABLE as Table)[form][caller][obs] as Cell<Caller> }))),
);
type RowEntry = Entry & { cell: Row<Caller> };
const isRejected = (cell: Cell<Caller>): cell is Rejected => 'rejected' in cell;
const isImpossible = (cell: Cell<Caller>): cell is Impossible => 'impossible' in cell;
const isRow = (cell: Cell<Caller>): cell is Row<Caller> => !isRejected(cell) && !isImpossible(cell);
const ROWS: RowEntry[] = CELLS.filter((e): e is RowEntry => isRow(e.cell));
const REJECTED = CELLS.filter((e) => isRejected(e.cell));
const IMPOSSIBLE = CELLS.filter((e) => isImpossible(e.cell));

// ------------------------------------------------------------------ failure outcomes (§3), typed per caller

/** keep: the failure removes nothing not shown gone; own-only: only what this acquisition itself made is undone. */
type Direction = 'keep' | 'own-only';
/** The outcome is the §2 cell of the form the caller meets (the failure does not change it). */
interface AsForm {
  readonly asForm: true;
}
type Outcome<C extends Caller> = Row<C> | AsForm;

/** Why a reachable caller has no outcome for a failure (one word each; every reachable caller is either answered or excluded). */
const EXCLUSIONS = {
  behind: 'behind a live ticket: the acquisition withdraws its ticket (queue), the guard answers not-head, before this point',
  'pre-queue': 'at the queue stage or before it (the loader): head or behind is not known yet, the head column answers for both',
  unheld: 'no hold mark: the release answers none before it reads anything',
  'own-pid-only': "the release observes only its own record and $$, never another holder's pid, lstart or host",
  'not-on-path': "this caller's function never passes the point (an acquisition-only, release-only or guard-only point)",
  'no-effect': "the release passes it (lock_release_own_gone) but no own moved-aside record exists for supervisor.lock: nothing changes",
} as const;
type Exclusion = keyof typeof EXCLUSIONS;

type Outcomes = { readonly [C in ReachableCaller]?: Outcome<C> };
type Exclusions = { readonly [C in ReachableCaller]?: Exclusion };
interface FailureRow {
  readonly point: string;
  readonly errno: string;
  readonly direction: Direction;
  readonly callers: Outcomes;
  readonly excluded: Exclusions;
}
/** Every reachable caller is written exactly once, in callers or in excluded: one left out (or written twice) fails the typecheck. */
type Complete<O, E> = [Exclude<ReachableCaller, keyof O | keyof E>] extends [never]
  ? [Extract<keyof O, keyof E>] extends [never]
    ? unknown
    : { readonly writtenTwice: Extract<keyof O, keyof E> }
  : { readonly callerNotWritten: Exclude<ReachableCaller, keyof O | keyof E> };
const failure = <const O extends Outcomes, const E extends Exclusions>(
  row: { point: string; errno: string; direction: Direction; callers: O; excluded: E } & Complete<O, E>,
) => row;
const AS_FORM: AsForm = { asForm: true };

/** The behind callers meet no observation of the record (S12): most failures. */
const BEHIND = { 'acquire-behind': 'behind', 'guard-behind': 'behind' } as const;
/** A failure at the queue stage: the head column answers for both. */
const PRE_QUEUE = { 'acquire-behind': 'pre-queue', 'guard-behind': 'pre-queue' } as const;
/** The releases do not pass a point of the acquisition or of the guard. */
const NO_RELEASE = { 'release-main': 'not-on-path', 'release-unheld': 'unheld' } as const;
/** An observation of another holder: the release reads its own $$ only. */
const RELEASE_SELF = { 'release-main': 'own-pid-only', 'release-unheld': 'unheld' } as const;

const FAILURE_TABLE = {
  'F1-kill0-eperm': failure({
    point: 'pid (lock_obs_kill0)',
    errno: 'EPERM that stays EPERM: a record with no lstart=, or machine_lock_pid_identity not answering reused (with lstart= the same answer as other-eperm × alive / unknown). On the aside form the head puts the moved record back first, so the record ends restored, not unchanged (acquire-head refused(eperm) / restored, guard-head kept(eperm) / restored: as aside × unknown)',
    direction: 'keep',
    callers: { 'acquire-head': refused('eperm'), 'guard-head': gKept('eperm') },
    excluded: { ...BEHIND, ...RELEASE_SELF },
  }),
  'F2-kill0-other': failure({
    point: 'pid (lock_obs_kill0)',
    errno: 'EIO and the like (not ESRCH, not EPERM)',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': gKept('unk'), 'release-main': r('deferred', 'unchanged', 'none-taken') },
    excluded: { ...BEHIND, 'release-unheld': 'unheld' },
  }),
  'F3-kill0-self-flips': failure({
    point: 'pid of $$ (lock_release_held: the self check unknown, the next read alive)',
    errno: 'EIO once',
    direction: 'keep',
    callers: { 'release-main': r('needs-head', 'unchanged', 'none-taken') },
    excluded: { 'acquire-head': 'not-on-path', 'guard-head': 'not-on-path', ...BEHIND, 'release-unheld': 'unheld' },
  }),
  'F4-zombie-holder': failure({
    point: 'pid (kill -0 of a zombie answers alive)',
    errno: '— (the holder KILLed, not yet reaped)',
    direction: 'keep',
    callers: { 'acquire-head': refused('rec'), 'guard-head': G_KEPT },
    excluded: { ...BEHIND, ...RELEASE_SELF },
  }),
  'F5-holder-killed': failure({
    point: 'the supervisor KILLed by stop_and_wait (lib.sh): EXIT never runs',
    errno: '— (SIGKILL)',
    direction: 'keep',
    callers: { 'guard-head': G_REMOVED, 'acquire-head': ACQUIRED },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F6-ps-lstart-judge': failure({
    point: 'machine_lock_pid_identity (PR1a-f): unknown:lstart / unknown:etime',
    errno: 'ps -o lstart= / ps -o etime= / date fails or prints nothing, after kill -0 alive (after EPERM it is other-eperm × unknown)',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': gKept('unk') },
    excluded: { ...BEHIND, ...RELEASE_SELF },
  }),
  'F7-ps-lstart-at-write': failure({
    point: 'proc_lstart $$ when the owner is written',
    errno: 'ps fails: lstart= written empty',
    direction: 'keep',
    callers: { 'acquire-head': refused('rec'), 'guard-head': G_KEPT },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F8-tz-differs': failure({
    point: 'machine_lock_pid_identity steps 5-6: the lstart texts differ, the record has started_at=, and now − etime is not later than started_at + 2 s (epoch times, so the TZ does not count)',
    errno: '— (writer and reader under different TZ values, the holder alive): the function answers alive',
    direction: 'keep',
    callers: { 'acquire-head': refused('rec'), 'guard-head': G_KEPT },
    excluded: { ...BEHIND, ...RELEASE_SELF },
  }),
  'F9-started-at-missing': failure({
    point: "machine_lock_pid_identity's <started-at-ms>: a record with no started_at= line (the old version's)",
    errno: '— (the holder alive, the lstart texts differ: another TZ or a reused pid cannot be told apart): the function answers unknown:lstart:EMISMATCH (PR1a-f §4.1 step 4; no mtime stands in for started_at). From EPERM it stays EPERM (refused(eperm), as other-eperm × unknown)',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': gKept('unk') },
    excluded: { ...BEHIND, ...RELEASE_SELF },
  }),
  'F10-hostname-changed': failure({
    point: 'LOCK_HOST (hostname) against the record\'s host=',
    errno: '— (the host name changed since the record was written)',
    direction: 'keep',
    callers: { 'acquire-head': refused('host'), 'guard-head': gKept('host') },
    excluded: { ...BEHIND, ...RELEASE_SELF },
  }),
  'F11-mkdir-lock': failure({
    point: 'mkdir-lock',
    errno: 'other than EEXIST',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk') },
    excluded: { 'guard-head': 'not-on-path', ...BEHIND, ...NO_RELEASE },
  }),
  'F12-owner-create-exists': failure({
    point: 'owner-create (O_EXCL)',
    errno: 'EEXIST, or another record read back',
    direction: 'keep',
    callers: { 'acquire-head': refused('rec') },
    excluded: { 'guard-head': 'not-on-path', ...BEHIND, ...NO_RELEASE },
  }),
  'F13-owner-create-open': failure({
    point: 'owner-create',
    errno: 'cannot open (ENOSPC, EACCES …)',
    direction: 'own-only',
    callers: { 'acquire-head': refused('unk') },
    excluded: { 'guard-head': 'not-on-path', ...BEHIND, ...NO_RELEASE },
  }),
  'F14-owner-write-or-readback': failure({
    point: 'owner-create (write) / owner-readback',
    errno: 'the write fails after the open, or the read back is unknown',
    direction: 'own-only',
    callers: { 'acquire-head': refused('unk') },
    excluded: { 'guard-head': 'not-on-path', ...BEHIND, ...NO_RELEASE },
  }),
  'F15-owner-unlink': failure({
    point: "the removal of this acquisition's own temporary <lock>/.owner-<token> after F13/F14 (fault:owner-unlink; PR1a-f's tmp→link leaves a tmp, not an owner)",
    errno: 'any — the <lock> is left holding only that tmp (own-half-left); with no owner it is I3\'s to take out after the grace, never read as a corrupt record',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk', 'own-half-left') },
    excluded: { 'guard-head': 'not-on-path', ...BEHIND, ...NO_RELEASE },
  }),
  'F16-lock-rmdir': failure({
    point: 'rmdir <lock> after F13/F14 (fault:lock-rmdir)',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk', 'own-empty-left') },
    excluded: { 'guard-head': 'not-on-path', ...BEHIND, ...NO_RELEASE },
  }),
  'F17-killed-mid-owner': failure({
    point: 'an owner that is not a record: a half-written one (an older copy\'s writer killed between `: >owner` and `cat >>owner`, or a power loss after the link)',
    errno: '— (SIGKILL, power loss): a non-empty half owner, or a 0-byte owner younger than PR1a-f I4\'s grace, is a corrupt form (refused / kept, nothing removed); a 0-byte owner older than that grace is the head\'s to take out (acquire-head acquired / mine, guard-head removed / absent: driven below, as ownerless × gone)',
    direction: 'keep',
    callers: { 'acquire-head': refused('corrupt'), 'guard-head': gKept('corrupt') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F18-old-tmp-left': failure({
    point: 'the old version died between its mkdir and mv: <lock>/owner.tmp.<pid> only',
    errno: '— (ownerless-tmp form): within PR1a-f I3\'s grace it is waited for (refused(tmp) / kept(tmp)); older than the grace with the writer pid gone it is taken out (as ownerless-tmp × gone: driven below)',
    direction: 'keep',
    callers: { 'acquire-head': refused('tmp'), 'guard-head': gKept('tmp') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F19-owner-read': failure({
    point: 'lock-owner / release-owner / recover-owner / gone-owner / reclaim-owner (lock_obs_owner)',
    errno: 'EACCES, EIO',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': gKept('unk'), 'release-main': r('deferred', 'unchanged', 'none-taken') },
    excluded: { ...BEHIND, 'release-unheld': 'unheld' },
  }),
  'F20-gone-listing': failure({
    point: 'list-root / gone-lstat (lock_gone_candidates)',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': AS_FORM },
    excluded: { ...BEHIND, 'release-main': 'no-effect', 'release-unheld': 'unheld' },
  }),
  'F21-ownerless-rmdir': failure({
    point: 'ownerless-rmdir (lock_expire_ownerless)',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': gKept('unk') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F22-rename-aside-enoent': failure({
    point: 'rename-aside (lock_recover)',
    errno: 'ENOENT — someone removed it first',
    direction: 'keep',
    callers: { 'acquire-head': ACQUIRED, 'guard-head': r('absent', 'absent', 'retired') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F23-rename-aside-other': failure({
    point: 'rename-aside (lock_recover)',
    errno: 'other — lock_recover does not note it unknown, so the message is rec',
    direction: 'keep',
    callers: { 'acquire-head': refused('rec'), 'guard-head': G_KEPT },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F24-recover-restore-mkdir': failure({
    point: 'restore-mkdir in lock_recover (the token differed; put back)',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('aside', 'aside'), 'guard-head': r('restore-failed', 'aside', 'retired') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F25-settle-restore-mkdir': failure({
    point: 'restore-mkdir in lock_restore_from_gone (settling a moved-aside record)',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('aside', 'aside'), 'guard-head': r('kept', 'aside', 'retired') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F26-restore-rename': failure({
    point: 'restore-rename (mv <gone>/owner <lock>/owner)',
    errno: 'any — the empty <lock> is taken out again, the moved-aside record kept',
    direction: 'keep',
    callers: { 'acquire-head': refused('aside', 'aside'), 'guard-head': r('kept', 'aside', 'retired') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F27-rm-gone': failure({
    point: 'rm -rf <gone> after a recovery (|| true)',
    errno: 'any — a dead record moved aside is left; the next head settles it',
    direction: 'keep',
    callers: { 'acquire-head': ACQUIRED, 'guard-head': G_REMOVED },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F28-rm-release-held': failure({
    point: 'rm -rf <lock> in lock_release_held (|| true)',
    errno: 'any — answers released, the own record left (recovered after the shell exits)',
    direction: 'keep',
    callers: { 'release-main': r('released', 'unchanged', 'none-taken') },
    excluded: { 'acquire-head': 'not-on-path', 'guard-head': 'not-on-path', ...BEHIND, 'release-unheld': 'unheld' },
  }),
  'F29-ticket-ln': failure({
    point: 'lock_take_ticket (ln)',
    errno: 'other than EEXIST — no unknown is noted and no ticket is left, so the message is taking (MESSAGE_SOURCES)',
    direction: 'keep',
    callers: { 'acquire-head': r('refused', 'unchanged', 'none-taken', 'taking'), 'guard-head': r('not-head', 'unchanged', 'none-taken') },
    excluded: { ...PRE_QUEUE, ...NO_RELEASE },
  }),
  'F30-queue-list': failure({
    point: 'list-queue',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': r('not-head', 'unchanged', 'retired', 'unk') },
    excluded: { ...PRE_QUEUE, ...NO_RELEASE },
  }),
  'F31-mark-done': failure({
    point: 'lock_mark_done of the own ticket',
    errno: 'any — the ticket stays until its pid dies or its deadline + 60 s',
    direction: 'keep',
    callers: {
      'acquire-head': r('acquired', 'mine', 'left-until-retirable'),
      'acquire-behind': r('refused', 'unchanged', 'left-until-retirable', 'queue'),
      // the dead record of other-plain × gone is removed as in §2, but the ticket stays: the mark-done that failed is the one of this ticket
      'guard-head': r('removed', 'absent', 'left-until-retirable'),
      'guard-behind': r('not-head', 'unchanged', 'left-until-retirable'),
    },
    excluded: { 'release-main': 'not-on-path', 'release-unheld': 'unheld' },
  }),
  'F32-ps-etime': failure({
    point: 'lock_pid_start_ms (ps -o etime=) of a ticket ahead',
    errno: 'any — the ticket is not read as reused: waited for',
    direction: 'keep',
    callers: { 'acquire-head': refused('queue'), 'guard-head': NOT_HEAD },
    excluded: { ...PRE_QUEUE, ...NO_RELEASE },
  }),
  'F33-loader': failure({
    point: 'machine_lock_load (lib.sh keeps the return in PRODUCT_MACHINE_LOCK_OK)',
    errno: 'verify-run.sh missing, markers not 1 / 1, set -e',
    direction: 'keep',
    callers: {
      // no ticket is taken when the section did not load (the loader is checked first)
      'acquire-head': r('refused', 'unchanged', 'none-taken', 'loader'),
      'acquire-behind': r('refused', 'unchanged', 'none-taken', 'loader'),
      'guard-head': r('unloaded', 'unchanged', 'none-taken', 'loader'),
      'guard-behind': r('unloaded', 'unchanged', 'none-taken', 'loader'),
      'release-main': NONE,
    },
    excluded: { 'release-unheld': 'unheld' },
  }),
  'F34a-reclaim-rmdir': failure({
    point: 'reclaim-rmdir (an empty <lock> left by a put-back that stopped half way, with the moved-aside dead record still there)',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': gKept('unk') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  // A failed rename of the dead record changes nothing (its gone judgement was made before, and the empty <lock> is already out):
  // the head takes the lock with mkdir + link, which exclude each other, so there is no double hold. The dead record stays aside
  // until the next head. Safe by the PM's investigation (pm-investigate-4288-f34-rename.md); PR1a-f's lock-observation-points test expects acquired too.
  'F34b-reclaim-rename': failure({
    point: 'reclaim-rename (the dead moved-aside record is renamed away after the empty <lock> was taken out)',
    errno: 'any (reclaim-rename=EIO) — no unknown is noted',
    direction: 'keep',
    callers: { 'acquire-head': ACQUIRED, 'guard-head': r('absent', 'absent', 'retired') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
} as const satisfies Record<string, FailureRow>;
type Failure = keyof typeof FAILURE_TABLE;
const FAILURES = Object.keys(FAILURE_TABLE) as Failure[];
const FAILURE_OUTCOMES = FAILURES.flatMap((f) =>
  Object.entries(FAILURE_TABLE[f].callers as Record<string, Outcome<Caller>>).map(([caller, outcome]) => ({
    failure: f,
    caller: caller as ReachableCaller,
    outcome,
  })),
);

// ------------------------------------------------------------------ counts written in the design

const COUNTS = {
  cells: 297,
  rows: 185,
  rejected: 39,
  impossible: 73,
  failures: 35,
  rejections: 9,
  loaderRows: 5,
} as const;

// ------------------------------------------------------------------ the result sets of the code

/**
 * Every `<VAR>=<value>` assignment of a result variable in the given sources (empty resets dropped). Comment lines
 * (`#` first on the line) are skipped: a value named only in a comment — machine-lock.sh's `(LRH_RESULT=needs-head)`
 * — must not keep the set whole after the code stopped assigning it (PM Claude P3-4).
 */
function codeResultSet(variable: string, sources: readonly string[]): string[] {
  const re = new RegExp(`\\b${variable}=([a-z][a-z-]*)`, 'g');
  const found = new Set<string>();
  for (const src of sources) {
    const code = fs
      .readFileSync(src, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    for (const m of code.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}
const sorted = (xs: readonly string[]) => [...xs].sort();

/** The lines of a shell text that are code (a line with `#` first is a comment and dropped). */
const codeLines = (text: string): string[] => text.split('\n').filter((line) => !/^\s*#/.test(line));

/** The text of the shell function `name() {` up to the first `}` alone at the start of a line; undefined when absent. */
function shellFunction(text: string, name: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^\}\s*$/.test(line));
  return lines.slice(start, end < 0 ? undefined : end + 1).join('\n');
}

/**
 * The stop judgements (the ledger's "stop it or not": TERM / KILL when true) stay the string match of proc_matches,
 * and machine_lock_pid_identity is called only through the D7 wrapper of the loader (design §2.1, P3-1): lib.sh
 * and deadline-guard.sh never call it, proc_matches included, and the three stop sites still call proc_matches.
 */
const STOP_SITES = [
  { file: 'deadline-guard.sh', what: 'the supervisor past its deadline', call: /proc_matches "\$sup_pid" "\$sup_lstart"/ },
  { file: 'lib.sh', what: 'reclaim_server', call: /proc_matches "\$pid" "\$lstart" && \[ "\$\(env_db_of / },
  { file: 'lib.sh', what: 'reclaim_runner', call: /proc_matches "\$pid" "\$lstart" && \[ "\$\(proc_pgid / },
] as const;
function stopJudgementProblems(lib: string, guard: string): string[] {
  const problems: string[] = [];
  const body = shellFunction(lib, 'proc_matches');
  if (body === undefined) problems.push('lib.sh: proc_matches is not defined');
  const texts = { 'lib.sh': lib, 'deadline-guard.sh': guard } as const;
  for (const [file, text] of Object.entries(texts)) {
    if (codeLines(text).some((line) => line.includes('machine_lock_pid_identity'))) problems.push(`${file}: calls machine_lock_pid_identity`);
  }
  for (const site of STOP_SITES) {
    if (!codeLines(texts[site.file]).some((line) => site.call.test(line))) problems.push(`${site.file}: ${site.what} is not judged by proc_matches`);
  }
  return problems;
}

/**
 * The internal names of verify-run.sh's lock section that the messages `queue` and `aside` read after the
 * operation returned (design §2.2, P3-2). They are not a contract of the section: a rename would let the message
 * fall to `taking` silently, so their assignment (and that la_blocker is not `local`) is checked here.
 */
const MESSAGE_INTERNALS = { queue: 'la_blocker', aside: 'LOCK_GONE_PENDING' } as const satisfies Partial<Record<Message, string>>;
function lockSection(text: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('# --- machine-wide gate lock'));
  const end = lines.findIndex((line, i) => i > start && line.startsWith('# --- gate execution'));
  return start < 0 || end < 0 ? undefined : lines.slice(start, end + 1).join('\n');
}
function messageInternalProblems(verifyRun: string): string[] {
  const section = lockSection(verifyRun);
  if (section === undefined) return ['verify-run.sh: the lock section markers are not found'];
  const code = codeLines(section);
  const problems: string[] = [];
  for (const [kind, name] of Object.entries(MESSAGE_INTERNALS)) {
    if (!code.some((line) => new RegExp(`(^|[\\s;|&])${name}=`).test(line))) problems.push(`${kind}: ${name}= is not assigned in the lock section`);
    if (code.some((line) => new RegExp(`\\blocal\\b[^#]*\\b${name}\\b`).test(line))) problems.push(`${kind}: ${name} is local (gone when the operation returns)`);
  }
  return problems;
}

// ------------------------------------------------------------------ the tables check themselves

describe('Issue #4288 PR1c table (design §2): shape', () => {
  it('has every combination: 11 forms × 9 callers × 3 observations = 297 cells (185 rows, 39 rejected, 73 impossible)', () => {
    expect(FORMS).toHaveLength(11);
    expect(CALLERS).toHaveLength(9);
    expect(CELLS).toHaveLength(COUNTS.cells);
    expect(ROWS).toHaveLength(COUNTS.rows);
    expect(REJECTED).toHaveLength(COUNTS.rejected);
    expect(IMPOSSIBLE).toHaveLength(COUNTS.impossible);
    expect(FAILURES).toHaveLength(COUNTS.failures);
    expect(Object.keys(REJECTIONS)).toHaveLength(COUNTS.rejections);
    expect(Object.keys(LOADER_ROWS)).toHaveLength(COUNTS.loaderRows);
  });

  it('the counts written in the design are the counts of these tables (two objects made apart)', () => {
    const text = fs.readFileSync(DESIGN_MD, 'utf8');
    const m = text.match(
      /表の数: セル (\d+)・行 (\d+)・拒否 (\d+)・不可能 (\d+)・失敗 (\d+)・拒否の検査 (\d+)・読み込み (\d+)/,
    );
    expect(m, 'the counts line of the design').not.toBeNull();
    const [, cells, rows, rejected, impossible, failures, rejections, loaderRows] = (m as RegExpMatchArray).map(Number);
    expect({ cells, rows, rejected, impossible, failures, rejections, loaderRows }).toEqual({ ...COUNTS });
  });

  it('the cells no product path reaches are exactly: the subshell release (rejected), D5 (impossible), own × acquire (rejected), own × guard and own × release-main × gone (impossible)', () => {
    for (const e of CELLS.filter((c) => c.caller === 'release-subshell')) expect(e.cell).toEqual(SUBSHELL);
    for (const e of CELLS.filter((c) => c.caller.startsWith('d5-'))) expect(e.cell).toEqual(NO_D5);
    const others = [...REJECTED, ...IMPOSSIBLE].filter((e) => e.caller !== 'release-subshell' && !e.caller.startsWith('d5-'));
    expect(others.every((e) => e.form === 'own')).toBe(true);
    expect(new Set(others.map((e) => e.caller))).toEqual(
      new Set(['acquire-head', 'acquire-behind', 'guard-head', 'guard-behind', 'release-main']),
    );
    expect(others.filter((e) => e.caller === 'release-main').map((e) => e.obs)).toEqual(['gone']);
  });

  it('every rejected cell names a rejection of the function of its caller', () => {
    for (const e of REJECTED) {
      const fn = REJECTIONS[(e.cell as Rejected).rejected].fn;
      expect([FN_OF[e.caller], 'any']).toContain(fn);
    }
  });

  it('the group axis: only `none` is reachable for supervisor.lock (S7)', () => {
    expect(Object.entries(GROUP_AXIS).filter(([, v]) => 'reach' in v).map(([k]) => k)).toEqual(['none']);
  });

  it('every failure answers or excludes each reachable caller exactly once (P3-5; the typecheck catches it first)', () => {
    const reachable = CALLERS.filter((c) => !['release-subshell', 'd5-head', 'd5-behind'].includes(c)).sort();
    for (const f of FAILURES) {
      const answered = Object.keys(FAILURE_TABLE[f].callers as Outcomes);
      const excluded = Object.keys(FAILURE_TABLE[f].excluded as Exclusions);
      expect(answered.filter((c) => excluded.includes(c)), f).toEqual([]);
      expect([...answered, ...excluded].sort(), f).toEqual(reachable);
      for (const why of Object.values(FAILURE_TABLE[f].excluded as Exclusions) as string[]) expect(Object.keys(EXCLUSIONS)).toContain(why);
    }
    // A row that leaves a reachable caller unwritten does not typecheck (the control of the type above).
    // @ts-expect-error callerNotWritten: release-main, release-unheld, guard-behind
    failure({ point: 'p', errno: 'e', direction: 'keep', callers: { 'acquire-head': refused('unk') }, excluded: { 'acquire-behind': 'behind', 'guard-head': 'not-on-path' } });
  });

  it('the messages: every kind has one source, and eperm and unk never both answer one input (P2-A, P2-B)', () => {
    expect(Object.keys(MESSAGE_SOURCES).sort()).toEqual([...MESSAGES].sort());
    expect(MESSAGE_SOURCES.eperm.rank).toBeLessThan(MESSAGE_SOURCES.unk.rank);
    expect(MESSAGE_SOURCES.unk.when).toContain('not eperm');
    // The unknown of the pid axis is EIO and the like (§2.1); EPERM of the same pid is F1, the only eperm.
    const epermCells = ROWS.filter((e) => e.cell.message === 'eperm');
    expect(new Set(epermCells.map((e) => e.form))).toEqual(new Set(['other-eperm']));
    const epermFailures = FAILURE_OUTCOMES.filter((o) => !('asForm' in o.outcome) && o.outcome.message === 'eperm').map((o) => o.failure);
    expect([...new Set(epermFailures)]).toEqual(['F1-kill0-eperm']);
    for (const form of ['other-plain', 'other-lstart', 'aside'] as const) {
      expect(OBS_MEANING[form].unknown, form).toContain('EPERM is F1');
    }
  });

  it('the answers of machine_lock_pid_identity (PR1a-f) land in the columns of its contract; no tz form or message is left (PM decision 3)', () => {
    for (const [form, row] of Object.entries(IDENTITY_ROWS) as [Form, (typeof IDENTITY_ROWS)[keyof typeof IDENTITY_ROWS]][]) {
      expect(Object.keys(row.column).sort()).toEqual([...PID_IDENTITY].sort());
      const t = (TABLE as Table)[form];
      expect(t['acquire-head'][row.column.reused]).toEqual(ACQUIRED);
      expect(t['guard-head'][row.column.reused]).toEqual(G_REMOVED);
      expect(t['acquire-head'][row.column.alive]).toEqual(refused(row.heldMessage));
      expect(t['acquire-head'][row.column.unknown]).toEqual(refused(row.unknownMessage));
      expect(t['guard-head'][row.column.unknown]).toEqual(gKept(row.unknownMessage));
    }
    expect((FORMS as readonly string[]).includes('other-tz')).toBe(false);
    expect((MESSAGES as readonly string[]).includes('tz')).toBe(false);
    const design = fs.readFileSync(DESIGN_MD, 'utf8');
    expect(design).toContain('machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms>');
    expect(design).toContain('PR1a-f → PR1c');
  });

  it('every observation of every form is defined', () => {
    for (const form of FORMS) for (const obs of OBS) expect(OBS_MEANING[form][obs].length).toBeGreaterThan(0);
  });

  it.each(ROWS)('row $caller × $form × $obs: a result the caller can answer, known ends', ({ caller, cell }) => {
    expect((RESULTS[caller] as readonly string[]).includes(cell.result)).toBe(true);
    expect((LOCK_AFTER as readonly string[]).includes(cell.lock)).toBe(true);
    expect((TICKET_END as readonly string[]).includes(cell.ticket)).toBe(true);
    if (cell.message !== undefined) expect((MESSAGES as readonly string[]).includes(cell.message)).toBe(true);
  });
});

describe('Issue #4288 PR1c table: RESULTS come from the code (machine-lock.sh, verify-run.sh)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('LRH_RESULT / LRAH_RESULT / LRO_RESULT read out of the scripts equal CODE_RESULTS written here', () => {
    const sources = [MACHINE_LOCK_SH, VERIFY_RUN_SH];
    expect(codeResultSet('LRH_RESULT', sources)).toEqual(sorted(CODE_RESULTS.LRH));
    expect(codeResultSet('LRAH_RESULT', sources)).toEqual(sorted(CODE_RESULTS.LRAH));
    expect(codeResultSet('LRO_RESULT', sources)).toEqual(sorted(CODE_RESULTS.LRO));
  });

  it('positive control: a result value added to a copy of the code is caught (the copies under os.tmpdir())', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1c-results-'));
    tmpDirs.push(dir);
    const copy = path.join(dir, 'verify-run.sh');
    fs.writeFileSync(copy, `${fs.readFileSync(VERIFY_RUN_SH, 'utf8')}\nLRO_RESULT=handed-over\n`);
    expect(codeResultSet('LRO_RESULT', [MACHINE_LOCK_SH, copy])).not.toEqual(sorted(CODE_RESULTS.LRO));
  });

  it('positive control: a value the code no longer assigns is caught even when a comment still names it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1c-results-'));
    tmpDirs.push(dir);
    const copy = path.join(dir, 'machine-lock.sh');
    const text = fs.readFileSync(MACHINE_LOCK_SH, 'utf8');
    const code = text
      .split('\n')
      .map((line) => (/^\s*#/.test(line) ? line : line.replace(/\bLRH_RESULT=needs-head\b/g, 'LRH_RESULT=deferred')))
      .join('\n');
    expect(code).not.toBe(text);
    expect(code).toContain('(LRH_RESULT=needs-head)');
    fs.writeFileSync(copy, code);
    expect(codeResultSet('LRH_RESULT', [copy, VERIFY_RUN_SH])).not.toContain('needs-head');
  });

  it('negative control: an assignment written only in a comment adds nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1c-results-'));
    tmpDirs.push(dir);
    const copy = path.join(dir, 'verify-run.sh');
    fs.writeFileSync(copy, `${fs.readFileSync(VERIFY_RUN_SH, 'utf8')}\n#   (LRO_RESULT=handed-over)\n`);
    expect(codeResultSet('LRO_RESULT', [MACHINE_LOCK_SH, copy])).toEqual(sorted(CODE_RESULTS.LRO));
  });

  it('negative control: an unchanged copy reads the same sets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1c-results-'));
    tmpDirs.push(dir);
    const copy = path.join(dir, 'verify-run.sh');
    fs.copyFileSync(VERIFY_RUN_SH, copy);
    expect(codeResultSet('LRO_RESULT', [MACHINE_LOCK_SH, copy])).toEqual(sorted(CODE_RESULTS.LRO));
    expect(codeResultSet('LRAH_RESULT', [MACHINE_LOCK_SH, copy])).toEqual(sorted(CODE_RESULTS.LRAH));
  });

  it('every result a product function can answer is answered by some row: §2, a failure (§3), a rejection or the loader', () => {
    const answered = new Map<LibFn | 'any', Set<string>>();
    const add = (fn: LibFn | 'any', result: string) => {
      if (!answered.has(fn)) answered.set(fn, new Set());
      answered.get(fn)!.add(result);
    };
    for (const e of ROWS) add(FN_OF[e.caller], e.cell.result);
    for (const o of FAILURE_OUTCOMES) if (!('asForm' in o.outcome)) add(FN_OF[o.caller], o.outcome.result);
    for (const k of Object.keys(REJECTIONS) as RejectionKey[]) add(REJECTIONS[k].fn, 'rejected');
    const anyRejected = answered.get('any')?.has('rejected') ?? false;
    const reachable = CALLERS.filter((c) => !['release-subshell', 'd5-head', 'd5-behind'].includes(c));
    for (const caller of reachable) {
      const fn = FN_OF[caller];
      for (const result of RESULTS[caller]) {
        const ok = answered.get(fn)?.has(result) || (result === 'rejected' && anyRejected);
        expect(ok, `${fn} answers ${result}`).toBe(true);
      }
    }
  });
});

describe('Issue #4288 PR1c table: the table keeps the invariants (a) (design §1, §2.3)', () => {
  const removes = (e: RowEntry) => e.cell.lock === 'absent' || e.cell.lock === 'mine';

  it('1 (S2): acquired only by acquire-head, and then the lock is mine; mine only when acquired', () => {
    for (const e of ROWS) {
      expect(e.cell.result === 'acquired', `${e.caller} × ${e.form} × ${e.obs}`).toBe(e.cell.lock === 'mine');
      if (e.cell.result === 'acquired') expect(e.caller).toBe('acquire-head');
    }
  });

  it('2 (S1, S3): a caller that is not the head moves nothing, and an acquisition behind a ticket withdraws it (S12)', () => {
    for (const e of ROWS.filter((r) => r.caller.endsWith('-behind'))) expect(e.cell.lock).toBe('unchanged');
    for (const e of ROWS.filter((r) => r.caller === 'acquire-behind')) expect(e.cell).toEqual(refused('queue'));
  });

  it('3 (S3): an unknown observation never takes, removes or releases', () => {
    for (const e of ROWS.filter((r) => r.obs === 'unknown')) {
      expect(['unchanged', 'restored'], `${e.caller} × ${e.form}`).toContain(e.cell.lock);
      expect(['acquired', 'released', 'removed']).not.toContain(e.cell.result);
    }
  });

  it("4 (S3): another token's record is removed only by a head on gone; corrupt / ownerless-tmp / other-host by nobody", () => {
    for (const e of ROWS.filter((r) => r.form !== 'own' && removes(r) && r.form !== 'absent' && r.form !== 'stale-old')) {
      expect(['acquire-head', 'guard-head'], `${e.caller} × ${e.form} × ${e.obs}`).toContain(e.caller);
      expect(e.obs).toBe('gone');
    }
    for (const form of ['corrupt', 'other-host'] as const) {
      expect(ROWS.filter((r) => r.form === form && r.cell.lock !== 'unchanged')).toEqual([]);
    }
    // PR1a-f I3: ownerless-tmp is the head's to take out once it is old and the writer is shown gone — as ownerless × gone, and no other obs
    expect(ROWS.filter((r) => r.form === 'ownerless-tmp' && r.cell.lock !== 'unchanged').map((r) => `${r.caller}/${r.obs}`)).toEqual(['acquire-head/gone', 'guard-head/gone']);
  });

  it('5 (S4): the own record is removed only by the main shell on alive', () => {
    const removing = ROWS.filter((r) => r.form === 'own' && r.cell.lock === 'absent').map((r) => `${r.caller}/${r.obs}`);
    expect(removing).toEqual(['release-main/alive']);
  });

  it('6 (S5, S6): no row reaches D5 or a release from a subshell', () => {
    expect(ROWS.filter((r) => r.caller === 'release-subshell' || r.caller.startsWith('d5-'))).toEqual([]);
  });

  it('7 (S4): a release with no hold mark does nothing (once only)', () => {
    for (const e of ROWS.filter((r) => r.caller === 'release-unheld')) expect(e.cell).toEqual(NONE);
  });

  it('8 (S4): no release removes a record that is not its own', () => {
    for (const e of ROWS.filter((r) => r.caller.startsWith('release') && r.form !== 'own')) expect(e.cell.lock).toBe('unchanged');
  });

  it('9 (§3): only what the caller itself made is undone on a failure', () => {
    const ownOnly = FAILURES.filter((f) => FAILURE_TABLE[f].direction === 'own-only');
    expect(ownOnly).toEqual(['F13-owner-create-open', 'F14-owner-write-or-readback']);
  });

  it('10 (S11, decision 1): a refused acquisition names its message; only refusals and the guard carry one', () => {
    for (const e of ROWS) {
      if (e.cell.result === 'refused') expect(e.cell.message, `${e.caller} × ${e.form} × ${e.obs}`).toBeDefined();
      if (e.cell.message !== undefined) expect(['refused', 'kept']).toContain(e.cell.result);
      if (e.cell.message !== undefined && e.cell.result === 'kept') expect(e.caller).toBe('guard-head');
    }
  });

  it('11 (decision 1): a form only a person clears is told apart to the acquirer and the guard in every observation', () => {
    const want = { corrupt: 'corrupt', 'ownerless-tmp': 'tmp', 'other-host': 'host' } as const;
    for (const [form, message] of Object.entries(want)) {
      for (const caller of ['acquire-head', 'guard-head'] as const) {
        // PR1a-f I3: an old ownerless-tmp whose writer is gone is not "a form only a person clears": the head takes it out
        for (const obs of OBS) if (!(form === 'ownerless-tmp' && obs === 'gone')) expect((TABLE as Table)[form as Form][caller][obs]).toMatchObject({ message: form === 'ownerless-tmp' && obs === 'unknown' ? 'unk' : message });
      }
    }
    for (const f of FAILURES) {
      for (const o of Object.values(FAILURE_TABLE[f].callers as Record<string, Outcome<Caller>>)) {
        if ('asForm' in o || o.message === undefined) continue;
        if ((PERSON_MESSAGES as readonly string[]).includes(o.message)) expect(o.lock, f).not.toBe('absent');
      }
    }
  });

  it('12 (P3-7): restored only on the aside form; the guard never makes the lock its own (S8)', () => {
    for (const e of ROWS.filter((r) => r.cell.lock === 'restored')) expect(e.form).toBe('aside');
    for (const e of ROWS.filter((r) => r.caller.startsWith('guard'))) expect(e.cell.lock).not.toBe('mine');
  });

  it('13 (S8, S12): every §2 row retires the ticket it took, or took none; none is left', () => {
    for (const e of ROWS) {
      const takes = e.caller.startsWith('acquire') || e.caller.startsWith('guard');
      expect(e.cell.ticket, `${e.caller} × ${e.form} × ${e.obs}`).toBe(takes ? 'retired' : 'none-taken');
    }
  });

  it('14 (§4): the old version\'s .stale.* changes nothing: stale-old reads as absent', () => {
    expect(TABLE['stale-old']).toEqual(TABLE.absent);
  });

  it('15 (§3): no failure removes a record of another holder not shown gone', () => {
    const removing = FAILURE_OUTCOMES.filter(
      (o) => !('asForm' in o.outcome) && (o.outcome.lock === 'absent' || o.outcome.lock === 'mine'),
    ).map((o) => o.failure);
    // F5: the holder is dead (KILL); F22: already removed by someone; F27: recovered, only its aside left; F34b: the dead record was judged gone before the rename.
    expect([...new Set(removing)].sort()).toEqual(['F22-rename-aside-enoent', 'F27-rm-gone', 'F31-mark-done', 'F34b-reclaim-rename', 'F5-holder-killed'].sort());
  });
});

// ------------------------------------------------------------------ what the design leans on in the code (upstream 4th round)

describe('Issue #4288 PR1c: the stop judgements and the internal names the messages read (design §2.1, §2.2, §3)', () => {
  const lib = fs.readFileSync(LIB_SH, 'utf8');
  const guard = fs.readFileSync(DEADLINE_GUARD_SH, 'utf8');
  const verifyRun = fs.readFileSync(VERIFY_RUN_SH, 'utf8');

  it('P3-1: proc_matches (the stop judgements: deadline-guard, reclaim_server, reclaim_runner) never calls machine_lock_pid_identity', () => {
    expect(stopJudgementProblems(lib, guard)).toEqual([]);
    const design = fs.readFileSync(DESIGN_MD, 'utf8');
    expect(design).toContain('止める判定（`deadline-guard.sh:55`・`lib.sh:217`・`lib.sh:294` の `proc_matches`）では `machine_lock_pid_identity` を呼ばず');
  });

  it('P3-1 positive control: proc_matches calling machine_lock_pid_identity, or a stop site judged without it, is caught', () => {
    const body = shellFunction(lib, 'proc_matches') as string;
    const swapped = lib.replace(body, body.replace(/\[ "\$\(proc_lstart "\$1"\)" = "\$2" \]/, '[ "$(machine_lock_pid_identity "$1" "$2" 0)" = alive ]'));
    expect(swapped).not.toBe(lib);
    expect(stopJudgementProblems(swapped, guard)).toEqual(['lib.sh: calls machine_lock_pid_identity']);
    const guardSwapped = guard.replace('proc_matches "$sup_pid" "$sup_lstart"', 'proc_alive "$sup_pid"');
    expect(guardSwapped).not.toBe(guard);
    expect(stopJudgementProblems(lib, guardSwapped)).toEqual(['deadline-guard.sh: the supervisor past its deadline is not judged by proc_matches']);
  });

  it('P3-1 negative control: the name in a comment only is not a call', () => {
    expect(stopJudgementProblems(`${lib}\n# proc_matches is not machine_lock_pid_identity\n`, guard)).toEqual([]);
  });

  it('P3-2: the queue and aside messages read la_blocker and LOCK_GONE_PENDING, assigned in the lock section and not local', () => {
    expect(messageInternalProblems(verifyRun)).toEqual([]);
    expect(MESSAGE_SOURCES.queue.from).toContain(MESSAGE_INTERNALS.queue);
    expect(MESSAGE_SOURCES.aside.from).toContain(MESSAGE_INTERNALS.aside);
  });

  it('P3-2 positive control: a renamed or local name is caught', () => {
    const renamed = verifyRun.replace(/\bla_blocker=/g, 'la_ahead=');
    expect(renamed).not.toBe(verifyRun);
    expect(messageInternalProblems(renamed)).toEqual(['queue: la_blocker= is not assigned in the lock section']);
    const local = verifyRun.replace(/^(\s*)la_blocker=""/m, '$1local la_blocker=""');
    expect(local).not.toBe(verifyRun);
    expect(messageInternalProblems(local)).toEqual(['queue: la_blocker is local (gone when the operation returns)']);
  });

  it('P3-2 positive control: an assignment left only in a comment does not count', () => {
    const commented = verifyRun.replace(/^(\s*)(.*\bLOCK_GONE_PENDING=.*)$/gm, '$1# $2');
    expect(messageInternalProblems(commented)).toEqual(['aside: LOCK_GONE_PENDING= is not assigned in the lock section']);
  });

  it('P3-3: an EPERM of the aside record ends restored, as aside × unknown (F1 note)', () => {
    const t = (TABLE as Table).aside;
    for (const caller of ['acquire-head', 'guard-head'] as const) {
      const cell = t[caller].unknown;
      expect(isRow(cell) && cell.lock, caller).toBe('restored');
    }
    expect(FAILURE_TABLE['F1-kill0-eperm'].errno).toContain('refused(eperm) / restored');
    expect(FAILURE_TABLE['F1-kill0-eperm'].errno).toContain('kept(eperm) / restored');
  });
});

// ------------------------------------------------------------------ aligned with PR1a-f's upstream 3rd round (9537f6f06)

describe("Issue #4288 PR1c: aligned with PR1a-f's upstream 3rd round (I3's grace, I5's started_at / etime)", () => {
  const design = fs.readFileSync(DESIGN_MD, 'utf8');

  it("F9: a record with no started_at= whose lstart text differs is unknown:lstart:EMISMATCH (no owner's mtime stands in)", () => {
    expect(FAILURE_TABLE['F9-started-at-missing'].callers).toEqual({ 'acquire-head': refused('unk'), 'guard-head': gKept('unk') });
    expect(FAILURE_TABLE['F9-started-at-missing'].errno).toContain('unknown:lstart:EMISMATCH');
    expect(design).not.toContain('owner の mtime を使う');
    expect(design).not.toContain('owner の mtime を `<started-at-ms>` に使う');
    expect(design).toContain('unknown:lstart:EMISMATCH');
  });

  it('F8: a holder under another TZ is alive by started_at against now − etime, not by a multiple of 900 s', () => {
    expect(FAILURE_TABLE['F8-tz-differs'].point).toContain('started_at');
    expect(FAILURE_TABLE['F8-tz-differs'].point).not.toContain('900');
    expect(design).not.toContain('900 秒の倍数');
  });

  it("the grace of an ownerless <lock> refers to PR1a-f I3's production grace, not a copied 60000", () => {
    expect(design).not.toContain('LOCK_OWNERLESS_GRACE_MS=60000');
    expect(design).toContain('PR1a-f I3 の本番の猶予');
    expect(OBS_MEANING.ownerless.gone).toContain('PR1a-f I3');
  });

  it("a new writer's record carries v=1 (PR1a-f I9): the forms and the rows comparing a record's text read that line", () => {
    expect(design).toContain('`lstart=`・`started_at=`・`v=1` あり');
    expect(design).toContain('記録を字面で比べる試験（実装の契約の行・既存の `3312.test.ts` の owner の読み）は `v=1` の行を含めて読み、期待の意味は変えない');
  });

  it('the existing :618-626 test (stderr empty) leans on the lstart texts matching: the implementation writes started_at= there', () => {
    expect(design).toContain('`:618-626` の生きた owner の記録に `started_at=` を足す');
  });
});

// ------------------------------------------------------------------ behaviour (the implementation contract)
//
// Each row of the §2 table is driven through lib.sh itself (bash under `set -u`, a private PRODUCT_BASE made with
// fs.mkdtempSync under os.tmpdir(), removed in afterEach): the form is written in the base, the observation made real
// (a live `sleep`, a pid that is gone) or injected (CM_VERIFY_TEST_OBS_FAULT; EPERM of pid 1 too, see KILL0_EPERM), and the answer read back
// from PRODUCT_LOCK_RESULT / PRODUCT_LOCK_KIND / PRODUCT_LOCK_ERROR / the files (the whole base but the queue is compared
// as the table says; no row is skipped).

const HAS_TOOLS = spawnSync('bash', ['-c', 'command -v ps && command -v hostname'], { encoding: 'utf8' }).status === 0;
const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
const killPids: number[] = [];
afterEach(() => {
  const killed = killPids.splice(0);
  for (const pid of killed) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const c of children.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  // F4's zombie parent (`sleep 600`, not a child of this process): confirm it stopped, on a pass and on a failure.
  for (const pid of killed) {
    let gone = false;
    for (let i = 0; i < 200 && !gone; i++) {
      try {
        process.kill(pid, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch (error) {
        gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
        if (!gone) break;
      }
    }
    if (!gone) throw new Error(`the zombie parent ${pid} did not stop`);
  }
});

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function lstartOf(pid: number): string {
  return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout.trim();
}

function isoNow(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** A process that lives until the test ends. */
function liveProcess(): number {
  const c = spawn('sleep', ['600'], { stdio: 'ignore' });
  children.push(c);
  return c.pid as number;
}

/** A pid that is gone (a child waited for). */
function deadPid(): number {
  const r = spawnSync('bash', ['-c', 'echo $$']);
  return Number(r.stdout.toString().trim());
}

interface RecordOpts {
  pid: number;
  token?: string;
  host?: string;
  lstart?: string;
  startedAt?: string;
  label?: string;
  v?: boolean;
}
function recordText(o: RecordOpts): string {
  const lines = [`pid=${o.pid}`, `host=${o.host ?? os.hostname()}`, `token=${o.token ?? 'other-token'}`];
  if (o.startedAt !== undefined) lines.push(`started_at=${o.startedAt}`);
  if (o.v !== false) lines.push('v=1');
  lines.push(`label=${o.label ?? 'other'}`);
  if (o.lstart !== undefined) lines.push(`lstart=${o.lstart}`);
  return `${lines.join('\n')}\n`;
}

const OLD = '202601010000';

/** What a driven row sets up and expects besides the table's cell. */
interface Fixture {
  /** extra environment for the bash that runs the caller */
  env: Record<string, string>;
  /** the canonical record's text before the call (undefined: no canonical <lock>) */
  before?: string;
  /** the moved-aside (or swapped-in) record's text, when the end state has one */
  aside?: string;
  /** the caller holds the lock itself (`own`): the script takes it first */
  takeFirst?: boolean;
  /** bash run after lib.sh is sourced and before the call: wrappers of the observation functions */
  bashPre?: string;
  /** release-main with takeFirst: bash run after the acquisition and before the release */
  afterAcquire?: string;
  /** what appears in the base during the call (a race): added to the expected end state */
  planted?: Snap;
  /** a dead record moved aside is left behind by a failed `rm -rf` (F27) */
  goneLeft?: boolean;
  /** a live ticket of another process ahead, whatever the caller (createdAt in ms when given) */
  ahead?: { createdAt?: number };
  /** the §2 cell the failure leaves the caller with (the table says `asForm`) */
  asForm?: { form: Form; obs: Obs };
}

// ---- wrappers of the section's observation functions (bash, defined after lib.sh is sourced: the
// ---- `bashPre` of PR1a-f's harness). `orig_<fn>` is the original, called after the interference.
const orig = (fn: string): string => `eval "orig_$(declare -f ${fn})"\n`;
/** Another taker's mkdir wins between this acquisition's decision and its own mkdir (absent × alive). */
const WRAP_MKDIR_RACE = `${orig('lock_obs_mkdir')}lock_obs_mkdir() { if [ "$1" = mkdir-lock ]; then mkdir "$2" 2>/dev/null; fi; orig_lock_obs_mkdir "$@"; }\n`;
/** A taker's <lock> appears between the guard's owner read and its listing (absent × alive). */
const WRAP_LIST_RACE = `${orig('lock_obs_list')}lock_obs_list() { if [ "$1" = lock-list ]; then mkdir -p "$2" 2>/dev/null; fi; orig_lock_obs_list "$@"; }\n`;
/**
 * machine_lock_pid_identity reads the clock before and after its two `ps` calls and answers unknown:etime:ECLOCK when
 * they took 1 s or more (PR1a-f §4.1, a safe answer). Under load that made the rows that need the `reused` verdict
 * (other-eperm × gone) fail now and then, so those rows pin the clock inside this one function: the verdict they
 * assert is independent of how long `ps` took. Everything else still reads the real clock.
 */
/**
 * EPERM of kill -0, made the same on every host: the record names pid 1 and the lock section's observation seam answers
 * EPERM for the point `pid` on exactly that target (`pid@@1`), before any kill is sent. Whether a real kill -0 of pid 1
 * is refused depends on the host (macOS as a user: EPERM; a Linux container, or root: allowed — the CI's
 * `expected 'rec' to be 'eperm'`), so it is not relied on. Only this observation fails; the lstart / etime of pid 1
 * (machine_lock_pid_identity) are still read for real.
 */
const KILL0_EPERM = 'pid@@1=EPERM';

const PIN_CLOCK = `${orig('lock_now_ms')}eval "orig2_$(declare -f machine_lock_pid_identity)"\nmachine_lock_pid_identity() { local t rc; t=$(orig_lock_now_ms); lock_now_ms() { echo "$t"; }; orig2_machine_lock_pid_identity "$@"; rc=$?; lock_now_ms() { orig_lock_now_ms; }; return $rc; }\n`;

// ---- the end state of the base: everything under it except the queue (dirs as '', files as their text)
type Snap = Record<string, string>;
const LOCK_NAME = 'supervisor.lock';
function snap(base: string): Snap {
  const out: Snap = {};
  const walk = (rel: string): void => {
    for (const n of fs.readdirSync(path.join(base, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === 'supervisor.queue') continue;
      if (fs.lstatSync(path.join(base, r)).isDirectory()) {
        out[r] = '';
        walk(r);
      } else {
        out[r] = fs.readFileSync(path.join(base, r), 'utf8');
      }
    }
  };
  walk('');
  return out;
}
const isLockKey = (k: string): boolean => k === LOCK_NAME || k.startsWith(`${LOCK_NAME}/`) || k.startsWith(`${LOCK_NAME}.gone-`);
const isGoneKey = (k: string): boolean => k.startsWith(`${LOCK_NAME}.gone-`);
const pick = (s: Snap, f: (k: string) => boolean): Snap => Object.fromEntries(Object.entries(s).filter(([k]) => f(k)));

/** The time-of-day-independent shape of an own record's lstart= line (ps -o lstart= under LC_ALL=C). */
const LSTART_LINE = /^lstart=\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/m;

function makeFixture(form: Form, obs: Obs, base: string, caller: Caller): Fixture {
  const lock = path.join(base, 'supervisor.lock');
  const env: Record<string, string> = {};
  const live = (): number => liveProcess();
  const put = (text: string): string => {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner'), text);
    return text;
  };
  const pidOf = (o: Obs): number => (o === 'gone' ? deadPid() : live());
  const unknownPid = (o: Obs): void => {
    if (o === 'unknown') env.CM_VERIFY_TEST_OBS_FAULT = 'pid=EIO';
  };
  switch (form) {
    case 'absent':
    case 'stale-old': {
      if (form === 'stale-old') {
        fs.mkdirSync(`${lock}.stale.123.456`, { recursive: true });
        fs.writeFileSync(path.join(`${lock}.stale.123.456`, 'owner'), recordText({ pid: live(), v: false }));
      }
      const fx: Fixture = { env };
      if (obs === 'unknown') {
        // the head's own observation fails; the callers that do not observe are given both faults and answer as for gone
        env.CM_VERIFY_TEST_OBS_FAULT = caller === 'acquire-head' ? 'mkdir-lock=EIO' : caller === 'guard-head' ? 'lock-list=EIO' : 'mkdir-lock=EIO lock-list=EIO';
      } else if (obs === 'alive') {
        // someone else's <lock> appears just as this caller looks (a race the callers that do not observe cannot meet)
        if (caller === 'acquire-head') {
          fx.bashPre = WRAP_MKDIR_RACE;
          fx.planted = { [LOCK_NAME]: '' };
        } else if (caller === 'guard-head') {
          fx.bashPre = WRAP_LIST_RACE;
          fx.planted = { [LOCK_NAME]: '' };
        }
      }
      return fx;
    }
    case 'ownerless': {
      fs.mkdirSync(lock, { recursive: true });
      if (obs !== 'alive') spawnSync('touch', ['-t', OLD, lock]);
      if (obs === 'unknown') env.CM_VERIFY_TEST_OBS_FAULT = 'ownerless-mtime=EIO';
      return { env };
    }
    case 'ownerless-tmp': {
      // PR1a-f I3: young (alive: the writer may be writing) / older than the grace with the writer pid gone (gone) /
      // its age cannot be read (unknown)
      fs.mkdirSync(lock, { recursive: true });
      const tmp = path.join(lock, `owner.tmp.${obs === 'alive' ? 4242 : deadPid()}`);
      fs.writeFileSync(tmp, 'pid=1\n');
      if (obs !== 'alive') spawnSync('touch', ['-t', OLD, tmp, lock]);
      if (obs === 'unknown') env.CM_VERIFY_TEST_OBS_FAULT = 'ownerless-mtime=EIO';
      return { env };
    }
    case 'corrupt': {
      const text = put(`pid=${pidOf(obs)}\n`);
      return { env, before: text };
    }
    case 'own': {
      if (caller !== 'release-main') {
        // the caller's own token in the record, but nothing held by this shell (release-unheld)
        const text = put(recordText({ pid: live(), token: 'mine-token', startedAt: isoNow() }));
        return { env, before: text };
      }
      unknownPid(obs);
      return { env, takeFirst: true };
    }
    case 'other-plain': {
      const text = put(recordText({ pid: pidOf(obs), startedAt: isoNow() }));
      unknownPid(obs);
      return { env, before: text };
    }
    case 'other-lstart': {
      const pid = pidOf(obs);
      const text = put(recordText({ pid, startedAt: isoNow(), lstart: obs === 'gone' ? 'x' : lstartOf(pid) }));
      if (obs === 'unknown') env.CM_VERIFY_TEST_OBS_FAULT = 'lstart=EIO';
      return { env, before: text };
    }
    case 'other-eperm': {
      // pid 1 as a process of another user: kill -0 answers EPERM (injected, KILL0_EPERM).
      const text =
        obs === 'alive'
          ? put(recordText({ pid: 1, startedAt: isoNow(), lstart: lstartOf(1) }))
          : put(recordText({ pid: 1, startedAt: '2015-01-01T00:00:00Z', lstart: 'Thu Jan  1 00:00:00 2015' }));
      env.CM_VERIFY_TEST_OBS_FAULT = obs === 'unknown' ? `${KILL0_EPERM} etime=EIO` : KILL0_EPERM;
      return { env, before: text, bashPre: PIN_CLOCK };
    }
    case 'other-host': {
      const text = put(recordText({ pid: pidOf(obs), host: 'some-other-host.invalid', startedAt: isoNow() }));
      return { env, before: text };
    }
    case 'aside': {
      const pid = pidOf(obs);
      const text = recordText({ pid, token: 'aside-token', startedAt: isoNow() });
      const gone = `${lock}.gone-aside-token-1`;
      fs.mkdirSync(gone, { recursive: true });
      fs.writeFileSync(path.join(gone, 'owner'), text);
      unknownPid(obs);
      void caller;
      return { env, aside: text };
    }
  }
}

interface Ran {
  rc: number;
  result: string;
  kind: string;
  error: string;
  stderr: string;
  /** the tickets the call left or made (name → text) */
  tickets: Record<string, string>;
}

function bashLib(base: string, body: string, env: Record<string, string>, lib = LIB_SH, timeout = 60_000) {
  return spawnSync('bash', ['-c', `set -u\nPRODUCT_BASE='${base}'\n. '${lib}'\n${body}`], {
    env: { PATH: process.env.PATH ?? '', HOME: base, TMPDIR: os.tmpdir(), LC_ALL: 'C', CM_PRODUCT_LOCK_GUARD_BUDGET_SEC: '1', ...env } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout,
  });
}

const REPORT = 'echo "RC=$rc"; echo "RES=$PRODUCT_LOCK_RESULT"; echo "KIND=$PRODUCT_LOCK_KIND"; printf "ERR=%s\\n" "$(printf %s "$PRODUCT_LOCK_ERROR" | tr "\\n" " ")"';

function readTickets(base: string): Record<string, string> {
  const q = path.join(base, 'supervisor.queue');
  if (!fs.existsSync(q)) return {};
  const out: Record<string, string> = {};
  for (const n of fs.readdirSync(q)) if (/^\d{12}$/.test(n)) out[n] = fs.readFileSync(path.join(q, n), 'utf8');
  return out;
}

function parseReport(stdout: string, stderr: string, base: string): Ran {
  const get = (k: string): string => (stdout.split('\n').find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  return { rc: Number(get('RC')), result: get('RES'), kind: get('KIND'), error: get('ERR'), stderr, tickets: readTickets(base) };
}

/** A live ticket of another process ahead in the queue (createdAt: ms; the default is now). */
function placeTicketAhead(base: string, createdAt?: number): void {
  const q = path.join(base, 'supervisor.queue');
  fs.mkdirSync(q, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(q, '000000000001'),
    `{"pid":${liveProcess()},"host":"${os.hostname()}","token":"ahead","createdAt":${createdAt ?? now},"deadline":${now + 600_000}}\n`,
  );
}

/** The bash that makes the call for a caller, with the fixture's wrappers in front. */
function callBody(caller: Caller, fx: Fixture, base: string): string {
  const pre = fx.bashPre ?? '';
  const lock = path.join(base, 'supervisor.lock');
  switch (caller) {
    case 'acquire-head':
    case 'acquire-behind':
      return `${pre}product_lock_acquire t; rc=$?\n${REPORT}`;
    case 'guard-head':
    case 'guard-behind':
      return `${pre}product_lock_recover_only; rc=$?\n${REPORT}`;
    case 'release-unheld':
      return `${pre}product_lock_release; rc=$?\n${REPORT}`;
    case 'release-main': {
      if (fx.takeFirst) {
        const exported = Object.entries(fx.env)
          .map(([k, v]) => `${k}='${v}'`)
          .join(' ');
        const body = `${pre}product_lock_acquire t || exit 9\n${exported ? `export ${exported}\n` : ''}${fx.afterAcquire ?? ''}\nproduct_lock_release; rc=$?\n${REPORT}`;
        fx.env = {};
        return body;
      }
      // the caller holds a mark (this shell took the lock once); the record is another's now
      return `${pre}LOCK_HELD_PATH='${lock}'; LOCK_HELD_TOKEN=mine-token\nproduct_lock_release; rc=$?\n${REPORT}`;
    }
    default:
      throw new Error(`not driven: ${caller}`);
  }
}

interface Driven {
  ran: Ran;
  fx: Fixture;
  base: string;
  beforeSnap: Snap;
}
function runWith(caller: Caller, base: string, fx: Fixture): Driven {
  if (caller === 'acquire-behind' || caller === 'guard-behind' || fx.ahead) placeTicketAhead(base, fx.ahead?.createdAt);
  const beforeSnap = snap(base);
  const res = bashLib(base, callBody(caller, fx, base), fx.env);
  return { ran: parseReport(res.stdout, res.stderr, base), fx, base, beforeSnap };
}

function runRow(caller: Caller, form: Form, obs: Obs): Driven {
  const base = mkTmp('cm-sup-lock-');
  const fx = makeFixture(form, obs, base, caller);
  return runWith(caller, base, fx);
}

function lockOwnerText(base: string): string | undefined {
  const f = path.join(base, 'supervisor.lock', 'owner');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
}

const KIND_OF_CELL_MESSAGE: Record<Message, string> = {
  rec: 'rec',
  taking: 'taking',
  queue: 'queue',
  unk: 'unk',
  eperm: 'eperm',
  corrupt: 'corrupt',
  tmp: 'tmp',
  host: 'host',
  aside: 'aside',
  loader: '',
};

interface Expected {
  readonly result: string;
  readonly lock: LockAfter;
  readonly ticket: TicketEnd;
  readonly message?: Message;
}

/**
 * The end state against the table's outcome as it stands: the result, the message (the kind and the line), where the
 * record ends — the whole of the base but the queue is compared, so an empty <lock>, a temporary or a moved-aside
 * record left behind is a difference — and the caller's own ticket.
 */
function assertOutcome(cell: Expected, d: Driven, caller: Caller, label: string): void {
  const { ran, fx, base } = d;
  expect(ran.result, `${label}: ${ran.stderr}`).toBe(cell.result);
  const isGuard = caller === 'guard-head' || caller === 'guard-behind';
  if (cell.message === 'loader') {
    expect(ran.error, label).toMatch(/^busy: the machine lock could not be loaded/);
  } else if (cell.message !== undefined) {
    expect(ran.kind, `${label}: ${ran.error}`).toBe(KIND_OF_CELL_MESSAGE[cell.message]);
    expect(ran.error, label).not.toBe('');
    if (isGuard) expect(ran.error).toContain('busy:');
  } else if (isGuard || caller.startsWith('release')) {
    expect(ran.error, `${label}: a line is told only when a person has to look`).toBe('');
  }

  // where the record ends
  const after = snap(base);
  expect(pick(after, (k) => !isLockKey(k)), `${label}: nothing but the lock may change`).toEqual(pick(d.beforeSnap, (k) => !isLockKey(k)));
  const lockAfter = pick(after, isLockKey);
  const canon = pick(lockAfter, (k) => !isGoneKey(k));
  const goneKeys = Object.keys(lockAfter).filter(isGoneKey);
  const owner = canon[`${LOCK_NAME}/owner`];
  const leftover = (): void => {
    if (fx.goneLeft) expect(goneKeys.length, `${label}: the dead record moved aside stays`).toBeGreaterThan(0);
    else expect(goneKeys, `${label}: no moved-aside record left`).toEqual([]);
  };
  switch (cell.lock) {
    case 'unchanged':
      if (fx.takeFirst) {
        expect(Object.keys(canon).sort(), label).toEqual([LOCK_NAME, `${LOCK_NAME}/owner`]);
        expect(owner).toContain('label=t');
        leftover();
      } else {
        expect(lockAfter, `${label}: the lock as it was`).toEqual({ ...pick(d.beforeSnap, isLockKey), ...(fx.planted ?? {}) });
      }
      break;
    case 'absent':
      expect(canon, `${label}: no <lock> left`).toEqual({});
      leftover();
      break;
    case 'mine':
      expect(Object.keys(canon).sort(), `${label}: the <lock> holds the owner and nothing else`).toEqual([LOCK_NAME, `${LOCK_NAME}/owner`]);
      expect(owner).toContain('label=t');
      expect(owner, 'the own record carries the start time the reuse check needs (D7)').toMatch(LSTART_LINE);
      expect(owner).toMatch(/^started_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
      expect(owner).toMatch(/^v=1$/m);
      expect(owner, 'supervisor.lock never records a group (S7)').not.toContain('pgid=');
      if (fx.before !== undefined) expect(owner).not.toBe(fx.before);
      leftover();
      break;
    case 'restored':
      expect(Object.keys(canon).sort(), label).toEqual([LOCK_NAME, `${LOCK_NAME}/owner`]);
      expect(owner).toBe(fx.aside);
      expect(goneKeys, label).toEqual([]);
      break;
    case 'aside':
      expect(canon, `${label}: no <lock>, the record stays aside`).toEqual({});
      // the snapshot lists the moved-aside directory and its owner file: one directory, holding the judged record
      expect(goneKeys.filter((k) => !k.includes('/')), label).toHaveLength(1);
      expect(lockAfter[`${goneKeys.find((k) => !k.includes('/'))}/owner`]).toBe(fx.aside);
      break;
    case 'own-half-left': {
      // PR1a-f's tmp→link: what this acquisition's failed clean-up leaves is its own `.owner-<token>`, never an owner
      const keys = Object.keys(canon).sort();
      expect(keys[0], label).toBe(LOCK_NAME);
      expect(keys.length, label).toBeGreaterThan(1);
      for (const k of keys.slice(1)) expect(k, label).toMatch(/^supervisor\.lock\/\.owner-/);
      leftover();
      break;
    }
    case 'own-empty-left':
      expect(canon, `${label}: the empty <lock> this acquisition made stays`).toEqual({ [LOCK_NAME]: '' });
      leftover();
      break;
  }

  // the caller's own ticket: retired (done), none taken, or left until it can be retired
  const behind = caller === 'acquire-behind' || caller === 'guard-behind' || fx.ahead !== undefined;
  const mineTickets = Object.entries(ran.tickets).filter(([n]) => !(behind && n === '000000000001'));
  if (fx.takeFirst) {
    // the acquisition before the release took (and retired) its own ticket; the release adds none
    expect(Object.keys(ran.tickets), label).toHaveLength(1);
    for (const [, text] of mineTickets) expect(text).toContain('"done":true');
  } else if (cell.ticket === 'none-taken') {
    expect(mineTickets, `${label}: no ticket of its own`).toEqual([]);
  } else if (cell.ticket === 'retired') {
    expect(mineTickets.length, label).toBeGreaterThan(0);
    for (const [, text] of mineTickets) expect(text, label).toContain('"done":true');
  } else {
    expect(mineTickets.length, label).toBeGreaterThan(0);
    for (const [, text] of mineTickets) expect(text, `${label}: the ticket is not marked done`).not.toContain('"done":true');
  }
}

function checkRow(e: RowEntry): void {
  const d = runRow(e.caller, e.form, e.obs);
  assertOutcome(e.cell, d, e.caller, `${e.caller} × ${e.form} × ${e.obs}`);
}

describe.each(CALLERS)('Issue #4288 PR1c behaviour: %s (lib.sh / deadline-guard.sh)', (caller) => {
  const rows = ROWS.filter((r) => r.caller === caller);
  for (const e of rows) {
    const msg = e.cell.message ? ` (${e.cell.message})` : '';
    const title = `${e.form} × ${e.obs} → ${e.cell.result}${msg} / ${e.cell.lock} / ticket ${e.cell.ticket}`;
    if (!HAS_TOOLS) {
      it.todo(`${title} — needs ps and hostname`);
    } else {
      it(title, () => checkRow(e), 60_000);
    }
  }
  if (rows.length === 0) {
    // release-subshell: one rejection row (§5); d5-*: no product path calls D5 (S5).
    if (caller === 'release-subshell') {
      it('rejected (release-in-subshell): nothing removed, exit 2', () => {
        const base = mkTmp('cm-sup-lock-');
        const res = bashLib(
          base,
          `product_lock_acquire t || exit 9\n( product_lock_release; echo "SUBRC=$? $PRODUCT_LOCK_RESULT" )\nls "${base}/supervisor.lock/owner" >/dev/null && echo STILL-THERE`,
          {},
        );
        expect(res.stdout).toContain('SUBRC=2 rejected');
        expect(res.stdout).toContain('STILL-THERE');
      });
    } else {
      it('not reached by any product_lock_* (S5): no function of lib.sh calls lock_release_as_head', () => {
        const lib = fs.readFileSync(LIB_SH, 'utf8');
        expect(codeLines(lib).filter((l) => /lock_release_as_head/.test(l))).toEqual([]);
      });
    }
  }
});

describe('Issue #4288 PR1c rejections (design §5)', () => {
  const runs: Record<RejectionKey, (base: string) => { body: string; env?: Record<string, string>; base?: string }> = {
    'acquire-arity': () => ({ body: 'product_lock_acquire; rc=$?\n' + REPORT }),
    'acquire-label': () => ({ body: 'product_lock_acquire "$(printf "a\\npgid=1")"; rc=$?\n' + REPORT }),
    'acquire-while-holding': () => ({ body: 'product_lock_acquire t || exit 9\nproduct_lock_acquire u; rc=$?\n' + REPORT }),
    'release-args': () => ({ body: 'product_lock_release x; rc=$?\n' + REPORT }),
    'release-in-subshell': () => ({ body: '( product_lock_release; rc=$?\n' + REPORT + ' )' }),
    'recover-args': () => ({ body: 'product_lock_recover_only x; rc=$?\n' + REPORT }),
    'recover-while-holding': () => ({ body: 'product_lock_acquire t || exit 9\nproduct_lock_recover_only; rc=$?\n' + REPORT }),
    'recover-in-subshell': () => ({ body: '( product_lock_recover_only; rc=$?\n' + REPORT + ' )' }),
    'base-empty': () => ({ body: 'PRODUCT_BASE=""\nfor f in product_lock_acquire:t product_lock_release: product_lock_recover_only:; do fn=${f%%:*}; a=${f#*:}; ${fn} ${a:+$a}; echo "ONE:$fn rc=$? $PRODUCT_LOCK_RESULT"; done' }),
  };
  for (const k of Object.keys(REJECTIONS) as RejectionKey[]) {
    it(`${k}: ${REJECTIONS[k].fn} with ${REJECTIONS[k].check} → rejected (exit 2), nothing touched`, () => {
      const base = mkTmp('cm-sup-lock-');
      const { body } = runs[k](base);
      const res = bashLib(base, body, {});
      if (k === 'base-empty') {
        const lines = res.stdout.split('\n').filter((l) => l.startsWith('ONE:'));
        expect(lines).toHaveLength(3);
        for (const l of lines) expect(l).toMatch(/rc=2 rejected$/);
      } else {
        const ran = parseReport(res.stdout, res.stderr, base);
        expect(ran.rc).toBe(2);
        expect(ran.result).toBe('rejected');
        expect(ran.error).not.toBe('');
      }
      if (k !== 'acquire-while-holding' && k !== 'recover-while-holding') {
        // nothing touched: no lock, no ticket
        expect(fs.existsSync(path.join(base, 'supervisor.lock'))).toBe(false);
        expect(Object.keys(readTickets(base))).toEqual([]);
      } else {
        // the lock the shell took is still its own
        expect(lockOwnerText(base)).toContain('label=t');
      }
    });
  }
});

describe('Issue #4288 PR1c loader rows: the PR1b ↔ PR1c contract (design §5.2)', () => {
  const oldRunLock = (dir: string): void => {
    fs.mkdirSync(path.join(dir, 'scripts/uat'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts/uat/run-lock.sh'), path.join(dir, 'scripts/uat/run-lock.sh'));
  };
  /** A copy of the product dir and what it sources, under os.tmpdir(): lib.sh finds its repo root by its own path. */
  const makeTree = (): string => {
    const tree = mkTmp('cm-sup-tree-');
    for (const rel of ['scripts/agent-health/product/lib.sh', 'scripts/agent-health/product/ledger.py', 'scripts/lib/port-pids.sh', 'scripts/lib/machine-lock.sh', 'scripts/uat/run-lock.sh', '.claude/skills/cmate-verify/scripts/verify-run.sh']) {
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(tree, rel));
    }
    return tree;
  };
  const twice = (tree: string): string => {
    const f = path.join(tree, 'markers-twice.sh');
    const src = fs.readFileSync(VERIFY_RUN_SH, 'utf8');
    fs.writeFileSync(f, `${src}\n# --- machine-wide gate lock\n`);
    return f;
  };

  it('load-once: a run-lock.sh that sources machine-lock.sh first leaves lib.sh with one load, the table as is', () => {
    const tree = makeTree();
    const rl = path.join(tree, 'scripts/uat/run-lock.sh');
    fs.appendFileSync(rl, `\n. '${path.join(tree, 'scripts/lib/machine-lock.sh')}'\n`);
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(base, 'echo "OK=$PRODUCT_MACHINE_LOCK_OK"; product_lock_acquire t; rc=$?\n' + REPORT, {}, path.join(tree, 'scripts/agent-health/product/lib.sh'));
    expect(res.stdout).toContain('OK=0');
    expect(res.stdout).toContain('RES=acquired');
  });

  it('run-lock-load-failed: a failed machine-lock load by run-lock.sh leaves lib.sh loading it itself (a second try on the same copy fails too: refused(loader))', () => {
    const tree = makeTree();
    const bad = twice(tree);
    const rl = path.join(tree, 'scripts/uat/run-lock.sh');
    fs.appendFileSync(rl, `\n. '${path.join(tree, 'scripts/lib/machine-lock.sh')}' || true\n`);
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(
      base,
      'type run_lock_field >/dev/null && type run_lock_pid_alive >/dev/null && echo FUNCS\nproduct_lock_acquire t; rc=$?\n' + REPORT + '\nproduct_lock_recover_only; echo "G=$PRODUCT_LOCK_RESULT"',
      { MACHINE_LOCK_VERIFY_RUN: bad },
      path.join(tree, 'scripts/agent-health/product/lib.sh'),
    );
    expect(res.stdout).toContain('FUNCS');
    expect(res.stdout).toContain('RES=refused');
    expect(res.stdout).toContain('KIND=');
    expect(res.stdout).toContain('G=unloaded');
    expect(fs.existsSync(path.join(base, 'supervisor.lock'))).toBe(false);
  });

  it('old-run-lock-copy: today\'s run-lock.sh (no machine-lock source): one load by lib.sh, the table as is', () => {
    const tree = makeTree();
    oldRunLock(tree);
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(base, 'echo "OK=$PRODUCT_MACHINE_LOCK_OK"; product_lock_acquire t; rc=$?\n' + REPORT, {}, path.join(tree, 'scripts/agent-health/product/lib.sh'));
    expect(res.stdout).toContain('OK=0');
    expect(res.stdout).toContain('RES=acquired');
  });

  it('lib-load-failed: lib.sh\'s own source fails (an old run-lock.sh, markers twice): PRODUCT_MACHINE_LOCK_OK is not 0, refused(loader), unloaded', () => {
    const tree = makeTree();
    const bad = twice(tree);
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(
      base,
      'echo "OK=$PRODUCT_MACHINE_LOCK_OK"; product_lock_acquire t; rc=$?\n' + REPORT + '\nproduct_lock_recover_only; echo "G=$PRODUCT_LOCK_RESULT"; product_lock_release; echo "R=$PRODUCT_LOCK_RESULT"',
      { MACHINE_LOCK_VERIFY_RUN: bad },
      path.join(tree, 'scripts/agent-health/product/lib.sh'),
    );
    expect(res.stdout).not.toContain('OK=0');
    expect(res.stdout).toContain('RC=1');
    expect(res.stdout).toContain('RES=refused');
    expect(res.stdout).toMatch(/ERR=busy: the machine lock could not be loaded/);
    expect(res.stdout).toContain('G=unloaded');
    expect(res.stdout).toContain('R=none');
    expect(fs.existsSync(path.join(base, 'supervisor.lock'))).toBe(false);
  });

  it('pid-alive-two-valued: run_lock_pid_alive answers 0 / 1 / 0 for a live / an ESRCH / an EPERM pid, and proc_running follows', () => {
    const live = liveProcess();
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(
      base,
      `run_lock_pid_alive ${live}; echo "A=$?"; run_lock_pid_alive ${deadPid()}; echo "B=$?"; run_lock_pid_alive 1; echo "C=$?"; proc_running ${live}; echo "D=$?"; proc_running 1; echo "E=$?"`,
      {},
    );
    expect(res.stdout).toContain('A=0');
    expect(res.stdout).toContain('B=1');
    expect(res.stdout).toContain('C=0');
    expect(res.stdout).toContain('D=0');
    expect(res.stdout).toContain('E=0');
  });
});

describe('Issue #4288 PR1c failure outcomes (design §3): every outcome of the table driven, and compared as the table says', () => {
  const lockOf = (base: string): string => path.join(base, 'supervisor.lock');
  const writeLock = (base: string, text: string): string => {
    fs.mkdirSync(lockOf(base), { recursive: true });
    fs.writeFileSync(path.join(lockOf(base), 'owner'), text);
    return text;
  };
  const pidLstart = (pid: number, tz: string): string =>
    spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: tz } }).stdout.trim();
  const shim = (aux: string, name: string, text: string): string => {
    fs.mkdirSync(path.join(aux, 'bin'), { recursive: true });
    const f = path.join(aux, 'bin', name);
    fs.writeFileSync(f, text, { mode: 0o755 });
    return f;
  };
  const sleepMs = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  /** A pid kill -0 answers alive for although it ended: a child of a process that never waits for it. */
  const zombiePid = (aux: string): number => {
    const f = path.join(aux, 'zpid');
    // The parent's pid is the outer shell's `$!` (the subshell that execs sleep): /bin/bash 3.2 has no $BASHPID.
    spawnSync('bash', ['-c', `( sh -c 'exit 0' & echo $! > '${f}'; exec sleep 600 ) </dev/null >/dev/null 2>&1 & echo $! > '${f}.parent'`]);
    for (let i = 0; i < 300; i++) {
      if (fs.existsSync(`${f}.parent`)) {
        // an empty (half-written) file reads as 0, and kill(0) is the whole process group — only a real pid goes in
        const parent = Number(fs.readFileSync(`${f}.parent`, 'utf8').trim());
        if (Number.isInteger(parent) && parent > 1 && !killPids.includes(parent)) killPids.push(parent);
      }
      if (fs.existsSync(f) && fs.existsSync(`${f}.parent`)) {
        const z = Number(fs.readFileSync(f, 'utf8'));
        if (/Z/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(z)], { encoding: 'utf8' }).stdout)) return z;
      }
      sleepMs(50);
    }
    throw new Error('no zombie');
  };
  /** The base a killed supervisor left: it took the lock and was killed (SIGKILL), so its EXIT never ran. */
  const killedHolder = (base: string): string => {
    bashLib(base, 'product_lock_acquire t || exit 9\nkill -9 $$', {});
    return fs.readFileSync(path.join(lockOf(base), 'owner'), 'utf8');
  };
  const liveRecord = (): string => recordText({ pid: liveProcess(), startedAt: isoNow() });
  /** The §2 cell's fixture (setup of the form) with the failure's interference added. */
  const onForm = (form: Form, obs: Obs, base: string, caller: Caller, extra: Partial<Fixture> & { env?: Record<string, string> }): Fixture => {
    const fx = makeFixture(form, obs, base, caller);
    return { ...fx, ...extra, env: { ...fx.env, ...(extra.env ?? {}) }, asForm: { form, obs } };
  };
  const callerIsRelease = (c: Caller): boolean => c === 'release-main';

  /** a put-back stopped half way (an empty <lock>) while the dead record is still aside */
  const f34Fixture = (base: string, caller: Caller, fault: string): Fixture => {
    const fx = makeFixture('aside', 'gone', base, caller);
    fs.mkdirSync(lockOf(base), { recursive: true });
    return { ...fx, env: { CM_VERIFY_TEST_OBS_FAULT: fault } };
  };

  type SpecFn = (base: string, caller: ReachableCaller, aux: string) => Fixture;
  const SPECS: Record<Failure, SpecFn | undefined> = {
    'F1-kill0-eperm': (base) => ({ env: { CM_VERIFY_TEST_OBS_FAULT: KILL0_EPERM }, before: writeLock(base, recordText({ pid: 1, startedAt: isoNow() })) }),
    'F2-kill0-other': (base, caller): Fixture =>
      callerIsRelease(caller)
        ? { env: {}, takeFirst: true, afterAcquire: 'export CM_VERIFY_TEST_OBS_FAULT=pid=EIO' }
        : { env: { CM_VERIFY_TEST_OBS_FAULT: 'pid=EIO' }, before: writeLock(base, liveRecord()) },
    'F3-kill0-self-flips': (_base, _caller, aux) => {
      // the first kill -0 (the release's check of $$) says EIO, the next one tells the truth
      const cmd = shim(aux, 'kill0flip', `#!/bin/bash\nf="${aux}/count"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n >"$f"\nif [ "$n" = 1 ]; then echo "kill: ($3) - Input/output error" >&2; exit 1; fi\nkill -0 -- "$3"\n`);
      return { env: {}, takeFirst: true, afterAcquire: `export CM_VERIFY_TEST_KILL0_CMD='${cmd}'` };
    },
    'F4-zombie-holder': (base, _caller, aux) => ({ env: {}, before: writeLock(base, recordText({ pid: zombiePid(aux), startedAt: isoNow() })) }),
    'F5-holder-killed': (base) => ({ env: {}, before: killedHolder(base) }),
    'F6-ps-lstart-judge': (base) => {
      const pid = liveProcess();
      return { env: { CM_VERIFY_TEST_OBS_FAULT: 'lstart=EIO' }, before: writeLock(base, recordText({ pid, startedAt: isoNow(), lstart: lstartOf(pid) })) };
    },
    'F7-ps-lstart-at-write': (base) => ({ env: {}, before: writeLock(base, recordText({ pid: liveProcess(), startedAt: isoNow(), lstart: '' })) }),
    'F8-tz-differs': (base) => {
      const pid = liveProcess();
      return { env: { TZ: 'Pacific/Auckland' }, bashPre: PIN_CLOCK, before: writeLock(base, recordText({ pid, startedAt: isoNow(), lstart: pidLstart(pid, 'UTC') })) };
    },
    'F9-started-at-missing': (base) => {
      const pid = liveProcess();
      return { env: { TZ: 'Pacific/Auckland' }, before: writeLock(base, recordText({ pid, lstart: pidLstart(pid, 'UTC') })) };
    },
    'F10-hostname-changed': (base) => ({ env: {}, before: writeLock(base, recordText({ pid: liveProcess(), host: 'some-other-host.invalid', startedAt: isoNow() })) }),
    'F11-mkdir-lock': () => ({ env: { CM_VERIFY_TEST_OBS_FAULT: 'mkdir-lock=EIO' } }),
    'F12-owner-create-exists': (_base, _caller, aux) => {
      // another taker's owner is published between this acquisition's mkdir and its own link
      const text = liveRecord();
      fs.writeFileSync(path.join(aux, 'rec'), text);
      return {
        env: {},
        bashPre: `lock_test_pause() { if [ "$1" = owner-lock-made ]; then cp '${aux}/rec' "$LOCK_PATH/owner"; fi; }\n`,
        planted: { [LOCK_NAME]: '', [`${LOCK_NAME}/owner`]: text },
      };
    },
    'F13-owner-create-open': () => ({ env: { CM_VERIFY_TEST_OBS_FAULT: 'owner-create=EACCES' } }),
    'F14-owner-write-or-readback': () => ({ env: { CM_VERIFY_TEST_HANDOFF: 'fault:owner-write' } }),
    'F15-owner-unlink': () => ({ env: { CM_VERIFY_TEST_HANDOFF: 'fault:owner-write,fault:owner-unlink' } }),
    'F16-lock-rmdir': () => ({ env: { CM_VERIFY_TEST_HANDOFF: 'fault:owner-write,fault:lock-rmdir' } }),
    'F17-killed-mid-owner': (base) => ({ env: {}, before: writeLock(base, `pid=${liveProcess()}\nhost=${os.hostname()}\n`) }),
    'F18-old-tmp-left': (base) => {
      fs.mkdirSync(lockOf(base), { recursive: true });
      fs.writeFileSync(path.join(lockOf(base), 'owner.tmp.4242'), 'pid=4242\n');
      return { env: {} };
    },
    'F19-owner-read': (base, caller): Fixture =>
      callerIsRelease(caller)
        ? { env: {}, takeFirst: true, afterAcquire: 'export CM_VERIFY_TEST_OBS_FAULT=release-owner=EIO' }
        : { env: { CM_VERIFY_TEST_OBS_FAULT: 'lock-owner=EIO' }, before: writeLock(base, liveRecord()) },
    'F20-gone-listing': (base, caller) =>
      caller === 'guard-head'
        ? // the failing listing of the moved-aside records does not change what the guard does with a dead record
          onForm('other-plain', 'gone', base, caller, { env: { CM_VERIFY_TEST_OBS_FAULT: 'list-root=EIO' } })
        : { env: { CM_VERIFY_TEST_OBS_FAULT: 'list-root=EIO' } },
    'F21-ownerless-rmdir': (base) => {
      fs.mkdirSync(lockOf(base), { recursive: true });
      spawnSync('touch', ['-t', OLD, lockOf(base)]);
      return { env: { CM_VERIFY_TEST_OBS_FAULT: 'ownerless-rmdir=EIO' } };
    },
    'F22-rename-aside-enoent': (base) => ({
      // someone removes the lock just as this caller moves it aside
      env: {},
      bashPre: `${orig('lock_obs_mv')}lock_obs_mv() { if [ "$1" = rename-aside ]; then rm -rf "$2"; fi; orig_lock_obs_mv "$@"; }\n`,
      before: writeLock(base, recordText({ pid: deadPid(), startedAt: isoNow() })),
    }),
    'F23-rename-aside-other': (base) => ({
      env: { CM_VERIFY_TEST_OBS_FAULT: 'rename-aside=EIO' },
      before: writeLock(base, recordText({ pid: deadPid(), startedAt: isoNow() })),
    }),
    'F24-recover-restore-mkdir': (base, _caller, aux) => {
      // a successor took the lock after the dead record was judged: moved aside it is not the judged token, so it is put back —
      // and the put-back's mkdir fails
      const successor = recordText({ pid: liveProcess(), token: 'succ-token', startedAt: isoNow() });
      fs.writeFileSync(path.join(aux, 'succ'), successor);
      writeLock(base, recordText({ pid: deadPid(), startedAt: isoNow() }));
      return {
        env: { CM_VERIFY_TEST_OBS_FAULT: 'restore-mkdir=EIO' },
        bashPre: `${orig('lock_obs_mv')}lock_obs_mv() { if [ "$1" = rename-aside ]; then cp '${aux}/succ' "$2/owner"; fi; orig_lock_obs_mv "$@"; }\n`,
        aside: successor,
      };
    },
    'F25-settle-restore-mkdir': (base, caller) => ({ ...makeFixture('aside', 'alive', base, caller), env: { CM_VERIFY_TEST_OBS_FAULT: 'restore-mkdir=EIO' } }),
    'F26-restore-rename': (base, caller) => ({ ...makeFixture('aside', 'alive', base, caller), env: { CM_VERIFY_TEST_OBS_FAULT: 'restore-rename=EIO' } }),
    'F27-rm-gone': (base) => ({
      env: {},
      // the `rm -rf` of the dead record moved aside fails (|| true): the record stays aside, dead
      bashPre: 'rm() { case "$*" in *.gone-*) return 1;; esac; command rm "$@"; }\n',
      before: writeLock(base, recordText({ pid: deadPid(), startedAt: isoNow() })),
      goneLeft: true,
    }),
    'F28-rm-release-held': () => ({ env: {}, takeFirst: true, afterAcquire: 'rm() { case "$*" in *supervisor.lock*) return 1;; esac; command rm "$@"; }' }),
    'F29-ticket-ln': () => ({
      env: {},
      bashPre: 'ln() { case "$*" in *supervisor.queue*) echo "ln: $2: Permission denied" >&2; return 1;; esac; command ln "$@"; }\n',
    }),
    'F30-queue-list': (_base, caller, aux): Fixture =>
      caller === 'guard-head'
        ? {
            // the publish of the ticket lists the queue twice before the head check: only from the third listing on it fails
            env: {},
            bashPre: `${orig('lock_obs_list')}lock_obs_list() { if [ "$1" = list-queue ]; then n=$(cat '${aux}/n' 2>/dev/null || echo 0); n=$((n+1)); echo $n >'${aux}/n'; if [ $n -ge 3 ]; then CM_VERIFY_TEST_OBS_FAULT=list-queue=EIO orig_lock_obs_list "$@"; return; fi; fi; orig_lock_obs_list "$@"; }\n`,
          }
        : { env: { CM_VERIFY_TEST_OBS_FAULT: 'list-queue=EIO' } },
    'F31-mark-done': (base, caller) => {
      const stay = 'lock_mark_done() { return 1; }\n';
      // the guard meets the dead record of other-plain × gone (the table's row says what is left)
      if (caller === 'guard-head') return onForm('other-plain', 'gone', base, caller, { bashPre: stay });
      return { env: {}, bashPre: stay };
    },
    'F32-ps-etime': (_base, _caller, aux) => {
      // the process of the ticket ahead started after the ticket was made (reused pid) — unless ps cannot say when
      const ps = shim(aux, 'ps', '#!/bin/bash\ncase "$*" in *etime*) exit 1;; esac\nexec /bin/ps "$@"\n');
      void ps;
      return { env: { PATH: `${path.join(aux, 'bin')}:${process.env.PATH ?? ''}` }, ahead: { createdAt: 1000 } };
    },
    'F33-loader': undefined,
    'F34a-reclaim-rmdir': (base, caller) => f34Fixture(base, caller, 'reclaim-rmdir=EIO'),
    // the rename of the dead record fails after the empty <lock> was taken out
    // the dead record stays aside (goneLeft) until the next head
    'F34b-reclaim-rename': (base, caller) => ({ ...f34Fixture(base, caller, 'reclaim-rename=EIO'), goneLeft: true }),
  };

  function driveFailure(key: Failure, caller: ReachableCaller): void {
    const outcome = (FAILURE_TABLE[key].callers as Record<string, Outcome<Caller>>)[caller];
    const base = mkTmp('cm-sup-lock-');
    const aux = mkTmp('cm-sup-aux-');
    const spec = SPECS[key];
    if (spec === undefined) throw new Error(`no driver for ${key}`);
    const fx = spec(base, caller, aux);
    const cell = ('asForm' in outcome ? (TABLE as Table)[fx.asForm?.form as Form][caller][fx.asForm?.obs as Obs] : outcome) as Row<Caller>;
    const d = runWith(caller, base, fx);
    assertOutcome(cell, d, caller, `${key} × ${caller}`);
  }

  /** F33: the machine lock did not load. */
  function driveLoader(caller: ReachableCaller): void {
    const outcome = (FAILURE_TABLE['F33-loader'].callers as Record<string, Outcome<Caller>>)[caller] as Row<Caller>;
    const tree = mkTmp('cm-sup-tree-');
    for (const rel of ['scripts/agent-health/product/lib.sh', 'scripts/agent-health/product/ledger.py', 'scripts/lib/port-pids.sh', 'scripts/lib/machine-lock.sh', 'scripts/uat/run-lock.sh', '.claude/skills/cmate-verify/scripts/verify-run.sh']) {
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(tree, rel));
    }
    const bad = path.join(tree, 'markers-twice.sh');
    fs.writeFileSync(bad, `${fs.readFileSync(VERIFY_RUN_SH, 'utf8')}\n# --- machine-wide gate lock\n`);
    const base = mkTmp('cm-sup-lock-');
    const fx: Fixture = { env: { MACHINE_LOCK_VERIFY_RUN: bad } };
    if (caller.endsWith('behind')) placeTicketAhead(base);
    const beforeSnap = snap(base);
    const res = bashLib(base, callBody(caller, fx, base), fx.env, path.join(tree, 'scripts/agent-health/product/lib.sh'));
    assertOutcome(outcome, { ran: parseReport(res.stdout, res.stderr, base), fx, base, beforeSnap }, caller, `F33-loader × ${caller}`);
  }

  for (const o of FAILURE_OUTCOMES) {
    const out = 'asForm' in o.outcome ? 'as the §2 cell' : `${o.outcome.result}${o.outcome.message ? ` (${o.outcome.message})` : ''} / ${o.outcome.lock} / ticket ${o.outcome.ticket}`;
    const title = `${o.failure} × ${o.caller}: ${FAILURE_TABLE[o.failure].direction} → ${out}`;
    if (!HAS_TOOLS) {
      it.todo(`${title} — needs ps and hostname`);
    } else if (o.failure === 'F33-loader') {
      it(title, () => driveLoader(o.caller), 60_000);
    } else {
      it(title, () => driveFailure(o.failure, o.caller), 60_000);
    }
  }
});

describe('Issue #4288 PR1c lib.sh details the tables do not name (PM Claude P3-2/3/4/5/7, codex P3-2)', () => {
  const kv = (text: string | undefined, key: string): string | undefined => text?.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

  it('an own record carries label, lstart (D7), started_at and v=1, and no pgid (S7) — a lstart that goes missing is red', () => {
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(base, `product_lock_acquire mylabel; rc=$?\n${REPORT}`, {});
    const ran = parseReport(res.stdout, res.stderr, base);
    expect(ran.result).toBe('acquired');
    const owner = lockOwnerText(base);
    expect(kv(owner, 'label')).toBe('mylabel');
    expect(owner).toMatch(LSTART_LINE);
    expect(kv(owner, 'started_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(kv(owner, 'v')).toBe('1');
    expect(owner).not.toContain('pgid=');
  });

  it('LOCK_OWNER_EXTRA is set after the section is loaded: a value from the environment is not inherited, lstart= is in the record (PR1a-f clears it at load)', () => {
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(base, `product_lock_acquire real; rc=$?\n${REPORT}`, { LOCK_OWNER_EXTRA: 'lstart=from-the-environment\nlabel=env' });
    expect(parseReport(res.stdout, res.stderr, base).result).toBe('acquired');
    const owner = lockOwnerText(base);
    expect(kv(owner, 'label')).toBe('real');
    expect(owner).toMatch(LSTART_LINE);
    expect(owner).not.toContain('from-the-environment');
  });

  it('S2: the acquisition has a budget of 0 — behind a live ticket it answers at once, not after a wait', () => {
    const base = mkTmp('cm-sup-lock-');
    placeTicketAhead(base);
    const res = bashLib(base, `t0=$(lock_now_ms); product_lock_acquire t; rc=$?; t1=$(lock_now_ms)\n${REPORT}\necho "MS=$((t1 - t0))"`, {});
    const ran = parseReport(res.stdout, res.stderr, base);
    expect(ran.result).toBe('refused');
    expect(ran.kind).toBe('queue');
    const ms = Number((res.stdout.split('\n').find((l) => l.startsWith('MS=')) ?? 'MS=999999').slice(3));
    expect(ms, 'a budget of 2 s would wait 2000 ms or more').toBeLessThan(1500);
  });

  it("S10: every call puts the section's options down again — values left by another caller in the same shell do not leak in", () => {
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(
      base,
      `LOCK_WANT_TOKEN=bogus-token LOCK_OWNER_PID=1 LOCK_PENDING_TOKEN=pending LOCK_OWNER_EXTRA='label=zzz' LOCK_OWNERLESS_GRACE_MS=1\nproduct_lock_acquire t; rc=$?\n${REPORT}\necho "SELF=$$"`,
      {},
    );
    const ran = parseReport(res.stdout, res.stderr, base);
    expect(ran.result, res.stderr).toBe('acquired');
    const owner = lockOwnerText(base);
    expect(kv(owner, 'token')).not.toBe('bogus-token');
    expect(kv(owner, 'pid')).toBe((res.stdout.split('\n').find((l) => l.startsWith('SELF=')) ?? '').slice(5));
    expect(kv(owner, 'label')).toBe('t');
  });

  it("S10 (release): the release puts the section's options down again too — a codec another caller left in the shell does not make it miss its own record", () => {
    const base = mkTmp('cm-sup-lock-');
    const res = bashLib(
      base,
      `product_lock_acquire t || exit 9\nlock_parse_owner_text() { LPO_PID=""; LPO_HOST=""; LPO_TOKEN=""; LPO_PGID=""; LPO_LSTART=""; LPO_STARTED_AT=""; LPO_V=""; }\nLOCK_OWNER_CODEC=other\nproduct_lock_release; rc=$?\n${REPORT}`,
      {},
    );
    const ran = parseReport(res.stdout, res.stderr, base);
    expect(ran.result, res.stderr).toBe('released');
    expect(fs.existsSync(path.join(base, 'supervisor.lock')), 'the lock is gone').toBe(false);
  });

  it("I3's grace is lib.sh's own constant: changing I4's (0-byte owner) grace does not move the grace of an owner-less <lock>", () => {
    const lib = codeLines(fs.readFileSync(LIB_SH, 'utf8')).join('\n');
    expect(lib).toMatch(/^PRODUCT_LOCK_OWNERLESS_GRACE_MS=600000$/m);
    expect(lib).toContain('LOCK_OWNERLESS_GRACE_MS=$PRODUCT_LOCK_OWNERLESS_GRACE_MS');
    expect(lib).not.toContain('LOCK_EMPTY_OWNER_GRACE_MS');
    const base = mkTmp('cm-sup-lock-');
    fs.mkdirSync(path.join(base, 'supervisor.lock'));
    const res = bashLib(base, `LOCK_EMPTY_OWNER_GRACE_MS=1\nsleep 0.1\nproduct_lock_acquire t; rc=$?\n${REPORT}`, {});
    const ran = parseReport(res.stdout, res.stderr, base);
    expect(ran.result, 'a fresh empty <lock> is young whatever I4 says').toBe('refused');
    expect(ran.kind).toBe('taking');
  });

  it('PRODUCT_LOCK_KIND is emptied by every call: a refusal does not leave its kind to a later success, rejection or release', () => {
    const base = mkTmp('cm-sup-lock-');
    fs.mkdirSync(path.join(base, 'supervisor.lock'));
    fs.writeFileSync(path.join(base, 'supervisor.lock', 'owner'), `pid=${liveProcess()}\n`);
    const res = bashLib(
      base,
      `product_lock_acquire t; echo "A=$PRODUCT_LOCK_KIND"\nproduct_lock_acquire; echo "B=$PRODUCT_LOCK_KIND $PRODUCT_LOCK_RESULT"\nproduct_lock_recover_only; echo "C=$PRODUCT_LOCK_KIND"\nproduct_lock_release; echo "D=$PRODUCT_LOCK_KIND"\nrm -rf "${base}/supervisor.lock"\nproduct_lock_acquire t; echo "E=$PRODUCT_LOCK_KIND $PRODUCT_LOCK_RESULT"\nproduct_lock_release; echo "F=$PRODUCT_LOCK_KIND $PRODUCT_LOCK_RESULT"`,
      {},
    );
    expect(res.stdout).toContain('A=corrupt');
    expect(res.stdout).toContain('B= rejected');
    expect(res.stdout).toContain('C=corrupt');
    expect(res.stdout).toContain('D=\n');
    expect(res.stdout).toContain('E= acquired');
    expect(res.stdout).toContain('F= released');
  });

  it("F17 (PR1a-f I4): a 0-byte owner past the grace is the head's to take out; within it, and a half-written one, are told and kept", () => {
    const empty = (old: boolean): string => {
      const base = mkTmp('cm-sup-lock-');
      fs.mkdirSync(path.join(base, 'supervisor.lock'));
      fs.writeFileSync(path.join(base, 'supervisor.lock', 'owner'), '');
      if (old) spawnSync('touch', ['-t', OLD, path.join(base, 'supervisor.lock', 'owner')]);
      return base;
    };
    const acquire = (base: string): Ran => {
      const res = bashLib(base, `product_lock_acquire t; rc=$?\n${REPORT}`, {});
      return parseReport(res.stdout, res.stderr, base);
    };
    const guard = (base: string): Ran => {
      const res = bashLib(base, `product_lock_recover_only; rc=$?\n${REPORT}`, {});
      return parseReport(res.stdout, res.stderr, base);
    };
    const a = acquire(empty(true));
    expect(a.result).toBe('acquired');
    const gBase = empty(true);
    expect(guard(gBase).result).toBe('removed');
    expect(fs.existsSync(path.join(gBase, 'supervisor.lock'))).toBe(false);
    const young = empty(false);
    const y = acquire(young);
    expect(y.result).toBe('refused');
    expect(y.kind).toBe('corrupt');
    expect(y.error).toContain('is empty');
    expect(y.error).not.toContain('by hand');
    expect(lockOwnerText(young)).toBe('');
    const yg = guard(young);
    expect(yg.result).toBe('kept');
    expect(yg.kind).toBe('corrupt');
  });

  it('ownerless-tmp (PR1a-f I3): the young tmp is told without a "by hand" order that is false for it', () => {
    const base = mkTmp('cm-sup-lock-');
    fs.mkdirSync(path.join(base, 'supervisor.lock'));
    fs.writeFileSync(path.join(base, 'supervisor.lock', 'owner.tmp.4242'), 'pid=4242\n');
    const res = bashLib(base, `product_lock_acquire t; rc=$?\n${REPORT}`, {});
    const ran = parseReport(res.stdout, res.stderr, base);
    expect(ran.kind).toBe('tmp');
    expect(ran.error).toContain('PR1a-f I3');
    expect(ran.error).not.toMatch(/not taken; remove .* by hand/);
  });

  it('F32 positive control: without the failing etime, the process of the ticket ahead started after the ticket was made — the ticket is retired and the lock taken', () => {
    const base = mkTmp('cm-sup-lock-');
    placeTicketAhead(base, 1000);
    const res = bashLib(base, `product_lock_acquire t; rc=$?\n${REPORT}`, {});
    const ran = parseReport(res.stdout, res.stderr, base);
    expect(ran.result, res.stderr).toBe('acquired');
  });

  // codex P3-1 / PM Claude P3-1: the guard turns `absent` into `kept` only for a moved-aside record, and its message follows the converted result
  it.skipIf(!HAS_TOOLS)('F20 × guard-head, absent form: a failed listing of the directory holds nothing — absent, no kept, no message (as the §2 cell)', () => {
    const base = mkTmp('cm-sup-lock-');
    const d = runWith('guard-head', base, { env: { CM_VERIFY_TEST_OBS_FAULT: 'list-root=EIO' } });
    expect(d.ran.result).toBe('absent');
    expect(d.ran.kind).toBe('');
    expect(d.ran.error).toBe('');
    expect(d.ran.rc).toBe(0);
  }, 60_000);

  it.skipIf(!HAS_TOOLS)('F20 × guard-head, aside form: a moved-aside record that cannot be read is kept, and the guard says unk', () => {
    const base = mkTmp('cm-sup-lock-');
    const fx = makeFixture('aside', 'gone', base, 'guard-head');
    const d = runWith('guard-head', base, { ...fx, env: { ...fx.env, CM_VERIFY_TEST_OBS_FAULT: 'gone-lstat=EIO' } });
    expect(d.ran.result).toBe('kept');
    expect(d.ran.kind).toBe('unk');
    expect(d.ran.error).toContain('cannot be judged');
  }, 60_000);
});
