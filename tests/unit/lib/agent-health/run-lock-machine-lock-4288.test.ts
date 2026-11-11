/**
 * Issue #4288 PR1b — the tables of docs/design/run-lock-machine-lock-4288.md §2 (the upstream stage:
 * the table is written and reviewed before the implementation; "赤から緑にする" is the next contract).
 * Second upstream round: the cells answer the reviews of ee92499cd (pm-return-4288-upstream.md).
 *
 * What this file is now: the tables of §2 as typed data built from enumerations, so that a cell left
 * out is a type error (`satisfies`), and the invariants of §1 checked over every row (pure table
 * checks — they pass today and keep the table honest while it is reviewed). What it is not yet: a test
 * of the implementation. The places that will drive the real run-lock (src/lib/agent-health/run-lock.ts,
 * scripts/uat/run-lock.sh, scripts/uat/run-server.sh, scripts/agent-health/daily.sh on top of
 * scripts/lib/machine-lock.sh) are `it.todo`; the PR1b contract replaces each with an `it.each` over the
 * same rows that sets the state up in an os.tmpdir() lock and asserts the cell.
 *
 * Every row is one of three kinds:
 *   reach     — a production caller gets here; the cell is the expected outcome
 *   rejected  — no production caller; the wrapper's argument / context check (table E) refuses it before
 *               the lock is touched (decision 2 of pm-return-4288-upstream.md: 到達しない — 引数・文脈の検査で拒否)
 *   never     — cannot happen, with the reason
 *
 * Tables (row counts are pinned below and written in the design doc §2.8):
 *   A.  record shape × caller × observation → result      (pid and group are separate axes, §2.2)
 *   B.  D9 handover stage × flow × event                  (review-4288h P2-2)
 *   C.  UAT down: record × leader × rest of the group     (review-4288h P2-3, PM P1-1)
 *   C'. D5 result → down's status / exit
 *   D.  handover failure × flow → result / whereabouts / wording
 *   D2. odd observation (zombie, host change, EPERM, a group that does not empty) × caller
 *   E.  argument / context check × implementation       (the "rejected" rows of A point here)
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

// ================================================================ enumerations (table A, §2.1)

/** Shapes observed through the recorded pid only (no pgid= in the record, or no record). */
const P_SHAPES = [
  'none', // no <lock>, no moved-aside record, no ticket ahead
  'ticket-ahead', // no <lock>; a ticket of someone else is ahead in <lock>.queue
  'ownerless-young', // <lock> with no owner, empty, mtime ≤ 60 s
  'ownerless-old', // <lock> with no owner, empty, mtime > 60 s
  'ownerless-nonempty', // <lock> with no owner and not empty (an old version's owner.tmp.*, a partial rm): PR1a-f
  'unreadable', // <lock>/owner cannot be read (EIO, EACCES, a pgid= that is not a number)
  'corrupt', // <lock>/owner read, but no pid= or no token= (an empty owner from a SIGKILL mid-create): PR1a-f
  'own-self', // own token, recorded pid = the caller itself, no pgid= (TS main.ts; daily / UAT up / cleanup before a handover)
  'own-other', // own token, recorded pid ≠ the caller, no pgid= (down's view of up's T0; the old form; bash pid≠$$ test-only)
  'foreign', // another token, no pgid= (also an older record without host=)
  'aside-own', // no <lock>; a <lock>.gone-* record under an own token, no pgid=
  'aside-foreign', // no <lock>; a <lock>.gone-* record under another token, no pgid=
] as const;

/** Shapes whose record names a process group G: observed on two axes, the pid and G (decision 3). */
const G_SHAPES = [
  'own-self-g', // own T1, recorded pid = the caller, pgid=G of its child (daily after the handover)
  'own-self-selfg', // own record with pid = pgid = the caller (the self-group exception of D12): never written (I-5)
  'own-other-g', // own T1, recorded pid ≠ the caller, pgid=G (UAT: pid = server = G's leader; daily's T1 seen by run.ts)
  'foreign-g', // another token with pgid=
  'aside-own-g', // no <lock>; an own T1 in <lock>.gone-*
  'aside-foreign-g', // no <lock>; another token's record with pgid= in <lock>.gone-*
] as const;

const SHAPES = [...P_SHAPES, ...G_SHAPES] as const;
type PShape = (typeof P_SHAPES)[number];
type GShape = (typeof G_SHAPES)[number];
type Shape = (typeof SHAPES)[number];

/** The operations PR1b puts on run-lock (§2.1). */
const CALLERS = [
  'ts-acquire', // acquireRunLock without CM_RUN_LOCK_TOKEN (main.ts)
  'ts-inherit', // acquireRunLock with CM_RUN_LOCK_TOKEN (run.ts under daily.sh, D8)
  'ts-release', // the handle's release() after a take
  'ts-release-inherited', // the handle's release() after an inheritance: touches nothing
  'sh-acquire', // run_lock_acquire (daily.sh, UAT up, cleanup)
  'sh-inherit', // run_lock_acquire under CM_RUN_LOCK_TOKEN (a bash child of daily's run.ts, D8)
  'sh-release-held', // run_lock_release in the main shell that took the lock with its own $$ (D12; needs-head → D5 inside)
  'sh-release-unheld', // run_lock_release in a shell that holds nothing (a new shell, an inheritor, a second call): LRH none
  'sh-hand-off', // run_lock_set_pid → lock_hand_off (D4/D9): UAT up, daily.sh
  'sh-release-as-head', // run_lock_release_as_head (D5): UAT down, and run_lock_release after needs-head
] as const;
type Caller = (typeof CALLERS)[number];

/**
 * One observation axis (§2.1 の「観測するもの」): what kill -0 / the listing / the read would return
 * if asked. For P shapes it is the shape's one observation; for G shapes the first axis is the recorded
 * pid and the second is G (kill -0 -G). A cell that does not ask an axis is the same for its 3 values.
 */
const OBS = ['alive', 'gone', 'unknown'] as const;
type Obs = (typeof OBS)[number];

/** From the code: LRH_RESULT (D12), LRAH_RESULT (D5), the sync release, the takes, the handover. */
const RESULTS = [
  'acquired',
  'recovered-acquired', // the head moved a dead holder's lock aside, checked its token, deleted it, took the lock
  'expired-acquired', // the head rmdir'd an owner-less empty <lock> past 60 s (D3), took the lock
  'reclaimed-acquired', // the head deleted a dead moved-aside record (§2.7), took the lock
  'refused',
  'inherited',
  'none', // D12 in a shell that holds nothing / a second call (machine-lock.sh lock_release_held), the inherited handle
  'released',
  'needs-head',
  'deferred',
  'kept',
  'missing',
  'unknown',
  'not-head',
  'handed',
  'stage-token',
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

/** needs-head → the caller runs D5 in the same run; deferred / not-head / unknown → left to the next head. */
type Next = 'D5' | 'next-head';

/** The kind of the refusal's wording. Every one starts `another run holds <dir> (` (run-server-3359.test.ts:410). */
const REFUSE_MSGS = [
  'held', // (pid N, label L, since T[, run_dir])  — UAT up adds: stop it with `run-server.sh down --run-dir <run_dir>` (§4.4)
  'held-group', // (pid N gone, pgid G alive, label L …) — the same hint
  'ticket', // (ticket <t> of pid N ahead)
  'unknown', // (cannot tell: point=… path=… errno=…)
  'corrupt', // (<lock>/owner has no pid= or token=: remove <lock> by hand after checking; PR1a-f)
  'ownerless-young', // (no owner yet, <60 s)
  'ownerless-nonempty', // (no owner and not empty: <list>; remove by hand; PR1a-f)
  'aside', // (a moved-aside record <lock>.gone-… is alive)
] as const;
type RefuseMsg = (typeof REFUSE_MSGS)[number];

/** Argument / context checks of the wrappers (table E). */
const CHECKS = [
  'token-chars', // token not [A-Za-z0-9-]+ (I-8, F4)
  'field-newline', // label / run_dir with a newline (I-8, F10)
  'ts-pid-not-self', // acquireRunLock({ pid }) with pid ≠ process.pid (PM Claude P3-3)
  'sh-release-after-foreign-pid', // run_lock_release after run_lock_acquire <label> <pid≠$$> (F9 keeps that take, test-only)
  'handoff-pid-not-self', // run_lock_set_pid when the recorded pid is not $$ (I-6)
  'handoff-pgid-self', // run_lock_set_pid with pgid = $$ or = this shell's own pgid (PM Claude P2-5, I-5)
  'handoff-twice', // run_lock_set_pid after a handover (no caller hands over twice)
  'handoff-subshell', // run_lock_set_pid from a subshell (I-4)
  'release-subshell', // run_lock_release from a subshell (I-4)
  'machine-lock-unloaded', // run-lock.sh was sourced but machine-lock.sh failed to load (§4.3, decision 4)
] as const;
type CheckId = (typeof CHECKS)[number];

type Reach =
  | { kind: 'reach'; result: Exclude<Result, 'refused'>; after: After; next?: Next }
  | { kind: 'reach'; result: 'refused'; after: 'unchanged' | 'restored'; msg: RefuseMsg; next?: never };
type Cell = Reach | { kind: 'rejected'; check: CheckId } | { kind: 'never'; why: string };
type ByObs = Record<Obs, Cell>;
/** [pid][G] */
type ByPidG = Record<Obs, ByObs>;
type CallerTable = { [S in PShape]: ByObs } & { [S in GShape]: ByPidG };

const c = (result: Exclude<Result, 'refused'>, after: After, next?: Next): Cell =>
  next ? { kind: 'reach', result, after, next } : { kind: 'reach', result, after };
const r = (msg: RefuseMsg, after: 'unchanged' | 'restored' = 'unchanged'): Cell => ({ kind: 'reach', result: 'refused', after, msg });
const never = (why: string): Cell => ({ kind: 'never', why });
const rejected = (check: CheckId): Cell => ({ kind: 'rejected', check });
const all = (cell: Cell): ByObs => ({ alive: cell, gone: cell, unknown: cell });
const by = (alive: Cell, gone: Cell, unknown: Cell): ByObs => ({ alive, gone, unknown });
const gAll = (cell: Cell): ByPidG => ({ alive: all(cell), gone: all(cell), unknown: all(cell) });
/** pid × G written out: each argument is the G axis for one pid value. */
const pg = (pidAlive: ByObs, pidGone: ByObs, pidUnknown: ByObs): ByPidG => ({ alive: pidAlive, gone: pidGone, unknown: pidUnknown });

const kept = c('kept', 'unchanged');
const deferred = c('deferred', 'unchanged', 'next-head');
const missing = c('missing', 'unchanged');
const stageToken = c('stage-token', 'unchanged');
const noneResult = c('none', 'unchanged');

const FRESH_TOKEN = '取得の token は毎回新しい（T0 は run_id・daily-$$-…・cleanup-$$-…・<label>-<pid>-<乱数>）ので、自分の token の記録は取得の前に無い';
const NOT_THE_PID = '継ぐ者は記録の pid ではない（記録の pid は親の daily.sh か UAT のサーバー）';
const INHERIT_T1 = '継ぐ者は daily の子（run.ts とその bash の子）だけで、子は go の後に始まる（I-7）ので見る記録は T1（pgid=G）。up・cleanup は CM_RUN_LOCK_TOKEN を消してから取る（§4.2）';
const IN_G = '継ぐ者は G の中に居るので G は ESRCH にならず、T1 は gone と判定されない（退かされもしない）';
const NO_PGID_IN_TS = 'TS（run-lock.ts）は pgid を書かない（D9 は bash の daily と UAT だけ）';
const NODE_SELF = 'Node は自分の pid を観測しない（process.pid は呼び手そのもの。sync の release は pid の一致だけを見る）';
const SH_SELF = 'main シェル（BASH_SUBSHELL=0）の $$ は呼び手自身で生きている。自分の uid の生きた pid への kill -0 は ESRCH にも EPERM にもならない（サブシェルは表 E で拒否）';
const SELF_NOT_MOVED = '$$／process.pid で取った記録は、その pid が生きている間 gone と判定されず、退かされない（退避ができるのは gone と判定された記録だけ）';
const LEADER = 'UAT の T1 の pid は G の長（サーバー）なので、pid が生きていれば G は空でない';
const D5_NOT_SELF = 'D5 を呼ぶのは down（新しいシェル）と run_lock_release の needs-head の後だけで、どちらも記録の pid は呼び手の $$ でない';

// ================================================================ table A (§2.2)
// TS and bash are written as separate objects and compared (I-11, decision 3): the wording differs, not the cell.

const TS_ACQUIRE = {
  none: by(c('acquired', 'mine'), c('acquired', 'mine'), r('unknown')),
  'ticket-ahead': by(r('ticket'), c('acquired', 'mine'), r('unknown')),
  'ownerless-young': all(r('ownerless-young')),
  'ownerless-old': by(c('expired-acquired', 'mine'), c('expired-acquired', 'mine'), r('unknown')),
  'ownerless-nonempty': all(r('ownerless-nonempty')),
  unreadable: all(r('unknown')),
  corrupt: all(r('corrupt')),
  'own-self': all(never(FRESH_TOKEN)),
  'own-other': all(never(FRESH_TOKEN)),
  foreign: by(r('held'), c('recovered-acquired', 'mine'), r('unknown')),
  'aside-own': all(never(FRESH_TOKEN)),
  'aside-foreign': by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
  'own-self-g': gAll(never(FRESH_TOKEN)),
  'own-self-selfg': gAll(never(NO_PGID_IN_TS)),
  'own-other-g': gAll(never(FRESH_TOKEN)),
  'foreign-g': pg(all(r('held')), by(r('held-group'), c('recovered-acquired', 'mine'), r('unknown')), all(r('unknown'))),
  'aside-own-g': gAll(never(FRESH_TOKEN)),
  'aside-foreign-g': pg(
    all(r('aside', 'restored')),
    by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
    all(r('unknown', 'restored'))
  ),
} satisfies CallerTable;

const SH_ACQUIRE = {
  none: by(c('acquired', 'mine'), c('acquired', 'mine'), r('unknown')),
  'ticket-ahead': by(r('ticket'), c('acquired', 'mine'), r('unknown')),
  'ownerless-young': all(r('ownerless-young')),
  'ownerless-old': by(c('expired-acquired', 'mine'), c('expired-acquired', 'mine'), r('unknown')),
  'ownerless-nonempty': all(r('ownerless-nonempty')),
  unreadable: all(r('unknown')),
  corrupt: all(r('corrupt')),
  'own-self': all(never(FRESH_TOKEN)),
  'own-other': all(never(FRESH_TOKEN)),
  foreign: by(r('held'), c('recovered-acquired', 'mine'), r('unknown')),
  'aside-own': all(never(FRESH_TOKEN)),
  'aside-foreign': by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
  'own-self-g': gAll(never(FRESH_TOKEN)),
  'own-self-selfg': gAll(rejected('handoff-pgid-self')),
  'own-other-g': gAll(never(FRESH_TOKEN)),
  'foreign-g': pg(all(r('held')), by(r('held-group'), c('recovered-acquired', 'mine'), r('unknown')), all(r('unknown'))),
  'aside-own-g': gAll(never(FRESH_TOKEN)),
  'aside-foreign-g': pg(
    all(r('aside', 'restored')),
    by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
    all(r('unknown', 'restored'))
  ),
} satisfies CallerTable;

/** D8: the owner is read once before the acquisition; a live record under the inherited token is the parent's. */
const TS_INHERIT = {
  none: by(c('acquired', 'mine'), c('acquired', 'mine'), r('unknown')),
  'ticket-ahead': by(r('ticket'), c('acquired', 'mine'), r('unknown')),
  'ownerless-young': all(r('ownerless-young')),
  'ownerless-old': by(c('expired-acquired', 'mine'), c('expired-acquired', 'mine'), r('unknown')),
  'ownerless-nonempty': all(r('ownerless-nonempty')),
  unreadable: all(r('unknown')),
  corrupt: all(r('corrupt')),
  'own-self': all(never(NOT_THE_PID)),
  'own-other': all(never(INHERIT_T1)),
  foreign: by(r('held'), c('recovered-acquired', 'mine'), r('unknown')),
  'aside-own': all(never(INHERIT_T1)),
  'aside-foreign': by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
  'own-self-g': gAll(never(NOT_THE_PID)),
  'own-self-selfg': gAll(never(NO_PGID_IN_TS)),
  'own-other-g': pg(
    by(c('inherited', 'unchanged'), never(IN_G), c('inherited', 'unchanged')),
    by(c('inherited', 'unchanged'), never(IN_G), r('unknown')),
    by(r('unknown'), never(IN_G), r('unknown'))
  ),
  'foreign-g': pg(all(r('held')), by(r('held-group'), c('recovered-acquired', 'mine'), r('unknown')), all(r('unknown'))),
  'aside-own-g': gAll(never(IN_G)),
  'aside-foreign-g': pg(
    all(r('aside', 'restored')),
    by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
    all(r('unknown', 'restored'))
  ),
} satisfies CallerTable;

const SH_INHERIT = {
  none: by(c('acquired', 'mine'), c('acquired', 'mine'), r('unknown')),
  'ticket-ahead': by(r('ticket'), c('acquired', 'mine'), r('unknown')),
  'ownerless-young': all(r('ownerless-young')),
  'ownerless-old': by(c('expired-acquired', 'mine'), c('expired-acquired', 'mine'), r('unknown')),
  'ownerless-nonempty': all(r('ownerless-nonempty')),
  unreadable: all(r('unknown')),
  corrupt: all(r('corrupt')),
  'own-self': all(never(NOT_THE_PID)),
  'own-other': all(never(INHERIT_T1)),
  foreign: by(r('held'), c('recovered-acquired', 'mine'), r('unknown')),
  'aside-own': all(never(INHERIT_T1)),
  'aside-foreign': by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
  'own-self-g': gAll(never(NOT_THE_PID)),
  'own-self-selfg': gAll(rejected('handoff-pgid-self')),
  'own-other-g': pg(
    by(c('inherited', 'unchanged'), never(IN_G), c('inherited', 'unchanged')),
    by(c('inherited', 'unchanged'), never(IN_G), r('unknown')),
    by(r('unknown'), never(IN_G), r('unknown'))
  ),
  'foreign-g': pg(all(r('held')), by(r('held-group'), c('recovered-acquired', 'mine'), r('unknown')), all(r('unknown'))),
  'aside-own-g': gAll(never(IN_G)),
  'aside-foreign-g': pg(
    all(r('aside', 'restored')),
    by(r('aside', 'restored'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
    all(r('unknown', 'restored'))
  ),
} satisfies CallerTable;

/** sync release (machine-lock-sync.mjs `release`): mine & pid = process.pid → removed; missing / another → cleanupOwnGone, kept. */
const TS_RELEASE = {
  none: all(kept),
  'ticket-ahead': all(kept),
  'ownerless-young': all(kept),
  'ownerless-old': all(kept),
  'ownerless-nonempty': all(kept),
  unreadable: all(deferred),
  corrupt: all(kept),
  'own-self': by(c('released', 'removed'), never(NODE_SELF), never(NODE_SELF)),
  'own-other': all(rejected('ts-pid-not-self')),
  foreign: all(kept),
  'aside-own': all(never(SELF_NOT_MOVED)),
  'aside-foreign': all(kept),
  'own-self-g': gAll(never(NO_PGID_IN_TS)),
  'own-self-selfg': gAll(never(NO_PGID_IN_TS)),
  'own-other-g': gAll(never(NO_PGID_IN_TS)),
  'foreign-g': gAll(kept),
  'aside-own-g': gAll(never(NO_PGID_IN_TS)),
  'aside-foreign-g': gAll(kept),
} satisfies CallerTable;

/** The inherited handle's release touches nothing (today's `() => undefined`), whatever the lock looks like. */
const TS_RELEASE_INHERITED = {
  none: all(noneResult),
  'ticket-ahead': all(noneResult),
  'ownerless-young': all(noneResult),
  'ownerless-old': all(noneResult),
  'ownerless-nonempty': all(noneResult),
  unreadable: all(noneResult),
  corrupt: all(noneResult),
  'own-self': all(noneResult),
  'own-other': all(noneResult),
  foreign: all(noneResult),
  'aside-own': all(noneResult),
  'aside-foreign': all(noneResult),
  'own-self-g': gAll(noneResult),
  'own-self-selfg': gAll(never(NO_PGID_IN_TS)),
  'own-other-g': gAll(noneResult),
  'foreign-g': gAll(noneResult),
  'aside-own-g': gAll(noneResult),
  'aside-foreign-g': gAll(noneResult),
} satisfies CallerTable;

/**
 * D12 (machine-lock.sh lock_release_held) in the main shell that took the lock with its own $$. G first,
 * then the pid; missing / corrupt / another token → kept and lock_release_own_gone (G only, F15).
 * needs-head → run_lock_release calls D5 with [T0, T1] in the same run (I-3): its outcome is the
 * sh-release-as-head cell of the same shape and observation.
 */
const SH_RELEASE_HELD = {
  none: all(kept),
  'ticket-ahead': all(kept),
  'ownerless-young': all(kept),
  'ownerless-old': all(kept),
  'ownerless-nonempty': all(kept),
  unreadable: all(deferred),
  corrupt: all(kept),
  'own-self': by(c('released', 'removed'), never(SH_SELF), never(SH_SELF)),
  'own-other': all(rejected('sh-release-after-foreign-pid')),
  foreign: all(kept),
  'aside-own': all(never(SELF_NOT_MOVED)),
  'aside-foreign': all(kept),
  'own-self-g': pg(by(deferred, c('released', 'removed'), deferred), all(never(SH_SELF)), all(never(SH_SELF))),
  'own-self-selfg': gAll(rejected('handoff-pgid-self')),
  'own-other-g': pg(by(deferred, never(LEADER), deferred), by(deferred, c('needs-head', 'unchanged', 'D5'), deferred), all(deferred)),
  'foreign-g': gAll(kept),
  'aside-own-g': pg(
    by(kept, never(LEADER), kept),
    by(kept, c('kept', 'aside-removed'), kept),
    by(kept, c('kept', 'aside-removed'), kept)
  ),
  'aside-foreign-g': gAll(kept),
} satisfies CallerTable;

/** D12 returns none at once when LOCK_HELD_PATH is not this lock (machine-lock.sh:199-200): nothing is read or removed. */
const SH_RELEASE_UNHELD = {
  none: all(noneResult),
  'ticket-ahead': all(noneResult),
  'ownerless-young': all(noneResult),
  'ownerless-old': all(noneResult),
  'ownerless-nonempty': all(noneResult),
  unreadable: all(noneResult),
  corrupt: all(noneResult),
  'own-self': all(noneResult),
  'own-other': all(noneResult),
  foreign: all(noneResult),
  'aside-own': all(noneResult),
  'aside-foreign': all(noneResult),
  'own-self-g': gAll(noneResult),
  'own-self-selfg': gAll(rejected('handoff-pgid-self')),
  'own-other-g': gAll(noneResult),
  'foreign-g': gAll(noneResult),
  'aside-own-g': gAll(noneResult),
  'aside-foreign-g': gAll(noneResult),
} satisfies CallerTable;

/** run_lock_set_pid: the checks of table E first, then lock_hand_off reads the owner once (token ≠ T0 → stage=token). */
const SH_HAND_OFF = {
  none: all(stageToken),
  'ticket-ahead': all(stageToken),
  'ownerless-young': all(stageToken),
  'ownerless-old': all(stageToken),
  'ownerless-nonempty': all(stageToken),
  unreadable: all(stageToken),
  corrupt: all(stageToken),
  'own-self': by(c('handed', 't1'), never(SH_SELF), never(SH_SELF)),
  'own-other': all(rejected('handoff-pid-not-self')),
  foreign: all(stageToken),
  'aside-own': all(never(SELF_NOT_MOVED)),
  'aside-foreign': all(stageToken),
  'own-self-g': gAll(rejected('handoff-twice')),
  'own-self-selfg': gAll(rejected('handoff-pgid-self')),
  'own-other-g': gAll(rejected('handoff-twice')),
  'foreign-g': gAll(stageToken),
  'aside-own-g': gAll(rejected('handoff-twice')),
  'aside-foreign-g': gAll(stageToken),
} satisfies CallerTable;

/** D5 (verify-run.sh lock_release_as_head): head within 10 s, one read, own token & holder gone → removed; missing → lock_release_own_gone. */
const SH_RELEASE_AS_HEAD = {
  none: all(missing),
  'ticket-ahead': by(c('not-head', 'unchanged', 'next-head'), missing, c('not-head', 'unchanged', 'next-head')),
  'ownerless-young': all(missing),
  'ownerless-old': all(missing),
  'ownerless-nonempty': all(missing),
  unreadable: all(c('unknown', 'unchanged', 'next-head')),
  corrupt: all(kept),
  'own-self': all(never(D5_NOT_SELF)),
  'own-other': by(deferred, c('released', 'removed'), deferred),
  foreign: all(kept),
  // lock_release_own_gone looks at G only, and a record with no pgid= has none (lock_group_state '' → gone, F15):
  // the pid axis is not observed. An own moved-aside record exists only after a head judged it gone (I-6).
  'aside-own': all(c('missing', 'aside-removed')),
  'aside-foreign': all(missing),
  'own-self-g': gAll(never(D5_NOT_SELF)),
  'own-self-selfg': gAll(rejected('handoff-pgid-self')),
  'own-other-g': pg(by(deferred, never(LEADER), deferred), by(deferred, c('released', 'removed'), deferred), all(deferred)),
  'foreign-g': gAll(kept),
  'aside-own-g': pg(
    by(missing, never(LEADER), missing),
    by(missing, c('missing', 'aside-removed'), missing),
    by(missing, c('missing', 'aside-removed'), missing)
  ),
  'aside-foreign-g': gAll(missing),
} satisfies CallerTable;

const TABLE_A = {
  'ts-acquire': TS_ACQUIRE,
  'ts-inherit': TS_INHERIT,
  'ts-release': TS_RELEASE,
  'ts-release-inherited': TS_RELEASE_INHERITED,
  'sh-acquire': SH_ACQUIRE,
  'sh-inherit': SH_INHERIT,
  'sh-release-held': SH_RELEASE_HELD,
  'sh-release-unheld': SH_RELEASE_UNHELD,
  'sh-hand-off': SH_HAND_OFF,
  'sh-release-as-head': SH_RELEASE_AS_HEAD,
} satisfies Record<Caller, CallerTable>;

interface RowA {
  id: string;
  caller: Caller;
  shape: Shape;
  pid: Obs;
  /** null for a P shape (no group axis) */
  group: Obs | null;
  cell: Cell;
}

const isG = (shape: Shape): shape is GShape => (G_SHAPES as readonly string[]).includes(shape);

const ROWS_A: RowA[] = CALLERS.flatMap((caller) =>
  SHAPES.flatMap((shape) =>
    OBS.flatMap((pid): RowA[] => {
      if (isG(shape)) {
        const table = TABLE_A[caller][shape] as ByPidG;
        return OBS.map((group) => ({ id: `${caller}/${shape}/pid-${pid}/g-${group}`, caller, shape, pid, group, cell: table[pid][group] }));
      }
      const table = TABLE_A[caller][shape as PShape] as ByObs;
      return [{ id: `${caller}/${shape}/${pid}`, caller, shape, pid, group: null, cell: table[pid] }];
    })
  )
);

// ================================================================ table B (§2.3, review-4288h P2-2)

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
      kind: 'reach';
      record: 'T0' | 'T1';
      childStarts: boolean;
      /** a fresh acquirer while a process of G (the waiting child or a member) is still there */
      takerWhileGroupLives: 'acquires' | 'refused';
      /** a fresh acquirer after G is empty */
      takerAfterGroupEmpty: 'acquires' | 'refused';
    }
  | { kind: 'never'; why: string };

const BEFORE_PUBLISH = (): LifeCell => ({ kind: 'reach', record: 'T0', childStarts: false, takerWhileGroupLives: 'acquires', takerAfterGroupEmpty: 'acquires' });
const PUBLISHED_NOT_SIGNALLED = (): LifeCell => ({ kind: 'reach', record: 'T1', childStarts: false, takerWhileGroupLives: 'refused', takerAfterGroupEmpty: 'acquires' });
const STARTED = (): LifeCell => ({ kind: 'reach', record: 'T1', childStarts: true, takerWhileGroupLives: 'refused', takerAfterGroupEmpty: 'acquires' });
const ONLY_THE_LEADER: LifeCell = { kind: 'never', why: '合図の受け取り（ack）の前の G は待っている長 1 人だけで、長と別に残るメンバーは居ない' };

const LIFECYCLE_UAT = {
  forked: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  group: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  tmp: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  published: { 'parent-kill9': PUBLISHED_NOT_SIGNALLED(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  signalled: { 'parent-kill9': STARTED(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  acked: { 'parent-kill9': STARTED(), 'leader-dies-member-stays': STARTED() },
} satisfies Record<Stage, Record<LifeEvent, LifeCell>>;

const LIFECYCLE_DAILY = {
  forked: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  group: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  tmp: { 'parent-kill9': BEFORE_PUBLISH(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  published: { 'parent-kill9': PUBLISHED_NOT_SIGNALLED(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  signalled: { 'parent-kill9': STARTED(), 'leader-dies-member-stays': ONLY_THE_LEADER },
  acked: { 'parent-kill9': STARTED(), 'leader-dies-member-stays': STARTED() },
} satisfies Record<Stage, Record<LifeEvent, LifeCell>>;

/** UAT and daily share the cells; what differs is whose pid the T1 record names (§2.3). */
const TABLE_B = { uat: LIFECYCLE_UAT, daily: LIFECYCLE_DAILY } satisfies Record<Flow, Record<Stage, Record<LifeEvent, LifeCell>>>;

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

// ================================================================ table C (§2.4, review-4288h P2-3, PM P1-1)

/** What down reads before it signals anything: the lock's record against uat-run.state. */
const RECORDS_C = [
  't1', // the record is this run's T1 (state's lock_token, or <run_id>-g<server_pid>; pgid=server_pid)
  't0-up-alive', // the record is this run's T0 (token run_id, pid = up ≠ server_pid) and up is still alive
  't0-up-dead', // the same and up is dead (up died before the publish)
  'old', // an older up: no lock_token in the state and no pgid= in the record (pid = server_pid)
  'other', // the record's token is none of this run's (a head recovered ours, another run took it)
  'absent', // no <lock>
] as const;
type RecordC = (typeof RECORDS_C)[number];

/** The server recorded in uat-run.state (`server_pid` = G) when `down` runs. */
const LEADERS = [
  'alive-verified', // kill -0 alive, not a zombie, CM_DB_PATH under the run dir, listening alone on the port, ps -o pgid= says G (old: no pgid check)
  'alive-unverified', // alive, and one of those checks failed or could not be made (EPERM on a reused pid included)
  'zombie', // kill -0 alive but ps -o stat= says Z
  'dead', // kill -0 ESRCH
  'unrecorded', // no server_pid in the state (up died before recording it)
] as const;
type Leader = (typeof LEADERS)[number];

/** The rest of G (kill -0 -G, ps -A -o pid=,pgid=, and each member's CM_DB_PATH). Not observed for 'old'. */
const MEMBERS = [
  'none', // ESRCH: nobody else in G (for 'old': G is not observed)
  'verified', // members, every one with CM_DB_PATH under the run dir
  'unverified', // members, one of them without that (or its environment unreadable, or a zombie)
  'unknown', // kill -0 -G or ps could not say (EPERM, a failure)
] as const;
type Members = (typeof MEMBERS)[number];

const D5_RESULTS = ['released', 'missing', 'deferred', 'kept', 'not-head', 'unknown'] as const;
type D5Result = (typeof D5_RESULTS)[number];

type DownStatus = 'stopped' | 'stop-refused' | 'stop-refused-group' | 'stop-refused-lock';
type DownMsg = 'stopped' | 'unverified' | 'zombie' | 'group-left' | 'up-running' | 'other-holder' | 'holder-alive' | 'not-head' | 'unreadable' | 'corrupt';

/** C': the one rule from D5's result to down's status (PM: stopped / 0 only on released or missing). */
const D5_TO_STATUS = {
  released: { status: 'stopped', exit: 0, msg: 'stopped' },
  missing: { status: 'stopped', exit: 0, msg: 'stopped' },
  deferred: { status: 'stop-refused-lock', exit: 1, msg: 'holder-alive' },
  kept: { status: 'stop-refused-lock', exit: 1, msg: 'other-holder' },
  'not-head': { status: 'stop-refused-lock', exit: 1, msg: 'not-head' },
  unknown: { status: 'stop-refused-lock', exit: 1, msg: 'unreadable' },
} satisfies Record<D5Result, { status: DownStatus; exit: 0 | 1; msg: DownMsg }>;

type Signals = 'none' | 'leader' | 'leader+group' | 'group';
type DownCell =
  | { kind: 'reach'; signals: Signals; d5: D5Result | 'not-called'; status: DownStatus; exit: 0 | 1; msg: DownMsg }
  | { kind: 'never'; why: string };

const NO_G: DownCell = { kind: 'never', why: 'server_pid が無ければ G を名指せない（I-6: server_pid は引渡しの前に状態ファイルへ書き、書けなければ引き渡さずに exit 1）' };
const T1_HAS_LEADER: DownCell = { kind: 'never', why: 'T1 は server_pid を書いた後にだけ公開される（I-6）ので、記録が T1 なら server_pid はある' };
const PRE_PUBLISH_G: DownCell = { kind: 'never', why: '公開の前（記録が T0）の G は合図を待つ子 1 人だけで、長と別のメンバーは居ない（I-7）' };
const OLD_NO_G: DownCell = { kind: 'never', why: '旧い up は G を作らない（set -m 無し）ので、旧い形では G を観測しない（今の pid だけの停止、PM 決定 2）' };
const OLD_HAS_LEADER: DownCell = { kind: 'never', why: '旧い形の記録の pid は server_pid（旧い run_lock_set_pid は server_pid を書いた後）' };
const OTHER_AFTER_RECOVERY: DownCell = {
  kind: 'never',
  why: '記録が他の token に替わるのは、先頭が我々の記録を gone と判定して回収した後だけ。T1 なら G はそのとき空で、T0 なら G は待つ子 1 人だった',
};

const dc = (signals: Signals, d5: D5Result | 'not-called', status: DownStatus, exit: 0 | 1, msg: DownMsg): DownCell => ({ kind: 'reach', signals, d5, status, exit, msg });
/** After the signals, down calls D5 and takes its status from C'. */
const thenD5 = (signals: Signals, d5: D5Result): DownCell => dc(signals, d5, D5_TO_STATUS[d5].status, D5_TO_STATUS[d5].exit, D5_TO_STATUS[d5].msg);
const UNVERIFIED = dc('none', 'not-called', 'stop-refused', 1, 'unverified');
const ZOMBIE = dc('none', 'not-called', 'stop-refused', 1, 'zombie');
const GROUP_LEFT = (signals: Signals): DownCell => dc(signals, 'not-called', 'stop-refused-group', 1, 'group-left');
const UP_RUNNING = dc('none', 'not-called', 'stop-refused-lock', 1, 'up-running');

/** New-form signalling (I-10) followed by D5 whose result the record decides. */
const newForm = (d5: D5Result) => ({
  'alive-verified': { none: thenD5('leader', d5), verified: thenD5('leader+group', d5), unverified: thenD5('leader+group', d5), unknown: GROUP_LEFT('leader') },
  'alive-unverified': { none: UNVERIFIED, verified: UNVERIFIED, unverified: UNVERIFIED, unknown: UNVERIFIED },
  zombie: { none: ZOMBIE, verified: ZOMBIE, unverified: ZOMBIE, unknown: ZOMBIE },
  dead: { none: thenD5('none', d5), verified: thenD5('group', d5), unverified: GROUP_LEFT('none'), unknown: GROUP_LEFT('none') },
});

const TABLE_C = {
  t1: { ...newForm('released'), unrecorded: { none: T1_HAS_LEADER, verified: T1_HAS_LEADER, unverified: T1_HAS_LEADER, unknown: T1_HAS_LEADER } },
  't0-up-alive': {
    'alive-verified': { none: UP_RUNNING, verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    'alive-unverified': { none: UP_RUNNING, verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    zombie: { none: UP_RUNNING, verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    dead: { none: UP_RUNNING, verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    unrecorded: { none: UP_RUNNING, verified: NO_G, unverified: NO_G, unknown: NO_G },
  },
  't0-up-dead': {
    'alive-verified': { none: thenD5('leader', 'released'), verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    'alive-unverified': { none: UNVERIFIED, verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    zombie: { none: ZOMBIE, verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    dead: { none: thenD5('none', 'released'), verified: PRE_PUBLISH_G, unverified: PRE_PUBLISH_G, unknown: PRE_PUBLISH_G },
    unrecorded: { none: thenD5('none', 'released'), verified: NO_G, unverified: NO_G, unknown: NO_G },
  },
  old: {
    'alive-verified': { none: thenD5('leader', 'released'), verified: OLD_NO_G, unverified: OLD_NO_G, unknown: OLD_NO_G },
    'alive-unverified': { none: UNVERIFIED, verified: OLD_NO_G, unverified: OLD_NO_G, unknown: OLD_NO_G },
    zombie: { none: ZOMBIE, verified: OLD_NO_G, unverified: OLD_NO_G, unknown: OLD_NO_G },
    dead: { none: thenD5('none', 'released'), verified: OLD_NO_G, unverified: OLD_NO_G, unknown: OLD_NO_G },
    unrecorded: { none: OLD_HAS_LEADER, verified: OLD_HAS_LEADER, unverified: OLD_HAS_LEADER, unknown: OLD_HAS_LEADER },
  },
  other: {
    'alive-verified': { none: thenD5('leader', 'kept'), verified: OTHER_AFTER_RECOVERY, unverified: OTHER_AFTER_RECOVERY, unknown: OTHER_AFTER_RECOVERY },
    'alive-unverified': { none: UNVERIFIED, verified: OTHER_AFTER_RECOVERY, unverified: OTHER_AFTER_RECOVERY, unknown: OTHER_AFTER_RECOVERY },
    zombie: { none: ZOMBIE, verified: OTHER_AFTER_RECOVERY, unverified: OTHER_AFTER_RECOVERY, unknown: OTHER_AFTER_RECOVERY },
    dead: { none: thenD5('none', 'kept'), verified: OTHER_AFTER_RECOVERY, unverified: OTHER_AFTER_RECOVERY, unknown: OTHER_AFTER_RECOVERY },
    unrecorded: { none: thenD5('none', 'kept'), verified: NO_G, unverified: NO_G, unknown: NO_G },
  },
  absent: { ...newForm('missing'), unrecorded: { none: thenD5('none', 'missing'), verified: NO_G, unverified: NO_G, unknown: NO_G } },
} satisfies Record<RecordC, Record<Leader, Record<Members, DownCell>>>;

interface RowC {
  id: string;
  record: RecordC;
  leader: Leader;
  members: Members;
  cell: DownCell;
}

const ROWS_C: RowC[] = RECORDS_C.flatMap((record) =>
  LEADERS.flatMap((leader) => MEMBERS.map((members) => ({ id: `${record}/${leader}/${members}`, record, leader, members, cell: TABLE_C[record][leader][members] })))
);

// ================================================================ table D (§2.5, PM Claude P2-3)

/** A handover step that fails while the parent (UAT up / daily.sh) is alive. */
const HANDOFF_FAILURES = [
  'state-write', // state_set server_pid fails (UAT only, before the handover — I-6)
  'group', // ps -o pgid= of the child is not its pid, or unknown (stage=group)
  'tmp', // the .owner-T1 tmp cannot be written (stage=tmp)
  'mv', // the mv of the tmp over owner fails (stage=mv)
  'verify', // the owner read back after the mv is not T1 with pgid=G (stage=verify)
  'verify-unreadable', // the owner cannot be read back after the mv (stage=verify, owner unknown)
  'signal', // mkdir go fails and go is not there (stage=signal)
  'abort', // go already exists: the child withdrew first, past its deadline (stage=abort)
  'ack', // the child's mkdir ack fails: it exits without exec
  'child-exits', // the child exec'd and exits at once (UAT: the server cannot start; daily: run.ts fails)
] as const;
type HandoffFailure = (typeof HANDOFF_FAILURES)[number];

type Release =
  | 'D12-released' // T0 = the parent's own record, removed by D12
  | 'D12-needs-head-D5-released' // T1 (UAT: pid = server): G emptied, D12 needs-head, D5 released
  | 'D12-released-after-drain' // daily's T1 (pid = $$): G emptied, D12 released
  | 'D12-deferred' // the owner cannot be read: kept for the next head
  | 'stop-then-D5'; // UAT after go: the trap runs down's procedure (table C, record t1)

type FailMsg = `handoff-failed stage=${string}` | 'state-write-failed' | 'server-exited' | 'run-exited';

type FailCell =
  | {
      kind: 'reach';
      record: 'T0' | 'T1' | 'unknown';
      /** what the parent sends before it releases: pid only before the publish, -G (checked: leader alive and its pgid is G) after */
      signals: 'pid' | 'group' | 'none';
      child: 'never-starts' | 'exits' | 'ran';
      release: Release;
      lockAfter: 'removed' | 'kept';
      /** UAT: uat-run.state status; daily: the report's sync status */
      status: 'failed' | 'failed-lock-left' | 'sync-failed' | 'run-exit';
      exit: 1 | 2 | 'child';
      msg: FailMsg;
    }
  | { kind: 'never'; why: string };

const uatPre = (stage: string): FailCell => ({ kind: 'reach', record: 'T0', signals: 'pid', child: 'never-starts', release: 'D12-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: `handoff-failed stage=${stage}` });
const dailyPre = (stage: string): FailCell => ({ kind: 'reach', record: 'T0', signals: 'pid', child: 'never-starts', release: 'D12-released', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: `handoff-failed stage=${stage}` });

const TABLE_D = {
  uat: {
    'state-write': { kind: 'reach', record: 'T0', signals: 'pid', child: 'never-starts', release: 'D12-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'state-write-failed' },
    group: uatPre('group'),
    tmp: uatPre('tmp'),
    mv: uatPre('mv'),
    verify: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-needs-head-D5-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'handoff-failed stage=verify' },
    'verify-unreadable': { kind: 'reach', record: 'unknown', signals: 'group', child: 'never-starts', release: 'D12-deferred', lockAfter: 'kept', status: 'failed-lock-left', exit: 1, msg: 'handoff-failed stage=verify' },
    signal: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-needs-head-D5-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'handoff-failed stage=signal' },
    abort: { kind: 'reach', record: 'T1', signals: 'none', child: 'never-starts', release: 'D12-needs-head-D5-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'handoff-failed stage=abort' },
    ack: { kind: 'reach', record: 'T1', signals: 'none', child: 'exits', release: 'stop-then-D5', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'server-exited' },
    'child-exits': { kind: 'reach', record: 'T1', signals: 'none', child: 'ran', release: 'stop-then-D5', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'server-exited' },
  },
  daily: {
    'state-write': { kind: 'never', why: 'daily は状態ファイルを書かない（記録の pid は daily.sh 自身の $$）' },
    group: dailyPre('group'),
    tmp: dailyPre('tmp'),
    mv: dailyPre('mv'),
    verify: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=verify' },
    'verify-unreadable': { kind: 'reach', record: 'unknown', signals: 'group', child: 'never-starts', release: 'D12-deferred', lockAfter: 'kept', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=verify' },
    signal: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=signal' },
    abort: { kind: 'reach', record: 'T1', signals: 'none', child: 'never-starts', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=abort' },
    ack: { kind: 'reach', record: 'T1', signals: 'none', child: 'exits', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=ack' },
    'child-exits': { kind: 'reach', record: 'T1', signals: 'none', child: 'ran', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'run-exit', exit: 'child', msg: 'run-exited' },
  },
} satisfies Record<Flow, Record<HandoffFailure, FailCell>>;

interface RowD {
  id: string;
  flow: Flow;
  failure: HandoffFailure;
  cell: FailCell;
}

const ROWS_D: RowD[] = FLOWS.flatMap((flow) => HANDOFF_FAILURES.map((failure) => ({ id: `${flow}/${failure}`, flow, failure, cell: TABLE_D[flow][failure] })));

// ================================================================ table D2 (§2.6): odd observations, all on the keeping side

const ODD = [
  'zombie', // a recorded pid / G member is a zombie: kill -0 says alive
  'host-changed', // the record's host= is not today's hostname: lock_holder_state says alive
  'eperm-pid', // kill -0 <pid> is EPERM (the pid was reused by another user)
  'eperm-group', // kill -0 -G is EPERM (a member of G belongs to another user)
  'group-not-emptied', // TERM / grace / KILL to -G and G is still not empty (uninterruptible, EPERM, a zombie)
] as const;
type Odd = (typeof ODD)[number];

const ODD_CALLERS = ['acquire', 'daily-exit', 'uat-trap', 'down'] as const;
type OddCaller = (typeof ODD_CALLERS)[number];

type OddCell =
  | { kind: 'reach'; result: 'refused' | 'deferred' | 'released' | 'stop-refused' | 'stop-refused-group' | 'stop-refused-lock'; lock: 'kept' | 'removed'; msg: string }
  | { kind: 'never'; why: string };

const TABLE_D2 = {
  zombie: {
    acquire: { kind: 'reach', result: 'refused', lock: 'kept', msg: 'held … (zombie: its parent <ppid> has not reaped it)' },
    'daily-exit': { kind: 'never', why: 'daily の EXIT は長を wait する lock_stop_gate で G を空にする（§4.2）ので、長はゾンビで残らない。G の他のゾンビは group-not-emptied の行' },
    'uat-trap': { kind: 'never', why: 'up の trap はサーバー（up の子）に送った後 wait する（§2.4）ので、長はゾンビで残らない' },
    down: { kind: 'reach', result: 'stop-refused', lock: 'kept', msg: 'zombie: pid N (parent P has not reaped it)' },
  },
  'host-changed': {
    acquire: { kind: 'reach', result: 'refused', lock: 'kept', msg: 'held … (recorded on host H, this host is H2: remove <lock> by hand if H is this machine)' },
    'daily-exit': { kind: 'reach', result: 'released', lock: 'removed', msg: '' },
    'uat-trap': { kind: 'reach', result: 'deferred', lock: 'kept', msg: 'release-deferred (holder on host H)' },
    down: { kind: 'reach', result: 'stop-refused-lock', lock: 'kept', msg: 'holder-alive (recorded on host H)' },
  },
  'eperm-pid': {
    acquire: { kind: 'reach', result: 'refused', lock: 'kept', msg: 'unknown point=… errno=EPERM' },
    'daily-exit': { kind: 'never', why: SH_SELF },
    'uat-trap': { kind: 'reach', result: 'deferred', lock: 'kept', msg: 'release-deferred (recorded pid N is unknown:EPERM)' },
    down: { kind: 'reach', result: 'stop-refused', lock: 'kept', msg: 'unverified: pid N cannot be observed (EPERM)' },
  },
  'eperm-group': {
    acquire: { kind: 'reach', result: 'refused', lock: 'kept', msg: 'unknown point=group errno=EPERM' },
    'daily-exit': { kind: 'reach', result: 'deferred', lock: 'kept', msg: 'release-deferred pgid=G' },
    'uat-trap': { kind: 'reach', result: 'deferred', lock: 'kept', msg: 'release-deferred pgid=G' },
    down: { kind: 'reach', result: 'stop-refused-group', lock: 'kept', msg: 'group-left: G cannot be shown empty (EPERM)' },
  },
  'group-not-emptied': {
    acquire: { kind: 'never', why: '取得は G に信号を送らない' },
    'daily-exit': { kind: 'reach', result: 'deferred', lock: 'kept', msg: 'release-deferred pgid=G (left: <pids>)' },
    'uat-trap': { kind: 'reach', result: 'deferred', lock: 'kept', msg: 'release-deferred pgid=G (left: <pids>)' },
    down: { kind: 'reach', result: 'stop-refused-group', lock: 'kept', msg: 'group-left: <pids> still in G after KILL' },
  },
} satisfies Record<Odd, Record<OddCaller, OddCell>>;

interface RowD2 {
  id: string;
  odd: Odd;
  caller: OddCaller;
  cell: OddCell;
}

const ROWS_D2: RowD2[] = ODD.flatMap((odd) => ODD_CALLERS.map((caller) => ({ id: `${odd}/${caller}`, odd, caller, cell: TABLE_D2[odd][caller] })));

// ================================================================ table E (§4.2): the checks that make rows "rejected"

const IMPLS = ['ts', 'sh'] as const;
type Impl = (typeof IMPLS)[number];

type CheckCell =
  | { kind: 'reach'; result: 'refused-arg'; touches: 'nothing'; how: string }
  | { kind: 'never'; why: string };

const refusedArg = (how: string): CheckCell => ({ kind: 'reach', result: 'refused-arg', touches: 'nothing', how });
const NO_HANDOFF_IN_TS: CheckCell = { kind: 'never', why: 'TS は handOff を出さない（main.ts は子にロックを渡さない）' };
const NO_SUBSHELL_IN_TS: CheckCell = { kind: 'never', why: 'Node にサブシェルは無い' };

const TABLE_E = {
  'token-chars': { ts: refusedArg('{ ok: false, error }'), sh: refusedArg('RUN_LOCK_ERROR, 1') },
  'field-newline': { ts: refusedArg('{ ok: false, error }'), sh: refusedArg('RUN_LOCK_ERROR, 1') },
  'ts-pid-not-self': {
    ts: refusedArg('{ ok: false, error }'),
    sh: { kind: 'never', why: 'bash の取得は pid≠$$ を受ける（F9、run-lock-3359.test.ts の TS↔bash の読み合わせ）。代わりにその取得の解放と引渡しを拒む' },
  },
  'sh-release-after-foreign-pid': {
    ts: { kind: 'never', why: 'TS は pid≠process.pid の取得を拒む（ts-pid-not-self）' },
    sh: refusedArg('RUN_LOCK_ERROR, 1; the record stays until its pid dies and the next head recovers it'),
  },
  'handoff-pid-not-self': { ts: NO_HANDOFF_IN_TS, sh: refusedArg('stage=arg, 1; nothing written, LOCK_PENDING_TOKEN not set') },
  'handoff-pgid-self': { ts: NO_HANDOFF_IN_TS, sh: refusedArg('stage=arg, 1') },
  'handoff-twice': { ts: NO_HANDOFF_IN_TS, sh: refusedArg('stage=arg, 1') },
  'handoff-subshell': { ts: NO_HANDOFF_IN_TS, sh: refusedArg('stage=arg, 1') },
  'release-subshell': { ts: NO_SUBSHELL_IN_TS, sh: refusedArg('RUN_LOCK_ERROR, 1; D12 is not called') },
  'machine-lock-unloaded': {
    ts: { kind: 'never', why: 'TS は machine-lock-sync.mjs を静的に import する（読めなければプロセスが起動しない）' },
    sh: refusedArg('source returns 0 with the functions defined; run_lock_acquire / set_pid / release return 1 with RUN_LOCK_ERROR "machine-lock not loaded: …"'),
  },
} satisfies Record<CheckId, Record<Impl, CheckCell>>;

interface RowE {
  id: string;
  check: CheckId;
  impl: Impl;
  cell: CheckCell;
}

const ROWS_E: RowE[] = CHECKS.flatMap((check) => IMPLS.map((impl) => ({ id: `${check}/${impl}`, check, impl, cell: TABLE_E[check][impl] })));

// ================================================================ the invariants (§1) over the rows

const withoutSelfGroup = (table: CallerTable): Partial<CallerTable> =>
  Object.fromEntries(Object.entries(table).filter(([shape]) => shape !== 'own-self-selfg')) as Partial<CallerTable>;
const kindOf = (cell: { kind: string }): string => cell.kind;
const count = <T extends { cell: { kind: string } }>(rows: T[], kind: string): number => rows.filter((row) => kindOf(row.cell) === kind).length;
const reachRows = <T extends { cell: { kind: string } }>(rows: T[]): T[] => rows.filter((row) => row.cell.kind === 'reach');

const TAKES: readonly Result[] = ['acquired', 'recovered-acquired', 'expired-acquired', 'reclaimed-acquired'];
const implOf = (caller: Caller): Impl => (caller.startsWith('ts-') ? 'ts' : 'sh');

/**
 * I-1: the canonical lock is removed only by the self path (D12 / the sync release: pid alive, and G gone when
 * the record names one) or by the head on a gone holder (D5: pid gone, and G gone when the record names one).
 */
function removalAllowed(row: RowA): boolean {
  if (row.caller === 'ts-release') return row.shape === 'own-self' && row.pid === 'alive';
  if (row.caller === 'sh-release-held') {
    if (row.shape === 'own-self') return row.pid === 'alive';
    if (row.shape === 'own-self-g') return row.pid === 'alive' && row.group === 'gone';
    return false;
  }
  if (row.caller === 'sh-release-as-head') {
    if (row.shape === 'own-other') return row.pid === 'gone';
    if (row.shape === 'own-other-g') return row.pid === 'gone' && row.group === 'gone';
    return false;
  }
  return false;
}

/** The own moved-aside record is removed on G only; a record without pgid= has no G to observe (F15). */
function asideRemovalAllowed(row: RowA): boolean {
  if (row.shape === 'aside-own') return row.caller === 'sh-release-as-head';
  if (row.shape === 'aside-own-g') return (row.caller === 'sh-release-held' || row.caller === 'sh-release-as-head') && row.group === 'gone';
  return false;
}

/** I-2: does the cell turn on an axis that was unknown? (the pid axis of aside-own is not observed — F15) */
function decidedOnUnknown(row: RowA, cell: Reach): boolean {
  if (cell.after === 'aside-removed') return row.group === 'unknown';
  if (row.group === null) return row.pid === 'unknown';
  // D12 asks G first and the pid only when G is gone (machine-lock.sh lock_release_held).
  if (row.caller === 'sh-release-held') return row.group === 'unknown' || (row.group === 'gone' && row.pid === 'unknown');
  // The holder judgement asks the pid first and G only when the pid is gone (verify-run.sh lock_holder_state).
  return row.pid === 'unknown' || (row.pid === 'gone' && row.group === 'unknown');
}

describe('#4288 PR1b table A: record shape × caller × pid × G (docs/design/run-lock-machine-lock-4288.md §2.2)', () => {
  it('has every combination of the enumerations: 10 callers × (12 shapes × 3 + 6 shapes × 9) = 900 rows', () => {
    expect(ROWS_A).toHaveLength(CALLERS.length * (P_SHAPES.length * OBS.length + G_SHAPES.length * OBS.length * OBS.length));
    expect(ROWS_A).toHaveLength(900);
    expect({ reach: count(ROWS_A, 'reach'), rejected: count(ROWS_A, 'rejected'), never: count(ROWS_A, 'never') }).toEqual({ reach: 578, rejected: 90, never: 232 });
    expect(new Set(ROWS_A.map((row) => row.id)).size).toBe(ROWS_A.length);
  });

  it.each(ROWS_A.filter((row) => row.cell.kind === 'never'))('$id is unreachable for a stated reason', (row) => {
    expect(row.cell.kind === 'never' && row.cell.why.length > 0).toBe(true);
  });

  it.each(ROWS_A.filter((row) => row.cell.kind === 'rejected'))('$id is refused by a check of table E for its implementation', (row) => {
    if (row.cell.kind !== 'rejected') throw new Error('filtered');
    expect(TABLE_E[row.cell.check][implOf(row.caller)].kind).toBe('reach');
  });

  it.each(reachRows(ROWS_A))('$id keeps the invariants of §1 (I-1 removal, I-2 unknown, I-3 next, I-5, I-6)', (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    const cell = row.cell;
    expect(RESULTS).toContain(cell.result);
    // I-1: the canonical lock is removed only on the allowed paths; nobody else removes it.
    expect(cell.after === 'removed').toBe(removalAllowed(row));
    if (cell.result === 'released') expect(cell.after).toBe('removed');
    if (cell.after === 'aside-removed') expect(asideRemovalAllowed(row)).toBe(true);
    // I-2: an unknown that the cell turns on is never read as free — no take, inheritance, removal, handover.
    if (decidedOnUnknown(row, cell)) {
      expect([...TAKES, 'inherited', 'released', 'handed']).not.toContain(cell.result);
      expect(['removed', 'mine', 't1', 'aside-removed']).not.toContain(cell.after);
    }
    // I-3: needs-head goes to D5 in the same run; deferred / not-head / unknown are left to the next head.
    if (cell.result === 'needs-head') expect(cell.next).toBe('D5');
    if (cell.result === 'deferred' || cell.result === 'not-head' || cell.result === 'unknown') expect(cell.next).toBe('next-head');
    if (cell.next === 'D5') expect(cell.result).toBe('needs-head');
    // needs-head only where D12 meets a record whose pid is not this shell's — UAT's T1 after its G emptied.
    if (cell.result === 'needs-head') expect([row.caller, row.shape, row.pid, row.group]).toEqual(['sh-release-held', 'own-other-g', 'gone', 'gone']);
    // A take leaves the caller holding <lock>; nothing else does. A refusal names its wording.
    expect(TAKES.includes(cell.result)).toBe(cell.after === 'mine');
    if (cell.result === 'refused') expect(REFUSE_MSGS).toContain(cell.msg);
    // I-5: the self-group shape is never reached (run_lock_set_pid refuses pgid = $$).
    expect(row.shape).not.toBe('own-self-selfg');
    // I-6: a handover leaves T1 on record, and only a handover from the caller's own live T0 does.
    expect(cell.result === 'handed').toBe(cell.after === 't1');
    if (cell.result === 'handed') expect([row.caller, row.shape, row.pid]).toEqual(['sh-hand-off', 'own-self', 'alive']);
  });

  it('TS and bash agree on every acquisition and inheritance cell — two objects written apart (I-11)', () => {
    expect(TS_ACQUIRE).not.toBe(SH_ACQUIRE);
    expect(TS_INHERIT).not.toBe(SH_INHERIT);
    // own-self-selfg differs only in why it is not reached: TS never writes pgid=, bash refuses it (table E).
    expect(withoutSelfGroup(TS_ACQUIRE)).toEqual(withoutSelfGroup(SH_ACQUIRE));
    expect(withoutSelfGroup(TS_INHERIT)).toEqual(withoutSelfGroup(SH_INHERIT));
  });

  it('no own-self-selfg row is reached: bash rejects it by handoff-pgid-self, TS never writes pgid= (I-5)', () => {
    const rows = ROWS_A.filter((row) => row.shape === 'own-self-selfg');
    expect(rows).toHaveLength(CALLERS.length * 9);
    for (const row of rows) {
      if (implOf(row.caller) === 'sh') expect(row.cell).toEqual({ kind: 'rejected', check: 'handoff-pgid-self' });
      else expect(row.cell).toEqual({ kind: 'never', why: NO_PGID_IN_TS });
    }
  });

  for (const caller of CALLERS) {
    it.todo(
      `PR1b: drive ${caller} over its ${reachRows(ROWS_A.filter((row) => row.caller === caller)).length} reachable rows in an os.tmpdir() lock (pid and G set apart: a live pid, an ESRCH pid with a live member of G, …) and assert result / after / next / wording`
    );
  }
  it.todo('PR1b (I-11): run TS and bash on the same rows of the acquisition and inheritance columns and compare what each did');
});

describe('#4288 PR1b table B: the D9 handover — stage × flow × event (§2.3, review-4288h P2-2)', () => {
  it('has every combination, 24 rows (10 never, 14 reachable)', () => {
    expect(ROWS_B).toHaveLength(FLOWS.length * STAGES.length * EVENTS.length);
    expect(ROWS_B).toHaveLength(24);
    expect(count(ROWS_B, 'never')).toBe(10);
    expect(count(ROWS_B, 'reach')).toBe(14);
  });

  it.each(reachRows(ROWS_B))('$id: the child works only after the signal, and a published G is never taken over (I-7)', (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    const at = STAGES.indexOf(row.stage);
    const published = at >= STAGES.indexOf('published');
    expect(row.cell.record).toBe(published ? 'T1' : 'T0');
    expect(row.cell.childStarts).toBe(at >= STAGES.indexOf('signalled'));
    // Before the publish the record names no group: the next head may recover it — the waiting
    // child withdraws and never starts (P2-2: tmp is not published). From the publish on, G holds.
    expect(row.cell.takerWhileGroupLives).toBe(published ? 'refused' : 'acquires');
    expect(row.cell.takerAfterGroupEmpty).toBe('acquires');
  });

  it('UAT and daily are two objects with the same cells', () => {
    expect(LIFECYCLE_UAT).not.toBe(LIFECYCLE_DAILY);
    expect(LIFECYCLE_UAT).toEqual(LIFECYCLE_DAILY);
  });

  for (const flow of FLOWS) {
    it.todo(`PR1b: run the ${flow} handover with a fake child, stop at each stage (CM_VERIFY_TEST_HANDOFF=pause:<stage>), deliver the event, assert the row`);
  }
});

describe('#4288 PR1b table C: UAT down — record × leader × the rest of its group (§2.4, review-4288h P2-3, PM P1-1)', () => {
  it('has every combination, 120 rows (68 never, 52 reachable), and C′ covers every D5 result', () => {
    expect(ROWS_C).toHaveLength(RECORDS_C.length * LEADERS.length * MEMBERS.length);
    expect(ROWS_C).toHaveLength(120);
    expect(count(ROWS_C, 'never')).toBe(68);
    expect(count(ROWS_C, 'reach')).toBe(52);
    expect(Object.keys(D5_TO_STATUS).sort()).toEqual([...D5_RESULTS].sort());
  });

  it.each(reachRows(ROWS_C))('$id: G is signalled only when shown to be the run’s, and “stopped” only on D5 released / missing (I-10, C′)', (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    const cell = row.cell;
    // I-10: signals only to a verified live leader, or to a verified rest of G after the leader died.
    if (cell.signals === 'leader' || cell.signals === 'leader+group') expect(row.leader).toBe('alive-verified');
    if (cell.signals === 'leader+group') expect(['verified', 'unverified']).toContain(row.members);
    if (cell.signals === 'group') expect([row.leader, row.members]).toEqual(['dead', 'verified']);
    if (row.record === 't0-up-alive') expect(cell.signals).toBe('none');
    if (row.leader === 'alive-unverified' || row.leader === 'zombie') expect(cell.signals).toBe('none');
    // P2-4: an unknown G is never signalled.
    if (row.members === 'unknown') expect(cell.signals === 'group' || cell.signals === 'leader+group').toBe(false);
    // C′: stopped / 0 iff D5 said released or missing; otherwise the lock is not claimed to be gone.
    if (cell.d5 !== 'not-called') {
      expect([cell.status, cell.exit, cell.msg]).toEqual([D5_TO_STATUS[cell.d5].status, D5_TO_STATUS[cell.d5].exit, D5_TO_STATUS[cell.d5].msg]);
    }
    expect(cell.status === 'stopped').toBe(cell.d5 === 'released' || cell.d5 === 'missing');
    expect(cell.exit).toBe(cell.status === 'stopped' ? 0 : 1);
    // PM P1-1: down cleans this run's own T1 for sure once G is empty (the row the refusal of up points to).
    if (row.record === 't1' && (row.members === 'none' || row.members === 'verified') && (row.leader === 'alive-verified' || row.leader === 'dead')) {
      expect([cell.d5, cell.status]).toEqual(['released', 'stopped']);
    }
  });

  it.each(D5_RESULTS)('C′ %s: stopped / exit 0 only on released or missing (PM 決定 3)', (d5) => {
    const rule = D5_TO_STATUS[d5];
    const gone = d5 === 'released' || d5 === 'missing';
    expect(rule.status === 'stopped').toBe(gone);
    expect(rule.exit).toBe(gone ? 0 : 1);
  });

  it.todo('PR1b: run down against a fake server (a sh that exec’s sleep, with a member in its group) for each reachable row and assert signals / D5 / status / exit / wording');
  it.todo('PR1b: the up trap after go runs the same procedure (record t1): stopped → status failed, any other → failed-server-left');
});

describe('#4288 PR1b table D: a handover step fails while the parent lives (§2.5, PM Claude P2-3)', () => {
  it('has every combination, 20 rows (1 never, 19 reachable)', () => {
    expect(ROWS_D).toHaveLength(FLOWS.length * HANDOFF_FAILURES.length);
    expect(count(ROWS_D, 'never')).toBe(1);
    expect(count(ROWS_D, 'reach')).toBe(19);
  });

  it.each(reachRows(ROWS_D))('$id: the child never works unsignalled, -G only after the publish, and a kept lock is said', (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    const cell = row.cell;
    const beforePublish = ['state-write', 'group', 'tmp', 'mv'].includes(row.failure);
    // Before the publish the record is T0 (the parent's own), only the waiting child's pid is signalled (P3-6).
    expect(cell.record === 'T0').toBe(beforePublish);
    if (beforePublish) expect([cell.signals, cell.release]).toEqual(['pid', 'D12-released']);
    if (cell.signals === 'group') expect(beforePublish).toBe(false);
    // The child works only after go (I-7).
    if (['state-write', 'group', 'tmp', 'mv', 'verify', 'verify-unreadable', 'signal', 'abort'].includes(row.failure)) expect(cell.child).toBe('never-starts');
    // An unreadable owner keeps the lock (I-2) and says so; everything else ends with the lock gone.
    expect(cell.lockAfter === 'kept').toBe(cell.release === 'D12-deferred');
    if (cell.lockAfter === 'kept') expect(cell.status === 'failed-lock-left' || cell.status === 'sync-failed').toBe(true);
    // UAT's T1 names the server: D12 is needs-head → D5; daily's names daily.sh: D12 itself, after G is empty.
    if (row.flow === 'uat' && cell.release !== 'D12-released' && cell.release !== 'D12-deferred') {
      expect(['D12-needs-head-D5-released', 'stop-then-D5']).toContain(cell.release);
    }
    if (row.flow === 'daily' && cell.record === 'T1') expect(cell.release).toBe('D12-released-after-drain');
  });

  for (const flow of FLOWS) {
    it.todo(`PR1b: inject each failure into the ${flow} handover (CM_VERIFY_TEST_FAULT / a fake child) and assert record / signals / child / release / status / exit / wording`);
  }
});

describe('#4288 PR1b table D2: odd observations stay on the keeping side and are said (§2.6)', () => {
  it('has every combination, 20 rows (4 never, 16 reachable)', () => {
    expect(ROWS_D2).toHaveLength(ODD.length * ODD_CALLERS.length);
    expect({ never: count(ROWS_D2, 'never'), reach: count(ROWS_D2, 'reach') }).toEqual({ never: 4, reach: 16 });
  });

  it.each(reachRows(ROWS_D2))('$id: nothing someone else holds is removed, and the human is told', (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    // The one removal is daily's own record after a host rename (D12's self path does not read host=).
    if (row.cell.lock === 'removed') expect([row.odd, row.caller, row.cell.result]).toEqual(['host-changed', 'daily-exit', 'released']);
    else expect(row.cell.msg.length).toBeGreaterThan(0);
  });

  it.todo('PR1b: a zombie (a child not waited), a record with another host=, an EPERM pid / group (a process of another uid in a fixture user, or the kill hook of the sync side) for each reachable row');
});

describe('#4288 PR1b table E: the argument / context checks (§4.2)', () => {
  it('has every combination, 20 rows (8 never, 12 reachable)', () => {
    expect(ROWS_E).toHaveLength(CHECKS.length * IMPLS.length);
    expect({ never: count(ROWS_E, 'never'), reach: count(ROWS_E, 'reach') }).toEqual({ never: 8, reach: 12 });
  });

  it('every check that table A points at is reachable in that implementation, and every check is used or stands alone', () => {
    const pointed = new Set(ROWS_A.flatMap((row) => (row.cell.kind === 'rejected' ? [`${row.cell.check}/${implOf(row.caller)}`] : [])));
    for (const id of pointed) expect(ROWS_E.find((row) => row.id === id)?.cell.kind).toBe('reach');
  });

  it.todo('PR1b: call each wrapper with the refused argument / from the refused context and assert it returns before touching <lock>, the queue or the moved-aside records');
});

describe('#4288 PR1b: the table sizes written in the design doc (§2.8)', () => {
  it('1110 rows in all (C′ counted as 6): 697 reachable, 90 rejected, 323 never', () => {
    const rows = [...ROWS_A, ...ROWS_B, ...ROWS_C, ...ROWS_D, ...ROWS_D2, ...ROWS_E];
    expect({
      all: rows.length + D5_RESULTS.length,
      reach: count(rows, 'reach') + D5_RESULTS.length,
      rejected: count(rows, 'rejected'),
      never: count(rows, 'never'),
    }).toEqual({ all: 1110, reach: 697, rejected: 90, never: 323 });
  });
});
