/**
 * Issue #4288 PR1a-f — the owner written atomically (tmp → link(2)), the owner-less <lock> holding only
 * temporaries taken out by a graced head through a predicate of its own (the new `.owner-*` by age, the
 * older run-lock / supervisor.lock `owner.tmp.<pid>` only once that pid is gone), an empty owner taken
 * out by the head past a fixed grace, an unparsable owner named and never removed, and D7's reuse
 * check made independent of the time zone and of the clock (machine_lock_pid_identity: the lstart
 * difference is not a time-zone offset AND etime's start is after started_at). Design:
 * docs/design/machine-lock-owner-atomic-4288.md (upstream round 2).
 *
 * UPSTREAM SKELETON (the design stage). This file holds the tables of §2 (T: implementation × owner
 * form × caller × three-valued observation → result; K: the interruption points of an acquisition ×
 * implementation → the form left and who takes it out) and §3 (F: the failures of the external calls,
 * typed by implementation, caller, point, direction, result and the lock left), built from
 * enumerations so that a cell left out (or one too many) fails the typecheck (`satisfies`).
 *
 * The three implementations' tables are written out separately (BASH_T / SYNC_T / TS_T, BASH_K /
 * SYNC_K / TS_K), never one object listed three times, and each is compared with an expectation
 * computed from the invariants of §1 (`ruleT`, `todayT`, `ruleK`) and with the others — so a wrong
 * cell in one implementation's table is caught (round 1's KILL_TABLE compared an object with itself).
 *
 * Nothing here calls the implementation yet: every behaviour row is an `it.todo`, and the
 * implementation contract of PR1a-f turns them red → green (verify-run.sh's lock section,
 * scripts/lib/machine-lock.sh, scripts/orchestrate/machine-lock-sync.mjs,
 * src/lib/verification/machine-lock.ts). What runs now is the tables checking themselves against the
 * invariants, and the time-zone witness of §4 on plain numbers.
 *
 * Counts (written in the design §2.5): T 3 implementations × 17 forms × 4 callers × 3 observations =
 * 612 cells, 270 unreachable, 342 rows; K 5 points × 3 implementations = 15 rows; F 46 rows. 403 rows.
 *
 * How the implementation will drive a row (for the implementation contract, not run here):
 *   - a root from fs.mkdtempSync under os.tmpdir(), removed in afterEach; nothing under ~/.commandmate,
 *     no server, no tmux;
 *   - the form written into `<root>/x.lock` (temporaries named `.owner-<token>` / `owner.tmp.<pid>`,
 *     ages with fs.utimesSync, a kv record with lstart= / started_at= for the D7 forms), the
 *     observation made real (a live `sleep`, a dead pid, the test's own lstart under another TZ=) or
 *     injected (CM_VERIFY_TEST_OBS_FAULT=<point>=<ERRNO>, a `ps` shim on PATH, hooks.fault);
 *   - graced callers with LOCK_OWNERLESS_GRACE_MS / ownerlessGraceMs = 60000;
 *   - `acquire-behind`: a live ticket of another pid placed ahead in the queue;
 *   - K: the pauses of §2.6 (bash `CM_VERIFY_TEST_HANDOFF=pause:<stage>`, sync `hooks.onOwnerStage`,
 *     TS `__testHooks.onOwnerStage`), then SIGKILL;
 *   - positive controls: the current implementation (develop fd2f4a589) gives the `now` of a row.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

// ------------------------------------------------------------------ enumerations (§2.1)

const IMPLS = ['bash', 'sync', 'ts'] as const;
type Impl = (typeof IMPLS)[number];

const FORMS = [
  'empty-dir',
  'tmp-new',
  'tmp-old-young',
  'tmp-old',
  'tmp-stray',
  'tmp-new+gone-dead',
  'tmp-new+gone-alive',
  'empty-owner',
  'garbage-owner',
  'lstart-match',
  'lstart-tz',
  'lstart-reused',
  'lstart-fails',
  'etime-fails',
  'lstart-same-etime-fails',
  'lstart-legacy',
  'lstart-legacy-reused',
] as const;
type Form = (typeof FORMS)[number];

/** The forms judged by D7 (a kv record with an lstart= line): only the bash loader's callers read them. */
const D7_FORMS = [
  'lstart-match',
  'lstart-tz',
  'lstart-reused',
  'lstart-fails',
  'etime-fails',
  'lstart-same-etime-fails',
  'lstart-legacy',
  'lstart-legacy-reused',
] as const satisfies readonly Form[];
type D7Form = (typeof D7_FORMS)[number];
const isD7 = (form: Form): form is D7Form => (D7_FORMS as readonly Form[]).includes(form);

const CALLERS = ['acquire-head-grace', 'acquire-head-nograce', 'acquire-behind', 'guard-head'] as const;
type Caller = (typeof CALLERS)[number];

const OBS = ['alive', 'gone', 'unknown'] as const;
type Obs = (typeof OBS)[number];

/** The kind of a refusal's wording. corrupt, stray and old-taker are new (I3, I4). */
const MESSAGES = ['rec', 'taking', 'queue', 'unk', 'corrupt', 'stray', 'old-taker'] as const;
type Message = (typeof MESSAGES)[number];

type AcquireCode = 'acquired' | `refused:${Message}`;
type GuardCode = 'removed' | 'kept';
/** What a caller can answer (lock_acquire_path's 0/1 with its wording, LRO_RESULT / recoverIfDead). */
type CodeOf<C extends Caller> = C extends 'guard-head' ? GuardCode : C extends 'acquire-behind' ? 'refused:queue' : AcquireCode;
type Code = AcquireCode | GuardCode;

const UNREACHABLE_REASONS = {
  'd7-bash-only': 'D7 is in the bash loader only: no JS caller reads a kv record with lstart= (I6)',
  'no-kv-for-nograce':
    "the callers without a grace (verify gate, merge-pr, precheck, gate-runner) keep JSON owners at their own paths and do not load the loader's D7",
  'ts-no-grace': 'the TS implementation has no ownerlessGraceMs (I6: no caller, no combination)',
  'ts-no-guard': 'the TS implementation has no D6 guard (recoverIfDead is sync JS / bash)',
} as const;
type Reason = keyof typeof UNREACHABLE_REASONS;

interface Changed<C extends Caller> {
  readonly is: CodeOf<C>;
  /** The result (with its wording) of the implementation before PR1a-f: the positive control. */
  readonly now: CodeOf<C>;
}
interface Unreachable {
  readonly unreachable: Reason;
}
type Cell<C extends Caller> = CodeOf<C> | Changed<C> | Unreachable;
/** alive / gone / unknown */
type Triple<C extends Caller> = readonly [Cell<C>, Cell<C>, Cell<C>];
type TableT = { readonly [F in Form]: { readonly [C in Caller]: Triple<C> } };

/** What the decisive observation of each form is, per value (§2.1). */
const AGE = {
  alive: 'the <lock> (and every temporary in it) is 60 s old or younger',
  gone: 'older than 60 s (fs.utimesSync)',
  unknown: 'the listing, an lstat, an mtime or the owner read fails (lock-list / ownerless-tmp-lstat / ownerless-mtime / lock-owner = EIO)',
} as const;
const NAME_PID = {
  alive: 'the pid in owner.tmp.<pid> answers kill -0 (a live sleep: an older writer stopped past the grace)',
  gone: 'ESRCH',
  unknown: 'EPERM (CM_VERIFY_TEST_KILL0_CMD / hooks.kill)',
} as const;
const KILL0 = {
  alive: 'kill -0 of the recorded pid answers (a live sleep)',
  gone: 'ESRCH',
  unknown: 'EPERM (a process of another user; CM_VERIFY_TEST_KILL0_CMD)',
} as const;
const OBS_MEANING = {
  'empty-dir': AGE,
  'tmp-new': AGE,
  'tmp-old-young': { alive: 'young; the pid is not read (must not matter)', gone: 'young (must not matter)', unknown: 'young (must not matter)' },
  'tmp-old': NAME_PID,
  'tmp-stray': AGE,
  'tmp-new+gone-dead': AGE,
  'tmp-new+gone-alive': { alive: 'the canonical age is not read (must not matter)', gone: 'not read', unknown: 'not read' },
  'empty-owner': { ...AGE, alive: 'the owner is 60 s old or younger (LOCK_EMPTY_OWNER_GRACE_MS)', gone: 'older than 60 s' },
  'garbage-owner': { ...AGE, alive: 'young (must not matter: an unparsable owner is never removed)', gone: 'old (must not matter)' },
  'lstart-match': KILL0,
  'lstart-tz': KILL0,
  'lstart-reused': KILL0,
  'lstart-fails': KILL0,
  'etime-fails': KILL0,
  'lstart-same-etime-fails': KILL0,
  'lstart-legacy': KILL0,
  'lstart-legacy-reused': KILL0,
} as const satisfies Record<Form, Record<Obs, string>>;

/** What the form is, for the row's setup. */
const FORM_MEANING = {
  'empty-dir': '<lock> with no owner and nothing in it (K1; D3 as today)',
  'tmp-new': '<lock> holding only `.owner-<token>` (K2 / K3 of the new create, or an undo whose unlink failed: F17)',
  'tmp-old-young': '<lock> holding only `owner.tmp.<pid>` within the grace (an older run-lock.sh:62 / lib.sh:174 writer before its mv)',
  'tmp-old': 'the same past the grace; taken out only when <pid> is gone (codex P1: a stopped older writer resuming would rm -rf a successor)',
  'tmp-stray': '<lock> with no owner holding a temporary and a name that is not one (a file `x`, a directory, owner.tmp.abc)',
  'tmp-new+gone-dead':
    'tmp-new in the canonical <lock> and a `.gone-*` whose record is dead: the take-back-half keeps lock_ownerless_empty (no), the cleanup uses lock_ownerless_temps_only (mutation control: widening the shared predicate makes the rmdir ENOTEMPTY and blocks every poll)',
  'tmp-new+gone-alive': 'tmp-new in the canonical <lock> and a `.gone-*` whose record lives: the put-back does not land on the tmp (lock_ownerless_empty stays no)',
  'empty-owner': 'an owner of 0 bytes (an older writer killed between `: >` / openSync and the write, or a power loss after link)',
  'garbage-owner': 'an owner that does not parse',
  'lstart-match': 'kv record with lstart= equal to ps -o lstart= (LC_ALL=C) and started_at= after the start',
  'lstart-tz': 'the same holder, its lstart= written under another TZ= (the naive difference is a whole time-zone offset)',
  'lstart-reused': 'lstart= differs by what is not a time-zone offset and the process under the pid started > started_at= + 2 s',
  'lstart-fails': 'ps -o lstart= fails or prints nothing (CM_VERIFY_TEST_OBS_FAULT=lstart=EIO)',
  'etime-fails': 'lstart= differs (not an offset); ps -o etime= fails or prints a malformed value (etime=EIO, `bad:bad`, `1:99`)',
  'lstart-same-etime-fails': 'lstart= equals ps; etime would fail but is never read',
  'lstart-legacy': 'no started_at= (the older supervisor.lock record), a live holder under another TZ; the owner mtime stands in',
  'lstart-legacy-reused': 'no started_at=, a reused pid started after the owner mtime + 2 s',
} as const satisfies Record<Form, string>;

// ------------------------------------------------------------------ table T, written per implementation (§2.3, §2.4)

const U = <const R extends Reason>(reason: R) => ({ unreachable: reason }) as const;
const UUU = <const R extends Reason>(reason: R) => [U(reason), U(reason), U(reason)] as const;
const Q = ['refused:queue', 'refused:queue', 'refused:queue'] as const;

const BASH_T = {
  'empty-dir': {
    'acquire-head-grace': ['refused:taking', 'acquired', 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': Q,
    'guard-head': ['kept', 'removed', 'kept'],
  },
  'tmp-new': {
    'acquire-head-grace': ['refused:taking', { is: 'acquired', now: 'refused:taking' }, 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': Q,
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'tmp-old-young': {
    'acquire-head-grace': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-behind': Q,
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'tmp-old': {
    'acquire-head-grace': [
      { is: 'refused:old-taker', now: 'refused:taking' },
      { is: 'acquired', now: 'refused:taking' },
      { is: 'refused:unk', now: 'refused:taking' },
    ],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-behind': Q,
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'tmp-stray': {
    'acquire-head-grace': [{ is: 'refused:stray', now: 'refused:taking' }, { is: 'refused:stray', now: 'refused:taking' }, 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': Q,
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'tmp-new+gone-dead': {
    'acquire-head-grace': ['refused:taking', { is: 'acquired', now: 'refused:taking' }, 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': Q,
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'tmp-new+gone-alive': {
    'acquire-head-grace': ['refused:rec', 'refused:rec', 'refused:rec'],
    'acquire-head-nograce': ['refused:rec', 'refused:rec', 'refused:rec'],
    'acquire-behind': Q,
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'empty-owner': {
    'acquire-head-grace': [{ is: 'refused:taking', now: 'refused:rec' }, { is: 'acquired', now: 'refused:rec' }, 'refused:unk'],
    'acquire-head-nograce': [{ is: 'refused:taking', now: 'refused:rec' }, { is: 'acquired', now: 'refused:rec' }, 'refused:unk'],
    'acquire-behind': Q,
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'garbage-owner': {
    'acquire-head-grace': [{ is: 'refused:corrupt', now: 'refused:rec' }, { is: 'refused:corrupt', now: 'refused:rec' }, 'refused:unk'],
    'acquire-head-nograce': [{ is: 'refused:corrupt', now: 'refused:rec' }, { is: 'refused:corrupt', now: 'refused:rec' }, 'refused:unk'],
    'acquire-behind': Q,
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'lstart-match': {
    'acquire-head-grace': ['refused:rec', 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': ['kept', 'removed', 'kept'],
  },
  'lstart-tz': {
    'acquire-head-grace': [{ is: 'refused:rec', now: 'acquired' }, 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': [{ is: 'kept', now: 'removed' }, 'removed', 'kept'],
  },
  'lstart-reused': {
    'acquire-head-grace': ['acquired', 'acquired', { is: 'acquired', now: 'refused:unk' }],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': ['removed', 'removed', { is: 'removed', now: 'kept' }],
  },
  'lstart-fails': {
    'acquire-head-grace': ['refused:unk', 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': ['kept', 'removed', 'kept'],
  },
  'etime-fails': {
    'acquire-head-grace': [{ is: 'refused:unk', now: 'acquired' }, 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': [{ is: 'kept', now: 'removed' }, 'removed', 'kept'],
  },
  'lstart-same-etime-fails': {
    'acquire-head-grace': ['refused:rec', 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': ['kept', 'removed', 'kept'],
  },
  'lstart-legacy': {
    'acquire-head-grace': [{ is: 'refused:rec', now: 'acquired' }, 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': [{ is: 'kept', now: 'removed' }, 'removed', 'kept'],
  },
  'lstart-legacy-reused': {
    'acquire-head-grace': ['acquired', 'acquired', { is: 'acquired', now: 'refused:unk' }],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': ['removed', 'removed', { is: 'removed', now: 'kept' }],
  },
} as const satisfies TableT;

const SYNC_D7 = {
  'acquire-head-grace': UUU('d7-bash-only'),
  'acquire-head-nograce': UUU('d7-bash-only'),
  'acquire-behind': UUU('d7-bash-only'),
  'guard-head': UUU('d7-bash-only'),
} as const;
const SYNC_T = {
  'empty-dir': {
    'acquire-head-grace': ['refused:taking', 'acquired', 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', 'removed', 'kept'],
  },
  'tmp-new': {
    'acquire-head-grace': ['refused:taking', { is: 'acquired', now: 'refused:taking' }, 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'tmp-old-young': {
    'acquire-head-grace': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'tmp-old': {
    'acquire-head-grace': [
      { is: 'refused:old-taker', now: 'refused:taking' },
      { is: 'acquired', now: 'refused:taking' },
      { is: 'refused:unk', now: 'refused:taking' },
    ],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'tmp-stray': {
    'acquire-head-grace': [{ is: 'refused:stray', now: 'refused:taking' }, { is: 'refused:stray', now: 'refused:taking' }, 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'tmp-new+gone-dead': {
    'acquire-head-grace': ['refused:taking', { is: 'acquired', now: 'refused:taking' }, 'refused:unk'],
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'tmp-new+gone-alive': {
    'acquire-head-grace': ['refused:rec', 'refused:rec', 'refused:rec'],
    'acquire-head-nograce': ['refused:rec', 'refused:rec', 'refused:rec'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'empty-owner': {
    'acquire-head-grace': [{ is: 'refused:taking', now: 'refused:rec' }, { is: 'acquired', now: 'refused:rec' }, 'refused:unk'],
    'acquire-head-nograce': [{ is: 'refused:taking', now: 'refused:rec' }, { is: 'acquired', now: 'refused:rec' }, 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', { is: 'removed', now: 'kept' }, 'kept'],
  },
  'garbage-owner': {
    'acquire-head-grace': [{ is: 'refused:corrupt', now: 'refused:rec' }, { is: 'refused:corrupt', now: 'refused:rec' }, 'refused:unk'],
    'acquire-head-nograce': [{ is: 'refused:corrupt', now: 'refused:rec' }, { is: 'refused:corrupt', now: 'refused:rec' }, 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': ['kept', 'kept', 'kept'],
  },
  'lstart-match': SYNC_D7,
  'lstart-tz': SYNC_D7,
  'lstart-reused': SYNC_D7,
  'lstart-fails': SYNC_D7,
  'etime-fails': SYNC_D7,
  'lstart-same-etime-fails': SYNC_D7,
  'lstart-legacy': SYNC_D7,
  'lstart-legacy-reused': SYNC_D7,
} as const satisfies TableT;

const TS_D7 = {
  'acquire-head-grace': UUU('d7-bash-only'),
  'acquire-head-nograce': UUU('d7-bash-only'),
  'acquire-behind': UUU('d7-bash-only'),
  'guard-head': UUU('d7-bash-only'),
} as const;
const TS_NO_GRACE = UUU('ts-no-grace');
const TS_NO_GUARD = UUU('ts-no-guard');
const TS_T = {
  'empty-dir': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'tmp-new': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'tmp-old-young': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'tmp-old': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:taking'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'tmp-stray': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'tmp-new+gone-dead': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': ['refused:taking', 'refused:taking', 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'tmp-new+gone-alive': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': ['refused:rec', 'refused:rec', 'refused:rec'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'empty-owner': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': [{ is: 'refused:taking', now: 'refused:rec' }, { is: 'acquired', now: 'refused:rec' }, 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'garbage-owner': {
    'acquire-head-grace': TS_NO_GRACE,
    'acquire-head-nograce': [{ is: 'refused:corrupt', now: 'refused:rec' }, { is: 'refused:corrupt', now: 'refused:rec' }, 'refused:unk'],
    'acquire-behind': ['refused:queue', 'refused:queue', 'refused:queue'],
    'guard-head': TS_NO_GUARD,
  },
  'lstart-match': TS_D7,
  'lstart-tz': TS_D7,
  'lstart-reused': TS_D7,
  'lstart-fails': TS_D7,
  'etime-fails': TS_D7,
  'lstart-same-etime-fails': TS_D7,
  'lstart-legacy': TS_D7,
  'lstart-legacy-reused': TS_D7,
} as const satisfies TableT;

const T_TABLES: Readonly<Record<Impl, TableT>> = { bash: BASH_T, sync: SYNC_T, ts: TS_T };

// ------------------------------------------------------------------ the expectations, computed from §1 (written apart from the tables)

/** What machine_lock_pid_identity (§4) answers for each D7 form, when kill -0 of the pid is alive or EPERM. */
const IDENTITY_OF = {
  'lstart-match': 'alive',
  'lstart-tz': 'alive',
  'lstart-reused': 'reused',
  'lstart-fails': 'unknown',
  'etime-fails': 'unknown',
  'lstart-same-etime-fails': 'alive',
  'lstart-legacy': 'alive',
  'lstart-legacy-reused': 'reused',
} as const satisfies Record<D7Form, 'alive' | 'reused' | 'unknown'>;

/** Whether the recorded and the current lstart strings differ (what the implementation before PR1a-f compared). */
const LSTART_STRING_DIFFERS = {
  'lstart-match': false,
  'lstart-tz': true,
  'lstart-reused': true,
  'lstart-fails': null,
  'etime-fails': true,
  'lstart-same-etime-fails': false,
  'lstart-legacy': true,
  'lstart-legacy-reused': true,
} as const satisfies Record<D7Form, boolean | null>;

type Expected = Unreachable | { readonly is: Code; readonly now?: Code };

function reach(impl: Impl, form: Form, caller: Caller): Reason | null {
  if (isD7(form) && impl !== 'bash') return 'd7-bash-only';
  if (impl === 'ts' && caller === 'acquire-head-grace') return 'ts-no-grace';
  if (impl === 'ts' && caller === 'guard-head') return 'ts-no-guard';
  if (isD7(form) && caller === 'acquire-head-nograce') return 'no-kv-for-nograce';
  return null;
}

/** The result after PR1a-f, from the invariants I0-b, I3, I4, I5 (not from the tables). */
function ruleT(form: Form, caller: Caller, obs: Obs): Code {
  if (caller === 'acquire-behind') return 'refused:queue'; // I0-b
  const guard = caller === 'guard-head';
  const graced = caller !== 'acquire-head-nograce'; // the graced acquirer and the D6 guard
  const take: Code = guard ? 'removed' : 'acquired';
  const keep = (m: Message): Code => (guard ? 'kept' : `refused:${m}`);
  switch (form) {
    case 'empty-dir':
    case 'tmp-new':
    case 'tmp-new+gone-dead': // I3 through its own predicate; the dead `.gone-*` is reclaimed first
      if (obs === 'unknown') return keep('unk');
      return obs === 'gone' && graced ? take : keep('taking');
    case 'tmp-old-young':
      return keep('taking'); // the age first: the pid is not read
    case 'tmp-old': // I3: only a gone pid of the name lets it go
      if (!graced) return keep('taking');
      return obs === 'gone' ? take : obs === 'alive' ? keep('old-taker') : keep('unk');
    case 'tmp-stray':
      if (obs === 'unknown') return keep('unk');
      return graced ? keep('stray') : keep('taking');
    case 'tmp-new+gone-alive':
      return keep('rec');
    case 'empty-owner': // I4: any head, past the fixed grace, moved aside and checked
      return obs === 'gone' ? take : obs === 'alive' ? keep('taking') : keep('unk');
    case 'garbage-owner': // I4: never removed
      return obs === 'unknown' ? keep('unk') : keep('corrupt');
    default: {
      // I5
      if (obs === 'gone') return take;
      const id = IDENTITY_OF[form];
      if (id === 'reused') return take;
      if (obs === 'unknown') return keep('unk');
      return id === 'alive' ? keep('rec') : keep('unk');
    }
  }
}

/** The result of the implementation before PR1a-f (develop fd2f4a589), from §0 E1-E7. */
function todayT(form: Form, caller: Caller, obs: Obs): Code {
  if (caller === 'acquire-behind') return 'refused:queue';
  const guard = caller === 'guard-head';
  const graced = caller !== 'acquire-head-nograce';
  const take: Code = guard ? 'removed' : 'acquired';
  const keep = (m: Message): Code => (guard ? 'kept' : `refused:${m}`);
  switch (form) {
    case 'empty-dir':
      if (obs === 'unknown') return keep('unk');
      return obs === 'gone' && graced ? take : keep('taking');
    case 'tmp-new':
    case 'tmp-new+gone-dead':
    case 'tmp-stray': // E4: not empty, nobody takes it; the listing failing is unknown
      return obs === 'unknown' ? keep('unk') : keep('taking');
    case 'tmp-old-young':
    case 'tmp-old': // the pid in the name is never read
      return keep('taking');
    case 'tmp-new+gone-alive':
      return keep('rec');
    case 'empty-owner':
    case 'garbage-owner': // E3: corrupt, waited on; the wording is `rec` with the holder missing
      return obs === 'unknown' ? keep('unk') : keep('rec');
    default: {
      // E5, E6: the string compare, only when the original judgement is alive
      if (obs === 'gone') return take;
      if (obs === 'unknown') return keep('unk');
      const differs = LSTART_STRING_DIFFERS[form];
      if (differs === null) return keep('unk');
      return differs ? take : keep('rec');
    }
  }
}

function expectedT(impl: Impl, form: Form, caller: Caller, obs: Obs): Expected {
  const reason = reach(impl, form, caller);
  if (reason) return { unreachable: reason };
  const is = ruleT(form, caller, obs);
  const now = todayT(form, caller, obs);
  return now === is ? { is } : { is, now };
}

function normalize(cell: Cell<Caller>): Expected {
  if (typeof cell === 'string') return { is: cell };
  if ('unreachable' in cell) return { unreachable: cell.unreachable };
  return { is: cell.is, now: cell.now };
}

interface Entry {
  impl: Impl;
  form: Form;
  caller: Caller;
  obs: Obs;
  cell: Expected;
}
const CELLS: Entry[] = IMPLS.flatMap((impl) =>
  FORMS.flatMap((form) =>
    CALLERS.flatMap((caller) =>
      OBS.map((obs, i) => ({ impl, form, caller, obs, cell: normalize((T_TABLES[impl][form][caller] as Triple<Caller>)[i]) })),
    ),
  ),
);
type Reached = Entry & { cell: { readonly is: Code; readonly now?: Code } };
const isReached = (e: Entry): e is Reached => !('unreachable' in e.cell);
const ROWS: Reached[] = CELLS.filter(isReached);
const UNREACHABLE = CELLS.filter((e) => !isReached(e));

const lockAfter = (code: Code): 'mine' | 'absent' | 'unchanged' => (code === 'acquired' ? 'mine' : code === 'removed' ? 'absent' : 'unchanged');

// ------------------------------------------------------------------ table K, written per implementation (§2.6)

const KILL_POINTS = ['K1-after-mkdir', 'K2-tmp-opened', 'K3-tmp-written', 'K4-linked', 'K5-tmp-removed'] as const;
type KillPoint = (typeof KILL_POINTS)[number];

/** The pause each point stops at (the same name in the three implementations; PR1a-f owns them, §2.6). */
const PAUSES = ['owner-lock-made', 'owner-tmp-opened', 'owner-tmp-written', 'owner-linked', 'owner-tmp-removed'] as const;
type Pause = (typeof PAUSES)[number];

type Left = 'empty-dir' | 'tmp-new' | 'complete+tmp' | 'complete';
type By = 'graced-head-after-grace' | 'recover-when-pid-gone' | 'nobody-until-a-human';
interface KillRow {
  readonly pause: Pause;
  readonly left: Left;
  readonly byGraced: By | 'no-grace-caller';
  readonly byNograce: By;
}
type TableK = { readonly [P in KillPoint]: KillRow };

const BASH_K = {
  'K1-after-mkdir': { pause: 'owner-lock-made', left: 'empty-dir', byGraced: 'graced-head-after-grace', byNograce: 'nobody-until-a-human' },
  'K2-tmp-opened': { pause: 'owner-tmp-opened', left: 'tmp-new', byGraced: 'graced-head-after-grace', byNograce: 'nobody-until-a-human' },
  'K3-tmp-written': { pause: 'owner-tmp-written', left: 'tmp-new', byGraced: 'graced-head-after-grace', byNograce: 'nobody-until-a-human' },
  'K4-linked': { pause: 'owner-linked', left: 'complete+tmp', byGraced: 'recover-when-pid-gone', byNograce: 'recover-when-pid-gone' },
  'K5-tmp-removed': { pause: 'owner-tmp-removed', left: 'complete', byGraced: 'recover-when-pid-gone', byNograce: 'recover-when-pid-gone' },
} as const satisfies TableK;
const SYNC_K = {
  'K1-after-mkdir': { pause: 'owner-lock-made', left: 'empty-dir', byGraced: 'graced-head-after-grace', byNograce: 'nobody-until-a-human' },
  'K2-tmp-opened': { pause: 'owner-tmp-opened', left: 'tmp-new', byGraced: 'graced-head-after-grace', byNograce: 'nobody-until-a-human' },
  'K3-tmp-written': { pause: 'owner-tmp-written', left: 'tmp-new', byGraced: 'graced-head-after-grace', byNograce: 'nobody-until-a-human' },
  'K4-linked': { pause: 'owner-linked', left: 'complete+tmp', byGraced: 'recover-when-pid-gone', byNograce: 'recover-when-pid-gone' },
  'K5-tmp-removed': { pause: 'owner-tmp-removed', left: 'complete', byGraced: 'recover-when-pid-gone', byNograce: 'recover-when-pid-gone' },
} as const satisfies TableK;
const TS_K = {
  'K1-after-mkdir': { pause: 'owner-lock-made', left: 'empty-dir', byGraced: 'no-grace-caller', byNograce: 'nobody-until-a-human' },
  'K2-tmp-opened': { pause: 'owner-tmp-opened', left: 'tmp-new', byGraced: 'no-grace-caller', byNograce: 'nobody-until-a-human' },
  'K3-tmp-written': { pause: 'owner-tmp-written', left: 'tmp-new', byGraced: 'no-grace-caller', byNograce: 'nobody-until-a-human' },
  'K4-linked': { pause: 'owner-linked', left: 'complete+tmp', byGraced: 'no-grace-caller', byNograce: 'recover-when-pid-gone' },
  'K5-tmp-removed': { pause: 'owner-tmp-removed', left: 'complete', byGraced: 'no-grace-caller', byNograce: 'recover-when-pid-gone' },
} as const satisfies TableK;
const K_TABLES: Readonly<Record<Impl, TableK>> = { bash: BASH_K, sync: SYNC_K, ts: TS_K };

/** The expectation of a K row from I1, I3 and I6 (written apart from the tables). */
function ruleK(impl: Impl, point: KillPoint): Omit<KillRow, 'pause'> {
  const published = point === 'K4-linked' || point === 'K5-tmp-removed';
  const left: Left = point === 'K1-after-mkdir' ? 'empty-dir' : point === 'K4-linked' ? 'complete+tmp' : point === 'K5-tmp-removed' ? 'complete' : 'tmp-new';
  const ownerless: By = published ? 'recover-when-pid-gone' : 'graced-head-after-grace';
  return {
    left,
    byGraced: impl === 'ts' ? 'no-grace-caller' : ownerless,
    byNograce: published ? 'recover-when-pid-gone' : 'nobody-until-a-human',
  };
}

const KILL_ROWS = IMPLS.flatMap((impl) => KILL_POINTS.map((point) => ({ impl, point, ...K_TABLES[impl][point] })));

/** What the implementation before PR1a-f leaves when killed between the open and the write (E1, E2), and how a test gets there. */
const KILL_NOW = {
  bash: { left: 'empty-owner', how: 'lock_obs_create with its stdin a FIFO nobody writes: `: >` made the owner, `cat >>` waits; SIGKILL' },
  sync: { left: 'empty-owner', how: "a child whose hooks.fault('owner-write') never returns (after openSync, before writeSync); SIGKILL" },
  ts: { left: 'empty-owner', how: "the same with __testHooks.fault('owner-write')" },
} as const satisfies Record<Impl, { left: Left | 'empty-owner'; how: string }>;

// ------------------------------------------------------------------ table F (§3)

/** The observation points (§2.8 of verify-lock-holder-group-4288.md); `new` ones are added by PR1a-f. */
const POINTS = {
  'mkdir-lock': 'existing',
  'owner-create': 'existing',
  'owner-write': 'existing',
  'owner-write-short': 'new',
  'owner-close': 'new',
  'owner-publish': 'new',
  'owner-readback': 'existing',
  'owner-unlink': 'existing',
  'lock-rmdir': 'existing',
  'lock-list': 'existing',
  'ownerless-tmp-lstat': 'new',
  'ownerless-mtime': 'existing',
  'ownerless-tmp-unlink': 'new',
  'ownerless-rmdir': 'existing',
  'owner-tmp-pid': 'new',
  'empty-owner-move': 'new',
  'owner-mtime': 'new',
  pid: 'existing',
  lstart: 'existing',
  etime: 'new',
} as const;
type Point = keyof typeof POINTS;

const F_CALLERS = ['acquire', 'cleanup', 'empty-owner', 'd7', 'ticket', 'hand-off'] as const;
type FCaller = (typeof F_CALLERS)[number];

/** keep: nothing removed or taken; own-only: only what this caller itself made is undone. No `residual` (I7). */
type Direction = 'keep' | 'own-only';
type FMessage = Message | 'owner-exists' | 'not-ours' | 'write-failed';
type FResult =
  | 'acquired'
  | `refused:${FMessage}`
  | 'cleanup:next-step'
  | 'cleanup:next-poll'
  | 'd7:original'
  | 'd7:alive'
  | 'd7:unknown'
  | 'ticket:kept'
  | 'hand-off:failed';
type FLeft = 'nothing-made' | 'own-lock-undone' | 'unchanged' | 'lock+own-tmp' | 'lock-empty' | 'mine+tmp' | 'aside-kept';

interface FailureRow {
  readonly impls: readonly Impl[];
  readonly caller: FCaller;
  readonly point: Point | null;
  readonly direction: Direction;
  readonly result: FResult;
  readonly left: FLeft;
  readonly note: string;
}

const ALL = IMPLS;
const GRACED = ['bash', 'sync'] as const satisfies readonly Impl[];
const BASH = ['bash'] as const satisfies readonly Impl[];
const JS = ['sync', 'ts'] as const satisfies readonly Impl[];

const FAILURE_TABLE = {
  'F1-mkdir-lock': { impls: ALL, caller: 'acquire', point: 'mkdir-lock', direction: 'keep', result: 'refused:unk', left: 'nothing-made', note: 'EEXIST is not a failure' },
  'F2-tmp-create-exists': { impls: ALL, caller: 'acquire', point: 'owner-create', direction: 'own-only', result: 'refused:unk', left: 'unchanged', note: 'not opened: the tmp is not removed; the rmdir fails on a non-empty <lock>' },
  'F3-tmp-create-other': { impls: ALL, caller: 'acquire', point: 'owner-create', direction: 'own-only', result: 'refused:unk', left: 'own-lock-undone', note: 'EACCES / ENOSPC; the head made this <lock>' },
  'F4-tmp-write': { impls: ALL, caller: 'acquire', point: 'owner-write', direction: 'own-only', result: 'refused:write-failed', left: 'own-lock-undone', note: 'ENOSPC / EIO' },
  'F5-tmp-write-short': { impls: ALL, caller: 'acquire', point: 'owner-write-short', direction: 'own-only', result: 'refused:write-failed', left: 'own-lock-undone', note: 'JS/TS: the sum of writeSync < byteLength; bash: the tmp read back differs' },
  'F6-tmp-close': { impls: JS, caller: 'acquire', point: 'owner-close', direction: 'own-only', result: 'refused:write-failed', left: 'own-lock-undone', note: 'closeSync throws: not published (bash: caught by F5)' },
  'F7-link-exists-file': { impls: ALL, caller: 'acquire', point: 'owner-publish', direction: 'own-only', result: 'refused:owner-exists', left: 'unchanged', note: 'own tmp removed' },
  'F8-link-exists-dir': { impls: ALL, caller: 'acquire', point: 'owner-publish', direction: 'own-only', result: 'refused:owner-exists', left: 'unchanged', note: 'nothing made inside the directory (`ln` would: /bin/link and linkSync answer EEXIST)' },
  'F9-link-exists-dirlink': { impls: ALL, caller: 'acquire', point: 'owner-publish', direction: 'own-only', result: 'refused:owner-exists', left: 'unchanged', note: 'nothing made where the symlink points (outside <lock>)' },
  'F10-link-exists-filelink': { impls: ALL, caller: 'acquire', point: 'owner-publish', direction: 'own-only', result: 'refused:owner-exists', left: 'unchanged', note: 'the symlink is not followed or replaced' },
  'F11-link-enoent': { impls: ALL, caller: 'acquire', point: 'owner-publish', direction: 'own-only', result: 'refused:unk', left: 'unchanged', note: 'own tmp removed if there; no rmdir: a <lock> there now is not ours' },
  'F12-link-other': { impls: ALL, caller: 'acquire', point: 'owner-publish', direction: 'own-only', result: 'refused:unk', left: 'own-lock-undone', note: 'EPERM / ENOTSUP / EIO' },
  'F13-readback-unknown-same-inode': { impls: ALL, caller: 'acquire', point: 'owner-readback', direction: 'own-only', result: 'refused:unk', left: 'own-lock-undone', note: 'the owner removed only after `-ef` / dev+ino says it is the tmp (as 70+i today)' },
  'F14-readback-unknown-other-inode': { impls: ALL, caller: 'acquire', point: 'owner-readback', direction: 'own-only', result: 'refused:unk', left: 'unchanged', note: 'the owner is not the tmp: not removed; own tmp only' },
  'F15-readback-not-ours': { impls: ALL, caller: 'acquire', point: 'owner-readback', direction: 'own-only', result: 'refused:not-ours', left: 'unchanged', note: 'own tmp removed' },
  'F16-tmp-unlink-after-publish': { impls: ALL, caller: 'acquire', point: 'owner-unlink', direction: 'keep', result: 'acquired', left: 'mine+tmp', note: 'the tmp goes with the rm -rf of release / recovery' },
  'F17-undo-tmp-unlink': { impls: ALL, caller: 'acquire', point: 'owner-unlink', direction: 'keep', result: 'refused:write-failed', left: 'lock+own-tmp', note: 'tmp-new: a graced head takes it out after the grace (I3)' },
  'F18-undo-lock-rmdir': { impls: ALL, caller: 'acquire', point: 'lock-rmdir', direction: 'keep', result: 'refused:write-failed', left: 'lock-empty', note: 'as today' },
  'F19-cleanup-list': { impls: GRACED, caller: 'cleanup', point: 'lock-list', direction: 'keep', result: 'refused:unk', left: 'unchanged', note: 'no mkdir this poll' },
  'F20-cleanup-tmp-lstat': { impls: GRACED, caller: 'cleanup', point: 'ownerless-tmp-lstat', direction: 'keep', result: 'refused:unk', left: 'unchanged', note: 'no mkdir this poll' },
  'F21-cleanup-mtime': { impls: GRACED, caller: 'cleanup', point: 'ownerless-mtime', direction: 'keep', result: 'refused:unk', left: 'unchanged', note: 'no mkdir this poll' },
  'F22-cleanup-tmp-unlink': { impls: GRACED, caller: 'cleanup', point: 'ownerless-tmp-unlink', direction: 'keep', result: 'refused:unk', left: 'unchanged', note: 'not ENOENT: no rmdir, no mkdir this poll' },
  'F23-cleanup-tmp-unlink-enoent': { impls: GRACED, caller: 'cleanup', point: 'ownerless-tmp-unlink', direction: 'keep', result: 'cleanup:next-step', left: 'unchanged', note: 'already gone (an older cleaner at the same time): on to the next name / the rmdir' },
  'F24-cleanup-rmdir-notempty': { impls: GRACED, caller: 'cleanup', point: 'ownerless-rmdir', direction: 'keep', result: 'cleanup:next-poll', left: 'unchanged', note: 'taken in between: judged as a record next poll' },
  'F25-cleanup-rmdir-other': { impls: GRACED, caller: 'cleanup', point: 'ownerless-rmdir', direction: 'keep', result: 'refused:unk', left: 'unchanged', note: 'no mkdir this poll' },
  'F26-old-tmp-pid-unknown': { impls: GRACED, caller: 'cleanup', point: 'owner-tmp-pid', direction: 'keep', result: 'refused:unk', left: 'unchanged', note: 'kill -0 of the name\'s pid: EPERM / EIO' },
  'F27-old-tmp-pid-alive': { impls: GRACED, caller: 'cleanup', point: null, direction: 'keep', result: 'refused:old-taker', left: 'unchanged', note: 'an older writer stopped past the grace; resumed, it mv-s its own tmp (codex P1 closed)' },
  'F28-old-tmp-pid-not-numeric': { impls: GRACED, caller: 'cleanup', point: null, direction: 'keep', result: 'refused:stray', left: 'unchanged', note: 'owner.tmp.<not a pid>' },
  'F29-empty-owner-young': { impls: ALL, caller: 'empty-owner', point: null, direction: 'keep', result: 'refused:taking', left: 'unchanged', note: '60 s or younger: maybe being written (P3-8)' },
  'F30-empty-owner-move': { impls: ALL, caller: 'empty-owner', point: 'empty-owner-move', direction: 'keep', result: 'refused:unk', left: 'unchanged', note: 'the mv aside fails' },
  'F31-empty-owner-aside-written': { impls: ALL, caller: 'empty-owner', point: null, direction: 'keep', result: 'refused:rec', left: 'aside-kept', note: 'no longer 0 bytes once moved: lock_settle_gone judges it as a record next poll' },
  'F32-kill0-other': { impls: BASH, caller: 'd7', point: 'pid', direction: 'keep', result: 'd7:original', left: 'unchanged', note: 'EIO: unknown stays, D7 not applied' },
  'F33-ps-lstart': { impls: BASH, caller: 'd7', point: 'lstart', direction: 'keep', result: 'd7:unknown', left: 'unchanged', note: 'alive → unknown:lstart:<errno>; EPERM stays' },
  'F34-lstart-unparsed': { impls: BASH, caller: 'd7', point: 'lstart', direction: 'keep', result: 'd7:unknown', left: 'unchanged', note: 'machine_lock_lstart_naive_s fails on either string' },
  'F35-ps-etime': { impls: BASH, caller: 'd7', point: 'etime', direction: 'keep', result: 'd7:unknown', left: 'unchanged', note: 'alive → unknown:etime:<errno>; EPERM stays' },
  'F36-etime-malformed': { impls: BASH, caller: 'd7', point: 'etime', direction: 'keep', result: 'd7:unknown', left: 'unchanged', note: '`bad:bad`, `1:99`, `-1:00`, four fields: never read as 0 s elapsed (codex P2)' },
  'F37-ticket-etime-malformed': { impls: ALL, caller: 'ticket', point: 'etime', direction: 'keep', result: 'ticket:kept', left: 'unchanged', note: 'bash lock_pid_start_ms takes the strict parse; JS/TS parseEtime checks the ranges' },
  'F38-started-at-missing-mtime-fails': { impls: BASH, caller: 'd7', point: 'owner-mtime', direction: 'keep', result: 'd7:original', left: 'unchanged', note: 'no started_at= and no owner mtime: the pid alone' },
  'F39-started-at-unparsed': { impls: BASH, caller: 'd7', point: null, direction: 'keep', result: 'd7:original', left: 'unchanged', note: 'date cannot read started_at=' },
  'F40-started-at-carry-over': { impls: BASH, caller: 'd7', point: null, direction: 'keep', result: 'd7:alive', left: 'unchanged', note: 'LOB_STARTED_AT emptied per read: a record without started_at= after one with uses its own owner mtime' },
  'F41-hostname': { impls: BASH, caller: 'd7', point: null, direction: 'keep', result: 'd7:original', left: 'unchanged', note: 'another host= is alive' },
  'F42-clock-back-and-tz': { impls: BASH, caller: 'd7', point: null, direction: 'keep', result: 'd7:alive', left: 'unchanged', note: 'round 1\'s residual F24: witness (1) reads a time-zone-only difference as the same start' },
  'F43-launchd-reader': { impls: BASH, caller: 'd7', point: null, direction: 'keep', result: 'd7:alive', left: 'unchanged', note: 'written under env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin (TZ, LC_ALL unset), read with TZ=UTC and TZ=Asia/Tokyo' },
  'F44-pid-gone-group-alive': { impls: BASH, caller: 'd7', point: null, direction: 'keep', result: 'd7:original', left: 'unchanged', note: 'pgid= and lstart=, the pid gone and G alive: D7 not applied (no such record in production)' },
  'F45-handoff-lstart': { impls: BASH, caller: 'hand-off', point: null, direction: 'keep', result: 'hand-off:failed', left: 'unchanged', note: 'LOCK_OWNER_EXTRA with lstart=: LHO_STAGE=lstart, the owner not rewritten (I5\'s premise)' },
  'F46-garbage-owner': { impls: ALL, caller: 'acquire', point: null, direction: 'keep', result: 'refused:corrupt', left: 'unchanged', note: 'never removed; the refusal and D6 name <lock>/owner (I4)' },
} as const satisfies Record<string, FailureRow>;
type Failure = keyof typeof FAILURE_TABLE;
const FAILURES = Object.keys(FAILURE_TABLE) as Failure[];
const F_ROWS: Array<FailureRow & { id: Failure }> = FAILURES.map((id) => ({ id, ...FAILURE_TABLE[id] }));

// ------------------------------------------------------------------ §4: machine_lock_pid_identity (the contract PR1c calls)

const PID_IDENTITY = {
  bash: {
    name: 'machine_lock_pid_identity',
    file: 'scripts/lib/machine-lock.sh',
    args: ['pid', 'recorded-lstart', 'started-at-ms'],
    answers: ['alive', 'reused', 'unknown:<point>:<errno>'],
    helpers: ['machine_lock_etime_ms', 'machine_lock_lstart_naive_s'],
  },
  sync: { name: null, why: 'no JS caller reads lstart= (I6); parseEtime gains the range check (F37)' },
  ts: { name: null, why: 'the same' },
} as const;

/** Witness (1): the naive (zone-less) difference of two lstart strings is a time-zone offset. */
const TZ_STEP_S = 900;
const TZ_SPAN_S = 26 * 3600;
const isTimeZoneOffset = (diffS: number): boolean => diffS % TZ_STEP_S === 0 && Math.abs(diffS) <= TZ_SPAN_S;

/** machine_lock_etime_ms's rule, on the text: `[[dd-]hh:]mm:ss`, hh < 24, mm < 60, ss < 60; anything else is null. */
function etimeMs(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  if (d !== undefined && h === undefined) return null;
  const hours = Number(h ?? 0);
  const minutes = Number(mm);
  const seconds = Number(ss);
  if (hours >= 24 || minutes >= 60 || seconds >= 60) return null;
  return (((Number(d ?? 0) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

// ------------------------------------------------------------------ the tables check themselves

describe('Issue #4288 PR1a-f tables (design §2.5): shape', () => {
  it('T has every combination: 3 implementations × 17 forms × 4 callers × 3 observations = 612 cells, 270 unreachable, 342 rows', () => {
    expect(IMPLS).toHaveLength(3);
    expect(FORMS).toHaveLength(17);
    expect(CALLERS).toHaveLength(4);
    expect(CELLS).toHaveLength(612);
    expect(UNREACHABLE).toHaveLength(270);
    expect(ROWS).toHaveLength(342);
  });

  it('the unreachable cells are exactly the reasons of §2.4', () => {
    const count = (impl: Impl, reason: Reason) => UNREACHABLE.filter((e) => e.impl === impl && (e.cell as Unreachable).unreachable === reason).length;
    expect(count('bash', 'no-kv-for-nograce')).toBe(24);
    expect(count('sync', 'd7-bash-only')).toBe(96);
    expect(count('ts', 'd7-bash-only')).toBe(96);
    expect(count('ts', 'ts-no-grace')).toBe(27);
    expect(count('ts', 'ts-no-guard')).toBe(27);
    for (const e of UNREACHABLE) expect(UNREACHABLE_REASONS[(e.cell as Unreachable).unreachable].length).toBeGreaterThan(0);
  });

  it('K has 5 points × 3 implementations = 15 rows, F has 46 rows: 403 rows in all', () => {
    expect(KILL_ROWS).toHaveLength(15);
    expect(FAILURES).toHaveLength(46);
    expect(ROWS.length + KILL_ROWS.length + FAILURES.length).toBe(403);
  });

  it('every form and every observation of it is defined', () => {
    for (const form of FORMS) {
      expect(FORM_MEANING[form].length).toBeGreaterThan(0);
      for (const obs of OBS) expect(OBS_MEANING[form][obs].length).toBeGreaterThan(0);
    }
  });

  it.each(ROWS)('row $impl $caller × $form × $obs: a known message, a positive control that differs', ({ cell }) => {
    for (const code of [cell.is, ...(cell.now ? [cell.now] : [])]) {
      if (code.startsWith('refused:')) expect((MESSAGES as readonly string[]).includes(code.slice('refused:'.length))).toBe(true);
    }
    if (cell.now !== undefined) expect(cell.now).not.toBe(cell.is);
  });
});

describe('Issue #4288 PR1a-f table T: each implementation as written against the rules and against each other (§2.3, §2.4)', () => {
  it.each(CELLS)('$impl $form × $caller × $obs equals the rule of §1 (and today for the positive control)', ({ impl, form, caller, obs, cell }) => {
    expect(cell).toEqual(expectedT(impl, form, caller, obs));
  });

  it('where two implementations reach a cell, their separately written cells agree', () => {
    for (const form of FORMS) {
      for (const caller of CALLERS) {
        for (const obs of OBS) {
          const reached = CELLS.filter((e) => e.form === form && e.caller === caller && e.obs === obs && isReached(e));
          for (const e of reached) expect(e.cell).toEqual(reached[0].cell);
        }
      }
    }
  });

  it('the tables are separate objects (round 1 compared one object with itself)', () => {
    expect(BASH_T).not.toBe(SYNC_T);
    expect(BASH_T['tmp-new']).not.toBe(SYNC_T['tmp-new']);
    expect(BASH_K).not.toBe(SYNC_K);
    expect(BASH_K['K1-after-mkdir']).not.toBe(TS_K['K1-after-mkdir']);
  });
});

describe('Issue #4288 PR1a-f tables keep the invariants (a) (design §1)', () => {
  const moves = (e: Reached) => lockAfter(e.cell.is) !== 'unchanged';

  it('I0-b: a caller that is not the head moves nothing', () => {
    for (const e of ROWS.filter((r) => r.caller === 'acquire-behind')) expect(e.cell).toEqual({ is: 'refused:queue' });
  });

  it('I0-c: an unknown observation never takes or removes — except a reused pid read EPERM by both witnesses (I5)', () => {
    for (const e of ROWS.filter((r) => r.obs === 'unknown' && moves(r))) {
      expect(['lstart-reused', 'lstart-legacy-reused']).toContain(e.form);
    }
  });

  it('I3: an owner-less <lock> is taken out only by a graced head (or the guard), past the grace, of temporaries alone, an older tmp only with its pid gone', () => {
    const ownerless: readonly Form[] = ['empty-dir', 'tmp-new', 'tmp-old-young', 'tmp-old', 'tmp-stray', 'tmp-new+gone-dead', 'tmp-new+gone-alive'];
    for (const e of ROWS.filter((r) => ownerless.includes(r.form) && moves(r))) {
      expect(['acquire-head-grace', 'guard-head']).toContain(e.caller);
      expect(e.obs).toBe('gone');
      expect(['tmp-stray', 'tmp-old-young', 'tmp-new+gone-alive']).not.toContain(e.form);
      expect(e.impl).not.toBe('ts');
    }
    for (const e of ROWS.filter((r) => r.caller === 'acquire-head-nograce' && ownerless.includes(r.form))) expect(moves(e)).toBe(false);
    for (const e of ROWS.filter((r) => r.form === 'tmp-old' && r.obs === 'alive' && r.caller === 'acquire-head-grace')) {
      expect(e.cell.is).toBe('refused:old-taker');
    }
  });

  it('I4: an unparsable owner is removed by nobody and named; an empty owner only by a head past the fixed grace', () => {
    for (const e of ROWS.filter((r) => r.form === 'garbage-owner')) {
      expect(moves(e)).toBe(false);
      if (e.caller.startsWith('acquire-head') && e.obs !== 'unknown') expect(e.cell.is).toBe('refused:corrupt');
    }
    for (const e of ROWS.filter((r) => r.form === 'empty-owner' && moves(r))) {
      expect(e.obs).toBe('gone');
      expect(e.caller).not.toBe('acquire-behind');
    }
    // the gate (no grace) is reached too: P2-6
    expect(ROWS.filter((r) => r.form === 'empty-owner' && r.caller === 'acquire-head-nograce' && r.obs === 'gone').map((r) => r.impl)).toEqual([
      'bash',
      'sync',
      'ts',
    ]);
  });

  it('I5: D7 turns nothing alive into taken except a reused pid; a live holder under another TZ, an older record or an etime it cannot read is kept', () => {
    for (const e of ROWS.filter((r) => isD7(r.form) && r.obs !== 'gone' && moves(r))) {
      expect(['lstart-reused', 'lstart-legacy-reused']).toContain(e.form);
    }
    for (const form of ['lstart-tz', 'lstart-legacy', 'etime-fails'] as const) {
      expect(normalize(BASH_T[form]['acquire-head-grace'][0])).toMatchObject({ now: 'acquired' });
      expect(normalize(BASH_T[form]['guard-head'][0])).toMatchObject({ is: 'kept', now: 'removed' });
    }
  });

  it('I1, K: no interruption point leaves an empty or half owner, in any implementation; today one does', () => {
    for (const impl of IMPLS) {
      for (const point of KILL_POINTS) {
        const { pause, ...row } = K_TABLES[impl][point];
        expect(row).toEqual(ruleK(impl, point));
        expect(pause).toBe(PAUSES[KILL_POINTS.indexOf(point)]);
      }
      expect(KILL_ROWS.some((k) => (k.left as string) === KILL_NOW[impl].left)).toBe(false);
    }
  });

  it('K: TS has no graced head, so its K1-K3 are left to a human (round 1 said graced-head-after-grace)', () => {
    for (const point of ['K1-after-mkdir', 'K2-tmp-opened', 'K3-tmp-written'] as const) {
      expect(TS_K[point].byGraced).toBe('no-grace-caller');
      expect(TS_K[point].byNograce).toBe('nobody-until-a-human');
    }
  });

  it('§3: no residual row (I7); own-only rows are the acquisition\'s own undo; the cleanup rows are graced, the D7 rows bash', () => {
    expect(F_ROWS.filter((f) => (f.direction as string) === 'residual')).toEqual([]);
    for (const f of F_ROWS) expect((F_CALLERS as readonly string[]).includes(f.caller)).toBe(true);
    for (const f of F_ROWS.filter((r) => r.direction === 'own-only')) expect(f.caller).toBe('acquire');
    for (const f of F_ROWS.filter((r) => r.caller === 'cleanup')) expect([...f.impls]).toEqual(['bash', 'sync']);
    for (const f of F_ROWS.filter((r) => r.caller === 'd7' || r.caller === 'hand-off')) expect([...f.impls]).toEqual(['bash']);
    // every new point of §2.8 is driven by a row
    const used = new Set(F_ROWS.map((f) => f.point));
    for (const [p, kind] of Object.entries(POINTS)) if (kind === 'new') expect(used.has(p as Point)).toBe(true);
    // a short write and a failed close are rows (codex P2)
    expect(FAILURE_TABLE['F5-tmp-write-short'].point).toBe('owner-write-short');
    expect(FAILURE_TABLE['F6-tmp-close'].point).toBe('owner-close');
  });

  it('the positive controls (cells whose result or wording changes) are the ones the design marks', () => {
    const changed = ROWS.filter((r) => r.impl === 'bash' && r.cell.now !== undefined).map((r) => `${r.form}/${r.caller}/${r.obs}`);
    expect(changed.sort()).toEqual(
      [
        'tmp-new/acquire-head-grace/gone',
        'tmp-new/guard-head/gone',
        'tmp-old/acquire-head-grace/alive',
        'tmp-old/acquire-head-grace/gone',
        'tmp-old/acquire-head-grace/unknown',
        'tmp-old/guard-head/gone',
        'tmp-stray/acquire-head-grace/alive',
        'tmp-stray/acquire-head-grace/gone',
        'tmp-new+gone-dead/acquire-head-grace/gone',
        'tmp-new+gone-dead/guard-head/gone',
        'empty-owner/acquire-head-grace/alive',
        'empty-owner/acquire-head-grace/gone',
        'empty-owner/acquire-head-nograce/alive',
        'empty-owner/acquire-head-nograce/gone',
        'empty-owner/guard-head/gone',
        'garbage-owner/acquire-head-grace/alive',
        'garbage-owner/acquire-head-grace/gone',
        'garbage-owner/acquire-head-nograce/alive',
        'garbage-owner/acquire-head-nograce/gone',
        'lstart-tz/acquire-head-grace/alive',
        'lstart-tz/guard-head/alive',
        'lstart-reused/acquire-head-grace/unknown',
        'lstart-reused/guard-head/unknown',
        'etime-fails/acquire-head-grace/alive',
        'etime-fails/guard-head/alive',
        'lstart-legacy/acquire-head-grace/alive',
        'lstart-legacy/guard-head/alive',
        'lstart-legacy-reused/acquire-head-grace/unknown',
        'lstart-legacy-reused/guard-head/unknown',
      ].sort(),
    );
  });
});

describe('Issue #4288 PR1a-f §4: the time-zone independent comparison PR1c calls', () => {
  it('the contract: bash machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms> → alive | reused | unknown; no JS twin without a caller', () => {
    expect(PID_IDENTITY.bash.name).toBe('machine_lock_pid_identity');
    expect(PID_IDENTITY.bash.answers).toEqual(['alive', 'reused', 'unknown:<point>:<errno>']);
    expect(PID_IDENTITY.sync.name).toBeNull();
    expect(PID_IDENTITY.ts.name).toBeNull();
    expect(new Set(Object.values(IDENTITY_OF))).toEqual(new Set(['alive', 'reused', 'unknown']));
  });

  it('witness (1): a whole time-zone offset is the same start; anything else (a second, a minute off) is not', () => {
    expect(isTimeZoneOffset(0)).toBe(true);
    expect(isTimeZoneOffset(9 * 3600)).toBe(true); // UTC vs Asia/Tokyo (measured: 09:32:44 / 18:32:44)
    expect(isTimeZoneOffset(-(5 * 3600 + 1800))).toBe(true); // Asia/Kolkata
    expect(isTimeZoneOffset(5 * 3600 + 2700)).toBe(true); // Asia/Kathmandu
    expect(isTimeZoneOffset(9 * 3600 + 1)).toBe(false);
    expect(isTimeZoneOffset(60)).toBe(false);
    expect(isTimeZoneOffset(27 * 3600)).toBe(false);
  });

  it('the strict etime parse: valid forms read, malformed ones are null (never 0 s elapsed: codex P2)', () => {
    expect(etimeMs('00:00')).toBe(0);
    expect(etimeMs('01:02')).toBe(62_000);
    expect(etimeMs('1:02:03')).toBe(3_723_000);
    expect(etimeMs('2-03:04:05')).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000);
    for (const bad of ['bad:bad', '1:99', '99:00', '-1:00', '1:2:3:4', '24:00:00', '2-04:05', '', ' ']) expect(etimeMs(bad)).toBeNull();
  });
});

// ------------------------------------------------------------------ behaviour (the implementation contract)

describe.each(IMPLS)('Issue #4288 PR1a-f behaviour T: %s (to implement)', (impl) => {
  for (const e of ROWS.filter((r) => r.impl === impl)) {
    const now = e.cell.now ? ` [today: ${e.cell.now}]` : '';
    it.todo(`${e.form} × ${e.caller} × ${e.obs} → ${e.cell.is} / ${lockAfter(e.cell.is)}${now}`);
  }
});

describe('Issue #4288 PR1a-f behaviour K: an acquisition killed at each point (design §2.6, to implement)', () => {
  for (const k of KILL_ROWS) it.todo(`${k.impl} ${k.point} (pause ${k.pause}): leaves ${k.left}; graced ${k.byGraced}, no grace ${k.byNograce}`);
  for (const impl of IMPLS) it.todo(`${impl} positive control: today leaves ${KILL_NOW[impl].left} — ${KILL_NOW[impl].how}`);
});

describe('Issue #4288 PR1a-f failure directions F (design §3, to implement)', () => {
  for (const f of F_ROWS) {
    it.todo(`${f.id} [${f.impls.join(',')}] ${f.caller}${f.point ? ` @${f.point}` : ''}: ${f.direction} → ${f.result} / ${f.left} — ${f.note}`);
  }
});
