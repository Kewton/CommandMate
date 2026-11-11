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
 * Nothing here calls the implementation: every behaviour row is an `it.todo`, and the implementation
 * contract of PR1c turns them red → green (scripts/agent-health/product/lib.sh, deadline-guard.sh).
 * What runs now is the tables checking themselves against the invariants of §1, the code's result sets,
 * and the counts written in the design.
 *
 * How the implementation will drive a row (for the implementation contract, not run here):
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
    alive: 'not observed: <lock> has no owner and holds owner.tmp.<pid> of the old version (never taken; a person removes it)',
    gone: 'not observed (the pid in the tmp name is not read)',
    unknown: 'not observed',
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
  'ownerless-tmp': personOnly('tmp'),
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
    point: 'rm -f <lock>/owner after F13/F14 (fault:owner-unlink)',
    errno: 'any',
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
    point: 'the acquirer dies between `: >owner` and `cat >>owner` (lock_obs_create)',
    errno: '— (SIGKILL, power loss): an empty or half owner is left — a corrupt form',
    direction: 'keep',
    callers: { 'acquire-head': refused('corrupt'), 'guard-head': gKept('corrupt') },
    excluded: { ...BEHIND, ...NO_RELEASE },
  }),
  'F18-old-tmp-left': failure({
    point: 'the old version died between its mkdir and mv: <lock>/owner.tmp.<pid> only',
    errno: '— (ownerless-tmp form)',
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
      'guard-head': AS_FORM,
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
      'acquire-head': refused('loader'),
      'acquire-behind': refused('loader'),
      'guard-head': r('unloaded', 'unchanged', 'none-taken', 'loader'),
      'guard-behind': r('unloaded', 'unchanged', 'none-taken', 'loader'),
      'release-main': NONE,
    },
    excluded: { 'release-unheld': 'unheld' },
  }),
  'F34-reclaim-rename-or-rmdir': failure({
    point: 'reclaim-rename / reclaim-rmdir (an empty <lock> while a put-back is unknown)',
    errno: 'any',
    direction: 'keep',
    callers: { 'acquire-head': refused('unk'), 'guard-head': gKept('unk') },
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
  failures: 34,
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
    for (const form of ['corrupt', 'ownerless-tmp', 'other-host'] as const) {
      expect(ROWS.filter((r) => r.form === form && r.cell.lock !== 'unchanged')).toEqual([]);
    }
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
        for (const obs of OBS) expect((TABLE as Table)[form as Form][caller][obs]).toMatchObject({ message });
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
    // F5: the holder is dead (KILL); F22: already removed by someone; F27: recovered, only its aside left.
    expect([...new Set(removing)].sort()).toEqual(['F22-rename-aside-enoent', 'F27-rm-gone', 'F31-mark-done', 'F5-holder-killed'].sort());
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

describe.each(CALLERS)('Issue #4288 PR1c behaviour: %s (to implement: lib.sh / deadline-guard.sh)', (caller) => {
  const rows = ROWS.filter((r) => r.caller === caller);
  for (const e of rows) {
    const msg = e.cell.message ? ` (${e.cell.message})` : '';
    it.todo(`${e.form} × ${e.obs} → ${e.cell.result}${msg} / ${e.cell.lock} / ticket ${e.cell.ticket}`);
  }
  if (rows.length === 0) {
    // release-subshell: one rejection row (§5); d5-*: no product path calls D5 (S5).
    it.todo(caller === 'release-subshell' ? 'rejected (release-in-subshell): nothing removed, exit 2' : 'not reached by any product_lock_* (S5)');
  }
});

describe('Issue #4288 PR1c rejections (design §5, to implement)', () => {
  for (const k of Object.keys(REJECTIONS) as RejectionKey[]) {
    it.todo(`${k}: ${REJECTIONS[k].fn} with ${REJECTIONS[k].check} → rejected (exit 2), nothing touched`);
  }
});

describe('Issue #4288 PR1c loader rows: the PR1b ↔ PR1c contract (design §5.2, to implement)', () => {
  for (const [k, v] of Object.entries(LOADER_ROWS)) {
    it.todo(`${k}: ${v.setup} → loads ${v.loads}, acquire ${v.acquire}, guard ${v.guard}`);
  }
});

describe('Issue #4288 PR1c failure outcomes (design §3, to implement)', () => {
  for (const o of FAILURE_OUTCOMES) {
    const out = 'asForm' in o.outcome ? 'as the §2 cell' : `${o.outcome.result}${o.outcome.message ? ` (${o.outcome.message})` : ''} / ${o.outcome.lock} / ticket ${o.outcome.ticket}`;
    it.todo(`${o.failure} × ${o.caller}: ${FAILURE_TABLE[o.failure].direction} → ${out}`);
  }
});
