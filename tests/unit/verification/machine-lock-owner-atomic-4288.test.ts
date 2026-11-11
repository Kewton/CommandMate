/**
 * Issue #4288 PR1a-f — the owner written atomically (tmp → link(2)), the owner-less <lock> holding only
 * temporaries taken out by a graced head through a predicate of its own (the new `.owner-*` by age, the
 * older run-lock / supervisor.lock `owner.tmp.<pid>` only once that pid is gone), an empty owner taken
 * out by the head past a fixed grace (10 min), an unparsable owner named and never removed, and D7's
 * reuse check made independent of the time zone (machine_lock_pid_identity: the same lstart string is
 * alive; otherwise, with started_at, the start computed from etime against started_at; without it,
 * unknown). Design: docs/design/machine-lock-owner-atomic-4288.md (upstream round 3: the invariants
 * split into "new writers only" and "while older copies remain", the latter's known limits being
 * `limit` rows of F with the condition that ends them; F expanded per real caller × implementation;
 * round 4: the first acquisition records only its own pid, the undo after a confirmation never deletes
 * by name — rename to a name of its own, check that inode, delete or link it back — the paths left are
 * listed in §3.1, the clock read before and after ps, the writer's version v=1 on new records;
 * round 5: the put-back of a moved-aside owner links instead of renaming over — EEXIST keeps the aside
 * and names it (I2-c, F67) — and §3.1's enumeration closed: lock_release's missing branch keeps the
 * <lock>, setOwnerFields answers false instead of throwing, the rmdir-only and own-name paths);
 * round 5 addition (PM decision): the guarantee written under the stop premise P0 (no writer stops past
 * the grace inside the lock's steps) and P1 (the wall clock) — every `limit` row names the premise it is
 * outside of (F69-F71 added, not fixed) — and the record's reserved keys refused in the caller's fields (I1-c, F68).
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
 * 612 cells, 270 unreachable, 342 rows; K 5 points × 3 implementations = 15 rows; F 71 rows expanded
 * into 331 implementation × caller cases, 42 unreachable, 289 reached. 646 behaviour rows.
 *
 * How the implementation will drive a row (for the implementation contract, not run here):
 *   - a root from fs.mkdtempSync under os.tmpdir(), removed in afterEach; nothing under ~/.commandmate,
 *     no server, no tmux;
 *   - the form written into `<root>/x.lock` (temporaries named `.owner-<token>` / `owner.tmp.<pid>`,
 *     ages with fs.utimesSync, a kv record with lstart= / started_at= for the D7 forms), the
 *     observation made real (a live `sleep`, a dead pid, the test's own lstart under another TZ=) or
 *     injected (CM_VERIFY_TEST_OBS_FAULT=<point>=<ERRNO>, a `ps` shim on PATH, hooks.fault);
 *   - graced callers with LOCK_OWNERLESS_GRACE_MS / ownerlessGraceMs = 600000 (the production value, I3),
 *     the empty owner past LOCK_EMPTY_OWNER_GRACE_MS = 600000 (I4);
 *   - `acquire-behind`: a live ticket of another pid placed ahead in the queue;
 *   - K: the pauses of §2.6 (bash `CM_VERIFY_TEST_HANDOFF=pause:<stage>`, sync `hooks.onOwnerStage`,
 *     TS `__testHooks.onOwnerStage`), then SIGKILL;
 *   - positive controls: the current implementation (develop fd2f4a589) gives the `now` of a row.
 *
 * @vitest-environment node
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import * as H from './lock-owner-atomic-4288-harness';

// The TS implementation's warnings are what names its refusals (corrupt, owner-exists …): read them here.
// (A global, not an import of the harness: the harness imports machine-lock.ts, which imports the logger.)
vi.mock('@/lib/logger', () => {
  const g = globalThis as { __pr1afLogs?: string[] };
  const LOGS = (g.__pr1afLogs ??= []);
  const push = (event: string, data?: unknown) => LOGS.push(`${event} ${JSON.stringify(data ?? {})}`);
  const logger = { warn: push, info: () => {}, error: push, debug: () => {}, withContext: () => logger };
  return { createLogger: () => logger };
});

const REPO = path.resolve(__dirname, '../../..');
/** The production grace of the graced callers (I3) and the fixed grace of the empty owner (I4): 10 min (PM decision 1). */
const GRACE_MS = 600_000;

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
  alive: `the <lock> (and every temporary in it) is ${GRACE_MS} ms old or younger`,
  gone: `older than ${GRACE_MS} ms (fs.utimesSync)`,
  unknown: 'the listing, an lstat, an mtime or the owner read fails (lock-list / ownerless-tmp-lstat / ownerless-mtime / lock-owner = EIO)',
} as const;
const NAME_PID = {
  alive: 'the pid in owner.tmp.<pid> answers kill -0 and started at or before the tmp mtime + 2 s (maybe the older writer, stopped past the grace); a pid started later is reused and reads as gone (F52)',
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
  'empty-owner': { ...AGE, alive: `the owner is ${GRACE_MS} ms old or younger (LOCK_EMPTY_OWNER_GRACE_MS)`, gone: `older than ${GRACE_MS} ms` },
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
  'tmp-old': 'the same past the grace; taken out only when <pid> is shown not to be the writer (gone, or started after the tmp mtime + 2 s) (codex P1: a stopped older writer resuming would rm -rf a successor)',
  'tmp-stray': '<lock> with no owner holding a temporary and a name that is not one (a file `x`, a directory, owner.tmp.abc)',
  'tmp-new+gone-dead':
    'tmp-new in the canonical <lock> and a `.gone-*` whose record is dead: the take-back-half keeps lock_ownerless_empty (no), the cleanup uses lock_ownerless_temps_only (mutation control: widening the shared predicate makes the rmdir ENOTEMPTY and blocks every poll)',
  'tmp-new+gone-alive': 'tmp-new in the canonical <lock> and a `.gone-*` whose record lives: the put-back does not land on the tmp (lock_ownerless_empty stays no)',
  'empty-owner': 'an owner of 0 bytes (an older writer killed between `: >` / openSync and the write, or a power loss after link)',
  'garbage-owner': 'an owner that does not parse',
  'lstart-match': 'kv record with lstart= equal to ps -o lstart= (LC_ALL=C) and started_at= after the start',
  'lstart-tz': 'the same holder, its lstart= written under another TZ=, started_at= present: the start from etime is not after started_at + 2 s',
  'lstart-reused': 'lstart= differs, started_at= present, and the process under the pid started > started_at= + 2 s (from etime)',
  'lstart-fails': 'ps -o lstart= fails or prints nothing (CM_VERIFY_TEST_OBS_FAULT=lstart=EIO)',
  'etime-fails': 'lstart= differs, started_at= present; ps -o etime= fails or prints a malformed value (etime=EIO, `bad:bad`, `1:99`)',
  'lstart-same-etime-fails': 'lstart= equals ps; etime would fail but is never read',
  'lstart-legacy': 'no started_at= (the older supervisor.lock record), a live holder under another TZ: the strings differ, so unknown (no evidence of reuse; round 2\'s owner mtime stand-in is gone)',
  'lstart-legacy-reused': 'no started_at=, a reused pid: unknown as well — reused only with started_at / etime evidence (PM decision 2)',
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
    'acquire-head-grace': [{ is: 'refused:unk', now: 'acquired' }, 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': [{ is: 'kept', now: 'removed' }, 'removed', 'kept'],
  },
  'lstart-legacy-reused': {
    'acquire-head-grace': [{ is: 'refused:unk', now: 'acquired' }, 'acquired', 'refused:unk'],
    'acquire-head-nograce': UUU('no-kv-for-nograce'),
    'acquire-behind': Q,
    'guard-head': [{ is: 'kept', now: 'removed' }, 'removed', 'kept'],
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
  'lstart-legacy': 'unknown',
  'lstart-legacy-reused': 'unknown',
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

// ------------------------------------------------------------------ table F (§3), per real caller × implementation

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
  'lock-owner': 'existing',
  'ownerless-tmp-lstat': 'new',
  'ownerless-mtime': 'existing',
  'ownerless-tmp-unlink': 'new',
  'ownerless-rmdir': 'existing',
  'owner-tmp-pid': 'new',
  'empty-owner-move': 'new',
  'owner-pid': 'new',
  'owner-undo-rename': 'new',
  'owner-undo-link': 'new',
  /** Round 5 addition (I1-c): the caller's fields carry a reserved key of the record. */
  'owner-fields': 'new',
  /** The put-back of a moved-aside owner (§2.7): the name kept, what it observes is link(2) from round 5 (I2-c). */
  'restore-rename': 'existing',
  pid: 'existing',
  lstart: 'existing',
  etime: 'new',
} as const;
type Point = keyof typeof POINTS;

/**
 * The real callers (codex round 2 P2: not the operation names). The acquirers and the D6 guard are
 * the callers of table T; guard-behind is a D6 guard that does not become the head; ticket-retire is
 * lock_ticket_retirable / ticketRetirable / retirable inside every caller's queue wait; hand-off is
 * lock_hand_off; release-head (round 4) is D5's release by a non-holder as the head
 * (lock_release_as_head / releaseAsHead, bash and the sync JS only).
 */
const F_CALLERS = ['acquire-head-grace', 'acquire-head-nograce', 'guard-head', 'guard-behind', 'ticket-retire', 'hand-off', 'release-head'] as const;
type FCaller = (typeof F_CALLERS)[number];

type FMessage = Message | 'owner-exists' | 'not-ours' | 'write-failed';
type FAcquire = 'acquired' | `refused:${FMessage}`;
/** What each caller answers: D6 keeps `kept` (and absent / restore-failed), unlike round 2's FResult. */
type FCodeOf<C extends FCaller> = C extends 'acquire-head-grace' | 'acquire-head-nograce'
  ? FAcquire
  : C extends 'guard-head'
    ? 'removed' | 'kept' | 'absent' | 'restore-failed'
    : C extends 'guard-behind'
      ? 'not-head'
      : C extends 'ticket-retire'
        ? 'retired' | 'kept'
        : C extends 'hand-off'
          ? 'handed' | 'failed'
          : 'released' | 'missing' | 'deferred' | 'kept' | 'unknown' | 'not-head';
type FResult = FCodeOf<FCaller>;
type FResults = { readonly [C in FCaller]?: FCodeOf<C> };

/**
 * keep: nothing removed or taken (a rule's own clean-up is the rule, not a failure direction);
 * own-only: only what this caller itself made is undone; limit: outside a premise, a known limit
 * that may fall on the removing side — `mixed` while older copies remain (I8 (b)), `premise` outside
 * P1 (the wall clock). No `residual` (I7).
 */
type Direction = 'keep' | 'own-only' | 'limit';
interface Limit {
  readonly kind: 'mixed' | 'premise';
  /** What ends it (§6.1), or why it stays. */
  readonly until: string;
  /** Whom it falls on (I9): `no-v` — only a writer / record without v= (an older copy); `any` — new writers too (a premise). */
  readonly writer: 'no-v' | 'any';
  /** Which premise is broken (the design's "前提 P0"): P0 a stop past the grace (10 min) inside the lock's steps, P1 the wall clock. */
  readonly outside: 'P0' | 'P1' | 'P0+P1';
}
type FLeft =
  | 'nothing-made'
  | 'own-lock-undone'
  | 'unchanged'
  | 'lock+own-tmp'
  | 'lock-empty'
  | 'mine+tmp'
  | 'aside-kept'
  | 'reclaimed'
  | 'two-holders-possible'
  | 'live-holder-removed';

interface FailureRow {
  /** The implementations where the call exists. */
  readonly impls: readonly Impl[];
  readonly point: Point | null;
  readonly direction: Direction;
  /** The callers that make this call, and what each answers. */
  readonly results: FResults;
  readonly left: FLeft;
  readonly note: string;
  readonly limit?: Limit;
}

const ALL = IMPLS;
const GRACED = ['bash', 'sync'] as const satisfies readonly Impl[];
const BASH = ['bash'] as const satisfies readonly Impl[];
const JS = ['sync', 'ts'] as const satisfies readonly Impl[];

/** Both acquirers answer the same (the owner create is the same in the graced and the no-grace acquisition). */
const ACQ = <const R extends FAcquire>(r: R) => ({ 'acquire-head-grace': r, 'acquire-head-nograce': r }) as const;
/** The graced acquirer and the D6 guard (the clean-up of I3 and D7 are reached by both). */
const AG_GH = <const R extends FAcquire, const G extends FCodeOf<'guard-head'>>(r: R, g: G) => ({ 'acquire-head-grace': r, 'guard-head': g }) as const;
/** Every head: both acquirers and the D6 guard (I4's empty owner, an unparsable owner). */
const HEADS = <const R extends FAcquire, const G extends FCodeOf<'guard-head'>>(r: R, g: G) => ({ ...ACQ(r), 'guard-head': g }) as const;

const UNTIL_OLD_RUNLOCK = '§6.1 1 and 3: PR1b / PR1c merged (no older lib.sh / run-lock.sh writer) and the older worktree copies updated; then (a) no process started before that runs an older copy (ps) and (b) 7 days without a record lacking v=';
const UNTIL_OLD_VERIFY = '§6.1 2 and 3: the skills port of verify-run.sh published (asked of a human) and the older worktree copies updated; then (a) no process started before that runs an older copy (ps) and (b) 7 days without a record lacking v=';

const UNTIL_RESTART = '§6.1 (c): after the deploy, every process that may have loaded an older copy (agent sessions and their shells, daily / supervisor / resident shells, the server, interactive shells) restarted once (T_RESTART); the ps narrowing (a) and the 7 days (b) are only the best-effort aid';
const STAYS_P0 = 'stays a premise (P0: no writer stops past the grace inside the lock\'s steps; a lock on mkdir / link / rename alone has no fencing)';
const STAYS_P1 = 'stays a premise (P1: the wall clock does not change by more than 2 s from the writer\'s start to the end of the reader\'s observation)';

const FAILURE_TABLE = {
  'F1-mkdir-lock': { impls: ALL, point: 'mkdir-lock', direction: 'keep', results: ACQ('refused:unk'), left: 'nothing-made', note: 'EEXIST is not a failure' },
  'F2-tmp-create-exists': { impls: ALL, point: 'owner-create', direction: 'own-only', results: ACQ('refused:unk'), left: 'unchanged', note: 'not opened: the tmp is not removed; the rmdir fails on a non-empty <lock>' },
  'F3-tmp-create-other': {
    impls: ALL,
    point: 'owner-create',
    direction: 'own-only',
    results: ACQ('refused:unk'),
    left: 'own-lock-undone',
    note: 'EACCES / ENOSPC / ENOENT: rmdir of the <lock> this mkdir made (empty only). Resumed after the ticket expired, the rmdir may take another head\'s K1 <lock>; that head then refuses on ENOENT — nobody holds (safe side, PM Claude P3-2)',
  },
  'F4-tmp-write': { impls: ALL, point: 'owner-write', direction: 'own-only', results: ACQ('refused:write-failed'), left: 'own-lock-undone', note: 'ENOSPC / EIO' },
  'F5-tmp-write-short': {
    impls: ALL,
    point: 'owner-write-short',
    direction: 'own-only',
    results: ACQ('refused:write-failed'),
    left: 'own-lock-undone',
    note: 'JS/TS: the sum of writeSync < byteLength; bash: the tmp read back with $(cat) differs from the stdin read once with $(cat) and written with printf %s\\n (same way on both sides: the trailing newline does not count, PM Claude P3-5)',
  },
  'F6-tmp-close': { impls: JS, point: 'owner-close', direction: 'own-only', results: ACQ('refused:write-failed'), left: 'own-lock-undone', note: 'closeSync throws: not published (bash: caught by F5)' },
  'F7-link-exists-file': { impls: ALL, point: 'owner-publish', direction: 'own-only', results: ACQ('refused:owner-exists'), left: 'unchanged', note: 'own tmp removed' },
  'F8-link-exists-dir': { impls: ALL, point: 'owner-publish', direction: 'own-only', results: ACQ('refused:owner-exists'), left: 'unchanged', note: 'nothing made inside the directory (`ln` would: /bin/link and linkSync answer EEXIST)' },
  'F9-link-exists-dirlink': { impls: ALL, point: 'owner-publish', direction: 'own-only', results: ACQ('refused:owner-exists'), left: 'unchanged', note: 'nothing made where the symlink points (outside <lock>)' },
  'F10-link-exists-filelink': { impls: ALL, point: 'owner-publish', direction: 'own-only', results: ACQ('refused:owner-exists'), left: 'unchanged', note: 'the symlink is not followed or replaced' },
  'F11-link-enoent': { impls: ALL, point: 'owner-publish', direction: 'own-only', results: ACQ('refused:unk'), left: 'unchanged', note: 'own tmp removed if there; no rmdir: a <lock> there now is not ours' },
  'F12-link-other': { impls: ALL, point: 'owner-publish', direction: 'own-only', results: ACQ('refused:unk'), left: 'own-lock-undone', note: 'EPERM / ENOTSUP / EIO' },
  'F13-readback-unknown-same-inode': {
    impls: ALL,
    point: 'owner-readback',
    direction: 'own-only',
    results: ACQ('refused:unk'),
    left: 'own-lock-undone',
    note: 'round 4: the owner is renamed to .undo-<token> first and that name is checked against the tmp — bash `[ ! -L undo ] && [ undo -ef tmp ]` (P3-4), JS/TS lstat(undo) vs lstat(tmp) dev+ino (the tmp is closed: P3-3); the same inode: .undo-<token> and the tmp removed, rmdir. The name `owner` is never removed after a check',
  },
  'F14-readback-unknown-other-inode': { impls: ALL, point: 'owner-readback', direction: 'own-only', results: ACQ('refused:unk'), left: 'unchanged', note: 'the renamed one is another inode, a symlink, or there is no tmp to compare: linked back to <lock>/owner and .undo-<token> removed; own tmp only' },
  'F15-readback-not-ours': { impls: ALL, point: 'owner-readback', direction: 'own-only', results: ACQ('refused:not-ours'), left: 'unchanged', note: 'own tmp removed' },
  'F16-tmp-unlink-after-publish': { impls: ALL, point: 'owner-unlink', direction: 'keep', results: ACQ('acquired'), left: 'mine+tmp', note: 'the tmp goes with the rm -rf of release / recovery' },
  'F17-undo-tmp-unlink': { impls: ALL, point: 'owner-unlink', direction: 'keep', results: ACQ('refused:write-failed'), left: 'lock+own-tmp', note: 'tmp-new: a graced head takes it out after the grace (I3)' },
  'F18-undo-lock-rmdir': { impls: ALL, point: 'lock-rmdir', direction: 'keep', results: ACQ('refused:write-failed'), left: 'lock-empty', note: 'as today' },
  'F19-cleanup-list': { impls: GRACED, point: 'lock-list', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'no mkdir this poll; D6 names it in LRO_UNKNOWN' },
  'F20-cleanup-tmp-lstat': { impls: GRACED, point: 'ownerless-tmp-lstat', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'no mkdir this poll' },
  'F21-cleanup-mtime': { impls: GRACED, point: 'ownerless-mtime', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'no mkdir this poll' },
  'F22-cleanup-tmp-unlink': { impls: GRACED, point: 'ownerless-tmp-unlink', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'not ENOENT: no rmdir, no mkdir this poll' },
  'F23-cleanup-tmp-unlink-enoent': { impls: GRACED, point: 'ownerless-tmp-unlink', direction: 'keep', results: AG_GH('acquired', 'removed'), left: 'reclaimed', note: 'already gone (an older cleaner at the same time): on to the next name / the rmdir — the rule goes on' },
  'F24-cleanup-rmdir-notempty': { impls: GRACED, point: 'ownerless-rmdir', direction: 'keep', results: AG_GH('refused:rec', 'kept'), left: 'unchanged', note: 'published in between: the owner is judged as a record' },
  'F25-cleanup-rmdir-other': { impls: GRACED, point: 'ownerless-rmdir', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'no mkdir this poll' },
  'F26-old-tmp-pid-unknown': { impls: GRACED, point: 'owner-tmp-pid', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: "kill -0 of the name's pid: EPERM / EIO" },
  'F27-old-tmp-pid-alive': { impls: GRACED, point: null, direction: 'keep', results: AG_GH('refused:old-taker', 'kept'), left: 'unchanged', note: 'alive and started at or before the tmp mtime + 2 s: maybe the older writer stopped past the grace; resumed, it mv-s its own tmp (codex round 1 P1)' },
  'F28-old-tmp-pid-not-numeric': { impls: GRACED, point: null, direction: 'keep', results: AG_GH('refused:stray', 'kept'), left: 'unchanged', note: 'owner.tmp.<not a pid>' },
  'F29-empty-owner-young': { impls: ALL, point: null, direction: 'keep', results: HEADS('refused:taking', 'kept'), left: 'unchanged', note: '10 min or younger: maybe being written' },
  'F30-empty-owner-move': { impls: ALL, point: 'empty-owner-move', direction: 'keep', results: HEADS('refused:unk', 'kept'), left: 'unchanged', note: 'the mv aside fails' },
  'F31-empty-owner-aside-written': { impls: ALL, point: null, direction: 'keep', results: HEADS('refused:rec', 'kept'), left: 'aside-kept', note: 'no longer 0 bytes once moved: lock_settle_gone judges it as a record next poll' },
  'F32-kill0-other': { impls: BASH, point: 'pid', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: EIO, unknown stays, D7 not applied' },
  'F33-ps-lstart': { impls: BASH, point: 'lstart', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: alive → unknown:lstart:<errno>; EPERM stays' },
  'F34-lstart-only-60s': {
    impls: BASH,
    point: null,
    direction: 'keep',
    results: AG_GH('refused:unk', 'kept'),
    left: 'unchanged',
    note: 'D7: no started_at=, the strings 60 s apart (readers under UTC0 and XXX-0:01, a live holder): unknown:lstart:EMISMATCH — round 2 read "not a multiple of 15 min" as another start (codex round 2 P2; PM decision 2)',
  },
  'F35-ps-etime': { impls: BASH, point: 'etime', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: alive → unknown:etime:<errno>; EPERM stays' },
  'F36-etime-malformed': { impls: BASH, point: 'etime', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: `bad:bad`, `1:99`, `-1:00`, four fields: never read as 0 s elapsed' },
  'F37-ticket-etime-malformed': { impls: ALL, point: 'etime', direction: 'keep', results: { 'ticket-retire': 'kept' }, left: 'unchanged', note: 'bash lock_pid_start_ms takes the strict parse; JS/TS parseEtime checks the ranges; the clock read before and after ps as in F65 (a step back in between keeps the ticket)' },
  'F38-lstart-only-reused': { impls: BASH, point: null, direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: no started_at=, the pid reused by a live process: kept and named until that pid ends (round 2\'s owner mtime stand-in dropped)' },
  'F39-started-at-unparsed': { impls: BASH, point: null, direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: date cannot read started_at=, the strings differ: as if absent (F34)' },
  'F40-started-at-carry-over': { impls: BASH, point: null, direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: LOB_STARTED_AT emptied per read: a record without started_at= after one with is not read as reused' },
  'F41-hostname': { impls: BASH, point: null, direction: 'keep', results: AG_GH('refused:rec', 'kept'), left: 'unchanged', note: 'D7: another host= is alive' },
  'F42-clock-back': {
    impls: BASH,
    point: null,
    direction: 'limit',
    results: AG_GH('acquired', 'removed'),
    left: 'live-holder-removed',
    note: 'D7: the wall clock stepped back > 2 s between the holder\'s start and its acquisition, and the writer and reader TZ differ (the strings differ): now − etime > started_at + 2 s reads a live holder as reused; so does GNU ps\'s monotonic etime with the clock stepped forward > 2 s after the acquisition. A change between now and ps is F65 (unknown), not this row. Same TZ: the strings match, never reached',
    limit: { kind: 'premise', until: 'stays a premise (P1; the parent §1.8 treatment, PM Claude PR1c round 3 hand-over B-2)', writer: 'any', outside: 'P1' },
  },
  'F43-launchd-reader': { impls: BASH, point: null, direction: 'keep', results: AG_GH('refused:rec', 'kept'), left: 'unchanged', note: 'D7: written under env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin (TZ, LC_ALL unset), read with TZ=UTC and TZ=Asia/Tokyo: started_at against etime, alive' },
  'F44-pid-gone-group-alive': { impls: BASH, point: null, direction: 'keep', results: AG_GH('refused:rec', 'kept'), left: 'unchanged', note: 'D7: pgid= and lstart=, the pid gone and G alive: D7 not applied (no such record in production)' },
  'F45-handoff-lstart': { impls: BASH, point: null, direction: 'keep', results: { 'hand-off': 'failed' }, left: 'unchanged', note: "LOCK_OWNER_EXTRA with lstart=: LHO_STAGE=lstart, the owner not rewritten (I5's premise)" },
  'F46-garbage-owner': { impls: ALL, point: null, direction: 'keep', results: HEADS('refused:corrupt', 'kept'), left: 'unchanged', note: 'never removed; the refusal and D6 name <lock>/owner (I4)' },
  'F47-guard-absent-check': { impls: GRACED, point: 'lock-list', direction: 'keep', results: { 'guard-head': 'kept' }, left: 'unchanged', note: "D6's own failure: its lock_ownerless_empty (the absent check, verify-run.sh:2030) answers unknown; named in LRO_UNKNOWN (an acquirer never makes this check)" },
  'F48-guard-not-head': { impls: GRACED, point: null, direction: 'keep', results: { 'guard-behind': 'not-head' }, left: 'unchanged', note: "D6's own failure: not the head within its budget (a live ticket ahead): moves nothing (I0-b)" },
  'F49-old-k1-resumed': {
    impls: GRACED,
    point: null,
    direction: 'limit',
    results: AG_GH('acquired', 'removed'),
    left: 'two-holders-possible',
    note: 'an older run-lock / supervisor.lock writer (no ticket) stopped after its mkdir, before owner.tmp.<pid> (no pid anywhere), past the 10 min grace; the head reclaims the empty <lock> and takes it; resumed, the writer writes its tmp in the successor\'s <lock> and mv -f replaces the owner (codex round 2 P1)',
    limit: { kind: 'mixed', until: UNTIL_OLD_RUNLOCK, writer: 'no-v', outside: 'P0' },
  },
  'F50-pr1a-writer-ticket-expired': {
    impls: ALL,
    point: null,
    direction: 'limit',
    results: HEADS('acquired', 'removed'),
    left: 'two-holders-possible',
    note: 'a PR1a writer (`: >`, then cat >> by name, rm -f owner by name on failure) alive, its ticket retired at deadline + 60 s, stopped on an empty owner past 10 min; the head reclaims the empty owner and takes it; resumed, it appends to the successor\'s owner (unparsable, nobody removes it) or removes it by name (PM Claude round 2 P2-A)',
    limit: { kind: 'mixed', until: UNTIL_OLD_VERIFY, writer: 'no-v', outside: 'P0' },
  },
  'F51-pre-pid-stop': {
    impls: ALL,
    point: null,
    direction: 'limit',
    results: HEADS('acquired', 'removed'),
    left: 'two-holders-possible',
    note: 'a copy older than PR1a (`printf > owner`, an older cmate-verify) stopped after opening the owner, before its pid is written, past 10 min; the head reclaims the empty owner; resumed, its write lands in the removed inode and it may believe it holds',
    limit: { kind: 'mixed', until: UNTIL_OLD_VERIFY, writer: 'no-v', outside: 'P0' },
  },
  'F52-old-tmp-pid-reused': { impls: GRACED, point: null, direction: 'keep', results: AG_GH('acquired', 'removed'), left: 'reclaimed', note: 'the pid is alive but started after the tmp mtime + 2 s (from etime): not the writer, the rule takes it out (PM Claude P3-1; round 2 kept it old-taker for ever)' },
  'F53-old-tmp-pid-etime': { impls: GRACED, point: 'etime', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'the old tmp pid alive and its ps -o etime= fails or is malformed, or the clock stepped back while it was read / the read took 1 s or more (ECLOCK, as F65)' },
  'F54-started-at-60s': { impls: BASH, point: null, direction: 'keep', results: AG_GH('refused:rec', 'kept'), left: 'unchanged', note: 'D7: started_at= present, the strings 60 s apart (a minute-unit TZ offset, a live holder): the start from etime is not after started_at + 2 s, alive' },
  'F55-old-tmp-clock-back': {
    impls: GRACED,
    point: null,
    direction: 'limit',
    results: AG_GH('acquired', 'removed'),
    left: 'two-holders-possible',
    note: 'an older writer whose wall clock stepped back > 2 s between its start and its tmp write, then stopped between the tmp and its mv past 10 min: F52 reads it as reused and takes the tmp out; resumed, its mv -f fails and its rm -rf "$dir" may remove the successor\'s <lock> (outside P1, while older copies remain)',
    limit: { kind: 'mixed', until: UNTIL_OLD_RUNLOCK, writer: 'no-v', outside: 'P0+P1' },
  },
  'F56-owner-pid-not-self': { impls: GRACED, point: 'owner-pid', direction: 'keep', results: ACQ('refused:unk'), left: 'nothing-made', note: "round 4, I1-b: LOCK_OWNER_PID / ownerPid not the caller's own pid: refused before the ticket and the mkdir (machine-lock-owner-pid-not-self); another pid is recorded by the hand-off (D4) only" },
  'F57-undo-paused-after-rename': {
    impls: ALL,
    point: null,
    direction: 'own-only',
    results: ACQ('refused:unk'),
    left: 'unchanged',
    note: 'round 4, the interrupt right after the check: stopped past 60 s after the rename to .undo-<token> (before the inode check, or after it before the unlink / the link back): no owner and a .undo-<token> in <lock> — every head reads it stray and neither cleans nor recovers; resumed, the writer checks, removes or links back its own name only',
  },
  'F58-undo-restore-exists': {
    impls: ALL,
    point: 'owner-undo-link',
    direction: 'limit',
    results: ACQ('refused:unk'),
    left: 'two-holders-possible',
    note: 'the link back of .undo-<token> answers EEXIST: an older writer (`: >`, `printf >`) made an owner in the moment the owner was moved: not put back, .undo-<token> kept, machine-lock-undo-restore-failed for a human. A new writer links only into the <lock> it made (in a successor\'s <lock> its tmp is gone: ENOENT, F11)',
    limit: { kind: 'mixed', until: UNTIL_OLD_VERIFY, writer: 'no-v', outside: 'P0' },
  },
  'F59-undo-rename-enoent': { impls: ALL, point: 'owner-undo-rename', direction: 'own-only', results: ACQ('refused:unk'), left: 'unchanged', note: 'the owner is no longer there: own tmp removed, no rmdir (the <lock> there is not shown to be ours)' },
  'F60-undo-rename-other': { impls: ALL, point: 'owner-undo-rename', direction: 'own-only', results: ACQ('refused:unk'), left: 'unchanged', note: 'another errno: the owner is not removed; own tmp only; named as unknown' },
  'F61-undo-successor-before-rename': {
    impls: ALL,
    point: null,
    direction: 'own-only',
    results: ACQ('refused:unk'),
    left: 'unchanged',
    note: "codex round 3 P2's order, new writers only, a sane clock: stopped after the read-back failed and before the rename, the recorded pid dies meanwhile (bash: the parent $$ of the pipeline's subshell), the ticket retires, a successor recovers and takes; resumed, the rename moves the successor's owner, the own tmp went with the recovery so nothing compares, and the link puts the successor's owner back (the same inode)",
  },
  'F62-release-head-paused': { impls: GRACED, point: null, direction: 'keep', results: { 'release-head': 'kept' }, left: 'unchanged', note: "round 4: D5 judged the record gone, stopped past its ticket, another head recovered and took; resumed, it removes by lock_recover / recoverLock (moved aside under its own name, the token checked: the successor's differs from T0 / T1, put back), no longer rm -rf <lock> by name" },
  'F63-guard-absent': { impls: GRACED, point: null, direction: 'keep', results: { 'guard-head': 'absent' }, left: 'unchanged', note: 'D6 as the head finds no <lock> (codex round 3 P3)' },
  'F64-guard-restore-failed': { impls: GRACED, point: null, direction: 'keep', results: { 'guard-head': 'restore-failed' }, left: 'aside-kept', note: "D6 moved a record aside whose token differs (a successor took it in between) and the restore mkdir fails: the aside stays and is read as held while its record lives (§2.7); machine-lock-restore-failed (codex round 3 P3)" },
  'F65-clock-back-during-observation': { impls: BASH, point: 'etime', direction: 'keep', results: AG_GH('refused:unk', 'kept'), left: 'unchanged', note: 'D7: now_after < now_before (the clock stepped back between now and ps) or the read took 1 s or more: unknown:etime:ECLOCK, read again next poll (codex round 3 P2: now 1000 s, back to 970 s, etime 870 s used to read a start of 130 s > 110 s + 2 s as reused)' },
  'F66-owner-without-v': { impls: ALL, point: null, direction: 'keep', results: HEADS('refused:rec', 'kept'), left: 'unchanged', note: 'I9: a parsed record without v= (an older copy) or an older owner.tmp.<pid>: judged as before; named once per process and lock, machine-lock-legacy-writer <lock> pid=<pid> — the observation that ends the mixed period (§6.1 (b))' },
  'F67-put-back-link-exists': {
    impls: ALL,
    point: 'restore-rename',
    direction: 'keep',
    results: HEADS('refused:rec', 'restore-failed'),
    left: 'aside-kept',
    note: "round 5 (PM Claude round 4 P2-1): an owner published between the put-back's check (created / ownerless-empty) and its link(gone/owner, <lock>/owner) — EEXIST: not put back, the aside kept, the <lock> not rmdir'd (it holds the publisher's owner); machine-lock-restore-failed <lock>: kept <gone> (EEXIST). Round 4's rename overwrote it. Interrupt after pause:restore-mkdir. A new writer resumed from K1 into that window still makes two holders (I8 (a)'s exception, §8 4)",
  },
  'F68-owner-fields-reserved': {
    impls: GRACED,
    point: 'owner-fields',
    direction: 'keep',
    results: ACQ('refused:unk'),
    left: 'nothing-made',
    note: "round 5 addition (codex round 4 P2, PM decision 3; not a premise, so closed): ownerFields (sync, spread last today) / LOCK_OWNER_EXTRA (bash kv, the first line of a key wins, so an extra pgid= beat the section's) carries a reserved key (pid host token acquiredAt/started_at pgid v; sync also lstart done; bash lstart= past its first line): refused before the ticket and the mkdir, machine-lock-owner-field-reserved <lock> key=<k>; setOwnerFields answers false. TS has no such entry (I1-c)",
  },
  'F69-new-k1-writer-into-emptied-name': {
    impls: ALL,
    point: null,
    direction: 'limit',
    results: ACQ('refused:unk'),
    left: 'two-holders-possible',
    note: "outside P0 (codex round 4 P2): a new writer C stopped at K1 past 10 min, A recovered and published, A's parent died (F61's order) and B took, C resumed and made its tmp inside B's <lock>, A's undo moved B's owner to .undo-<A> and C linked into the emptied name; A's link back is EEXIST — B and C hold. The put-back's empty <lock> (F67) is the same shape. Named, not fixed",
    limit: { kind: 'premise', until: STAYS_P0, writer: 'any', outside: 'P0' },
  },
  'F70-clock-back-offset-by-reader-stop': {
    impls: BASH,
    point: 'etime',
    direction: 'limit',
    results: AG_GH('acquired', 'removed'),
    left: 'live-holder-removed',
    note: 'D7: outside P1 (codex round 4 P2): start 100 s, acquired 110 s, now_before 1000 s, the clock back to 970 s, BSD etime 870 s, the reader stops 30 s, now_after 1000 s — the difference 0 passes the ECLOCK check and the start reads 130 s > 112 s: a live holder whose lstart string differs (another TZ) is read as reused. Two wall-clock reads cannot bound the real elapsed time. Named, not fixed',
    limit: { kind: 'premise', until: STAYS_P1, writer: 'any', outside: 'P1' },
  },
  'F71-old-writer-in-generic-shell': {
    impls: ALL,
    point: null,
    direction: 'limit',
    results: HEADS('acquired', 'removed'),
    left: 'two-holders-possible',
    note: "outside P0, mixed (codex round 4 P2): an older copy's functions loaded into a generic shell (bash -s, an interactive shell) or node, stopped past 10 min mid-steps (before writing too): the ps narrowing of §6.1 (a) does not see its command, and it writes nothing (b) could see; resumed, it mv -f's / deletes by name the successor's owner (as F49-F51)",
    limit: { kind: 'mixed', until: UNTIL_RESTART, writer: 'no-v', outside: 'P0' },
  },
  'F72-old-tmp-slow-observation': {
    impls: GRACED,
    point: 'etime',
    direction: 'keep',
    results: AG_GH('refused:unk', 'kept'),
    left: 'unchanged',
    note: 'impl-6: the pid of an older tmp is alive and the observation of its start (ps -o etime= between two clock reads) took 1 s or more (a loaded machine): ECLOCK, so unknown — the conservative side, the tmp kept and named (etime ECLOCK), never read as reused (F52, F55 pin the fast side)',
  },
} as const satisfies Record<string, FailureRow>;
type Failure = keyof typeof FAILURE_TABLE;
const FAILURES = Object.keys(FAILURE_TABLE) as Failure[];
const F_ROWS: Array<FailureRow & { id: Failure }> = FAILURES.map((id) => ({ id, ...(FAILURE_TABLE[id] as FailureRow) }));

const F_UNREACHABLE_REASONS = {
  'ts-no-grace': UNREACHABLE_REASONS['ts-no-grace'],
  'ts-no-guard': UNREACHABLE_REASONS['ts-no-guard'],
} as const;
type FReason = keyof typeof F_UNREACHABLE_REASONS;
function fReach(impl: Impl, caller: FCaller): FReason | null {
  if (impl === 'ts' && caller === 'acquire-head-grace') return 'ts-no-grace';
  if (impl === 'ts' && (caller === 'guard-head' || caller === 'guard-behind')) return 'ts-no-guard';
  return null;
}

interface FCase {
  id: Failure;
  impl: Impl;
  caller: FCaller;
  result: FResult;
  row: FailureRow;
  unreachable: FReason | null;
}
const F_ALL_CASES: FCase[] = F_ROWS.flatMap((row) =>
  row.impls.flatMap((impl) =>
    (F_CALLERS.filter((c) => row.results[c] !== undefined) as FCaller[]).map((caller) => ({
      id: row.id,
      impl,
      caller,
      result: row.results[caller] as FResult,
      row,
      unreachable: fReach(impl, caller),
    })),
  ),
);
const F_CASES = F_ALL_CASES.filter((c) => c.unreachable === null);
const fMoves = (r: FResult): boolean => r === 'acquired' || r === 'removed' || r === 'retired';

// ------------------------------------------------------------------ §4: machine_lock_pid_identity (the contract PR1c uses through D7)

const PID_IDENTITY = {
  bash: {
    name: 'machine_lock_pid_identity',
    file: 'scripts/lib/machine-lock.sh',
    args: ['pid', 'recorded-lstart', 'started-at-ms (may be empty)'],
    answers: ['alive', 'reused', 'unknown:<point>:<errno>'],
    helpers: ['machine_lock_etime_ms'],
    /** alive is "reuse not shown", a value leaning to keep: it decides whether to remove, never whether to stop (PM decision 3). */
    use: 'D7 through lock_record_state only: the acquisition, lock_settle_gone and the D6 guard',
    never: [
      { file: 'scripts/agent-health/product/lib.sh', fn: 'proc_matches' },
      { file: 'scripts/agent-health/product/deadline-guard.sh', fn: null },
      { file: 'scripts/agent-health/product/supervisor.sh', fn: null },
    ],
  },
  sync: { name: null, why: 'no JS caller reads lstart= (I6); parseEtime gains the range check (F37)' },
  ts: { name: null, why: 'the same' },
} as const;

/** The rule of §4.1 on plain values (no strings parsed): what the identity answers. */
interface IdentityInput {
  /** ps -o lstart= against the record: the same string, a different one, or unreadable. */
  readonly cur: 'same' | 'differs' | 'unreadable';
  /** started_at= in ms, or null when absent / unparsable. */
  readonly startedAtMs: number | null;
  /** now − etime in ms (taken before ps), or null when etime fails or is malformed. */
  readonly startMs: number | null;
  /** Round 4: the clock read before and after ps and the etime read in between; when given, it decides startMs. */
  readonly observed?: Observation;
}
interface Observation {
  readonly nowBefore: number;
  readonly nowAfter: number;
  readonly etime: number;
}
const SLACK_MS = 2000;
/** §4.1 5–6 (round 4): a step back between the two reads, or a read of 1 s or more, is unknown (ECLOCK). */
function startFrom({ nowBefore, nowAfter, etime }: Observation): number | null {
  if (nowAfter < nowBefore || nowAfter - nowBefore >= 1000) return null;
  return nowBefore - etime;
}
/** Round 3's rule (now before ps only): the positive control of F65. */
const startFromRound3 = ({ nowBefore, etime }: Observation): number => nowBefore - etime;
function identity({ cur, startedAtMs, startMs, observed }: IdentityInput): 'alive' | 'reused' | 'unknown' {
  if (cur === 'unreadable') return 'unknown';
  if (cur === 'same') return 'alive';
  if (startedAtMs === null) return 'unknown'; // lstart= only: no evidence either way (PM decision 2)
  const start = observed ? startFrom(observed) : startMs;
  if (start === null) return 'unknown';
  return start > startedAtMs + SLACK_MS ? 'reused' : 'alive';
}

const T0 = Date.UTC(2026, 10, 11, 9, 32, 44); // the holder's real start (measured lstart: 09:32:44 UTC / 18:32:44 Asia/Tokyo)
/** Witnesses of §4.1: each with its input, its answer, and the row it stands for. */
const IDENTITY_CASES = {
  'same-string': { input: { cur: 'same', startedAtMs: null, startMs: null }, answer: 'alive', row: 'lstart-match, lstart-same-etime-fails (etime never read)' },
  'tz-9h-with-started-at': { input: { cur: 'differs', startedAtMs: T0 + 1000, startMs: T0 }, answer: 'alive', row: 'lstart-tz, F43' },
  'tz-60s-with-started-at': { input: { cur: 'differs', startedAtMs: T0 + 1000, startMs: T0 }, answer: 'alive', row: 'F54 (the size of the string difference is not read)' },
  'tz-60s-lstart-only': { input: { cur: 'differs', startedAtMs: null, startMs: T0 }, answer: 'unknown', row: 'F34 (round 2 said "not an offset")' },
  'tz-9h-lstart-only': { input: { cur: 'differs', startedAtMs: null, startMs: T0 }, answer: 'unknown', row: 'lstart-legacy' },
  'reused-with-started-at': { input: { cur: 'differs', startedAtMs: T0, startMs: T0 + 60_000 }, answer: 'reused', row: 'lstart-reused' },
  'reused-lstart-only': { input: { cur: 'differs', startedAtMs: null, startMs: T0 + 60_000 }, answer: 'unknown', row: 'lstart-legacy-reused, F38' },
  'etime-fails': { input: { cur: 'differs', startedAtMs: T0, startMs: null }, answer: 'unknown', row: 'etime-fails, F35, F36' },
  'lstart-fails': { input: { cur: 'unreadable', startedAtMs: T0, startMs: T0 }, answer: 'unknown', row: 'lstart-fails, F33' },
  'started-within-slack': { input: { cur: 'differs', startedAtMs: T0, startMs: T0 + SLACK_MS }, answer: 'alive', row: 'the 2 s slack (lock_now_ms in whole seconds)' },
  // the clock stepped back 5 s after the holder started and before it wrote started_at: a live holder, read as reused
  'clock-back-premise': { input: { cur: 'differs', startedAtMs: T0 - 4000, startMs: T0 }, answer: 'reused', row: 'F42 (limit, premise P1)' },
  // round 4 (codex round 3 P2): started 100 s, acquired 110 s; now_before 1000 s, the clock back to 970 s before
  // ps, BSD etime 870 s: round 3 read a start of 130 s (> 112 s, reused); now_after < now_before is unknown
  'clock-back-during-observation': {
    input: { cur: 'differs', startedAtMs: 110_000, startMs: null, observed: { nowBefore: 1_000_000, nowAfter: 970_100, etime: 870_000 } },
    answer: 'unknown',
    row: 'F65',
  },
  // a step back of 300 ms hidden inside a 200 ms read: the error stays under the read's length, alive
  'hidden-step-within-observation': {
    input: { cur: 'differs', startedAtMs: 110_000, startMs: null, observed: { nowBefore: 1_000_000, nowAfter: 1_000_200, etime: 900_100 } },
    answer: 'alive',
    row: 'P1 (the observation window)',
  },
  'slow-observation': {
    input: { cur: 'differs', startedAtMs: 110_000, startMs: null, observed: { nowBefore: 1_000_000, nowAfter: 1_001_000, etime: 900_000 } },
    answer: 'unknown',
    row: 'F65 (1 s or more: a step inside cannot be told)',
  },
  'clock-forward-during-observation': {
    input: { cur: 'differs', startedAtMs: 110_000, startMs: null, observed: { nowBefore: 1_000_000, nowAfter: 1_030_100, etime: 930_000 } },
    answer: 'unknown',
    row: 'F65',
  },
} as const satisfies Record<string, { input: IdentityInput; answer: 'alive' | 'reused' | 'unknown'; row: string }>;

/** Each D7 form of table T as an input of §4.1 (the identity of IDENTITY_OF must follow from the rule). */
const FORM_IDENTITY = {
  'lstart-match': 'same-string',
  'lstart-tz': 'tz-9h-with-started-at',
  'lstart-reused': 'reused-with-started-at',
  'lstart-fails': 'lstart-fails',
  'etime-fails': 'etime-fails',
  'lstart-same-etime-fails': 'same-string',
  'lstart-legacy': 'tz-9h-lstart-only',
  'lstart-legacy-reused': 'reused-lstart-only',
} as const satisfies Record<D7Form, keyof typeof IDENTITY_CASES>;

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

  it('K has 5 points × 3 implementations = 15 rows, F has 72 rows: 335 implementation × caller cases, 42 unreachable, 293 reached; 650 rows in all', () => {
    expect(KILL_ROWS).toHaveLength(15);
    expect(FAILURES).toHaveLength(72);
    expect(F_ALL_CASES).toHaveLength(335);
    expect(F_ALL_CASES.filter((c) => c.unreachable !== null)).toHaveLength(42);
    expect(F_CASES).toHaveLength(293);
    expect(ROWS.length + KILL_ROWS.length + F_CASES.length).toBe(650);
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
      // round 3: lstart-legacy-reused is no longer taken (no started_at, no evidence of reuse)
      expect(['lstart-reused']).toContain(e.form);
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
      // reused only with the evidence of started_at and etime (PM decision 2): not the lstart=-only record
      expect(['lstart-reused']).toContain(e.form);
    }
    for (const form of ['lstart-legacy', 'lstart-legacy-reused'] as const) {
      expect(normalize(BASH_T[form]['acquire-head-grace'][0])).toMatchObject({ is: 'refused:unk' });
      expect(normalize(BASH_T[form]['guard-head'][0])).toMatchObject({ is: 'kept' });
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

  it('§3: no residual row (I7); own-only rows are the acquisition\'s own undo; the clean-up rows are graced, the D7 rows bash', () => {
    expect(F_ROWS.filter((f) => (f.direction as string) === 'residual')).toEqual([]);
    for (const f of F_ROWS) for (const c of Object.keys(f.results)) expect((F_CALLERS as readonly string[]).includes(c)).toBe(true);
    for (const f of F_ROWS.filter((r) => r.direction === 'own-only')) {
      expect(Object.keys(f.results).sort()).toEqual(['acquire-head-grace', 'acquire-head-nograce']);
    }
    for (const id of ['F19-cleanup-list', 'F22-cleanup-tmp-unlink', 'F24-cleanup-rmdir-notempty', 'F26-old-tmp-pid-unknown', 'F52-old-tmp-pid-reused'] as const) {
      expect([...FAILURE_TABLE[id].impls]).toEqual(['bash', 'sync']);
    }
    for (const f of F_ROWS.filter((r) => r.note.startsWith('D7:') || r.id === 'F45-handoff-lstart')) expect([...f.impls]).toEqual(['bash']);
    // every new point of §2.8 is driven by a row
    const used = new Set(F_ROWS.map((f) => f.point));
    for (const [p, kind] of Object.entries(POINTS)) if (kind === 'new') expect(used.has(p as Point)).toBe(true);
    // a short write and a failed close are rows (codex P2)
    expect(FAILURE_TABLE['F5-tmp-write-short'].point).toBe('owner-write-short');
    expect(FAILURE_TABLE['F6-tmp-close'].point).toBe('owner-close');
  });

  it('§3: F is written per real caller (codex round 2 P2): an acquirer and the D6 guard on the same failure agree, and the guard answers kept', () => {
    for (const f of F_ROWS) {
      const acq = f.results['acquire-head-grace'] ?? f.results['acquire-head-nograce'];
      const guard = f.results['guard-head'];
      if (acq !== undefined && guard !== undefined) expect(acq === 'acquired').toBe(guard === 'removed');
      if (f.results['acquire-head-grace'] !== undefined && f.results['acquire-head-nograce'] !== undefined) {
        expect(f.results['acquire-head-grace']).toBe(f.results['acquire-head-nograce']);
      }
    }
    // the guard's own rows (D6's failures) and kept as a result
    expect(FAILURE_TABLE['F47-guard-absent-check'].results).toEqual({ 'guard-head': 'kept' });
    expect(FAILURE_TABLE['F48-guard-not-head'].results).toEqual({ 'guard-behind': 'not-head' });
    expect(F_CASES.filter((c) => c.caller === 'guard-head' && c.result === 'kept').length).toBeGreaterThan(0);
    // the clean-up and D7 rows name the guard too (round 2 named only the operation); round 4: the rows the
    // graced acquirer reaches without the no-grace one (F56 is both acquirers' option check, F62 is D5's)
    for (const f of F_ROWS.filter((r) => r.impls.length === 2 && r.impls[0] === 'bash' && r.impls[1] === 'sync' && r.results['acquire-head-grace'] !== undefined && r.results['acquire-head-nograce'] === undefined)) {
      expect(Object.keys(f.results).some((c) => c.startsWith('guard'))).toBe(true);
    }
    // TS has neither a graced acquirer nor a guard: such cases are unreachable, with the reason
    for (const c of F_ALL_CASES.filter((x) => x.impl === 'ts' && (x.caller === 'acquire-head-grace' || x.caller.startsWith('guard')))) {
      expect(c.unreachable).not.toBeNull();
    }
    for (const c of F_ALL_CASES.filter((x) => x.unreachable !== null)) expect(F_UNREACHABLE_REASONS[c.unreachable as FReason].length).toBeGreaterThan(0);
  });

  it('§3, I7, I8: a row that moves is the rule or the own undo — the removing side outside a premise is a `limit` row, mixed or premise, with what ends it', () => {
    const moving = F_ROWS.filter((f) => f.direction === 'keep' && Object.values(f.results).some((r) => fMoves(r as FResult)));
    expect(moving.map((f) => f.id).sort()).toEqual(['F16-tmp-unlink-after-publish', 'F23-cleanup-tmp-unlink-enoent', 'F52-old-tmp-pid-reused']);
    const limits = F_ROWS.filter((f) => f.direction === 'limit');
    expect(limits.map((f) => `${f.id}:${f.limit?.kind}`).sort()).toEqual([
      'F42-clock-back:premise',
      'F49-old-k1-resumed:mixed',
      'F50-pr1a-writer-ticket-expired:mixed',
      'F51-pre-pid-stop:mixed',
      'F55-old-tmp-clock-back:mixed',
      'F58-undo-restore-exists:mixed',
      'F69-new-k1-writer-into-emptied-name:premise',
      'F70-clock-back-offset-by-reader-stop:premise',
      'F71-old-writer-in-generic-shell:mixed',
    ]);
    for (const f of limits) {
      expect(f.limit?.until.length).toBeGreaterThan(0);
      // I9: a mixed limit falls only on a writer without v=; a premise on any writer
      expect(f.limit?.writer).toBe(f.limit?.kind === 'mixed' ? 'no-v' : 'any');
      expect(['two-holders-possible', 'live-holder-removed']).toContain(f.left);
    }
    for (const f of F_ROWS.filter((r) => r.direction !== 'limit')) {
      expect(f.limit).toBeUndefined();
      expect(['two-holders-possible', 'live-holder-removed']).not.toContain(f.left);
    }
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
        'lstart-legacy-reused/acquire-head-grace/alive',
        'lstart-legacy-reused/guard-head/alive',
      ].sort(),
    );
  });
});

describe('Issue #4288 PR1a-f round 4 (design §3.1, I1-b, I2-b, I9, P1): no name deleted after a check, the own pid only, v=', () => {
  it('I1-b: the first acquisition with another pid is refused before anything is made (F56); another pid is the hand-off\'s only', () => {
    const f = FAILURE_TABLE['F56-owner-pid-not-self'];
    expect([f.point, f.left, f.direction]).toEqual(['owner-pid', 'nothing-made', 'keep']);
    expect(f.results).toEqual({ 'acquire-head-grace': 'refused:unk', 'acquire-head-nograce': 'refused:unk' });
    expect([...f.impls]).toEqual(['bash', 'sync']); // TS has no ownerPid
  });

  it('I2-b: the undo renames to its own name before the check; the interrupt right after the check and codex round 3\'s order leave the successor\'s owner', () => {
    for (const id of ['F13-readback-unknown-same-inode', 'F14-readback-unknown-other-inode', 'F57-undo-paused-after-rename', 'F59-undo-rename-enoent', 'F60-undo-rename-other', 'F61-undo-successor-before-rename'] as const) {
      const f = FAILURE_TABLE[id];
      expect([id, f.direction, [...f.impls]]).toEqual([id, 'own-only', ['bash', 'sync', 'ts']]);
    }
    expect(FAILURE_TABLE['F13-readback-unknown-same-inode'].note).toContain('.undo-<token>');
    for (const id of ['F57-undo-paused-after-rename', 'F59-undo-rename-enoent', 'F60-undo-rename-other', 'F61-undo-successor-before-rename'] as const) {
      expect([id, FAILURE_TABLE[id].left]).toEqual([id, 'unchanged']);
    }
    // the only way the undo can leave two holders is an older writer in the moved moment (F58, mixed, no v=)
    expect(FAILURE_TABLE['F58-undo-restore-exists'].limit).toMatchObject({ kind: 'mixed', writer: 'no-v' });
  });

  it('§3.1: D5 removes through lock_recover (F62); D6 answers absent and restore-failed in rows of their own (F63, F64; codex round 3 P3)', () => {
    expect(FAILURE_TABLE['F62-release-head-paused'].results).toEqual({ 'release-head': 'kept' });
    const guard = F_CASES.filter((c) => c.caller === 'guard-head').map((c) => c.result);
    for (const r of ['removed', 'kept', 'absent', 'restore-failed'] as const) expect([r, guard.includes(r)]).toEqual([r, true]);
    expect(F_CASES.filter((c) => c.caller === 'guard-behind').map((c) => c.result)).toContain('not-head');
  });

  it('I9: a record without v= is judged as before and named (F66); the mixed limits fall only on such writers', () => {
    const f = FAILURE_TABLE['F66-owner-without-v'];
    expect([f.direction, f.left]).toEqual(['keep', 'unchanged']);
    expect(f.note).toContain('machine-lock-legacy-writer');
    for (const l of F_ROWS.filter((r) => r.limit?.kind === 'mixed')) expect([l.id, l.limit?.writer]).toEqual([l.id, 'no-v']);
  });
});

// ------------------------------------------------------------------ §3.1: the paths that delete or overwrite a lock name after a check

/**
 * §3.1 as data (round 5 closed it against PM Claude round 4's grep of the four lock sections: 13 paths
 * and the tickets). `after` is the form PR1a-f leaves: no path may be `check-then-name` (a check, then
 * a delete / overwrite by the name `<lock>` or `<lock>/owner` that a successor may hold by then).
 */
type NamedForm =
  | 'rename-inode' // rename to an own name, check that inode, delete or link back (I2-b)
  | 'link-back' // link(2) back, EEXIST kept and named (I2-c)
  | 'rmdir-only' // rmdir: succeeds only on an empty directory, the check itself
  | 'own-name' // the check and the delete act on a name only this caller makes (token + serial)
  | 'temps-only' // only temporary names unlinked, then rmdir (I3)
  | 'self-record' // the record's pid is the caller itself (D12, D4): nobody recovers it while the caller stops
  | 'not-removed' // the branch no longer deletes the name
  | 'outside' // the ticket queue: the order changes, no owner / <lock> / aside is removed (#4277)
  | 'check-then-name';
const NAMED_PATHS = {
  'undo-after-publish': { pm: 1, impls: ALL, after: 'rename-inode', changed: true },
  'write-failure-cleanup': { pm: 2, impls: ALL, after: 'rmdir-only', changed: true },
  'release-as-head-d5': { pm: 3, impls: GRACED, after: 'own-name', changed: true },
  'empty-owner-reclaim': { pm: 4, impls: ALL, after: 'own-name', changed: true },
  'dead-holder-recover': { pm: 5, impls: ALL, after: 'own-name', changed: false },
  'ownerless-cleanup': { pm: 6, impls: GRACED, after: 'temps-only', changed: true },
  'release-held-d12': { pm: 7, impls: ALL, after: 'self-record', changed: false },
  'lock-release-missing': { pm: 8, impls: BASH, after: 'not-removed', changed: true },
  'set-owner-fields': { pm: 9, impls: ['sync'], after: 'self-record', changed: true },
  'hand-off-publish-d4': { pm: 10, impls: GRACED, after: 'self-record', changed: false },
  'put-back': { pm: 11, impls: ALL, after: 'link-back', changed: true },
  'take-back-half-rmdir': { pm: 12, impls: ALL, after: 'rmdir-only', changed: false },
  'reclaim-own-name': { pm: 12, impls: ALL, after: 'own-name', changed: false },
  'settle-missing-rmdir': { pm: 13, impls: ALL, after: 'rmdir-only', changed: false },
  'tickets-mark-done': { pm: null, impls: ALL, after: 'outside', changed: false },
} as const satisfies Record<string, { pm: number | null; impls: readonly Impl[]; after: NamedForm; changed: boolean }>;

/** setOwnerFields (sync) after round 5: what it answers instead of writing or throwing. */
const SET_OWNER_FIELDS = {
  released: false,
  'token-differs': false,
  'after-hand-off': false,
  'lock-gone-enoent': false, // round 5 (PM Claude round 4 P3-3): no longer thrown to merge-pr
  'write-or-rename-fails': false,
  written: true,
} as const satisfies Record<string, boolean>;

describe('Issue #4288 PR1a-f round 5 (design I2-c, §3.1, §7.3): the put-back links, the enumeration is closed', () => {
  it('I2-c: the put-back of a moved-aside owner links; EEXIST keeps the aside and the <lock>, in all three implementations (F67)', () => {
    const f = FAILURE_TABLE['F67-put-back-link-exists'];
    expect([[...f.impls], f.point, f.direction, f.left]).toEqual([['bash', 'sync', 'ts'], 'restore-rename', 'keep', 'aside-kept']);
    expect(f.results).toEqual({ 'acquire-head-grace': 'refused:rec', 'acquire-head-nograce': 'refused:rec', 'guard-head': 'restore-failed' });
    expect(f.note).toContain('EEXIST');
    expect(f.note).toContain('machine-lock-restore-failed');
    // reached by the TS acquirers, not by a TS guard (there is none)
    const ts = F_ALL_CASES.filter((c) => c.id === 'F67-put-back-link-exists' && c.impl === 'ts');
    expect(ts.map((c) => `${c.caller}:${c.unreachable ?? 'reached'}`).sort()).toEqual(['acquire-head-grace:ts-no-grace', 'acquire-head-nograce:reached', 'guard-head:ts-no-guard']);
    // the put-back point keeps its name (lock-observation-points-4288 pins it)
    expect(POINTS['restore-rename']).toBe('existing');
  });

  it('§3.1: every path PM Claude round 4 found is listed, and none checks then deletes or overwrites by name', () => {
    const found = new Set(Object.values(NAMED_PATHS).map((p) => p.pm).filter((n) => n !== null));
    expect([...found].sort((a, b) => (a as number) - (b as number))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    for (const [id, p] of Object.entries(NAMED_PATHS)) expect([id, p.after]).not.toEqual([id, 'check-then-name']);
    // round 5's changes: the put-back links, lock_release's missing branch keeps the <lock>
    expect(NAMED_PATHS['put-back'].after).toBe('link-back');
    expect(NAMED_PATHS['lock-release-missing']).toMatchObject({ after: 'not-removed', changed: true });
    // the tickets are outside not because the name is the caller's own (lock_mark_done retires another
    // waiter's ticket too) but because a ticket's replacement removes no owner (PM Claude round 4 P3-5)
    expect(NAMED_PATHS['tickets-mark-done'].after).toBe('outside');
  });

  it('§3.1: setOwnerFields answers false instead of writing after a hand-off or throwing on a missing <lock> (PM Claude round 4 P3-3)', () => {
    const answers = Object.entries(SET_OWNER_FIELDS);
    expect(answers.filter(([, v]) => v).map(([k]) => k)).toEqual(['written']);
    expect(SET_OWNER_FIELDS['lock-gone-enoent']).toBe(false);
  });

  describe('the primitive under the put-back, on a real directory (os.tmpdir)', () => {
    let root: string | null = null;
    afterEach(() => {
      if (root !== null) fs.rmSync(root, { recursive: true, force: true });
      root = null;
    });
    /** A <lock> the put-back made, an owner published into it in the window, and the aside's record. */
    const window = (): { lock: string; gone: string } => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1af-putback-'));
      const lock = path.join(root, 'x.lock');
      const gone = path.join(root, 'x.lock.gone-A-1');
      fs.mkdirSync(lock);
      fs.mkdirSync(gone);
      fs.writeFileSync(path.join(gone, 'owner'), '{"token":"R"}\n');
      fs.writeFileSync(path.join(lock, 'owner'), '{"token":"W"}\n'); // published between the check and the put-back
      return { lock, gone };
    };

    it('positive control: round 4\'s rename(gone/owner, <lock>/owner) overwrites the owner published in the window', () => {
      const { lock, gone } = window();
      fs.renameSync(path.join(gone, 'owner'), path.join(lock, 'owner'));
      expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toContain('"R"');
    });

    it('I2-c: link(gone/owner, <lock>/owner) answers EEXIST and leaves both records (the aside kept, the <lock> not rmdir\'d)', () => {
      const { lock, gone } = window();
      let code: string | null = null;
      try {
        fs.linkSync(path.join(gone, 'owner'), path.join(lock, 'owner'));
      } catch (e) {
        code = (e as NodeJS.ErrnoException).code ?? null;
      }
      expect(code).toBe('EEXIST');
      expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toContain('"W"');
      expect(fs.readFileSync(path.join(gone, 'owner'), 'utf8')).toContain('"R"');
    });

    it('negative control: with no owner published, link puts the record back as rename did', () => {
      const { lock, gone } = window();
      fs.unlinkSync(path.join(lock, 'owner'));
      fs.linkSync(path.join(gone, 'owner'), path.join(lock, 'owner'));
      expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toContain('"R"');
    });
  });
});

// ------------------------------------------------------------------ the stop premise P0 (PM decision, round 5 addition) and I1-c

/** I1-c: the record's reserved keys a caller's fields may not carry, per implementation (3 rows). */
const RESERVED_FIELDS = {
  bash: {
    entry: 'LOCK_OWNER_EXTRA (kv codec; lock_acquire_path and lock_hand_off)',
    reserved: ['pid', 'host', 'token', 'started_at', 'pgid', 'v'],
    lstart: 'one line allowed (D7\'s only entry in the kv record), a second refused',
    answer: 'refused:unk point=owner-fields errno=EINVAL; hand-off LHO_STAGE=fields',
  },
  sync: {
    entry: 'ownerFields (acquireMachineLockSync) and setOwnerFields',
    reserved: ['pid', 'host', 'token', 'acquiredAt', 'started_at', 'pgid', 'v', 'lstart', 'done'],
    lstart: 'refused (no D7 in the sync JS)',
    answer: "refused (unknown.point 'owner-fields', EINVAL); setOwnerFields false",
  },
  ts: {
    entry: null,
    reserved: [],
    lstart: 'no entry',
    answer: 'unreachable: no caller-supplied fields (an entry added later refuses the same keys, §5)',
  },
} as const satisfies Record<Impl, { entry: string | null; reserved: readonly string[]; lstart: string; answer: string }>;

/** Today's record assembly (machine-lock-sync.mjs:877): the caller's fields spread last. */
const syncRecordToday = (pid: number, token: string, fields: Record<string, unknown>) => ({ pid, host: 'h', token, acquiredAt: 1, ...fields });
/** bash kv today: lock_format_owner prints pid/host/token/started_at, then LOCK_OWNER_EXTRA, then pgid; the parser keeps a key's first line. */
const kvParseFirstWins = (lines: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const l of lines) {
    const k = l.slice(0, l.indexOf('='));
    if (!(k in out)) out[k] = l.slice(l.indexOf('=') + 1);
  }
  return out;
};
/** I1-c's check (the model the implementation contract drives). */
const reservedKeyOf = (impl: Impl, keys: readonly string[]): string | null => {
  const r = RESERVED_FIELDS[impl].reserved as readonly string[];
  const hit = keys.find((k) => r.includes(k));
  if (hit !== undefined) return hit;
  if (impl === 'bash' && keys.filter((k) => k === 'lstart').length > 1) return 'lstart';
  return null;
};

describe('Issue #4288 PR1a-f the stop premise P0 (design "前提 P0", §7.4): the guarantee under P0, outside it named, I1-c closed', () => {
  it('every limit row says which premise it is outside of; the mixed ones are a special case of P0', () => {
    const limits = F_ROWS.filter((f) => f.direction === 'limit');
    expect(limits).toHaveLength(9);
    for (const f of limits) expect([f.id, ['P0', 'P1', 'P0+P1'].includes(f.limit?.outside as string)]).toEqual([f.id, true]);
    for (const f of limits.filter((r) => r.limit?.kind === 'mixed')) expect([f.id, f.limit?.outside.startsWith('P0')]).toEqual([f.id, true]);
    expect(Object.fromEntries(limits.map((f) => [f.id, f.limit?.outside]))).toEqual({
      'F42-clock-back': 'P1',
      'F49-old-k1-resumed': 'P0',
      'F50-pr1a-writer-ticket-expired': 'P0',
      'F51-pre-pid-stop': 'P0',
      'F55-old-tmp-clock-back': 'P0+P1',
      'F58-undo-restore-exists': 'P0',
      'F69-new-k1-writer-into-emptied-name': 'P0',
      'F70-clock-back-offset-by-reader-stop': 'P1',
      'F71-old-writer-in-generic-shell': 'P0',
    });
  });

  it('codex round 4\'s three crossings are outside rows, one each, not fixed (F69 new writers too, F70 the clock, F71 ended by the restart)', () => {
    expect(FAILURE_TABLE['F69-new-k1-writer-into-emptied-name'].limit).toMatchObject({ kind: 'premise', writer: 'any', outside: 'P0' });
    expect(FAILURE_TABLE['F70-clock-back-offset-by-reader-stop'].limit).toMatchObject({ kind: 'premise', writer: 'any', outside: 'P1' });
    expect([...FAILURE_TABLE['F70-clock-back-offset-by-reader-stop'].impls]).toEqual(['bash']);
    expect(FAILURE_TABLE['F71-old-writer-in-generic-shell'].limit).toMatchObject({ kind: 'mixed', writer: 'no-v', outside: 'P0' });
    expect(FAILURE_TABLE['F71-old-writer-in-generic-shell'].limit.until).toContain('restarted');
    expect(FAILURE_TABLE['F71-old-writer-in-generic-shell'].limit.until).toContain('best-effort');
    // F70's numbers: the difference of the two wall-clock reads is 0, yet the computed start is past started_at + 2 s
    const nowBefore = 1000_000;
    const etime = 870_000;
    const nowAfter = 1000_000;
    expect(nowAfter - nowBefore < 0 || nowAfter - nowBefore >= 1000).toBe(false); // passes the ECLOCK check
    expect(nowBefore - etime > 110_000 + 2000).toBe(true); // read as reused: the row the premise names
  });

  it('I1-c: the reserved keys are refused in the three implementations\' rows (F68, TS has no entry)', () => {
    const f = FAILURE_TABLE['F68-owner-fields-reserved'];
    expect([[...f.impls], f.point, f.direction, f.left]).toEqual([['bash', 'sync'], 'owner-fields', 'keep', 'nothing-made']);
    expect(f.results).toEqual({ 'acquire-head-grace': 'refused:unk', 'acquire-head-nograce': 'refused:unk' });
    for (const k of ['pid', 'token', 'pgid', 'v', 'host']) {
      expect([k, reservedKeyOf('bash', [k]), reservedKeyOf('sync', [k])]).toEqual([k, k, k]);
    }
    expect(RESERVED_FIELDS.ts.entry).toBeNull();
    expect(SET_OWNER_FIELDS['written']).toBe(true);
  });

  it('positive control: today the caller\'s fields reach the reserved keys (sync spreads them last; bash kv keeps an extra pgid= before the section\'s)', () => {
    expect(syncRecordToday(process.pid, 'T0', { pid: 999_999 }).pid).toBe(999_999);
    const kv = kvParseFirstWins(['pid=100', 'host=h', 'token=T0', 'started_at=2026-11-11T00:00:00Z', 'pgid=4242', 'pgid=100']);
    expect(kv.pgid).toBe('4242');
  });

  it('negative control: the fields the callers pass today are not reserved (merge-pr phase / repo / base, supervisor lstart= label= run_dir=)', () => {
    expect(reservedKeyOf('sync', ['phase', 'repo', 'base'])).toBeNull();
    expect(reservedKeyOf('bash', ['lstart', 'label', 'run_dir'])).toBeNull();
    expect(reservedKeyOf('bash', ['lstart', 'lstart'])).toBe('lstart');
    expect(reservedKeyOf('sync', ['lstart'])).toBe('lstart');
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

  it('the rule of §4.1 (round 3): the same string is alive; with started_at the start from etime decides; lstart= only is unknown; reused needs the evidence', () => {
    for (const [name, c] of Object.entries(IDENTITY_CASES)) expect([name, identity(c.input)]).toEqual([name, c.answer]);
    for (const form of D7_FORMS) expect([form, identity(IDENTITY_CASES[FORM_IDENTITY[form]].input)]).toEqual([form, IDENTITY_OF[form]]);
    // the 60 s rows (codex round 2 P2): unknown without started_at, never reused on the size of the difference
    expect(IDENTITY_CASES['tz-60s-lstart-only'].answer).toBe('unknown');
    for (const c of Object.values(IDENTITY_CASES)) if (c.answer === 'reused') expect(c.input.startedAtMs).not.toBeNull();
    // the clock stepping back is the premise row F42, not a quiet residual
    expect(IDENTITY_CASES['clock-back-premise'].row).toContain('F42');
    expect(FAILURE_TABLE['F42-clock-back'].limit.kind).toBe('premise');
    // round 4: the step back during the read is unknown now; round 3's rule read it as reused (the positive control)
    const back = IDENTITY_CASES['clock-back-during-observation'].input.observed;
    expect(startFromRound3(back)).toBeGreaterThan(110_000 + SLACK_MS);
    expect(startFrom(back)).toBeNull();
  });

  it('§4.2: the identity decides whether to remove, never whether to stop — proc_matches, deadline-guard and supervisor do not call it (PM decision 3)', () => {
    expect(PID_IDENTITY.bash.use).toContain('D7');
    for (const { file, fn } of PID_IDENTITY.bash.never) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      let body = text;
      if (fn !== null) {
        const start = text.indexOf(`${fn}() {`);
        expect(start).toBeGreaterThanOrEqual(0);
        body = text.slice(start, text.indexOf('\n}', start) + 2);
      }
      expect([file, body.includes('machine_lock_pid_identity')]).toEqual([file, false]);
    }
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

/*
 * The rows driven against the three implementations (lock-owner-atomic-4288-harness.ts): every root a
 * mkdtemp under os.tmpdir(), removed in afterEach; the processes a row starts killed there. A row's
 * observation is made real (a live `sleep`, a dead pid, a lstart printed under another TZ=, an age set
 * with utimes) or injected (CM_VERIFY_TEST_OBS_FAULT / hooks.fault, a `ps` shim on PATH, a pause).
 */
let root = '';
const freshRoot = (): string => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1af-4288-'));
  return root;
};
afterEach(() => {
  H.killChildren();
  if (root) {
    spawnSync('chmod', ['-R', 'u+rwx', root]);
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = '';
});

const lockOfRoot = (r: string): string => H.lockPathIn(r);
const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
/** Replace a file by a rename (a different inode under the same name). */
const replaceFile = (file: string, text: string): void => {
  const tmp = `${file}.repl`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};
const agedAll = (dir: string, ageMs: number): void => {
  for (const n of fs.readdirSync(dir)) H.age(path.join(dir, n), ageMs);
  H.age(dir, ageMs);
};
const goneDirs = (r: string): string[] => fs.readdirSync(r).filter((n) => n.startsWith('x.lock.gone-')).map((n) => path.join(r, n));
const namesIn = (dir: string): string[] | null => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);
/** The D7 records and the forms of table T use the key=value codec in bash's graced callers (supervisor.lock). */
const kvFor = (impl: Impl, who: string): boolean => impl === 'bash' && who !== 'acquire-head-nograce';
const LSTART_1970 = 'Thu Jan  1 00:00:00 1970';

/** The setup of a cell of table T (the observation of §2.1 made real or injected). */
function setupT(impl: Impl, form: Form, caller: Caller, obs: Obs, r: string): H.DriveOptions {
  const lock = lockOfRoot(r);
  const kv = kvFor(impl, caller);
  const faults: string[] = [];
  // A fast, fully injected observation, except a bash waiter behind a ticket (it polls on the clock, which stays real there).
  const o: H.DriveOptions = { tz: 'UTC', ...(impl === 'bash' && caller === 'acquire-behind' ? {} : { observation: 'fast' as const }) };
  if (caller === 'acquire-behind') H.ticketAhead(r);
  const ageMs = obs === 'alive' ? 0 : H.OLD_MS;
  const ageFault = () => {
    if (obs === 'unknown') faults.push('lock-owner=EIO');
  };
  switch (form) {
    case 'empty-dir':
      fs.mkdirSync(lock);
      H.age(lock, ageMs);
      ageFault();
      break;
    case 'tmp-new':
    case 'tmp-stray':
      write(path.join(lock, '.owner-abc'), '{"pid":1,"tok');
      if (form === 'tmp-stray') write(path.join(lock, 'x'), '');
      agedAll(lock, ageMs);
      ageFault();
      break;
    case 'tmp-old-young':
    case 'tmp-old': {
      const pid = obs === 'gone' ? H.dead() : H.liveSleep();
      write(path.join(lock, `owner.tmp.${pid}`), `pid=${pid}\n`);
      agedAll(lock, form === 'tmp-old-young' ? 0 : H.OLD_MS);
      if (obs === 'unknown') faults.push(`owner-tmp-pid=EPERM`);
      if (obs === 'alive') {
        // The pid started long before the tmp (maybe its writer): a ps shim for bash, startOf for the sync JS.
        o.pathPrefix = H.psShim(r);
        o.env = { FAKE_ETIME_PID: String(pid), FAKE_ETIME: '1-00:00:00' };
        const started = Date.now() - 86_400_000; // the setup's read, not the hook's
        o.hooks = { startOf: (p: number) => (p === pid ? started : null) };
      }
      break;
    }
    case 'tmp-new+gone-dead':
    case 'tmp-new+gone-alive': {
      write(path.join(lock, '.owner-abc'), '{"pid":1,"tok');
      agedAll(lock, form === 'tmp-new+gone-alive' ? H.OLD_MS : ageMs);
      const alive = form === 'tmp-new+gone-alive';
      write(path.join(r, 'x.lock.gone-111-1', 'owner'), H.recordText({ pid: alive ? process.pid : H.dead(), token: alive ? 'live-gone' : 'dead-gone', v: true }, kv));
      faults.push(...(obs === 'unknown' ? ['lock-owner=EIO'] : []));
      break;
    }
    case 'empty-owner':
    case 'garbage-owner':
      write(path.join(lock, 'owner'), form === 'empty-owner' ? '' : 'garbage');
      agedAll(lock, ageMs);
      ageFault();
      break;
    default: {
      // D7 (bash only): a kv record with lstart=, read under TZ=UTC.
      const live = H.liveSleep();
      const pid = obs === 'gone' ? H.dead() : live;
      if (obs === 'unknown') faults.push(`pid@${live}=EPERM`);
      const utc = H.lstartOf(live, 'UTC');
      const tokyo = H.lstartOf(live, 'Asia/Tokyo');
      const now = H.iso(Date.now());
      const rec: H.OwnerRecord = { pid, token: 'T1' };
      switch (form) {
        case 'lstart-match':
          Object.assign(rec, { lstart: utc, started_at: now });
          break;
        case 'lstart-tz':
          Object.assign(rec, { lstart: tokyo, started_at: now });
          break;
        case 'lstart-reused':
          Object.assign(rec, { lstart: LSTART_1970, started_at: H.iso(Date.now() - 3_600_000) });
          break;
        case 'lstart-fails':
          Object.assign(rec, { lstart: utc, started_at: now });
          faults.push('lstart=EIO');
          break;
        case 'etime-fails':
          Object.assign(rec, { lstart: tokyo, started_at: now });
          faults.push('etime=EIO');
          break;
        case 'lstart-same-etime-fails':
          Object.assign(rec, { lstart: utc, started_at: now });
          faults.push('etime=EIO');
          break;
        case 'lstart-legacy':
          Object.assign(rec, { lstart: tokyo });
          break;
        case 'lstart-legacy-reused':
          Object.assign(rec, { lstart: LSTART_1970 });
          break;
      }
      write(path.join(lock, 'owner'), H.recordText(rec, true));
    }
  }
  o.fault = faults.join(' ');
  return o;
}

describe.each(IMPLS)('Issue #4288 PR1a-f behaviour T: %s (to implement)', (impl) => {
  for (const e of ROWS.filter((r) => r.impl === impl)) {
    const now = e.cell.now ? ` [today: ${e.cell.now}]` : '';
    it(`${e.form} × ${e.caller} × ${e.obs} → ${e.cell.is} / ${lockAfter(e.cell.is)}${now}`, async () => {
      const r = freshRoot();
      const o = setupT(impl, e.form, e.caller, e.obs, r);
      const before = H.snapshot(r);
      const out = await H.drive(impl, e.caller, r, o);
      expect(out.code, out.log).toBe(e.cell.is);
      const after = lockAfter(e.cell.is);
      if (after === 'mine') expect(H.isMine(r), H.snapshot(r)).toBe(true);
      else if (after === 'absent') expect(fs.existsSync(lockOfRoot(r))).toBe(false);
      else expect(H.snapshot(r)).toBe(before);
    }, 60000);
  }
});

/** What an interrupted acquisition left (§2.6): the names in <lock>. */
function leftForm(lock: string): string {
  const names = namesIn(lock);
  if (names === null) return 'absent';
  const tmps = names.filter((n) => n.startsWith('.owner-'));
  const owner = names.includes('owner');
  if (names.length === 0) return 'empty-dir';
  if (!owner && tmps.length === names.length) return 'tmp-new';
  if (owner) {
    const text = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
    if (text.length === 0) return 'empty-owner';
    if (!/"v":1|^v=1$/m.test(text)) return 'garbage-owner';
    return tmps.length > 0 ? 'complete+tmp' : 'complete';
  }
  return `other:${names.join(',')}`;
}

/** Kill an acquisition of `impl` at `pause` (a real SIGKILL of the process that took it). */
async function killAt(impl: Impl, pause: Pause, r: string, who: 'acquire-head-grace' | 'acquire-head-nograce' = 'acquire-head-nograce'): Promise<number> {
  const lock = lockOfRoot(r);
  const dir = fs.mkdtempSync(path.join(r, 'kill-'));
  const reached = path.join(dir, `${pause}.reached`);
  let child: ChildProcess;
  if (impl === 'bash') {
    // bash: the record in the format its reader keeps (key=value for the graced callers, JSON for the gate).
    child = spawn('bash', ['-c', `${H.bashPrelude(who)}if lock_acquire_path "$LK" "$(machine_lock_queue_of "$LK")" 0; then echo acquired; fi\n`], {
      stdio: 'ignore',
      detached: true,
      env: { ...H.bashEnv(r, {}), CM_VERIFY_TEST_HANDOFF: `pause:${pause}`, CM_VERIFY_TEST_HANDOFF_DIR: dir },
    });
  } else {
    const mod = impl === 'sync' ? path.join(REPO, 'scripts/orchestrate/machine-lock-sync.mjs') : path.join(REPO, 'src/lib/verification/machine-lock.ts');
    const call =
      impl === 'sync'
        ? `m.acquireMachineLockSync('x', { lockPath: ${JSON.stringify(lock)}, timeoutMs: 0, hooks: { onOwnerStage } })`
        : `await m.acquireMachineLock('x', { root: ${JSON.stringify(r)}, timeoutMs: 0, __testHooks: { onOwnerStage } })`;
    const script = `import fs from 'node:fs';
const m = await import(${JSON.stringify(mod)});
const onOwnerStage = (s) => { if (s === ${JSON.stringify(pause)}) { fs.writeFileSync(${JSON.stringify(reached)}, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000); } };
${call};
`;
    const file = path.join(dir, impl === 'sync' ? 'kill.mjs' : 'kill.mts');
    fs.writeFileSync(file, script);
    child = impl === 'sync'
      ? spawn(process.execPath, [file], { stdio: 'ignore', detached: true, cwd: REPO })
      : spawn(path.join(REPO, 'node_modules/.bin/tsx'), [file], { stdio: 'ignore', detached: true, cwd: REPO });
  }
  H.children.push(child);
  const end = Date.now() + 30000;
  while (!fs.existsSync(reached) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fs.existsSync(reached), `${impl} reached ${pause}`).toBe(true);
  // sync / ts: the child creates the signal file before its pid is in it (pm-return-4288-pr1af-impl-3
  // item 1). Wait (bounded) for the pid, and fail rather than skip the ESRCH wait below on an empty read.
  let written = '';
  if (impl !== 'bash') {
    for (;;) {
      written = fs.readFileSync(reached, 'utf8').trim();
      if (/^\d+$/.test(written) || Date.now() >= end) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(written, `${impl} ${pause}: the pid in the signal file`).toMatch(/^\d+$/);
  }
  const exited = new Promise((resolve) => child.on('exit', resolve));
  process.kill(-(child.pid as number), 'SIGKILL');
  await exited;
  // The pid the record names (pm-return-4288-pr1af-impl-2 item 3): under tsx the writer is the child's
  // child, which stays a zombie — `kill -0` answers alive — until launchd reaps it, after the exit
  // awaited above. The rows that judge a published record by its pid wait for ESRCH first.
  // The number of ESRCH waits passed (sync / ts: the probes run until ESRCH, at least 1; bash: 0) — the K rows assert it, so dropping the wait is red.
  let probes = 0;
  if (/^\d+$/.test(written)) {
    probes = await waitEsrch(Number(written));
  }
  return probes;
}

/** Wait (up to 30 s) until `pid` answers ESRCH to kill(pid, 0): exited and reaped. The number of probes run (>= 1). */
async function waitEsrch(pid: number): Promise<number> {
  const end = Date.now() + 30000;
  for (let probes = 1; ; probes++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return probes;
    }
    expect(Date.now() < end, `pid ${pid} reaped`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Who takes out what the killed acquisition left (§2.6), on a copy of it aged past the grace. */
async function takenBy(impl: Impl, who: 'acquire-head-grace' | 'acquire-head-nograce', from: string): Promise<string> {
  const r = fs.mkdtempSync(path.join(root, `by-${who}-`));
  fs.cpSync(lockOfRoot(from), lockOfRoot(r), { recursive: true });
  agedAll(lockOfRoot(r), H.OLD_MS);
  const young = fs.mkdtempSync(path.join(root, `young-${who}-`));
  fs.cpSync(lockOfRoot(from), lockOfRoot(young), { recursive: true });
  agedAll(lockOfRoot(young), 0);
  const old = await H.drive(impl, who, r);
  const fresh = await H.drive(impl, who, young);
  if (old.code === 'acquired' && fresh.code === 'acquired') return 'recover-when-pid-gone';
  if (old.code === 'acquired' && fresh.code !== 'acquired') return 'graced-head-after-grace';
  return old.code === 'refused:taking' ? 'nobody-until-a-human' : `?${old.code}/${fresh.code}`;
}

/** The pre-PR1a-f owner create, written out (E1, E2): an empty owner first, the record after it. */
async function killToday(impl: Impl, r: string): Promise<string> {
  const lock = lockOfRoot(r);
  fs.mkdirSync(lock);
  const owner = path.join(lock, 'owner');
  let child: ChildProcess;
  if (impl === 'bash') {
    const fifo = path.join(r, 'stdin.fifo');
    spawnSync('mkfifo', [fifo]);
    // verify-run.sh's lock_obs_create before PR1a-f: `set -C; : > owner`, then `cat >> owner`.
    child = spawn('bash', ['-c', 'if ( export LC_ALL=C; set -C; : > "$1" ) 2>/dev/null; then cat >> "$1" < "$2"; fi', 'bash', owner, fifo], { stdio: 'ignore', detached: true });
  } else {
    // makeObserver().create before PR1a-f: openSync(owner, 'wx'), the fault seam, writeSync — a seam that never returns.
    child = spawn(process.execPath, ['-e', `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(owner)}, 'wx'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000); fs.writeSync(fd, '{}');`], { stdio: 'ignore', detached: true });
  }
  H.children.push(child);
  const end = Date.now() + 10000;
  while (!fs.existsSync(owner) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  process.kill(-(child.pid as number), 'SIGKILL');
  await exited;
  return leftForm(lock);
}

describe('Issue #4288 PR1a-f behaviour K: an acquisition killed at each point (design §2.6, to implement)', () => {
  for (const k of KILL_ROWS) {
    it(`${k.impl} ${k.point} (pause ${k.pause}): leaves ${k.left}; graced ${k.byGraced}, no grace ${k.byNograce}`, async () => {
      const r = freshRoot();
      const esrchWaits = await killAt(k.impl, k.pause, r);
      // sync / ts: the record's pid is read from the signal file and its ESRCH awaited at least once.
      if (k.impl !== 'bash') expect(esrchWaits, `${k.impl} ${k.pause}: ESRCH waits passed`).toBeGreaterThanOrEqual(1);
      // I1: whatever the point, never an empty or half owner.
      expect(leftForm(lockOfRoot(r))).toBe(k.left);
      if (k.byGraced !== 'no-grace-caller') {
        let from = r;
        if (k.impl === 'bash') {
          from = fs.mkdtempSync(path.join(r, 'kv-'));
          await killAt(k.impl, k.pause, from, 'acquire-head-grace');
          expect(leftForm(lockOfRoot(from))).toBe(k.left);
        }
        expect(await takenBy(k.impl, 'acquire-head-grace', from)).toBe(k.byGraced);
      }
      expect(await takenBy(k.impl, 'acquire-head-nograce', r)).toBe(k.byNograce);
    }, 90000);
  }
  for (const impl of IMPLS) {
    it(`${impl} positive control: today leaves ${KILL_NOW[impl].left} — ${KILL_NOW[impl].how}`, async () => {
      const r = freshRoot();
      expect(await killToday(impl, r)).toBe(KILL_NOW[impl].left);
      // and the K rows of the new form never do (I1)
      expect(KILL_ROWS.filter((x) => x.impl === impl).map((x) => x.left)).not.toContain(KILL_NOW[impl].left);
    }, 30000);
  }
});

// ------------------------------------------------------------------ F: the failure rows driven

type FRun = { code: string; check?: () => void };
type FDriver = (impl: Impl, caller: FCaller, r: string) => Promise<FRun>;

/** The who of a caller of table F that drive() knows. */
const whoOf = (caller: FCaller): H.Who => (caller === 'ticket-retire' ? 'acquire-head-nograce' : (caller as H.Who));
const recordFor = (impl: Impl, caller: FCaller, rec: H.OwnerRecord): string => H.recordText(rec, kvFor(impl, caller));
const ACQ_CALL = 'if lock_acquire_path "$LK" "$(machine_lock_queue_of "$LK")" 0; then echo acquired; else echo "refused $LOCK_HELD_BY"; fi\n';

/** A fault-only row: the lock left as `left` says. */
const faultRow =
  (fault: string, left: (r: string) => void): FDriver =>
  async (impl, caller, r) => {
    const out = await H.drive(impl, whoOf(caller), r, { fault });
    return { code: out.code, check: () => left(r) };
  };
const absentLock = (r: string) => expect(fs.existsSync(lockOfRoot(r))).toBe(false);

/** Something done between the tmp's write and its publish / after the publish (§2.6's pauses), in each implementation. */
async function atStage(impl: Impl, caller: FCaller, r: string, stage: Pause, act: () => void, o: H.DriveOptions = {}): Promise<H.Outcome> {
  if (impl === 'bash') return H.driveBashPaused(whoOf(caller), r, { [stage]: act }, o);
  return H.drive(impl, whoOf(caller), r, { ...o, hooks: { ...(o.hooks ?? {}), onOwnerStage: (s: string) => (s === stage ? act() : undefined) } });
}

/**
 * Something done inside the undo of a publish whose read-back failed (owner-readback=EIO): at `point`
 * (owner-undo-rename: before the rename; owner-undo-lstat: after it, before the inode check), once. bash
 * reaches the point through lock_test_obs_fault in the pipeline's subshell, wrapped here to pause there
 * (as F23 wraps lock_obs_unlink); sync and TS through hooks.fault, which acts and injects nothing.
 */
async function atUndo(impl: Impl, caller: FCaller, r: string, point: 'owner-undo-rename' | 'owner-undo-lstat', act: () => void): Promise<H.Outcome> {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    act();
  };
  if (impl === 'bash') {
    const wrap = `eval "ltof_real() $(declare -f lock_test_obs_fault | sed 1d)"\nlock_test_obs_fault() { if [ "$1" = ${point} ]; then lock_test_pause at-${point}; fi; ltof_real "$@"; }\n`;
    return H.driveBashPaused(whoOf(caller), r, { [`at-${point}`]: once }, { fault: 'owner-readback=EIO', bashPre: wrap });
  }
  const fault = (p: string): string | undefined => {
    if (p === 'owner-readback') return 'EIO';
    if (p === point) once();
    return undefined;
  };
  return H.drive(impl, whoOf(caller), r, { hooks: { fault } });
}

/** A successor's owner of each kind put where the publish's link lands (F7-F10). */
const SUCCESSOR = JSON.stringify({ pid: process.pid, host: H.HOST, token: 'succ', acquiredAt: 0, v: 1 });
const publishMeets =
  (kind: 'file' | 'dir' | 'dirlink' | 'filelink'): FDriver =>
  async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    const owner = path.join(lock, 'owner');
    const outsideDir = path.join(r, 'outside-dir');
    const outsideFile = path.join(r, 'outside-file');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(outsideFile, 'outside');
    const out = await atStage(impl, caller, r, 'owner-tmp-written', () => {
      if (kind === 'file') fs.writeFileSync(owner, SUCCESSOR);
      if (kind === 'dir') fs.mkdirSync(owner);
      if (kind === 'dirlink') fs.symlinkSync(outsideDir, owner);
      if (kind === 'filelink') fs.symlinkSync(outsideFile, owner);
    });
    return {
      code: out.code,
      check: () => {
        expect(namesIn(lock)).toEqual(['owner']); // own tmp removed, nothing else made
        if (kind === 'file') expect(fs.readFileSync(owner, 'utf8')).toBe(SUCCESSOR);
        if (kind === 'dir') expect(fs.readdirSync(owner)).toEqual([]);
        if (kind === 'dirlink') expect([fs.lstatSync(owner).isSymbolicLink(), fs.readdirSync(outsideDir)]).toEqual([true, []]);
        if (kind === 'filelink') expect([fs.lstatSync(owner).isSymbolicLink(), fs.readFileSync(outsideFile, 'utf8')]).toEqual([true, 'outside']);
      },
    };
  };

/** An owner-less <lock> holding `names`, aged; the graced callers and the guard. */
const ownerless = (r: string, names: string[], ageMs = H.OLD_MS): string => {
  const lock = lockOfRoot(r);
  fs.mkdirSync(lock);
  for (const n of names) write(path.join(lock, n), 'x');
  agedAll(lock, ageMs);
  return lock;
};

/** bash D7: a kv record of `rec` under the lock, read under `tz` (default UTC). */
const d7 = (r: string, rec: H.OwnerRecord): void => write(path.join(lockOfRoot(r), 'owner'), H.recordText(rec, true));
const d7Row =
  (make: (live: number) => { rec: H.OwnerRecord; fault?: string; tz?: string; pathPrefix?: string; env?: Record<string, string> }): FDriver =>
  async (impl, caller, r) => {
    const live = H.liveSleep();
    const m = make(live);
    d7(r, m.rec);
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r, { fault: m.fault, tz: m.tz ?? 'UTC', pathPrefix: m.pathPrefix, env: m.env, observation: 'fast' });
    return { code: out.code, check: () => (out.code === 'acquired' || out.code === 'removed' ? undefined : expect(H.snapshot(r)).toBe(before)) };
  };

/** The record of a dead holder that a head recovers (the put-back rows). */
const deadRecord = (impl: Impl, caller: FCaller, r: string, token = 'T0'): void =>
  write(path.join(lockOfRoot(r), 'owner'), recordFor(impl, caller, { pid: H.dead(), token, v: true }));

const F_DRIVERS: Partial<Record<Failure, FDriver>> = {
  'F1-mkdir-lock': faultRow('mkdir-lock=EACCES', absentLock),
  'F2-tmp-create-exists': async (impl, caller, r) => {
    // A real tmp of this acquisition's token is there before its create (not an injected EEXIST): the
    // exclusive create answers EEXIST, the tmp is neither opened nor removed and the rmdir fails on it.
    const lock = lockOfRoot(r);
    const fixed = 'F2tmp';
    const tokenNow = (): string => {
      if (impl !== 'ts') return fixed;
      // TS takes no token: the one its ticket carries (the ticket is still in the queue at owner-lock-made).
      const q = H.queueIn(r);
      const tickets = fs.readdirSync(q).filter((n) => /^\d{12}$/.test(n));
      return (JSON.parse(fs.readFileSync(path.join(q, tickets[0]), 'utf8')) as { token: string }).token;
    };
    let tmp = '';
    const placeTmp = () => {
      tmp = path.join(lock, `.owner-${tokenNow()}`);
      fs.writeFileSync(tmp, 'left by an earlier attempt');
    };
    const out = await atStage(impl, caller, r, 'owner-lock-made', placeTmp, { bashPre: `LOCK_WANT_TOKEN=${fixed}\n`, syncOptions: { token: fixed } });
    return {
      code: out.code,
      check: () => {
        expect(tmp).not.toBe('');
        expect(namesIn(lock)).toEqual([path.basename(tmp)]); // the <lock> stays: its rmdir failed on the tmp
        expect(fs.readFileSync(tmp, 'utf8')).toBe('left by an earlier attempt'); // neither opened nor removed
      },
    };
  },
  'F3-tmp-create-other': faultRow('owner-create=EACCES', absentLock),
  'F4-tmp-write': faultRow('owner-write=ENOSPC', absentLock),
  'F5-tmp-write-short': faultRow('owner-write-short=EIO', absentLock),
  'F6-tmp-close': faultRow('owner-close=EIO', absentLock),
  'F7-link-exists-file': publishMeets('file'),
  'F8-link-exists-dir': publishMeets('dir'),
  'F9-link-exists-dirlink': publishMeets('dirlink'),
  'F10-link-exists-filelink': publishMeets('filelink'),
  'F11-link-enoent': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    // This <lock> (and the tmp) taken out by an older cleaner, and a successor's K1 <lock> in its place.
    const out = await atStage(impl, caller, r, 'owner-tmp-written', () => {
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
    });
    return { code: out.code, check: () => expect(namesIn(lock)).toEqual([]) };
  },
  'F12-link-other': faultRow('owner-publish=EPERM', absentLock),
  'F13-readback-unknown-same-inode': faultRow('owner-readback=EIO', absentLock),
  'F14-readback-unknown-other-inode': async (impl, caller, r) => {
    const owner = path.join(lockOfRoot(r), 'owner');
    const out = await atStage(impl, caller, r, 'owner-linked', () => replaceFile(owner, SUCCESSOR), { fault: 'owner-readback=EIO' });
    return { code: out.code, check: () => expect([namesIn(lockOfRoot(r)), fs.readFileSync(owner, 'utf8')]).toEqual([['owner'], SUCCESSOR]) };
  },
  'F15-readback-not-ours': async (impl, caller, r) => {
    const owner = path.join(lockOfRoot(r), 'owner');
    const succ = recordFor(impl, caller, { pid: process.pid, token: 'succ', v: true });
    const out = await atStage(impl, caller, r, 'owner-linked', () => replaceFile(owner, succ));
    return { code: out.code, check: () => expect([namesIn(lockOfRoot(r)), fs.readFileSync(owner, 'utf8')]).toEqual([['owner'], succ]) };
  },
  'F16-tmp-unlink-after-publish': async (impl, caller, r) => {
    const out = await H.drive(impl, whoOf(caller), r, { fault: 'owner-unlink=EIO' });
    return { code: out.code, check: () => expect(namesIn(lockOfRoot(r))?.map((n) => n.replace(/^\.owner-.*/, '.owner-<token>'))).toEqual(['.owner-<token>', 'owner']) };
  },
  'F17-undo-tmp-unlink': faultRow('owner-write=EIO owner-unlink=EIO', (r) => expect(namesIn(lockOfRoot(r))?.map((n) => n.replace(/^\.owner-.*/, '.owner-<token>'))).toEqual(['.owner-<token>'])),
  'F18-undo-lock-rmdir': faultRow('owner-write=EIO lock-rmdir=EIO', (r) => expect(namesIn(lockOfRoot(r))).toEqual([])),
  ...Object.fromEntries(
    (
      [
        ['F19-cleanup-list', 'lock-list=EIO'],
        ['F20-cleanup-tmp-lstat', 'ownerless-tmp-lstat=EIO'],
        ['F21-cleanup-mtime', 'ownerless-mtime=EIO'],
        ['F22-cleanup-tmp-unlink', 'ownerless-tmp-unlink=EIO'],
        ['F25-cleanup-rmdir-other', 'ownerless-rmdir=EACCES'],
      ] as const
    ).map(([id, fault]) => [
      id,
      (async (impl, caller, r) => {
        ownerless(r, ['.owner-abc']);
        const before = H.snapshot(r);
        const out = await H.drive(impl, whoOf(caller), r, { fault });
        // F25 fails at the rmdir, after the rule's own unlink of the temporaries: the <lock> stays, owner-less.
        return { code: out.code, check: () => (id === 'F25-cleanup-rmdir-other' ? expect(H.snapshot(r)).toBe('|<no owner>') : expect(H.snapshot(r)).toBe(before)) };
      }) satisfies FDriver,
    ]),
  ),
  'F23-cleanup-tmp-unlink-enoent': async (impl, caller, r) => {
    ownerless(r, ['.owner-abc']);
    // An older cleaner removed the name between the listing and this unlink.
    const bashPre = `eval "lock_obs_unlink_real() $(declare -f lock_obs_unlink | sed 1d)"\nlock_obs_unlink() { if [ "$1" = ownerless-tmp-unlink ]; then rm -f "$2"; echo absent; return 0; fi; lock_obs_unlink_real "$@"; }\n`;
    const fault = (point: string, target: string) => {
      if (point !== 'ownerless-tmp-unlink') return undefined;
      fs.rmSync(target, { force: true });
      return 'ENOENT';
    };
    const out = await H.drive(impl, whoOf(caller), r, { bashPre, hooks: { fault } });
    return { code: out.code, check: () => (caller === 'guard-head' ? absentLock(r) : expect(H.isMine(r)).toBe(true)) };
  },
  'F24-cleanup-rmdir-notempty': async (impl, caller, r) => {
    const lock = ownerless(r, ['.owner-abc']);
    const pub = recordFor(impl, caller, { pid: process.pid, token: 'pub', v: true });
    // Someone published between the unlink of the temporaries and the rmdir.
    const bashPre = `eval "lock_rmdir_errno_real() $(declare -f lock_rmdir_errno | sed 1d)"\nlock_rmdir_errno() { if [ "$1" = ownerless-rmdir ]; then printf '%s' '${pub}' > "$2/owner"; fi; lock_rmdir_errno_real "$@"; }\n`;
    const fault = (point: string) => {
      if (point === 'ownerless-rmdir') fs.writeFileSync(path.join(lock, 'owner'), pub);
      return undefined;
    };
    const out = await H.drive(impl, whoOf(caller), r, { bashPre, hooks: { fault } });
    return { code: out.code, check: () => expect([namesIn(lock), fs.readFileSync(path.join(lock, 'owner'), 'utf8')]).toEqual([['owner'], pub]) };
  },
  'F26-old-tmp-pid-unknown': async (impl, caller, r) => {
    const pid = H.liveSleep();
    ownerless(r, [`owner.tmp.${pid}`]);
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r, { fault: 'owner-tmp-pid=EPERM' });
    return { code: out.code, check: () => expect(H.snapshot(r)).toBe(before) };
  },
  'F27-old-tmp-pid-alive': async (impl, caller, r) => {
    const pid = H.liveSleep();
    ownerless(r, [`owner.tmp.${pid}`]);
    const before = H.snapshot(r);
    const started = Date.now() - 86_400_000; // the setup's read, not the hook's
    const out = await H.drive(impl, whoOf(caller), r, {
      pathPrefix: H.psShim(r),
      env: { FAKE_ETIME_PID: String(pid), FAKE_ETIME: '1-00:00:00' },
      hooks: { startOf: (p: number) => (p === pid ? started : null) },
      observation: 'fast',
    });
    return { code: out.code, check: () => expect(H.snapshot(r)).toBe(before) };
  },
  'F28-old-tmp-pid-not-numeric': async (impl, caller, r) => {
    ownerless(r, ['owner.tmp.abc']);
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r);
    return { code: out.code, check: () => expect(H.snapshot(r)).toBe(before) };
  },
  'F29-empty-owner-young': async (impl, caller, r) => {
    write(path.join(lockOfRoot(r), 'owner'), '');
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r);
    return { code: out.code, check: () => expect(H.snapshot(r)).toBe(before) };
  },
  'F30-empty-owner-move': async (impl, caller, r) => {
    write(path.join(lockOfRoot(r), 'owner'), '');
    agedAll(lockOfRoot(r), H.OLD_MS);
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r, { fault: 'empty-owner-move=EIO' });
    return { code: out.code, check: () => expect(H.snapshot(r)).toBe(before) };
  },
  'F31-empty-owner-aside-written': async (impl, caller, r) => {
    write(path.join(lockOfRoot(r), 'owner'), '');
    agedAll(lockOfRoot(r), H.OLD_MS);
    const rec = recordFor(impl, caller, { pid: process.pid, token: 'late', v: true });
    // The writer finished its write while the head moved the <lock> aside (or an older head moved a live successor's).
    const writeAside = () => {
      for (const g of goneDirs(r)) fs.writeFileSync(path.join(g, 'owner'), rec);
    };
    const out =
      impl === 'bash'
        ? await H.driveBashPaused(whoOf(caller), r, { 'empty-owner-moved': writeAside })
        : await H.drive(impl, whoOf(caller), r, { hooks: { onRecover: (s: string) => (s === 'empty-owner-moved' ? writeAside() : undefined) } });
    return {
      code: out.code,
      check: () => {
        const gs = goneDirs(r);
        expect(gs).toHaveLength(1);
        expect(fs.readFileSync(path.join(gs[0], 'owner'), 'utf8')).toBe(rec);
      },
    };
  },
  'F32-kill0-other': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo'), started_at: H.iso(Date.now()) }, fault: `pid@${live}=EIO` })),
  'F33-ps-lstart': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: H.lstartOf(live, 'UTC'), started_at: H.iso(Date.now()) }, fault: 'lstart=EIO' })),
  'F34-lstart-only-60s': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: H.lstartOf(live, 'XXX-0:01') }, tz: 'UTC0' })),
  'F35-ps-etime': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo'), started_at: H.iso(Date.now()) }, fault: 'etime=EIO' })),
  'F36-etime-malformed': async (impl, caller, r) => {
    const codes: string[] = [];
    for (const bad of ['bad:bad', '1:99', '-1:00', '1:2:3:4']) {
      const sub = fs.mkdtempSync(path.join(r, 'm-'));
      const live = H.liveSleep();
      d7(sub, { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo'), started_at: H.iso(Date.now()) });
      codes.push((await H.drive(impl, whoOf(caller), sub, { tz: 'UTC', pathPrefix: H.psShim(sub), env: { FAKE_ETIME_PID: String(live), FAKE_ETIME: bad }, observation: 'fast' })).code);
    }
    expect(new Set(codes).size).toBe(1);
    return { code: codes[0] };
  },
  'F37-ticket-etime-malformed': async (impl, caller, r) => {
    // A live ticket ahead whose pid's etime is malformed: never read as "just started" (it would be pid-reused).
    const live = H.liveSleep();
    const q = H.queueIn(r);
    fs.mkdirSync(q, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(q, '000000000001'), JSON.stringify({ pid: live, host: H.HOST, token: 'ahead', createdAt: now - 60_000, deadline: now + 3_600_000 }));
    const shim = H.psShim(r);
    const out = await H.drive(impl, 'acquire-head-nograce', r, { pathPrefix: shim, env: { FAKE_ETIME_PID: String(live), FAKE_ETIME: 'bad:bad' }, observation: 'fast' });
    const ticket = JSON.parse(fs.readFileSync(path.join(q, '000000000001'), 'utf8'));
    return { code: out.code === 'refused:queue' && ticket.done !== true ? 'kept' : `retired(${out.code})` };
  },
  'F38-lstart-only-reused': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: LSTART_1970 } })),
  'F39-started-at-unparsed': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo'), started_at: 'not-a-date' } })),
  'F40-started-at-carry-over': async (impl, caller, r) => {
    // A moved-aside record WITH started_at= (a dead pid, read first and reclaimed), then the lock's own
    // record WITHOUT one (a live pid, another lstart string): the second read must not inherit the first's time.
    const live = H.liveSleep();
    write(path.join(r, 'x.lock.gone-111-1', 'owner'), H.recordText({ pid: H.dead(), token: 'old', lstart: LSTART_1970, started_at: '2026-01-01T00:00:00Z' }, true));
    d7(r, { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo') });
    const out = await H.drive(impl, whoOf(caller), r, { tz: 'UTC' });
    return { code: out.code, check: () => expect(fs.readFileSync(path.join(lockOfRoot(r), 'owner'), 'utf8')).toContain('token=T1') };
  },
  'F41-hostname': d7Row((live) => ({ rec: { pid: live, token: 'T1', host: 'another-host.example', lstart: LSTART_1970, started_at: '2026-01-01T00:00:00Z' } })),
  'F42-clock-back': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo'), started_at: H.iso(Date.now() - 10_000) } })),
  'F43-launchd-reader': async (impl, caller, r) => {
    const codes: string[] = [];
    for (const tz of ['UTC', 'Asia/Tokyo']) {
      const sub = fs.mkdtempSync(path.join(r, 'l-'));
      const live = H.liveSleep();
      // written under env -i (TZ, LC_ALL unset), as launchd starts the supervisor
      const lstart = (spawnSync('env', ['-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'ps', '-o', 'lstart=', '-p', String(live)], { encoding: 'utf8' }).stdout ?? '').trim();
      d7(sub, { pid: live, token: 'T1', lstart, started_at: H.iso(Date.now()) });
      codes.push((await H.drive(impl, whoOf(caller), sub, { tz, observation: 'fast' })).code);
    }
    expect(new Set(codes).size).toBe(1);
    return { code: codes[0] };
  },
  'F44-pid-gone-group-alive': d7Row((live) => ({ rec: { pid: H.dead(), token: 'T1', pgid: live, lstart: LSTART_1970, started_at: '2026-01-01T00:00:00Z' } })),
  'F45-handoff-lstart': async (_impl, _caller, r) => {
    const out = spawnSync(
      'bash',
      ['-c', `${H.bashPrelude('acquire-head-grace')}${ACQ_CALL}cp "$LK/owner" "$LK/../before"\nLOCK_OWNER_EXTRA='lstart=Thu Jan  1 00:00:00 1970'\nlock_hand_off "$LK" "$LOCK_TOKEN" $$ $$; echo "stage=$LHO_STAGE"`],
      { encoding: 'utf8', env: H.bashEnv(r, {}) },
    );
    const stage = /stage=(.*)/.exec(out.stdout ?? '')?.[1] ?? '';
    return { code: stage === 'lstart' ? 'failed' : `handed(${stage})`, check: () => expect(fs.readFileSync(path.join(lockOfRoot(r), 'owner'), 'utf8')).toBe(fs.readFileSync(path.join(r, 'before'), 'utf8')) };
  },
  'F46-garbage-owner': async (impl, caller, r) => {
    write(path.join(lockOfRoot(r), 'owner'), 'garbage');
    agedAll(lockOfRoot(r), H.OLD_MS);
    const out = await H.drive(impl, whoOf(caller), r);
    return {
      code: out.code,
      check: () => {
        expect(fs.readFileSync(path.join(lockOfRoot(r), 'owner'), 'utf8')).toBe('garbage');
        expect(out.log).toMatch(/machine-lock-owner-corrupt /);
        expect(out.log).toContain(path.join(lockOfRoot(r), 'owner'));
      },
    };
  },
  'F47-guard-absent-check': async (impl, caller, r) => {
    ownerless(r, []);
    const out = await H.drive(impl, whoOf(caller), r, { fault: 'lock-list=EIO' });
    return { code: out.code, check: () => expect(out.unknown).toContain('point=lock-list') };
  },
  'F48-guard-not-head': async (impl, caller, r) => {
    H.ticketAhead(r);
    ownerless(r, []);
    const out = await H.drive(impl, 'guard-behind', r);
    return { code: out.code, check: () => expect(namesIn(lockOfRoot(r))).toEqual([]) };
  },
  'F49-old-k1-resumed': async (impl, caller, r) => {
    const lock = ownerless(r, []);
    const out = await H.drive(impl, whoOf(caller), r);
    // The older writer resumes past its K1: its owner.tmp.<pid> and `mv -f` replace the successor's owner.
    if (out.code === 'acquired') {
      fs.writeFileSync(path.join(lock, 'owner.tmp.1'), 'pid=1\n');
      fs.renameSync(path.join(lock, 'owner.tmp.1'), path.join(lock, 'owner'));
    }
    return { code: out.code, check: () => (out.code === 'acquired' ? expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe('pid=1\n') : absentLock(r)) };
  },
  'F50-pr1a-writer-ticket-expired': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    write(path.join(lock, 'owner'), '');
    agedAll(lock, H.OLD_MS);
    const out = await H.drive(impl, whoOf(caller), r);
    // The PR1a writer resumes: `cat >>` by name lands in the successor's owner (unparsable from now on).
    if (out.code === 'acquired') fs.appendFileSync(path.join(lock, 'owner'), '{"pid":1}\n');
    return { code: out.code, check: () => (out.code === 'acquired' ? expect(H.isMine(r)).toBe(true) : absentLock(r)) };
  },
  'F51-pre-pid-stop': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    write(path.join(lock, 'owner'), '');
    agedAll(lock, H.OLD_MS);
    const fd = fs.openSync(path.join(lock, 'owner'), 'a'); // the older writer, opened and stopped
    const out = await H.drive(impl, whoOf(caller), r);
    fs.writeSync(fd, '{"pid":1}'); // resumed: its write lands in the inode taken out
    fs.closeSync(fd);
    return { code: out.code, check: () => (out.code === 'acquired' ? expect(H.isMine(r)).toBe(true) : absentLock(r)) };
  },
  'F52-old-tmp-pid-reused': async (impl, caller, r) => {
    const pid = H.liveSleep(); // started now: after the tmp's mtime + 2 s
    ownerless(r, [`owner.tmp.${pid}`]);
    const out = await H.drive(impl, whoOf(caller), r, { observation: 'fast' }); // a fast observation: the start is read, not unknown
    return { code: out.code, check: () => (caller === 'guard-head' ? absentLock(r) : expect(H.isMine(r)).toBe(true)) };
  },
  'F53-old-tmp-pid-etime': async (impl, caller, r) => {
    const pid = H.liveSleep();
    ownerless(r, [`owner.tmp.${pid}`]);
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r, { pathPrefix: H.psShim(r), env: { FAKE_ETIME_PID: String(pid), FAKE_ETIME: 'bad:bad' }, hooks: { startOf: () => null }, observation: 'fast' });
    return { code: out.code, check: () => expect(H.snapshot(r)).toBe(before) };
  },
  'F54-started-at-60s': d7Row((live) => ({ rec: { pid: live, token: 'T1', lstart: H.lstartOf(live, 'XXX-0:01'), started_at: H.iso(Date.now()) }, tz: 'UTC0' })),
  'F55-old-tmp-clock-back': async (impl, caller, r) => {
    const pid = H.liveSleep(); // the writer itself, whose clock stepped back: it reads as reused (F52)
    const lock = ownerless(r, [`owner.tmp.${pid}`]);
    const out = await H.drive(impl, whoOf(caller), r, { observation: 'fast' });
    // Resumed: its `mv -f` finds no tmp, and its failure path `rm -rf "$dir"` removes the successor's <lock>.
    if (out.code === 'acquired') fs.rmSync(lock, { recursive: true, force: true });
    return { code: out.code, check: () => absentLock(r) };
  },
  'F72-old-tmp-slow-observation': async (impl, caller, r) => {
    const pid = H.liveSleep(); // started now, as F52: with a fast observation it reads as reused and is taken out
    ownerless(r, [`owner.tmp.${pid}`]);
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r, { observation: 'slow' });
    return { code: out.code, check: () => expect(H.snapshot(r)).toBe(before) };
  },
  'F56-owner-pid-not-self': async (impl, caller, r) => {
    const other = H.liveSleep();
    const out = await H.drive(impl, whoOf(caller), r, { bashPre: `LOCK_OWNER_PID=${other}\n`, syncOptions: { ownerPid: other } });
    return { code: out.code, check: () => expect([fs.existsSync(lockOfRoot(r)), fs.existsSync(H.queueIn(r)), out.log]).toEqual([false, false, expect.stringContaining('machine-lock-owner-pid-not-self')]) };
  },
  'F58-undo-restore-exists': async (impl, caller, r) => {
    const out = await H.drive(impl, whoOf(caller), r, { fault: 'owner-readback=EIO owner-undo-lstat=EIO owner-undo-link=EEXIST' });
    return {
      code: out.code,
      check: () => {
        expect(namesIn(lockOfRoot(r))?.map((n) => n.replace(/^\.undo-.*/, '.undo-<token>'))).toEqual(['.undo-<token>']);
        expect(out.log).toContain('machine-lock-undo-restore-failed');
      },
    };
  },
  'F57-undo-paused-after-rename': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    const seen: string[] = [];
    const out = await atUndo(impl, caller, r, 'owner-undo-lstat', () => {
      // Stopped right after the undo's rename, past 60 s and the 10 min grace: the writer's ticket expired
      // (removed here) and every name is older than the grace. Every head reads the <lock> stray.
      fs.rmSync(H.queueIn(r), { recursive: true, force: true });
      agedAll(lock, H.OLD_MS);
      const before = namesIn(lock);
      seen.push(JSON.stringify(before?.map((n) => n.replace(/-.*/, ''))));
      const s = lockSync.recoverIfDead(lock, { timeoutMs: 0, ownerlessGraceMs: H.GRACE_MS, warn: () => {} });
      seen.push(`sync:${s.result}`);
      const b = spawnSync('bash', ['-c', `${H.bashPrelude('guard-head')}lock_recover_only "$LK" "$(machine_lock_queue_of "$LK")" 0; echo "result $LRO_RESULT"\n`], {
        encoding: 'utf8',
        env: H.bashEnv(r, {}),
      });
      seen.push(`bash:${/result (\S+)/.exec(b.stdout ?? '')?.[1]}`);
      seen.push(JSON.stringify(namesIn(lock)) === JSON.stringify(before) ? 'unchanged' : `changed:${JSON.stringify(namesIn(lock))}`);
    });
    return {
      code: out.code,
      check: () => {
        expect(seen).toEqual(['[".owner",".undo"]', 'sync:kept', 'bash:kept', 'unchanged']);
        expect(namesIn(lock)).toBeNull(); // resumed: its own inode (F13) — both own names removed, the <lock> rmdir'd
      },
    };
  },
  'F59-undo-rename-enoent': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    const out = await atStage(impl, caller, r, 'owner-linked', () => fs.rmSync(path.join(lock, 'owner')), { fault: 'owner-readback=EIO' });
    return { code: out.code, check: () => expect(namesIn(lock)).toEqual([]) };
  },
  'F60-undo-rename-other': async (impl, caller, r) => {
    const out = await H.drive(impl, whoOf(caller), r, { fault: 'owner-readback=EIO owner-undo-rename=EIO' });
    return { code: out.code, check: () => expect(namesIn(lockOfRoot(r))).toEqual(['owner']) };
  },
  'F61-undo-successor-before-rename': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    const succ = recordFor(impl, caller, { pid: process.pid, token: 'succ', v: true });
    const out = await atUndo(impl, caller, r, 'owner-undo-rename', () => {
      // Before the undo's rename: the recorded pid died, the ticket retired, and a successor recovered —
      // this <lock> moved aside with the tmp in it and removed — and took (its own <lock> and owner).
      fs.renameSync(lock, `${lock}.gone-f61-1`);
      fs.rmSync(`${lock}.gone-f61-1`, { recursive: true, force: true });
      write(path.join(lock, 'owner'), succ);
    });
    // The rename moves the successor's owner; no tmp to compare, so it is linked back (the same inode).
    return { code: out.code, check: () => expect([namesIn(lock), fs.readFileSync(path.join(lock, 'owner'), 'utf8')]).toEqual([['owner'], succ]) };
  },
  'F62-release-head-paused': async (impl, _caller, r) => {
    const lock = lockOfRoot(r);
    write(path.join(lock, 'owner'), H.recordText({ pid: H.dead(), token: 'T0', v: true }, impl === 'bash'));
    const succ = H.recordText({ pid: process.pid, token: 'T2', v: true }, impl === 'bash');
    // Between its judgement and its removal, another head recovered the dead record and took the lock (T2).
    const successor = () => {
      fs.rmSync(lock, { recursive: true, force: true });
      write(path.join(lock, 'owner'), succ);
    };
    let code: string;
    if (impl === 'bash') {
      const out = await H.driveBashPaused('guard-head', r, { 'release-head-judged': successor }, { call: 'lock_release_as_head "$LK" "$(machine_lock_queue_of "$LK")" 0 T0; echo "result $LRAH_RESULT"\n' });
      code = out.code;
    } else {
      code = lockSync.releaseAsHead(lock, ['T0'], { timeoutMs: 0, hooks: { onRecover: (s: string) => (s === 'before-move' ? successor() : undefined) } }).result;
    }
    return { code, check: () => expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe(succ) };
  },
  'F63-guard-absent': async (impl, caller, r) => {
    const out = await H.drive(impl, whoOf(caller), r);
    return { code: out.code, check: () => absentLock(r) };
  },
  'F64-guard-restore-failed': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    deadRecord(impl, caller, r);
    const succ = recordFor(impl, caller, { pid: process.pid, token: 'T2', v: true });
    const successor = () => replaceFile(path.join(lock, 'owner'), succ);
    const out =
      impl === 'bash'
        ? await H.driveBashPaused('guard-head', r, { 'recover-only-judged': successor }, { fault: 'restore-mkdir=EACCES' })
        : await H.drive(impl, 'guard-head', r, { fault: 'restore-mkdir=EACCES', hooks: { onRecover: (s: string) => (s === 'before-move' ? successor() : undefined) } });
    return {
      code: out.code,
      check: () => {
        absentLock(r);
        expect(goneDirs(r).map((g) => fs.readFileSync(path.join(g, 'owner'), 'utf8'))).toEqual([succ]);
      },
    };
  },
  'F65-clock-back-during-observation': async (impl, caller, r) => {
    const live = H.liveSleep();
    d7(r, { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo'), started_at: H.iso(Date.now()) });
    const out = await H.drive(impl, whoOf(caller), r, { fault: 'etime=ECLOCK', tz: 'UTC' });
    // The same answer from a real step back between the two reads of the clock (lock_now_ms replaced).
    const direct = spawnSync(
      'bash',
      ['-c', `${H.bashPrelude('acquire-head-grace')}C="$LK.clock"; : > "$C"\nlock_now_ms() { if [ -s "$C" ]; then echo 970100; else echo 1 > "$C"; echo 1000000; fi; }\nmachine_lock_pid_identity ${live} 'Thu Jan  1 00:00:00 1970' 110000`],
      { encoding: 'utf8', env: H.bashEnv(r, {}) },
    );
    return { code: out.code, check: () => expect((direct.stdout ?? '').trim()).toBe('unknown:etime:ECLOCK') };
  },
  'F66-owner-without-v': async (impl, caller, r) => {
    write(path.join(lockOfRoot(r), 'owner'), recordFor(impl, caller, { pid: process.pid, token: 'older', v: false }));
    const before = H.snapshot(r);
    const out = await H.drive(impl, whoOf(caller), r);
    return {
      code: out.code,
      check: () => {
        expect(H.snapshot(r)).toBe(before);
        expect(out.log).toContain(impl === 'ts' ? 'machine-lock-legacy-writer' : `machine-lock-legacy-writer ${lockOfRoot(r)} pid=${process.pid}`);
      },
    };
  },
  'F67-put-back-link-exists': async (impl, caller, r) => {
    const lock = lockOfRoot(r);
    deadRecord(impl, caller, r);
    const succ = recordFor(impl, caller, { pid: process.pid, token: 'T2', v: true });
    const w = recordFor(impl, caller, { pid: process.pid, token: 'W', v: true });
    // The record moved aside is a successor's (T2: its token differs), and while the put-back checks, W publishes.
    const moved = () => {
      for (const g of goneDirs(r)) replaceFile(path.join(g, 'owner'), succ);
    };
    const publish = () => write(path.join(lock, 'owner'), w);
    const out =
      impl === 'bash'
        ? await H.driveBashPaused(whoOf(caller), r, { 'recover-moved': moved, 'restore-mkdir': publish })
        : await H.drive(impl, whoOf(caller), r, { hooks: { onRecover: (s: string) => (s === 'moved' ? moved() : s === 'restore-mkdir' ? publish() : undefined) } });
    return {
      code: out.code,
      check: () => {
        expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe(w);
        expect(goneDirs(r).map((g) => fs.readFileSync(path.join(g, 'owner'), 'utf8'))).toEqual([succ]);
        expect(out.log).toContain('machine-lock-restore-failed');
      },
    };
  },
  'F68-owner-fields-reserved': async (impl, caller, r) => {
    const out = await H.drive(impl, whoOf(caller), r, { bashPre: 'LOCK_OWNER_EXTRA=pgid=4242\n', syncOptions: { ownerFields: { pid: 4242 } } });
    return { code: out.code, check: () => expect([fs.existsSync(lockOfRoot(r)), out.log]).toEqual([false, expect.stringContaining('machine-lock-owner-field-reserved')]) };
  },
  'F70-clock-back-offset-by-reader-stop': async (impl, caller, r) => {
    const live = H.liveSleep();
    // started 100 s, acquired 110 s; now_before 1000 s; the clock back to 970 s, BSD etime 870 s; the reader stops 30 s: now_after 1000 s.
    d7(r, { pid: live, token: 'T1', lstart: H.lstartOf(live, 'Asia/Tokyo'), started_at: '1970-01-01T00:01:50Z' });
    const out = await H.drive(impl, whoOf(caller), r, {
      tz: 'UTC',
      bashPre: 'lock_now_ms() { echo 1000000; }\n',
      pathPrefix: H.psShim(r),
      env: { FAKE_ETIME_PID: String(live), FAKE_ETIME: '14:30' },
    });
    return { code: out.code };
  },
};

/** Rows not driven here, with why (reported by the implementation contract). */
const F_NOT_DRIVEN: Partial<Record<Failure, string>> = {
  'F69-new-k1-writer-into-emptied-name': 'outside P0: two writers stopped past 10 min interleaved with a third — named, not fixed',
  'F71-old-writer-in-generic-shell': 'outside P0, mixed: an older copy in a generic shell — ended by the restart of §6.1 (c), nothing to drive in this repository',
};

describe.each(IMPLS)('Issue #4288 PR1a-f failure directions F: %s (design §3, to implement)', (impl) => {
  for (const c of F_CASES.filter((x) => x.impl === impl)) {
    const limit = c.row.limit ? ` [limit ${c.row.limit.kind}: ${c.row.limit.until}]` : '';
    const name = `${c.id} ${c.caller}${c.row.point ? ` @${c.row.point}` : ''}: ${c.row.direction} → ${c.result} / ${c.row.left}${limit} — ${c.row.note}`;
    const driver = F_DRIVERS[c.id];
    if (!driver) {
      it.todo(name);
      continue;
    }
    it(name, async () => {
      const r = freshRoot();
      const run = await driver(impl, c.caller, r);
      expect(run.code).toBe(c.result);
      run.check?.();
    }, 60000);
  }
});

/** The rows whose verdict reads the start of a pid (ps -o etime= between two clock reads): all fully injected. */
const OBSERVATION_ROWS: readonly Failure[] = [
  'F27-old-tmp-pid-alive',
  'F37-ticket-etime-malformed',
  'F52-old-tmp-pid-reused',
  'F53-old-tmp-pid-etime',
  'F55-old-tmp-clock-back',
  'F72-old-tmp-slow-observation',
];

describe('Issue #4288 PR1a-f impl-7: the observation rows read no real clock and no real etime', () => {
  // Watched: every read of Date.now / performance.now whose stack is in the two implementations, except
  // markDone's `doneAt` stamp (written into a retired ticket, never an input of an observation or a verdict).
  const IMPL_FILE = /scripts\/orchestrate\/machine-lock-sync\.mjs|src\/lib\/verification\/machine-lock\.ts/;
  const watched = (stack: string): boolean => IMPL_FILE.test(stack) && !/at markDone /.test(stack);
  for (const c of F_CASES.filter((x) => (OBSERVATION_ROWS as readonly string[]).includes(x.id))) {
    it(`${c.id} ${c.impl} ${c.caller}: Date.now / performance.now are read 0 times by the implementation, ps etime 0 times for real`, async () => {
      const driver = F_DRIVERS[c.id] as FDriver;
      const r = freshRoot();
      const fromImpl: string[] = [];
      const spy = (fn: () => number) => (): number => {
        const stack = new Error().stack ?? '';
        if (watched(stack)) fromImpl.push(stack.split('\n').find((l) => IMPL_FILE.test(l)) ?? '?');
        return fn();
      };
      const realDateNow = Date.now.bind(Date);
      const realPerfNow = performance.now.bind(performance);
      vi.spyOn(Date, 'now').mockImplementation(spy(realDateNow));
      vi.spyOn(performance, 'now').mockImplementation(spy(realPerfNow));
      let run: FRun;
      try {
        run = await driver(c.impl, c.caller, r);
      } finally {
        vi.restoreAllMocks();
      }
      expect(run.code).toBe(c.result);
      expect(fromImpl).toEqual([]);
      const rec = H.lastObservation();
      expect(rec, 'the drive went through the injected observation').not.toBeNull();
      expect(rec?.realEtimeReads).toBe(0);
      // bash reads its clock through lock_now_ms (replaced by the injected one); the JS ones through hooks.now
      if (c.id !== 'F27-old-tmp-pid-alive' && c.id !== 'F53-old-tmp-pid-etime') expect(rec?.clockReads).toBeGreaterThanOrEqual(2);
      if (c.impl === 'bash') expect(rec?.psQueries).toBeGreaterThanOrEqual(1);
    }, 60000);
  }
});

describe('Issue #4288 PR1a-f: the rows of F not driven are named with why', () => {
  it('every F row has a driver or a reason', () => {
    for (const id of FAILURES) expect([id, F_DRIVERS[id] !== undefined || F_NOT_DRIVEN[id] !== undefined]).toEqual([id, true]);
    for (const id of Object.keys(F_NOT_DRIVEN)) expect(F_DRIVERS[id as Failure]).toBeUndefined();
  });
});
