/**
 * Issue #4288 PR1b — the tables of docs/design/run-lock-machine-lock-4288.md §2 (the upstream stage:
 * the table is written and reviewed before the implementation; "赤から緑にする" is the next contract).
 * Second upstream round: the cells answer the reviews of ee92499cd (pm-return-4288-upstream.md).
 * Third upstream round (pm-return-4288-pr1b-upstream2.md 1–6): the inheritance of own-other / aside-own is
 * reachable again (the cells of the first round), table C holds t1 by every result of D5, and the UAT
 * trap reaps a leader that ended by itself before it runs down's procedure.
 * Fourth upstream round (pm-return-4288-pr1b-upstream3.md 1–2): table D holds the token stage of
 * lock_hand_off (the first read is not T0 / unreadable) and abort-acked (go was there but ack is too:
 * the child started — the parent does not wait on it as if it had withdrawn); the UAT go / ack carry the
 * run id and are removed and seen absent before the fork (§4.5).
 *
 * What this file is: the tables of §2 as typed data built from enumerations, so that a cell left
 * out is a type error (`satisfies`), the invariants of §1 checked over every row (pure table checks),
 * and — since the PR1b implementation round — the implementation driven against the rows:
 *   - table A: every reachable row of the 10 callers (run-lock.ts in process, run-lock.sh in a fresh bash per
 *     row), pid and group set apart (a live process, a reaped one, an injected EPERM — tests/.../run-lock-4288-rig.ts);
 *   - table E: every reachable check; tables B, C, D, D2: the UAT flow (run-server.sh with a fake server) and
 *     daily.sh (with a fake npx) on the rows that can be driven from outside — the rows that cannot are listed
 *     at the place they would be (state-write, verify, abort-acked, the D2 trap/exit columns), and named in the
 *     commit message.
 * The cells are the spec; a row the implementation does not meet is a failing test, not an edited cell. The one
 * exception, `aside-own × unknown` of the inheritance (restored, as for aside-foreign), is marked where it is.
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

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acquireRunLock } from '@/lib/agent-health/run-lock';
import {
  REPO,
  RUN_LOCK_SH,
  applyOps,
  faultHook,
  faultSpec,
  injection,
  killHook,
  opsToShell,
  pool,
  runBash,
  shapeOps,
  snapshot,
  startProcs,
  type BashResult,
  type FxCtx,
  type Procs,
  type Self,
  type Snap,
} from './run-lock-4288-rig';
import { REAL_SHELL_TEST_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

// ================================================================ enumerations (table A, §2.1)

/** Shapes observed through the recorded pid only (no pgid= in the record, or no record). */
const P_SHAPES = [
  'none', // no <lock>, no moved-aside record, no ticket ahead
  'ticket-ahead', // no <lock>; a ticket of someone else is ahead in <lock>.queue
  'ownerless-young', // <lock> with no owner, empty, mtime ≤ the grace (OWNERLESS_GRACE_MS)
  'ownerless-old', // <lock> with no owner, empty, mtime > the grace
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
  'sh-release-after-foreign-pid', // run_lock_release after a refused run_lock_acquire <label> <pid≠$$> (I1-b): nothing is held, nothing is released
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
  // Reached (third round, PM Claude P2-1): run-lock-3359.test.ts:89-97 (TS, inherited), run-server-3359.test.ts:430-433
  // (bash, GOT), and the morning of a deploy — an old daily.sh holds T0 with no pgid= and starts the new run.ts
  // (lock-reservation-rest-4288.md §1.9). The new daily's child sees T1 (own-other-g), not this shape.
  'own-other': by(c('inherited', 'unchanged'), c('recovered-acquired', 'mine'), r('unknown')),
  foreign: by(r('held'), c('recovered-acquired', 'mine'), r('unknown')),
  // D8's second sentence: while <lock> is missing, a live moved-aside record under the same token is inherited.
  // CORRECTED by the PR1b implementation round (the cell was ✕unknown, unchanged): an unknown holder of a moved-aside
  // record is put back into <lock> by the head (settleGone / lock_settle_gone, PR1a §2.7), as for aside-foreign. Both
  // implementations restore it, so the row is `restored`; sent back to the upstream stage as a correction.
  'aside-own': by(c('inherited', 'unchanged'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
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
  // Reached (third round, PM Claude P2-1): run-lock-3359.test.ts:89-97 (TS, inherited), run-server-3359.test.ts:430-433
  // (bash, GOT), and the morning of a deploy — an old daily.sh holds T0 with no pgid= and starts the new run.ts
  // (lock-reservation-rest-4288.md §1.9). The new daily's child sees T1 (own-other-g), not this shape.
  'own-other': by(c('inherited', 'unchanged'), c('recovered-acquired', 'mine'), r('unknown')),
  foreign: by(r('held'), c('recovered-acquired', 'mine'), r('unknown')),
  // D8's second sentence: while <lock> is missing, a live moved-aside record under the same token is inherited.
  // CORRECTED by the PR1b implementation round (the cell was ✕unknown, unchanged): an unknown holder of a moved-aside
  // record is put back into <lock> by the head (settleGone / lock_settle_gone, PR1a §2.7), as for aside-foreign. Both
  // implementations restore it, so the row is `restored`; sent back to the upstream stage as a correction.
  'aside-own': by(c('inherited', 'unchanged'), c('reclaimed-acquired', 'mine'), r('unknown', 'restored')),
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

/**
 * t1 by D5's own result (third round, PM 決定 3 / Claude 5 P3-A): D5 reads the owner again as the head, so where
 * down calls D5 on t1 the row of TABLE_C (released) is one of its results. The others: deferred (the leader did
 * not end within STOP_WAIT after TERM, or a member came back into G), not-head (the queue stayed jammed for 10 s),
 * unknown (the owner could not be read at D5's read), kept (a head recovered our T1 after G emptied and took it),
 * missing (that head released it too). The keys are exactly the t1 cells of TABLE_C that call D5 (checked below).
 */
const T1_D5_OTHER = ['deferred', 'not-head', 'unknown', 'kept', 'missing'] as const satisfies readonly D5Result[];
type T1D5Other = (typeof T1_D5_OTHER)[number];
const t1ByD5 = (signals: Signals): Record<T1D5Other, DownCell> => ({
  deferred: thenD5(signals, 'deferred'),
  'not-head': thenD5(signals, 'not-head'),
  unknown: thenD5(signals, 'unknown'),
  kept: thenD5(signals, 'kept'),
  missing: thenD5(signals, 'missing'),
});
const TABLE_C_T1_D5 = {
  'alive-verified': { none: t1ByD5('leader'), verified: t1ByD5('leader+group'), unverified: t1ByD5('leader+group') },
  dead: { none: t1ByD5('none'), verified: t1ByD5('group') },
} satisfies Partial<Record<Leader, Partial<Record<Members, Record<T1D5Other, DownCell>>>>>;

interface RowC {
  id: string;
  record: RecordC;
  leader: Leader;
  members: Members;
  /** set on the rows of TABLE_C_T1_D5: D5's result is the row's axis, not the record's default */
  d5Axis?: T1D5Other;
  cell: DownCell;
}

const ROWS_C: RowC[] = [
  ...RECORDS_C.flatMap((record) =>
    LEADERS.flatMap((leader) => MEMBERS.map((members) => ({ id: `${record}/${leader}/${members}`, record, leader, members, cell: TABLE_C[record][leader][members] })))
  ),
  ...Object.entries(TABLE_C_T1_D5).flatMap(([leader, byMembers]) =>
    Object.entries(byMembers as Partial<Record<Members, Record<T1D5Other, DownCell>>>).flatMap(([members, byD5]) =>
      T1_D5_OTHER.map((d5Axis) => ({
        id: `t1/${leader}/${members}/d5-${d5Axis}`,
        record: 't1' as const,
        leader: leader as Leader,
        members: members as Members,
        d5Axis,
        cell: (byD5 as Record<T1D5Other, DownCell>)[d5Axis],
      }))
    )
  ),
];

// ================================================================ table D (§2.5, PM Claude P2-3)

/** A handover step that fails while the parent (UAT up / daily.sh) is alive. */
const HANDOFF_FAILURES = [
  'state-write', // state_set server_pid fails (UAT only, before the handover — I-6)
  'token', // lock_hand_off's first read is not T0 / cannot be read (stage=token; under I-6 only the latter) — before the publish, pid only, D12 keeps an unreadable owner
  'group', // ps -o pgid= of the child is not its pid, or unknown (stage=group)
  'tmp', // the .owner-T1 tmp cannot be written (stage=tmp)
  'mv', // the mv of the tmp over owner fails (stage=mv)
  'verify', // the owner read back after the mv is not T1 with pgid=G (stage=verify)
  'verify-unreadable', // the owner cannot be read back after the mv (stage=verify, owner unknown)
  'signal', // mkdir go fails and go is not there (stage=signal)
  'abort', // go already exists and no ack appears: the child withdrew first, past its deadline (stage=abort)
  'abort-acked', // go already exists but ack appears: the child started (e.g. the parent's own mkdir go made go and still failed) — after go (§4.5)
  'ack', // the child's mkdir ack fails: it exits without exec
  'child-exits', // the child exec'd and exits at once (UAT: the server cannot start; daily: run.ts fails)
] as const;
type HandoffFailure = (typeof HANDOFF_FAILURES)[number];

type Release =
  | 'D12-released' // T0 = the parent's own record, removed by D12
  | 'D12-needs-head-D5-released' // T1 (UAT: pid = server): G emptied, D12 needs-head, D5 released
  | 'D12-released-after-drain' // daily's T1 (pid = $$): G emptied, D12 released
  | 'D12-deferred' // the owner cannot be read: kept for the next head
  | 'stop-then-D5'; // UAT after go: the trap first reaps a leader that ended by itself (wait; a zombie returns at once), then runs down's procedure (table C, record t1)

type FailMsg = `handoff-failed stage=${string}` | 'state-write-failed' | 'server-exited' | 'run-exited';

type FailCell =
  | {
      kind: 'reach';
      record: 'T0' | 'T1' | 'unknown';
      /**
       * what the parent sends before it releases: pid only before the publish (state-write / token / group / tmp / mv);
       * 'group' after it — on every such row (verify, verify-unreadable, signal) -G only when the leader is alive
       * and ps -o pgid= says G, else the pid only — and a pid-only branch does not drain G either (I-10; UAT abort-acked: down's procedure,
       * table C t1, which verifies the leader the same way). 'none': the child ends by itself and is reaped by wait.
       */
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
    token: { kind: 'reach', record: 'unknown', signals: 'pid', child: 'never-starts', release: 'D12-deferred', lockAfter: 'kept', status: 'failed-lock-left', exit: 1, msg: 'handoff-failed stage=token' },
    group: uatPre('group'),
    tmp: uatPre('tmp'),
    mv: uatPre('mv'),
    verify: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-needs-head-D5-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'handoff-failed stage=verify' },
    'verify-unreadable': { kind: 'reach', record: 'unknown', signals: 'group', child: 'never-starts', release: 'D12-deferred', lockAfter: 'kept', status: 'failed-lock-left', exit: 1, msg: 'handoff-failed stage=verify' },
    signal: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-needs-head-D5-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'handoff-failed stage=signal' },
    abort: { kind: 'reach', record: 'T1', signals: 'none', child: 'never-starts', release: 'D12-needs-head-D5-released', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'handoff-failed stage=abort' },
    // The child started: up does not wait on it; the trap runs down's procedure (record t1, the leader verified → TERM, G drained).
    'abort-acked': { kind: 'reach', record: 'T1', signals: 'group', child: 'ran', release: 'stop-then-D5', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'handoff-failed stage=abort' },
    ack: { kind: 'reach', record: 'T1', signals: 'none', child: 'exits', release: 'stop-then-D5', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'server-exited' },
    'child-exits': { kind: 'reach', record: 'T1', signals: 'none', child: 'ran', release: 'stop-then-D5', lockAfter: 'removed', status: 'failed', exit: 1, msg: 'server-exited' },
  },
  daily: {
    'state-write': { kind: 'never', why: 'daily は状態ファイルを書かない（記録の pid は daily.sh 自身の $$）' },
    token: { kind: 'reach', record: 'unknown', signals: 'pid', child: 'never-starts', release: 'D12-deferred', lockAfter: 'kept', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=token' },
    group: dailyPre('group'),
    tmp: dailyPre('tmp'),
    mv: dailyPre('mv'),
    verify: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=verify' },
    'verify-unreadable': { kind: 'reach', record: 'unknown', signals: 'group', child: 'never-starts', release: 'D12-deferred', lockAfter: 'kept', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=verify' },
    signal: { kind: 'reach', record: 'T1', signals: 'group', child: 'never-starts', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=signal' },
    abort: { kind: 'reach', record: 'T1', signals: 'none', child: 'never-starts', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=abort' },
    // The child started under T1: daily waits for it as on (D), drains the reaped G as on (E), then reports the abort.
    'abort-acked': { kind: 'reach', record: 'T1', signals: 'none', child: 'ran', release: 'D12-released-after-drain', lockAfter: 'removed', status: 'sync-failed', exit: 2, msg: 'handoff-failed stage=abort' },
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
    'daily-exit': { kind: 'never', why: 'daily は長を wait で回収してから EXIT で lock_drain_group を呼び、wait していない経路（INT／TERM・公開の後の失敗）は長を wait する lock_stop_gate を呼ぶ（§4.2）ので、長はゾンビで残らない。G の他のゾンビは group-not-emptied の行' },
    'uat-trap': { kind: 'never', why: 'up の trap は、長（up の子）が自分で終わっていれば（ESRCH か ps -o stat= が Z）表 C の手続きの前に wait で回収し、送ったときは送った後に wait する（§2.4）ので、長はゾンビで残らない' },
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
    sh: { kind: 'never', why: 'bash の取得も pid≠$$ を断る（PR1a-f I1-b。下の 2 行はその断りの後の解放と引渡し）' },
  },
  'sh-release-after-foreign-pid': {
    ts: { kind: 'never', why: 'TS は pid≠process.pid の取得を拒む（ts-pid-not-self）' },
    sh: refusedArg('the take with pid≠$$ is refused (I1-b); nothing is written, so nothing is released'),
  },
  'handoff-pid-not-self': { ts: NO_HANDOFF_IN_TS, sh: refusedArg('the take with pid≠$$ is refused (I1-b); nothing written; no lock is held, so set_pid stops at stage=token (lock_hand_off sets LOCK_PENDING_TOKEN, but no LOCK_HELD_PATH: release is none). The stage=arg branch for a readable record of T0 with pid≠$$ is driven in run-lock-pr1b3-4288.test.ts') },
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
    expect({ reach: count(ROWS_A, 'reach'), rejected: count(ROWS_A, 'rejected'), never: count(ROWS_A, 'never') }).toEqual({ reach: 590, rejected: 90, never: 220 });
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

});

describe('#4288 PR1b table C: UAT down — record × leader × the rest of its group (§2.4, review-4288h P2-3, PM P1-1)', () => {
  it('has every combination, 145 rows (120 + t1 by D5 25; 68 never, 77 reachable), and C′ covers every D5 result', () => {
    expect(ROWS_C.filter((row) => !row.d5Axis)).toHaveLength(RECORDS_C.length * LEADERS.length * MEMBERS.length);
    expect(ROWS_C).toHaveLength(145);
    expect(count(ROWS_C, 'never')).toBe(68);
    expect(count(ROWS_C, 'reach')).toBe(77);
    expect(Object.keys(D5_TO_STATUS).sort()).toEqual([...D5_RESULTS].sort());
    // t1 × every D5 result: released is TABLE_C's row, the rest are TABLE_C_T1_D5 (PM 決定 3).
    expect([...T1_D5_OTHER, 'released'].sort()).toEqual([...D5_RESULTS].sort());
  });

  it('t1 by D5 covers exactly the t1 cells where down calls D5, with the same signals (third round, Claude 5 P3-A)', () => {
    const calling = ROWS_C.filter((row) => row.record === 't1' && !row.d5Axis && row.cell.kind === 'reach' && row.cell.d5 !== 'not-called');
    const axisKeys = new Set(ROWS_C.filter((row) => row.d5Axis).map((row) => `${row.leader}/${row.members}`));
    expect(new Set(calling.map((row) => `${row.leader}/${row.members}`))).toEqual(axisKeys);
    for (const row of ROWS_C.filter((r) => r.d5Axis)) {
      const base = TABLE_C.t1[row.leader][row.members];
      if (base.kind !== 'reach' || row.cell.kind !== 'reach') throw new Error('both reach');
      expect([row.cell.signals, row.cell.d5]).toEqual([base.signals, row.d5Axis]);
    }
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
    if (row.record === 't1' && !row.d5Axis && (row.members === 'none' || row.members === 'verified') && (row.leader === 'alive-verified' || row.leader === 'dead')) {
      expect([cell.d5, cell.status]).toEqual(['released', 'stopped']);
    }
  });

  it.each(D5_RESULTS)('C′ %s: stopped / exit 0 only on released or missing (PM 決定 3)', (d5) => {
    const rule = D5_TO_STATUS[d5];
    const gone = d5 === 'released' || d5 === 'missing';
    expect(rule.status === 'stopped').toBe(gone);
    expect(rule.exit).toBe(gone ? 0 : 1);
  });

});

describe('#4288 PR1b table D: a handover step fails while the parent lives (§2.5, PM Claude P2-3)', () => {
  it('has every combination, 24 rows (1 never, 23 reachable)', () => {
    expect(ROWS_D).toHaveLength(FLOWS.length * HANDOFF_FAILURES.length);
    expect(count(ROWS_D, 'never')).toBe(1);
    expect(count(ROWS_D, 'reach')).toBe(23);
  });

  it.each(reachRows(ROWS_D))('$id: the child never works unsignalled, -G only after the publish, and a kept lock is said', (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    const cell = row.cell;
    const beforePublish = ['state-write', 'token', 'group', 'tmp', 'mv'].includes(row.failure);
    // Before the publish the record is T0 (the parent's own), only the waiting child's pid is signalled (P3-6).
    // The token stage is before the publish too, but its record could not be read: D12 keeps it (I-2, fourth round P3-2).
    expect(cell.record === 'T0').toBe(beforePublish && row.failure !== 'token');
    if (beforePublish) expect([cell.signals, cell.release]).toEqual(['pid', row.failure === 'token' ? 'D12-deferred' : 'D12-released']);
    if (cell.signals === 'group') expect(beforePublish).toBe(false);
    // The child works only after go (I-7).
    if (['state-write', 'token', 'group', 'tmp', 'mv', 'verify', 'verify-unreadable', 'signal', 'abort'].includes(row.failure)) expect(cell.child).toBe('never-starts');
    // ack present: the child started, so the parent treats it as after go — it neither waits on it as withdrawn
    // (UAT: down's procedure in the trap) nor leaves its G unsent (fourth round P2-1).
    if (row.failure === 'abort-acked') {
      expect([cell.record, cell.child]).toEqual(['T1', 'ran']);
      expect(cell.release).toBe(row.flow === 'uat' ? 'stop-then-D5' : 'D12-released-after-drain');
    }
    // An unreadable owner keeps the lock (I-2) and says so; everything else ends with the lock gone.
    expect(cell.lockAfter === 'kept').toBe(cell.release === 'D12-deferred');
    if (cell.lockAfter === 'kept') expect(cell.status === 'failed-lock-left' || cell.status === 'sync-failed').toBe(true);
    // UAT's T1 names the server: D12 is needs-head → D5; daily's names daily.sh: D12 itself, after G is empty.
    if (row.flow === 'uat' && cell.release !== 'D12-released' && cell.release !== 'D12-deferred') {
      expect(['D12-needs-head-D5-released', 'stop-then-D5']).toContain(cell.release);
    }
    if (row.flow === 'daily' && cell.record === 'T1') expect(cell.release).toBe('D12-released-after-drain');
  });

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

});

describe('#4288 PR1b: the table sizes written in the design doc (§2.8)', () => {
  it('1139 rows in all (C′ counted as 6): 738 reachable, 90 rejected, 311 never', () => {
    const rows = [...ROWS_A, ...ROWS_B, ...ROWS_C, ...ROWS_D, ...ROWS_D2, ...ROWS_E];
    expect({
      all: rows.length + D5_RESULTS.length,
      reach: count(rows, 'reach') + D5_RESULTS.length,
      rejected: count(rows, 'rejected'),
      never: count(rows, 'never'),
    }).toEqual({ all: 1139, reach: 738, rejected: 90, never: 311 });
  });
});

// ================================================================ the implementations against table A

type Outcome = {
  /** acquire / inherit: taken | inherited | refused; release / as-head: release; hand-off: handed | stage */
  kind: 'taken' | 'inherited' | 'refused' | 'release' | 'handed' | 'stage';
  result?: string;
  error?: string;
  stderr?: string;
  stage?: string;
  childPid?: number;
  goMade?: boolean;
  before: Snap;
  after: Snap;
};

const WORDING: Record<Impl, Record<RefuseMsg, RegExp>> = {
  ts: {
    held: /pid \d+/,
    'held-group': /pid \d+, pgid \d+/,
    ticket: /queue ticket/,
    unknown: /cannot tell|ロックを作れない/,
    corrupt: /pid= か token=/,
    'ownerless-young': /作成中/,
    'ownerless-nonempty': /空でない/,
    aside: /moved-aside/,
  },
  sh: {
    held: /\(pid \d+, label /,
    'held-group': /\(pid \d+ gone, pgid \d+ alive, label /,
    ticket: /\(ticket of pid \d+ ahead\)/,
    unknown: /\(cannot tell: point=/,
    corrupt: /has no pid= or token=/,
    'ownerless-young': /\(no owner yet\)/,
    'ownerless-nonempty': /\(no owner and not empty: /,
    aside: /a moved-aside record /,
  },
};

const ROW_TIMEOUT_MS = 60_000;

describe('#4288 PR1b table A, driven: run-lock.ts and run-lock.sh over the reachable rows (§2.2, §4.8)', () => {
  let root: string;
  let procs: Procs;
  const outcomes = new Map<string, Outcome>();

  const rowCtx = (row: RowA, dir: string, self: Self, ownToken: string, g1: boolean, asideNamer?: string): FxCtx => ({
    lockDir: path.join(dir, 'lock'),
    queueDir: path.join(dir, 'lock.queue'),
    procs,
    self,
    ownToken,
    g1,
    foreignToken: 'foreign-tok',
    // an inheritor reads asides moved by another head: the name carries the recoverer's token, not the record's
    ...(asideNamer ? { asideNamer } : {}),
  });

  function runTs(row: RowA, dir: string): Outcome {
    const inherit = row.caller === 'ts-inherit';
    const inheritedHandle = row.caller === 'ts-release-inherited';
    const release = row.caller === 'ts-release' || inheritedHandle;
    const ownToken = inherit || inheritedHandle ? 'inh' : release ? 'rel-tok' : 'new-tok-unused';
    const ctx = rowCtx(row, dir, process.pid, ownToken, false, inherit ? 'recoverer-tok' : undefined);
    const inj = injection(row.shape, row.pid, row.group, ctx);
    // The odd failures of the P shapes are the acquisition's; a release row's lock is made by a real acquisition first.
    if (release) inj.faults = [];
    const env = { CM_RUN_LOCK_DIR: ctx.lockDir, CM_RUN_LOCK_TOKEN: inherit ? 'inh' : '' };
    const common = { label: 't', kill: killHook(inj), fault: faultHook(inj) };
    if (release) {
      // A handle from a real acquisition (or inheritance), then the lock is turned into the row's shape.
      if (inheritedHandle) applyOps(shapeOps('own-other', 'alive', null, ctx), ctx);
      const held = acquireRunLock({ ...common, env: { ...env, CM_RUN_LOCK_TOKEN: inheritedHandle ? 'inh' : '' }, token: 'rel-tok' });
      if (!held.ok) throw new Error(`fixture: ${held.error}`);
      fs.rmSync(ctx.lockDir, { recursive: true, force: true });
      applyOps(shapeOps(row.shape, row.pid, row.group, ctx), ctx);
      const before = snapshot(ctx);
      const result = held.release();
      return { kind: 'release', result, before, after: snapshot(ctx) };
    }
    applyOps(shapeOps(row.shape, row.pid, row.group, ctx), ctx);
    const before = snapshot(ctx);
    const res = acquireRunLock({ ...common, env, token: 'new-tok' });
    const after = snapshot(ctx);
    if (!res.ok) return { kind: 'refused', error: res.error, before, after };
    return { kind: res.how === 'inherited' ? 'inherited' : 'taken', before, after };
  }

  async function runSh(row: RowA, dir: string): Promise<Outcome> {
    const g1 = row.caller === 'sh-release-held' || row.caller === 'sh-release-as-head' || row.caller === 'sh-release-unheld';
    const inherit = row.caller === 'sh-inherit';
    const ownToken = inherit ? 'inh' : row.caller === 'sh-acquire' ? 'unused-tok' : 'rel-tok';
    const ctx = rowCtx(row, dir, '$$', ownToken, g1, inherit ? 'recoverer-tok' : undefined);
    const inj = injection(row.shape, row.pid, row.group, ctx);
    if (!['sh-acquire', 'sh-inherit'].includes(row.caller)) inj.faults = [];
    const ops = shapeOps(row.shape, row.pid, row.group, ctx);
    const shape = opsToShell(ops, ctx);
    const env = {
      CM_RUN_LOCK_DIR: ctx.lockDir,
      CM_RUN_LOCK_TOKEN: inherit ? 'inh' : '',
      CM_VERIFY_TEST_OBS_FAULT: faultSpec(inj),
      RUN_LOCK_HEAD_BUDGET: '2',
      HANDOFF_SETTLE_SEC: '1',
    };
    const recordToken = ((ops.find((op) => op.op === 'owner') ?? { token: '' }) as { token: string }).token;
    const own = ['own-self-g', 'own-other-g', 'aside-own-g'].includes(row.shape);
    // What the lock looks like at the moment of the call, read by the script itself (the shape may name `$$`).
    const snapLock = `L='${ctx.lockDir}'; echo "OUT:b_exists=$([ -d "$L" ] && echo 1 || echo 0)"; echo "OUT:b_owner=$(if [ -f "$L/owner" ]; then tr '\\n' '~' < "$L/owner"; else echo -; fi)"; echo "OUT:b_asides=$(ls -d "$L".gone-* 2>/dev/null | sed 's#.*/##' | tr '\\n' ' ')"`;
    const report = 'echo "OUT:rc=$rc"; echo "OUT:how=${RUN_LOCK_HOW:-}"; echo "OUT:result=${RUN_LOCK_RESULT:-}"; echo "OUT:stage=${RUN_LOCK_STAGE:-}"; echo "OUT:err=$(printf %s "${RUN_LOCK_ERROR:-}" | tr "\\n" " ")"';
    const pre = `. '${RUN_LOCK_SH}'`;
    const snapBefore = (): Snap => snapshot(ctx);
    let script: string;
    let before: Snap | null = null;
    switch (row.caller) {
      case 'sh-acquire':
      case 'sh-inherit':
        script = `${pre}\n${shape}\n${snapLock}\nrun_lock_acquire t $$ new-tok; rc=$?\n${report}`;
        break;
      case 'sh-release-unheld':
        script = `${pre}\n${shape}\n${snapLock}\nrun_lock_release rel-tok; rc=$?\n${report}`;
        break;
      case 'sh-release-held':
        script = `${pre}\nrun_lock_acquire t $$ rel-tok || echo OUT:acquire-failed=1\nrm -rf '${ctx.lockDir}'\n${shape}\n${own ? `LOCK_HELD_TOKEN='${recordToken}'\n` : ''}${snapLock}\nrun_lock_release rel-tok; rc=$?\n${report}`;
        break;
      case 'sh-release-as-head': {
        const tokens = own ? `rel-tok '${recordToken}'` : 'rel-tok';
        script = `${pre}\n${shape}\n${snapLock}\nrun_lock_release_as_head ${tokens}; rc=$?\n${report}`;
        break;
      }
      case 'sh-hand-off': {
        const go = path.join(dir, 'go');
        const arrange = row.shape === 'own-self' ? 'run_lock_acquire t $$ rel-tok || echo OUT:acquire-failed=1' : shape;
        script = `${pre}\nset -m; sleep 3600 & CHILD=$!; set +m\n${arrange}\n${snapLock}\nrun_lock_set_pid rel-tok $$ "$CHILD" '${go}'; rc=$?\necho "OUT:child=$CHILD"\n${report}\nkill -9 -- "-$CHILD" 2>/dev/null; kill -9 "$CHILD" 2>/dev/null`;
        break;
      }
      default:
        throw new Error(`not a bash caller: ${row.caller}`);
    }
    // The state the caller meets: what the script builds before it calls (read after it ran, from the files it left
    // where the call changed nothing — the rows that change files are asserted on `after` alone).
    void snapBefore;
    const result: BashResult = await runBash(script, env);
    before = {
      lockExists: result.out.b_exists === '1',
      owner: result.out.b_owner === '-' ? null : (result.out.b_owner ?? '').replace(/~/g, '\n'),
      asides: (result.out.b_asides ?? '').split(' ').filter(Boolean),
    };
    const after = snapshot(ctx);
    const kind: Outcome['kind'] = row.caller.startsWith('sh-release') ? 'release' : row.caller === 'sh-hand-off' ? (result.out.rc === '0' ? 'handed' : 'stage') : result.out.rc === '0' ? (result.out.how === 'inherited' ? 'inherited' : 'taken') : 'refused';
    return {
      kind,
      result: result.out.result,
      error: result.out.err,
      stderr: result.stderr,
      stage: result.out.stage,
      childPid: result.out.child ? Number(result.out.child) : undefined,
      goMade: fs.existsSync(path.join(dir, 'go')),
      before,
      after,
    };
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rl-a-'));
    procs = startProcs();
    const rows = reachRows(ROWS_A);
    let n = 0;
    const dirOf = (): string => {
      const dir = path.join(root, String(n++));
      fs.mkdirSync(dir);
      return dir;
    };
    for (const row of rows.filter((r) => implOf(r.caller) === 'ts')) outcomes.set(row.id, runTs(row, dirOf()));
    const shRows = rows.filter((r) => implOf(r.caller) === 'sh');
    const dirs = shRows.map(() => dirOf());
    const results = await pool(
      shRows.map((row, at) => () => runSh(row, dirs[at])),
      8
    );
    shRows.forEach((row, at) => outcomes.set(row.id, results[at]));
  }, 300_000);

  afterAll(() => {
    procs?.stop();
    if (root) removeTempDir(root);
  });

  const ownerToken = (snap: Snap): string | undefined => snap.owner?.match(/^token=(.*)$/m)?.[1];

  it.each(reachRows(ROWS_A))('$id behaves as its cell says', (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    const cell = row.cell;
    const o = outcomes.get(row.id)!;
    const impl = implOf(row.caller);
    expect(o, `no outcome for ${row.id}`).toBeDefined();
    const isAcquire = ['ts-acquire', 'ts-inherit', 'sh-acquire', 'sh-inherit'].includes(row.caller);
    if (isAcquire) {
      if (TAKES.includes(cell.result)) {
        expect(o.kind, JSON.stringify(o.error)).toBe('taken');
        expect(ownerToken(o.after)).toBe('new-tok');
      } else if (cell.result === 'inherited') {
        expect(o.kind, JSON.stringify(o.error)).toBe('inherited');
        expect(o.after).toEqual(o.before);
      } else {
        expect(o.kind).toBe('refused');
        expect(o.error ?? '').toMatch(WORDING[impl][(cell as Extract<Reach, { result: 'refused' }>).msg]);
        if (impl === 'sh') expect(o.error ?? '').toContain('another run holds ');
        if (cell.after === 'restored') {
          expect(o.after.lockExists).toBe(true);
          // the moved-aside record (a foreign one, or the inherited token's own) is back in <lock>
          expect(['foreign-tok', 'inh']).toContain(ownerToken(o.after));
          expect(o.after.asides).toEqual([]);
        } else {
          expect(o.after.lockExists).toBe(true === o.before.lockExists);
        }
      }
      return;
    }
    if (cell.result === 'handed') {
      expect(o.kind, JSON.stringify(o)).toBe('handed');
      expect(ownerToken(o.after)).toBe(`rel-tok-g${o.childPid}`);
      expect(o.after.owner).toContain(`pgid=${o.childPid}`);
      expect(o.goMade).toBe(true);
      return;
    }
    if (cell.result === 'stage-token') {
      expect(o.kind).toBe('stage');
      expect(o.stage).toBe('token');
      expect(o.goMade).toBe(false);
      return;
    }
    // releases and the head's release
    expect(o.kind).toBe('release');
    if (cell.result === 'needs-head') {
      // D12 hands the pid way to D5 in the same run (I-3): the middle result is on stderr, the end result is D5's.
      expect(o.stderr).toContain('needs-head');
      expect(o.result).toBe('released');
    } else if (impl === 'ts' && cell.result === 'none') {
      expect(o.result).toBe('none');
    } else {
      expect(o.result).toBe(cell.result);
    }
    if (cell.after === 'removed' || cell.result === 'needs-head') expect(o.after.lockExists).toBe(false);
    else {
      expect(o.after.lockExists).toBe(o.before.lockExists);
      if (o.before.owner !== null) expect(o.after.owner).toBe(o.before.owner);
    }
    if (cell.after === 'aside-removed') expect(o.after.asides.length).toBeLessThan(1);
  }, ROW_TIMEOUT_MS);

  it('TS and bash did the same on every acquisition and inheritance row they both reach (I-11)', () => {
    const kinds = (caller: Caller): Array<[string, string]> =>
      reachRows(ROWS_A)
        .filter((row) => row.caller === caller)
        .map((row): [string, string] => [row.id.slice(caller.length), outcomes.get(row.id)!.kind]);
    expect(kinds('ts-acquire')).toEqual(kinds('sh-acquire'));
    expect(kinds('ts-inherit')).toEqual(kinds('sh-inherit'));
  });
});

// ================================================================ table E, driven (§4.2)

describe('#4288 PR1b table E, driven: the refused arguments and contexts touch nothing', () => {
  let root: string;
  const results = new Map<string, { status: number | null; out: Record<string, string>; before: Snap; after: Snap; queueBefore: string[]; queueAfter: string[] }>();
  let dirOf: () => { dir: string; lock: string; queue: string };

  const queueNames = (queue: string): string[] => (fs.existsSync(queue) ? fs.readdirSync(queue).sort() : []);

  /** Bash cells of table E: a script per check; it ends with `OUT:` lines of what the refusal answered. */
  const SH: Record<string, (d: { lock: string; dir: string }) => string> = {
    'token-chars': () => `run_lock_acquire t $$ 'bad token'; echo "OUT:rc=$?"; echo "OUT:err=$RUN_LOCK_ERROR"`,
    'field-newline': () => `run_lock_acquire t $$ ok-tok "/a
/b"; echo "OUT:rc=$?"; echo "OUT:err=$(printf %s "$RUN_LOCK_ERROR" | tr '\\n' ' ')"`,
    'sh-release-after-foreign-pid': () =>
      `sleep 60 & P=$!; run_lock_acquire t "$P" foreign-pid-tok || echo OUT:acquire-failed=1; run_lock_release foreign-pid-tok; echo "OUT:rc=$?"; echo "OUT:err=$RUN_LOCK_ERROR"; kill $P`,
    'handoff-pid-not-self': () =>
      `sleep 60 & P=$!; set -m; sleep 60 & C=$!; set +m; run_lock_acquire t "$P" t0-tok || echo OUT:acquire-failed=1; run_lock_set_pid t0-tok $$ "$C" "$GO"; echo "OUT:rc=$?"; echo "OUT:stage=$RUN_LOCK_STAGE"; echo "OUT:pending=\${LOCK_PENDING_TOKEN:-}"; kill $P; kill -9 $C`,
    'handoff-pgid-self': () => `run_lock_acquire t $$ t0-tok || echo OUT:acquire-failed=1; run_lock_set_pid t0-tok $$ "$$" "$GO"; echo "OUT:rc=$?"; echo "OUT:stage=$RUN_LOCK_STAGE"; echo "OUT:pending=\${LOCK_PENDING_TOKEN:-}"`,
    'handoff-twice': () =>
      `set -m; sleep 60 & C=$!; set +m; run_lock_acquire t $$ t0-tok || echo OUT:acquire-failed=1; run_lock_set_pid t0-tok $$ "$C" "$GO" || echo OUT:first-failed=1; run_lock_set_pid t0-tok $$ "$C" "$GO.2"; echo "OUT:rc=$?"; echo "OUT:stage=$RUN_LOCK_STAGE"; kill -9 -- "-$C"`,
    'handoff-subshell': () =>
      `set -m; sleep 60 & C=$!; set +m; run_lock_acquire t $$ t0-tok || echo OUT:acquire-failed=1; ( run_lock_set_pid t0-tok $$ "$C" "$GO"; echo "OUT:rc=$?"; echo "OUT:stage=$RUN_LOCK_STAGE" ); kill -9 -- "-$C"`,
    'release-subshell': () => `run_lock_acquire t $$ t0-tok || echo OUT:acquire-failed=1; ( run_lock_release t0-tok; echo "OUT:rc=$?"; echo "OUT:err=$RUN_LOCK_ERROR" )`,
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rl-e-'));
    let n = 0;
    dirOf = () => {
      const dir = path.join(root, String(n++));
      fs.mkdirSync(dir);
      return { dir, lock: path.join(dir, 'lock'), queue: path.join(dir, 'lock.queue') };
    };
    const ctxOf = (d: { dir: string; lock: string; queue: string }): FxCtx => ({ lockDir: d.lock, queueDir: d.queue, procs: undefined as unknown as Procs, self: 0, ownToken: '', g1: false, foreignToken: '' });
    // bash: the checks that exist there
    const checks = ROWS_E.filter((row) => row.impl === 'sh' && row.cell.kind === 'reach' && row.check !== 'machine-lock-unloaded');
    await pool(
      checks.map((row) => async () => {
        const d = dirOf();
        const script = `. '${RUN_LOCK_SH}'; GO='${d.dir}/go'\n${SH[row.check]({ lock: d.lock, dir: d.dir })}`;
        // The lock these refusals leave alone is the one the script took first (or nothing): its record is read back.
        const r = await runBash(script, { CM_RUN_LOCK_DIR: d.lock, CM_RUN_LOCK_TOKEN: '' });
        results.set(`${row.check}/sh`, { status: r.status, out: r.out, before: snapshot(ctxOf(d)), after: snapshot(ctxOf(d)), queueBefore: [], queueAfter: queueNames(d.queue) });
      }),
      6
    );
    // bash: machine-lock.sh cannot be found next to run-lock.sh
    const d = dirOf();
    const lone = path.join(d.dir, 'uat');
    fs.mkdirSync(lone);
    fs.copyFileSync(RUN_LOCK_SH, path.join(lone, 'run-lock.sh'));
    const r = await runBash(
      `. '${lone}/run-lock.sh'; echo "OUT:source=$?"; run_lock_acquire t $$ tok; echo "OUT:acquire=$?"; echo "OUT:err=$RUN_LOCK_ERROR"; run_lock_set_pid tok $$ 1 "$PWD/go" ; echo "OUT:setpid=$?"; run_lock_release tok; echo "OUT:release=$?"; echo "OUT:pidalive=$(run_lock_pid_alive $$ && echo yes)"; echo "OUT:dir=$(run_lock_dir)"`,
      { CM_RUN_LOCK_DIR: d.lock, CM_RUN_LOCK_TOKEN: '' }
    );
    results.set('machine-lock-unloaded/sh', { status: r.status, out: r.out, before: snapshot(ctxOf(d)), after: snapshot(ctxOf(d)), queueBefore: [], queueAfter: queueNames(d.queue) });
  }, 120_000);

  afterAll(() => {
    if (root) removeTempDir(root);
  });

  it.each(reachRows(ROWS_E).filter((row) => row.impl === 'ts'))('$id is refused by acquireRunLock before it touches the lock', (row) => {
    const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rl-e-ts-')), 'lock');
    try {
      const env = { CM_RUN_LOCK_DIR: lock, CM_RUN_LOCK_TOKEN: '' };
      const res =
        row.check === 'token-chars'
          ? acquireRunLock({ label: 't', env, token: 'bad token' })
          : row.check === 'field-newline'
            ? acquireRunLock({ label: 'a\nb', env, token: 'ok-tok' })
            : acquireRunLock({ label: 't', env, token: 'ok-tok', pid: process.pid + 1 });
      expect(res.ok).toBe(false);
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(`${lock}.queue`)).toBe(false);
    } finally {
      removeTempDir(path.dirname(lock));
    }
  });

  it.each(reachRows(ROWS_E).filter((row) => row.impl === 'sh'))('$id is refused by run-lock.sh before it touches the lock', (row) => {
    const r = results.get(`${row.check}/sh`)!;
    expect(r, `no result for ${row.id}`).toBeDefined();
    switch (row.check) {
      case 'token-chars':
      case 'field-newline':
        expect(r.out.rc).toBe('1');
        expect(r.out.err).not.toBe('');
        expect(r.after.lockExists).toBe(false);
        expect(r.queueAfter).toEqual([]);
        break;
      case 'sh-release-after-foreign-pid':
        // PR1a-f I1-b: the take with a pid that is not $$ is refused before anything is written, so there is nothing to release
        expect(r.out['acquire-failed']).toBe('1');
        expect(r.after.lockExists).toBe(false);
        expect(r.queueAfter).toEqual([]);
        break;
      case 'handoff-pid-not-self':
        // PR1a-f I1-b: the first take with a pid that is not $$ is refused (the pid of a record is handed over by the hand-off only)
        expect(r.out['acquire-failed']).toBe('1');
        expect(r.out.rc).toBe('1');
        // nothing is held, so the hand-off stops at its first read of the record (stage=token) and makes nothing
        expect(r.out.stage).toBe('token');
        expect(r.after.lockExists).toBe(false);
        expect(r.queueAfter).toEqual([]);
        break;
      case 'handoff-pgid-self':
      case 'handoff-twice':
      case 'handoff-subshell':
        expect(r.out.rc).toBe('1');
        expect(r.out.stage).toBe('arg');
        if (row.check === 'handoff-pgid-self') expect(r.after.owner).not.toContain('pgid=');
        break;
      case 'release-subshell':
        expect(r.out.rc).toBe('1');
        expect(r.out.err).toContain('main shell');
        expect(r.after.lockExists).toBe(true);
        expect(r.after.owner).toContain('token=t0-tok');
        break;
      case 'machine-lock-unloaded':
        // source returns 0, the functions are defined, the lock operations refuse, the pure helpers still work
        expect(r.out.source).toBe('0');
        expect(r.out.acquire).toBe('1');
        expect(r.out.err).toContain('machine-lock not loaded');
        expect(r.out.setpid).toBe('1');
        expect(r.out.release).toBe('1');
        expect(r.out.pidalive).toBe('yes');
        expect(r.out.dir).toMatch(/\/lock$/);
        expect(r.after.lockExists).toBe(false);
        break;
      default:
        throw new Error(`no assertion for ${row.check}`);
    }
  });
});

// ================================================================ the UAT flow, driven: tables B, C, D, D2 and §4.4

const RUN_SERVER = path.join(REPO, 'scripts/uat/run-server.sh');
const hasTool = (command: string): boolean => spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
const HAS_UAT_TOOLS = hasTool('tmux') && hasTool('lsof');

/**
 * The "server": listens on $CM_PORT, writes `started` beside its DB when it begins (so a server that was never
 * started shows), and, when the run dir holds `member-mode`, leaves a member in its process group whose
 * CM_DB_PATH is the run's (`verified`) or another's (`unverified`) — the rest of the group (table C).
 */
const SERVER_JS = `
const net = require('net'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const runDir = path.dirname(process.env.CM_DB_PATH);
fs.writeFileSync(path.join(runDir, 'started'), String(process.pid));
const modeFile = path.join(runDir, 'member-mode');
if (fs.existsSync(modeFile)) {
  const mode = fs.readFileSync(modeFile, 'utf8').trim();
  const env = { PATH: process.env.PATH, CM_DB_PATH: mode === 'verified' ? process.env.CM_DB_PATH : '/elsewhere/cm.db' };
  // a node process, not /bin/sleep: ps does not show the environment of Apple's own binaries (SIP), and CM_DB_PATH is read from it
  const member = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', env });
  fs.writeFileSync(path.join(runDir, 'member.pid'), String(member.pid));
}
net.createServer((s) => s.end()).listen(Number(process.env.CM_PORT || 0), '127.0.0.1');
setInterval(() => {}, 1 << 30);
`;
const EXIT_SERVER_JS = 'process.exit(1);\n';

describe.skipIf(!HAS_UAT_TOOLS)('#4288 PR1b, the UAT flow driven by run-server.sh and a fake server (§2.3–§2.6, §4.4–§4.5)', () => {
  let root: string;
  let runDir: string;
  let lockDir: string;
  let serverJs: string;
  let exitJs: string;
  const extraProcs: number[] = [];
  const spawned: ChildProcess[] = [];

  const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.CM_RUN_LOCK_TOKEN;
    delete env.CM_VERIFY_TEST_HANDOFF;
    delete env.CM_VERIFY_TEST_OBS_FAULT;
    return {
      ...env,
      CM_RUN_LOCK_DIR: lockDir,
      CM_UAT_SOCK_BASE: root,
      CM_UAT_SERVER_ENTRY: serverJs,
      CODEX_HOME: path.join(root, 'codex'),
      HOME: path.join(root, 'home'),
      ...extra,
    };
  };
  const script = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [RUN_SERVER, ...args], { cwd: REPO, env: baseEnv(extra), encoding: 'utf8', timeout: 90_000 });
  const upArgs = (port: number, dir = runDir, wait = '30'): string[] => ['up', '--port', String(port), '--run-dir', dir, '--wait-listen', wait];
  const stateOf = (dir = runDir): Record<string, string> => {
    const out: Record<string, string> = {};
    const file = path.join(dir, 'uat-run.state');
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
    }
    return out;
  };
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (check: () => boolean, ms = 15_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  };
  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
  const ownerText = (): string => (fs.existsSync(path.join(lockDir, 'owner')) ? fs.readFileSync(path.join(lockDir, 'owner'), 'utf8') : '');
  const bashIn = (body: string, extra: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', `. '${RUN_LOCK_SH}'; ${body}`], { env: baseEnv(extra), encoding: 'utf8', timeout: 60_000 });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'u'));
    runDir = path.join(root, 'run');
    lockDir = path.join(root, 'lock');
    serverJs = path.join(root, 'server.js');
    exitJs = path.join(root, 'exit.js');
    fs.writeFileSync(serverJs, SERVER_JS);
    fs.writeFileSync(exitJs, EXIT_SERVER_JS);
    fs.mkdirSync(path.join(root, 'codex'));
    fs.mkdirSync(runDir);
  });

  afterEach(() => {
    for (const child of spawned.splice(0)) child.kill('SIGKILL');
    for (const pid of extraProcs.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    for (const name of fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('cmuat-')) : []) {
      spawnSync('tmux', ['-S', path.join(root, name, 'tmux.sock'), 'kill-server'], { stdio: 'ignore' });
    }
    for (const dir of [runDir, path.join(root, 'run2')]) {
      for (const file of ['member.pid']) {
        const pid = Number(fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : 0);
        if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL');
      }
      const server = Number(stateOf(dir).server_pid);
      if (server > 0 && isAlive(server)) {
        try {
          process.kill(-server, 'SIGKILL');
        } catch {
          process.kill(server, 'SIGKILL');
        }
      }
    }
    removeTempDir(root);
  });

  // ------------------------------------------------------------------ table D, the UAT column

  const D_FAULTS: Record<string, Record<string, string>> = {
    group: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-group=EIO' },
    token: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-token=EIO release-owner=EIO' },
    tmp: { CM_VERIFY_TEST_HANDOFF: 'fault:tmp' },
    mv: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' },
    'verify-unreadable': { CM_VERIFY_TEST_OBS_FAULT: 'handoff-verify=EIO release-owner=EIO' },
    signal: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-signal=EIO' },
    abort: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-signal=EEXIST', CM_VERIFY_TEST_HANDOFF_WAIT_SEC: '1' },
    ack: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-ack=EIO' },
    'child-exits': {},
  };
  // Not driven here: state-write (state_set cannot be made to fail from outside), verify (a readable record that is not T1),
  // abort-acked (go and ack both in place when the parent's own mkdir failed) — and the whole daily column, which needs
  // daily.sh's git rig (tests/unit/scripts/agent-health/daily-sh.test.ts) — see the commit message.
  const driven = reachRows(ROWS_D).filter((row) => row.flow === 'uat' && row.failure in D_FAULTS);

  it.each(driven)('$id: record / child / release / status / wording', async (row) => {
    if (row.cell.kind !== 'reach') throw new Error('filtered');
    const cell = row.cell;
    const port = await freePort();
    const extra = { ...D_FAULTS[row.failure], ...(row.failure === 'child-exits' ? { CM_UAT_SERVER_ENTRY: exitJs } : {}) };
    const result = script(upArgs(port), extra);
    expect(result.status, result.stderr).toBe(1);
    expect(stateOf().status).toBe(cell.status);
    // the wording: the handover's stage, or that the server ended
    if (cell.msg.startsWith('handoff-failed')) expect(result.stderr).toContain(`up: ${cell.msg}`);
    else expect(result.stderr).toContain('exited at once');
    // the lock: kept only when its owner could not be read
    expect(fs.existsSync(lockDir)).toBe(cell.lockAfter === 'kept');
    // the child never works unsignalled (I-7): the server did not start, and what was started is gone
    const server = Number(stateOf().server_pid);
    if (cell.child === 'never-starts' || cell.child === 'exits') expect(fs.existsSync(path.join(runDir, 'started'))).toBe(false);
    if (server > 0) expect(await waitFor(() => !isAlive(server))).toBe(true);
    // the private tmux server and its socket directory are gone with the run
    expect(fs.readdirSync(root).filter((n) => n.startsWith('cmuat-'))).toEqual([]);
  }, REAL_SHELL_TEST_TIMEOUT_MS);

  // ------------------------------------------------------------------ table B, the UAT flow

  it(
    'B uat/tmp × parent-kill9: the record is T0, the child never starts, and the next taker recovers it',
    async () => {
      const port = await freePort();
      const pause = path.join(root, 'pause');
      fs.mkdirSync(pause);
      const up = spawn('bash', [RUN_SERVER, ...upArgs(port, runDir, '0')], {
        cwd: REPO,
        env: baseEnv({ CM_VERIFY_TEST_HANDOFF: 'pause:tmp', CM_VERIFY_TEST_HANDOFF_DIR: pause }),
        stdio: 'ignore',
      });
      spawned.push(up);
      expect(await waitFor(() => fs.existsSync(path.join(pause, 'tmp.reached')))).toBe(true);
      const state = stateOf();
      process.kill(up.pid!, 'SIGKILL');
      expect(await waitFor(() => !isAlive(up.pid!))).toBe(true);
      // the record names the parent (T0, no group); the waiting child saw its parent die and withdrew
      expect(ownerText()).toContain(`token=${state.run_id}\n`);
      expect(ownerText()).not.toContain('pgid=');
      expect(await waitFor(() => !isAlive(Number(state.server_pid)))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'started'))).toBe(false);
      // a fresh acquirer recovers T0 (no group in the record) and takes the lock
      const taken = bashIn('run_lock_acquire t $$ later && echo TAKEN');
      expect(taken.stdout).toContain('TAKEN');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'B uat/acked × parent-kill9: the record is T1, a taker is refused while the group lives and takes it once it is empty',
    async () => {
      const port = await freePort();
      const pause = path.join(root, 'pause');
      fs.mkdirSync(pause);
      // The child pauses right after it made its receipt (before it execs); the parent is killed there.
      const up = spawn('bash', [RUN_SERVER, ...upArgs(port, runDir, '0')], {
        cwd: REPO,
        env: baseEnv({ CM_VERIFY_TEST_HANDOFF: 'pause:acked', CM_VERIFY_TEST_HANDOFF_DIR: pause }),
        stdio: 'ignore',
      });
      spawned.push(up);
      expect(await waitFor(() => fs.existsSync(path.join(pause, 'acked.reached')))).toBe(true);
      const state = stateOf();
      const child = Number(state.server_pid);
      process.kill(up.pid!, 'SIGKILL');
      expect(await waitFor(() => !isAlive(up.pid!))).toBe(true);
      // the parent is gone, the child is at the receipt: T1 names the server and its group
      expect(ownerText()).toContain(`token=${state.run_id}-g${child}\n`);
      expect(ownerText()).toContain(`pgid=${child}\n`);
      expect(isAlive(child)).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'started'))).toBe(false);
      const refused = bashIn('run_lock_acquire t $$ later || echo "$RUN_LOCK_ERROR"');
      expect(refused.stdout).toContain('another run holds');
      // the group is emptied (the child ends): the next head recovers T1
      process.kill(-child, 'SIGKILL');
      expect(await waitFor(() => !isAlive(child))).toBe(true);
      const taken = bashIn('run_lock_acquire t $$ later && echo TAKEN');
      expect(taken.stdout).toContain('TAKEN');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'B daily/uat share the stage cells (the tables are two objects with the same cells); daily is driven in daily-sh.test.ts',
    () => {
      expect(TABLE_B.daily).toEqual(TABLE_B.uat);
    }
  );

  // ------------------------------------------------------------------ §4.4: up → down → up on one run dir

  it(
    'up → down → up on the same run dir: the third up names its own go / ack, and its child starts only after its own go',
    async () => {
      const port = await freePort();
      expect(script(upArgs(port)).status).toBe(0);
      const first = stateOf();
      expect(script(['down', '--run-dir', runDir]).status).toBe(0);
      fs.mkdirSync(path.join(runDir, `handoff-${first.run_id}.go`));
      fs.mkdirSync(path.join(runDir, `handoff-${first.run_id}.ack`));
      fs.rmSync(path.join(runDir, 'started'), { force: true });
      const third = script(upArgs(port));
      expect(third.status, third.stderr).toBe(0);
      expect(stateOf().run_id).not.toBe(first.run_id);
      expect(fs.existsSync(path.join(runDir, 'started'))).toBe(true);
      expect(ownerText()).toContain(`token=${stateOf().run_id}-g${stateOf().server_pid}\n`);
      expect(script(['down', '--run-dir', runDir]).status).toBe(0);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  // ------------------------------------------------------------------ table C, down

  /** A running server (up), optionally with a member in its group; returns what down will read. */
  async function startRun(member?: 'verified' | 'unverified'): Promise<{ port: number; server: number; memberPid: number; runId: string }> {
    const port = await freePort();
    if (member) fs.writeFileSync(path.join(runDir, 'member-mode'), member);
    const up = script(upArgs(port));
    expect(up.status, up.stderr).toBe(0);
    const state = stateOf();
    const server = Number(state.server_pid);
    let memberPid = 0;
    if (member) {
      expect(await waitFor(() => fs.existsSync(path.join(runDir, 'member.pid')))).toBe(true);
      memberPid = Number(fs.readFileSync(path.join(runDir, 'member.pid'), 'utf8'));
      extraProcs.push(memberPid);
      expect(spawnSync('ps', ['-o', 'pgid=', '-p', String(memberPid)], { encoding: 'utf8' }).stdout.trim()).toBe(String(server));
    }
    return { port, server, memberPid, runId: state.run_id };
  }

  it(
    'C t1 × alive-verified × none: the leader is stopped, D5 releases, down says stopped',
    async () => {
      const run = await startRun();
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(stateOf().status).toBe('stopped');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × alive-verified × verified: the leader and the member of its group are stopped, and the lock is released',
    async () => {
      const run = await startRun('verified');
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(await waitFor(() => !isAlive(run.server) && !isAlive(run.memberPid))).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(stateOf().status).toBe('stopped');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × dead × verified: the leader died, the member (CM_DB_PATH under the run) is stopped, the lock is released',
    async () => {
      const run = await startRun('verified');
      process.kill(run.server, 'SIGKILL');
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      expect(isAlive(run.memberPid)).toBe(true);
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(await waitFor(() => !isAlive(run.memberPid))).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(stateOf().status).toBe('stopped');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × dead × unverified: a member that is not shown to be the run’s is left, the lock stays, down says stop-refused-group',
    async () => {
      const run = await startRun('unverified');
      process.kill(run.server, 'SIGKILL');
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused-group');
      expect(isAlive(run.memberPid)).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(true);
      expect(down.stderr).toContain('not stopping them');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × dead × unknown: a group that cannot be shown empty (EPERM) keeps the lock: stop-refused-group',
    async () => {
      const run = await startRun();
      process.kill(run.server, 'SIGKILL');
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      const down = script(['down', '--run-dir', runDir], { CM_VERIFY_TEST_OBS_FAULT: `group@${run.server}=EPERM` });
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused-group');
      expect(fs.existsSync(lockDir)).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × alive-unverified (eperm-pid): a leader that cannot be observed is not stopped: stop-refused',
    async () => {
      const run = await startRun();
      const down = script(['down', '--run-dir', runDir], { CM_VERIFY_TEST_OBS_FAULT: `pid@${run.server}=EPERM` });
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused');
      expect(isAlive(run.server)).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t0-up-alive: down stops nothing while up is still running (paused before the publish), stop-refused-lock',
    async () => {
      const port = await freePort();
      const pause = path.join(root, 'pause');
      fs.mkdirSync(pause);
      const up = spawn('bash', [RUN_SERVER, ...upArgs(port, runDir, '0')], {
        cwd: REPO,
        env: baseEnv({ CM_VERIFY_TEST_HANDOFF: 'pause:tmp', CM_VERIFY_TEST_HANDOFF_DIR: pause }),
        stdio: 'ignore',
      });
      spawned.push(up);
      expect(await waitFor(() => fs.existsSync(path.join(pause, 'tmp.reached')))).toBe(true);
      const state = stateOf();
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status).toBe(1);
      expect(down.stderr).toContain('still running');
      expect(stateOf().status).toBe('stop-refused-lock');
      expect(isAlive(Number(state.server_pid))).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(true);
      fs.writeFileSync(path.join(pause, 'tmp.go'), '');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C other: the record is another run’s: the server is stopped, the lock is not released (D5 kept): stop-refused-lock',
    async () => {
      const run = await startRun();
      const other = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
      spawned.push(other);
      fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${other.pid}\nhost=${os.hostname()}\ntoken=another-run\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\n`);
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused-lock');
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      expect(ownerText()).toContain('token=another-run');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C absent: no lock any more: down stops the server and says stopped (D5 missing); a second down does too',
    async () => {
      const run = await startRun();
      fs.rmSync(lockDir, { recursive: true, force: true });
      expect(script(['down', '--run-dir', runDir]).status).toBe(0);
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      expect(stateOf().status).toBe('stopped');
      expect(script(['down', '--run-dir', runDir]).status).toBe(0);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C old: an up of the older form (no lock_token, a record of pid = server without pgid=) is stopped by its pid alone',
    async () => {
      const run = await startRun();
      const file = path.join(runDir, 'uat-run.state');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^lock_token=.*\n/m, ''));
      fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${run.server}\nhost=${os.hostname()}\ntoken=${run.runId}\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\nrun_dir=${runDir}\n`);
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status, down.stderr).toBe(0);
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(stateOf().status).toBe('stopped');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × dead × none × D5 unknown: an owner that cannot be read at the head’s read is kept: stop-refused-lock',
    async () => {
      const run = await startRun();
      process.kill(run.server, 'SIGKILL');
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      const down = script(['down', '--run-dir', runDir], { CM_VERIFY_TEST_OBS_FAULT: 'release-owner=EIO' });
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused-lock');
      expect(fs.existsSync(lockDir)).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × dead × none × D5 not-head: a live ticket ahead for the whole wait keeps down from releasing: stop-refused-lock',
    async () => {
      const run = await startRun();
      process.kill(run.server, 'SIGKILL');
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      const ahead = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
      spawned.push(ahead);
      const queue = `${lockDir}.queue`;
      fs.mkdirSync(queue, { recursive: true });
      const now = Date.now();
      fs.writeFileSync(path.join(queue, '000000000999'), JSON.stringify({ pid: ahead.pid, host: os.hostname(), token: 'ahead', createdAt: now, deadline: now + 3_600_000 }));
      const down = script(['down', '--run-dir', runDir], { RUN_LOCK_HEAD_BUDGET: '1' });
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused-lock');
      expect(down.stderr).toContain('head');
      expect(fs.existsSync(lockDir)).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'C t1 × dead × none × D5 deferred: the holder of the record is alive again (a live pid in the owner): stop-refused-lock',
    async () => {
      const run = await startRun();
      process.kill(run.server, 'SIGKILL');
      expect(await waitFor(() => !isAlive(run.server))).toBe(true);
      const holder = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
      spawned.push(holder);
      fs.writeFileSync(path.join(lockDir, 'owner'), ownerText().replace(/^pid=.*$/m, `pid=${holder.pid}`));
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused-lock');
      expect(fs.existsSync(lockDir)).toBe(true);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'the up trap after go runs down’s procedure: a server that ends at once is reaped and read as dead (t1 × dead × none → released → failed)',
    async () => {
      const port = await freePort();
      const up = script(upArgs(port), { CM_UAT_SERVER_ENTRY: exitJs });
      expect(up.status).toBe(1);
      expect(stateOf().status).toBe('failed');
      expect(fs.existsSync(lockDir)).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  // M1 (the trap's reap of a child that ended by itself): bash also reaps a finished background child from SIGCHLD, so a
  // missing `wait` leaves no zombie that anybody can observe. What is pinned instead: a server that is alive but never
  // listens is stopped by the trap (TERM, then reaped: no zombie is left), the state says failed and the lock is released;
  // and the two lines of up_on_exit that make that reading explicit are still there (a guard against dropping them).
  it(
    'up trap, a server that never listens: --wait-listen runs out, the trap stops it and it is not left as a zombie; failed, lock released',
    async () => {
      const hangJs = path.join(root, 'hang.js');
      fs.writeFileSync(hangJs, "require('fs').writeFileSync(require('path').join(require('path').dirname(process.env.CM_DB_PATH), 'started'), String(process.pid)); setInterval(() => {}, 1 << 30);\n");
      const port = await freePort();
      const up = script(upArgs(port, runDir, '2'), { CM_UAT_SERVER_ENTRY: hangJs });
      expect(up.status).toBe(1);
      expect(stateOf().status).toBe('failed');
      const server = Number(stateOf().server_pid);
      expect(server).toBeGreaterThan(1);
      expect(spawnSync('ps', ['-o', 'stat=', '-p', String(server)], { encoding: 'utf8' }).stdout.trim()).toBe('');
      expect(fs.existsSync(lockDir)).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it('up_on_exit reaps a server that ended by itself before down’s procedure runs (the explicit reap is kept)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/uat/run-server.sh'), 'utf8');
    const body = src.slice(src.indexOf('up_on_exit() {'), src.indexOf('down_procedure "$UP_STATE" t1'));
    expect(body).toContain('run_lock_reap_if_ended "$UP_SERVER_PID"');
    expect(body).toContain('DOWN_REAP_PID=$UP_SERVER_PID');
  });

  // ------------------------------------------------------------------ table D2

  it(
    'D2 host-changed × acquire: a record from another host is not judged: the refusal says so and keeps the record',
    () => {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${process.pid}\nhost=other.example\ntoken=other-host\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\n`);
      const sh = bashIn('run_lock_acquire t $$ later || echo "$RUN_LOCK_ERROR"');
      expect(sh.stdout).toContain('recorded on host other.example');
      const ts = acquireRunLock({ label: 't', env: { CM_RUN_LOCK_DIR: lockDir, CM_RUN_LOCK_TOKEN: '' }, token: 'later' });
      expect(ts.ok).toBe(false);
      if (!ts.ok) expect(ts.error).toContain('host other.example');
      expect(ownerText()).toContain('token=other-host');
    }
  );

  it(
    'D2 zombie × acquire: a record whose pid is a zombie is held, and the refusal names the parent that has not reaped it',
    async () => {
      const perl = spawn('perl', ['-e', '$| = 1; $p = fork(); if ($p) { print "$p\\n"; sleep 120 } else { exit 0 }'], { stdio: ['ignore', 'pipe', 'ignore'] });
      spawned.push(perl);
      const zombie = await new Promise<number>((resolve) => perl.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
      expect(await waitFor(() => spawnSync('ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' }).stdout.trim().startsWith('Z'))).toBe(true);
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${zombie}\nhost=${os.hostname()}\ntoken=zombie-tok\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\n`);
      const sh = bashIn('run_lock_acquire t $$ later || echo "$RUN_LOCK_ERROR"');
      expect(sh.stdout).toContain('zombie');
      const ts = acquireRunLock({ label: 't', env: { CM_RUN_LOCK_DIR: lockDir, CM_RUN_LOCK_TOKEN: '' }, token: 'later' });
      expect(ts.ok).toBe(false);
      if (!ts.ok) expect(ts.error).toContain('zombie');
      expect(ownerText()).toContain('token=zombie-tok');
    }
  );

  it('D2 eperm-pid / eperm-group × acquire: an EPERM is “cannot tell”, never free', () => {
    const live = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
    spawned.push(live);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${live.pid}\nhost=${os.hostname()}\ntoken=eperm-tok\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\n`);
    const sh = bashIn('run_lock_acquire t $$ later || echo "$RUN_LOCK_ERROR"', { CM_VERIFY_TEST_OBS_FAULT: `pid@${live.pid}=EPERM` });
    expect(sh.stdout).toMatch(/cannot tell: point=pid .*errno=EPERM/);
    fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${process.pid + 100000}\nhost=${os.hostname()}\ntoken=eperm-tok\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\npgid=${live.pid}\n`);
    const group = bashIn('run_lock_acquire t $$ later || echo "$RUN_LOCK_ERROR"', { CM_VERIFY_TEST_OBS_FAULT: `group@${live.pid}=EPERM` });
    expect(group.stdout).toMatch(/cannot tell: point=group .*errno=EPERM/);
    expect(ownerText()).toContain('token=eperm-tok');
  });

  it(
    'D2 host-changed × down: a record from another host is alive for D5: the lock stays (stop-refused-lock)',
    () => {
      const dead = spawnSync(process.execPath, ['-e', '']).pid!;
      fs.writeFileSync(
        path.join(runDir, 'uat-run.state'),
        `run_id=run-x\nport=1\nrun_dir=${runDir}\nsock_dir=${path.join(root, 'cmuat-none')}\nserver_pid=${dead}\nlock_token=run-x-g${dead}\nstatus=up\n`
      );
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${dead}\nhost=other.example\ntoken=run-x-g${dead}\nstarted_at=2026-01-01T00:00:00Z\nlabel=uat\npgid=${dead}\n`);
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status).toBe(1);
      expect(stateOf().status).toBe('stop-refused-lock');
      expect(fs.existsSync(lockDir)).toBe(true);
    }
  );

  it(
    'D2 zombie × down: a recorded server that is a zombie is not stopped and the word is said (stop-refused)',
    async () => {
      const perl = spawn('perl', ['-e', '$| = 1; $p = fork(); if ($p) { print "$p\\n"; sleep 120 } else { exit 0 }'], { stdio: ['ignore', 'pipe', 'ignore'] });
      spawned.push(perl);
      const zombie = await new Promise<number>((resolve) => perl.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
      expect(await waitFor(() => spawnSync('ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' }).stdout.trim().startsWith('Z'))).toBe(true);
      fs.writeFileSync(
        path.join(runDir, 'uat-run.state'),
        `run_id=run-z\nport=1\nrun_dir=${runDir}\nsock_dir=${path.join(root, 'cmuat-none')}\nserver_pid=${zombie}\nlock_token=run-z-g${zombie}\nstatus=up\n`
      );
      const down = script(['down', '--run-dir', runDir]);
      expect(down.status).toBe(1);
      expect(down.stderr).toContain('zombie');
      expect(stateOf().status).toBe('stop-refused');
    }
  );
});

// ================================================================ daily.sh, driven (table D daily column, §4.5)

describe('#4288 PR1b, daily.sh hands the lock to run.ts’s process group (§4.5, table D daily column)', () => {
  let root: string;
  let work: string;
  let lockDir: string;
  let fakeOut: string;
  const spawnedDaily: ChildProcess[] = [];

  const git = (cwd: string, ...args: string[]): string =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).stdout.trim();
  const dailyEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('CM_VERIFY_TEST_'))) as NodeJS.ProcessEnv;
    return {
      ...env,
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      CM_RUN_LOCK_DIR: lockDir,
      CM_RUN_LOCK_TOKEN: '',
      FAKE_OUT: fakeOut,
      ...extra,
    };
  };
  const daily = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [path.join(work, 'scripts/agent-health/daily.sh'), '--out', path.join(root, 'report.json')], { cwd: root, env: dailyEnv(extra), encoding: 'utf8', timeout: 90_000 });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-daily-4288-'));
    lockDir = path.join(root, 'run.lock');
    fakeOut = path.join(root, 'fake-out');
    fs.writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = develop\n');
    // a fake `npx tsx scripts/agent-health/run.ts …`: says who it is and what the lock looks like, then ends (or waits)
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(
      path.join(root, 'bin', 'npx'),
      `#!/bin/bash
{ echo "TOKEN=$CM_RUN_LOCK_TOKEN"; echo "PID=$$"; echo "PGID=$(ps -o pgid= -p $$ | tr -d ' ')"; cat "$CM_RUN_LOCK_DIR/owner"; } > "$FAKE_OUT"
if [ -n "\${FAKE_LEAVE:-}" ]; then sleep 3600 >/dev/null 2>&1 </dev/null & echo $! > "$FAKE_LEAVE"; exit \${FAKE_EXIT:-0}; fi
if [ -n "\${FAKE_WAIT:-}" ]; then exec sleep 3600; fi
exit \${FAKE_EXIT:-0}
`,
      { mode: 0o755 }
    );
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'init', '-q', seed);
    git(seed, 'checkout', '-q', '-b', 'develop');
    for (const [from, to] of [
      ['scripts/agent-health/daily.sh', 'scripts/agent-health/daily.sh'],
      ['scripts/uat/run-lock.sh', 'scripts/uat/run-lock.sh'],
      ['scripts/lib/machine-lock.sh', 'scripts/lib/machine-lock.sh'],
      ['.claude/skills/cmate-verify/scripts/verify-run.sh', '.claude/skills/cmate-verify/scripts/verify-run.sh'],
    ]) {
      fs.mkdirSync(path.dirname(path.join(seed, to)), { recursive: true });
      fs.copyFileSync(path.join(REPO, from), path.join(seed, to));
    }
    fs.writeFileSync(path.join(seed, 'package-lock.json'), '{"lockfileVersion":3}\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'HEAD:develop');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
    work = path.join(root, 'work');
    git(root, 'clone', '-q', '-b', 'develop', origin, work);
  });

  afterEach(() => {
    for (const child of spawnedDaily.splice(0)) child.kill('SIGKILL');
    removeTempDir(root);
  });

  const fakeFields = (): Record<string, string> =>
    Object.fromEntries(
      fs
        .readFileSync(fakeOut, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );

  it('run.ts is the leader of a group the lock names: it inherits T1, the owner is T1 with pgid, and the exit code is run.ts’s', () => {
    const result = daily({ FAKE_EXIT: '3' });
    expect(result.status, result.stderr).toBe(3);
    const seen = fakeFields();
    expect(seen.PGID).toBe(seen.PID);
    expect(seen.TOKEN).toMatch(new RegExp(`^daily-\\d+-\\d{14}-\\d+-g${seen.PID}$`));
    expect(seen.token).toBe(seen.TOKEN);
    expect(seen.pgid).toBe(seen.PID);
    expect(Number(seen.pid)).not.toBe(Number(seen.PID));
    expect(seen.label).toBe('daily');
    // the group is empty when daily.sh ends: the lock is released
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('daily mv: an owner that cannot be published stops the handover: exit 2, run.ts never starts, the lock is released', () => {
    const result = daily({ CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('reason=handoff-failed stage=mv');
    expect(fs.existsSync(fakeOut)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('daily token: an owner that cannot be read at the first read keeps the lock (deferred) and says it: exit 2', () => {
    const result = daily({ CM_VERIFY_TEST_OBS_FAULT: 'handoff-token=EIO release-owner=EIO' });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('reason=handoff-failed stage=token');
    expect(fs.existsSync(fakeOut)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it('daily signal: the group is published but the signal cannot be made: its group is stopped, run.ts never works, exit 2', () => {
    const result = daily({ CM_VERIFY_TEST_OBS_FAULT: 'handoff-signal=EIO' });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('reason=handoff-failed stage=signal');
    expect(fs.existsSync(fakeOut)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('daily ack: a child that cannot make its receipt ends without exec (75): exit 2, handoff-failed stage=ack, one sync line, a report that says why', () => {
    const report = path.join(root, 'report.json');
    const result = daily({ CM_VERIFY_TEST_OBS_FAULT: 'handoff-ack=EIO' });
    // table D daily × ack: the child ends (75) before it execs; daily.sh does not pass 75 on, it says why
    expect(fs.existsSync(fakeOut)).toBe(false);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('reason=handoff-failed stage=ack');
    expect(result.stdout.split('\n').filter((line) => line.startsWith('AGENT_HEALTH_SYNC '))).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(report, 'utf8'));
    expect(written.sync.status).toBe('failed');
    expect(written.sync.reason).toBe('handoff-failed stage=ack');
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('(E) run.ts ends but leaves a member in its group: daily.sh drains the group, so the lock is released and the exit code is run.ts’s', async () => {
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const member = path.join(root, 'member.pid');
    const result = daily({ FAKE_LEAVE: member, FAKE_EXIT: '4' });
    expect(result.status, result.stderr).toBe(4);
    const pid = Number(fs.readFileSync(member, 'utf8').trim());
    expect(pid).toBeGreaterThan(1);
    const end = Date.now() + 15_000;
    while (isAlive(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(pid)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);
  }, REAL_SHELL_TEST_TIMEOUT_MS);

  it('TERM while run.ts runs (EXIT path F): its group is stopped, the lock is released, exit 143', async () => {
    const child = spawn('bash', [path.join(work, 'scripts/agent-health/daily.sh'), '--out', path.join(root, 'report.json')], {
      cwd: root,
      env: dailyEnv({ FAKE_WAIT: '1' }),
      stdio: 'ignore',
    });
    spawnedDaily.push(child);
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const end = Date.now() + 30_000;
    while (!(fs.existsSync(fakeOut) && fs.readFileSync(fakeOut, 'utf8').includes('label=')) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(fakeOut)).toBe(true);
    const seen = fakeFields();
    expect(seen.pgid).toBe(seen.PID);
    process.kill(child.pid!, 'SIGTERM');
    expect(await exited).toBe(143);
    expect(() => process.kill(Number(seen.PID), 0)).toThrow();
    expect(fs.existsSync(lockDir)).toBe(false);
  }, REAL_SHELL_TEST_TIMEOUT_MS);
});
