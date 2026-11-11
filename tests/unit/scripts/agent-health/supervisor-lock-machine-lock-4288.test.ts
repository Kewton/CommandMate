/**
 * Issue #4288 PR1c — supervisor.lock on the machine-wide lock (scripts/lib/machine-lock.sh, PR1a).
 * Design: docs/design/supervisor-lock-machine-lock-4288.md.
 *
 * UPSTREAM SKELETON (the design stage). This file holds the table of §2 — record form × caller ×
 * three-valued observation → result — and the failure directions of §3, built from enumerations so
 * that a cell left out (or one too many) fails the typecheck (`satisfies`). Nothing here calls the
 * implementation yet: every behaviour row is an `it.todo`, and the implementation contract of PR1c
 * turns them red → green (scripts/agent-health/product/lib.sh, deadline-guard.sh). What runs now is
 * the table checking itself against the invariants of §1 (a) — a table edited into a contradiction
 * fails here before anything is implemented.
 *
 * Counts (written in the design): 7 forms × 9 callers × 3 observations = 189 cells, 13 unreachable,
 * 176 rows; 22 failure rows.
 *
 * How the implementation will drive a row (for the implementation contract, not run here):
 *   - bash under `set -u`, `PRODUCT_BASE=<mkdtemp under os.tmpdir()>`, `. scripts/agent-health/product/lib.sh`;
 *     nothing under ~/.commandmate, no server, no tmux.
 *   - the form is written in the base (`supervisor.lock/owner` as key=value lines, `.gone-*`, an empty dir
 *     with `touch -t`), the observation made real (a live `sleep`, a dead pid, the test's own lstart) or
 *     injected (CM_VERIFY_TEST_KILL0_CMD, CM_VERIFY_TEST_OBS_FAULT=<point>=<ERRNO>, a `ps` shim on PATH,
 *     CM_VERIFY_TEST_HANDOFF=fault:… / pause:…);
 *   - `*-behind`: a live ticket of another pid placed ahead in `<base>/supervisor.queue/`.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

// ------------------------------------------------------------------ enumerations (§2.1)

const FORMS = ['absent', 'ownerless', 'corrupt', 'own', 'other-plain', 'other-lstart', 'aside'] as const;
type Form = (typeof FORMS)[number];

const CALLERS = [
  'acquire-head',
  'acquire-behind',
  'release-main',
  'release-subshell',
  'release-unheld',
  'release-as-head',
  'release-as-head-behind',
  'guard-head',
  'guard-behind',
] as const;
type Caller = (typeof CALLERS)[number];

const OBS = ['alive', 'gone', 'unknown'] as const;
type Obs = (typeof OBS)[number];

/** The results each caller can answer (product_lock_* over LRH_RESULT / LRAH_RESULT / LRO_RESULT). */
const RESULTS = {
  'acquire-head': ['acquired', 'refused'],
  'acquire-behind': ['refused'],
  'release-main': ['released', 'kept', 'deferred'],
  'release-subshell': ['kept', 'deferred', 'needs-head→released', 'needs-head→deferred'],
  'release-unheld': ['none'],
  'release-as-head': ['released', 'missing', 'deferred', 'kept'],
  'release-as-head-behind': ['not-head'],
  'guard-head': ['removed', 'kept', 'absent'],
  'guard-behind': ['not-head'],
} as const satisfies Record<Caller, readonly string[]>;
type ResultOf<C extends Caller> = (typeof RESULTS)[C][number];

/** Where the record of the form ends: stays, is removed, is replaced by the caller's, is put back. */
const LOCK_AFTER = ['unchanged', 'absent', 'mine', 'restored'] as const;
type LockAfter = (typeof LOCK_AFTER)[number];

/** PRODUCT_LOCK_ERROR of a refused acquisition (precedence: unk > rec > queue > taking). */
const MESSAGES = ['rec', 'taking', 'queue', 'unk'] as const;
type Message = (typeof MESSAGES)[number];

interface Row<C extends Caller> {
  readonly result: ResultOf<C>;
  readonly lock: LockAfter;
  readonly message?: Message;
}
interface Unreachable {
  readonly unreachable: string;
}
type Cell<C extends Caller> = Row<C> | Unreachable;
type Table = { readonly [F in Form]: { readonly [C in Caller]: { readonly [O in Obs]: Cell<C> } } };

/** What the decisive observation of each form is, per value (§2.1). */
const OBS_MEANING = {
  absent: {
    alive: 'acquire: mkdir <lock> EEXIST (made in between) / guard: the listing of <lock> shows it',
    gone: 'acquire: mkdir created / guard: ENOENT',
    unknown: 'mkdir or the listing fails with another errno (CM_VERIFY_TEST_OBS_FAULT=mkdir-lock|lock-list=EIO)',
  },
  ownerless: {
    alive: 'the empty <lock> is 60 s old or younger (being made)',
    gone: 'older than 60 s (touch -t)',
    unknown: 'its mtime or listing cannot be read (CM_VERIFY_TEST_OBS_FAULT=ownerless-mtime=EIO)',
  },
  corrupt: {
    alive: 'the pid left in the record is alive (must not matter)',
    gone: 'that pid is ESRCH (must not matter: a corrupt record is never recovered)',
    unknown: 'kill -0 of that pid fails (EPERM / EIO)',
  },
  own: {
    alive: 'kill -0 of the recorded pid ($$, or the parent $$ in a subshell) alive, lstart the same',
    gone: 'ESRCH (a subshell whose parent died; D5 after it)',
    unknown: 'kill -0 fails with EIO (CM_VERIFY_TEST_KILL0_CMD), or ps lstart fails for D5',
  },
  'other-plain': {
    alive: 'kill -0 of the recorded pid alive (no lstart= line, or an empty one)',
    gone: 'ESRCH',
    unknown: 'EPERM is alive; EIO and the like are unknown',
  },
  'other-lstart': {
    alive: 'the pid alive and ps -o lstart= equal to the record',
    gone: 'the pid alive and ps -o lstart= different (the pid was reused, D7)',
    unknown: 'ps fails or prints nothing (CM_VERIFY_TEST_OBS_FAULT=lstart=EIO)',
  },
  aside: {
    alive: "the moved-aside record's holder alive",
    gone: 'ESRCH',
    unknown: 'kill -0 of it fails (EIO)',
  },
} as const satisfies Record<Form, Record<Obs, string>>;

// ------------------------------------------------------------------ the table (§2.2)

const same = <const T,>(cell: T): Readonly<Record<Obs, T>> => ({ alive: cell, gone: cell, unknown: cell });

const NO_OWN_ACQUIRE = 'the supervisor takes once per shell under a new token (supervisor.sh:78); a second acquire is refused by its arguments (§5)';
const NO_OWN_GUARD = 'the guard never acquires (D6): no record carries its token';
const NO_SELF_ESRCH = 'the main shell is the caller: kill -0 $$ cannot be ESRCH';

const KEPT = { result: 'kept', lock: 'unchanged' } as const;
const NONE = { result: 'none', lock: 'unchanged' } as const;
const NOT_HEAD = { result: 'not-head', lock: 'unchanged' } as const;
const MISSING = { result: 'missing', lock: 'unchanged' } as const;
const refused = <const M extends Message>(message: M, lock: LockAfter = 'unchanged') => ({ result: 'refused', lock, message }) as const;
const ACQUIRED = { result: 'acquired', lock: 'mine' } as const;

/** A record of another token, judged by its observation (other-plain and other-lstart alike). */
const OTHER = {
  'acquire-head': { alive: refused('rec'), gone: ACQUIRED, unknown: refused('unk') },
  'acquire-behind': same(refused('rec')),
  'release-main': same(KEPT),
  'release-subshell': same(KEPT),
  'release-unheld': same(NONE),
  'release-as-head': same(KEPT),
  'release-as-head-behind': same(NOT_HEAD),
  'guard-head': { alive: KEPT, gone: { result: 'removed', lock: 'absent' }, unknown: KEPT },
  'guard-behind': same(NOT_HEAD),
} as const;

const TABLE = {
  absent: {
    'acquire-head': { alive: refused('taking'), gone: ACQUIRED, unknown: refused('unk') },
    'acquire-behind': same(refused('queue')),
    'release-main': same(KEPT),
    'release-subshell': same(KEPT),
    'release-unheld': same(NONE),
    'release-as-head': same(MISSING),
    'release-as-head-behind': same(NOT_HEAD),
    'guard-head': { alive: KEPT, gone: { result: 'absent', lock: 'unchanged' }, unknown: KEPT },
    'guard-behind': same(NOT_HEAD),
  },
  ownerless: {
    'acquire-head': { alive: refused('taking'), gone: ACQUIRED, unknown: refused('unk') },
    'acquire-behind': same(refused('queue')),
    'release-main': same(KEPT),
    'release-subshell': same(KEPT),
    'release-unheld': same(NONE),
    'release-as-head': same(MISSING),
    'release-as-head-behind': same(NOT_HEAD),
    'guard-head': { alive: KEPT, gone: { result: 'removed', lock: 'absent' }, unknown: KEPT },
    'guard-behind': same(NOT_HEAD),
  },
  corrupt: {
    'acquire-head': same(refused('rec')),
    'acquire-behind': same(refused('rec')),
    'release-main': same(KEPT),
    'release-subshell': same(KEPT),
    'release-unheld': same(NONE),
    'release-as-head': same(KEPT),
    'release-as-head-behind': same(NOT_HEAD),
    'guard-head': same(KEPT),
    'guard-behind': same(NOT_HEAD),
  },
  own: {
    'acquire-head': same({ unreachable: NO_OWN_ACQUIRE }),
    'acquire-behind': same({ unreachable: NO_OWN_ACQUIRE }),
    'release-main': {
      alive: { result: 'released', lock: 'absent' },
      gone: { unreachable: NO_SELF_ESRCH },
      unknown: { result: 'deferred', lock: 'unchanged' },
    },
    'release-subshell': {
      alive: { result: 'needs-head→deferred', lock: 'unchanged' },
      gone: { result: 'needs-head→released', lock: 'absent' },
      unknown: { result: 'deferred', lock: 'unchanged' },
    },
    'release-unheld': same(NONE),
    'release-as-head': {
      alive: { result: 'deferred', lock: 'unchanged' },
      gone: { result: 'released', lock: 'absent' },
      unknown: { result: 'deferred', lock: 'unchanged' },
    },
    'release-as-head-behind': same(NOT_HEAD),
    'guard-head': same({ unreachable: NO_OWN_GUARD }),
    'guard-behind': same({ unreachable: NO_OWN_GUARD }),
  },
  'other-plain': OTHER,
  'other-lstart': OTHER,
  aside: {
    'acquire-head': { alive: refused('rec', 'restored'), gone: ACQUIRED, unknown: refused('unk', 'restored') },
    'acquire-behind': same(refused('queue')),
    'release-main': same(KEPT),
    'release-subshell': same(KEPT),
    'release-unheld': same(NONE),
    'release-as-head': same(MISSING),
    'release-as-head-behind': same(NOT_HEAD),
    'guard-head': { alive: { result: 'kept', lock: 'restored' }, gone: { result: 'absent', lock: 'absent' }, unknown: { result: 'kept', lock: 'restored' } },
    'guard-behind': same(NOT_HEAD),
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
type ReachableEntry = Entry & { cell: Row<Caller> };
const isRow = (cell: Cell<Caller>): cell is Row<Caller> => !('unreachable' in cell);
const ROWS: ReachableEntry[] = CELLS.filter((e): e is ReachableEntry => isRow(e.cell));
const UNREACHABLE = CELLS.filter((e) => !isRow(e.cell));

// ------------------------------------------------------------------ failure directions (§3)

const FAILURES = [
  'F1-kill0-eperm',
  'F2-kill0-other',
  'F3-ps-lstart-judge',
  'F4-ps-lstart-at-write',
  'F5-mkdir-lock',
  'F6-owner-create-exists',
  'F7-owner-create-open',
  'F8-owner-write-or-readback',
  'F9-owner-unlink',
  'F10-lock-rmdir',
  'F11-mv-aside-enoent',
  'F12-mv-aside-other',
  'F13-restore-mkdir',
  'F14-restore-rename',
  'F15-rm-gone',
  'F16-rm-release-held',
  'F17-rm-release-as-head',
  'F18-ticket-ln',
  'F19-queue-list',
  'F20-ps-etime',
  'F21-loader',
  'F22-hostname',
] as const;
type Failure = (typeof FAILURES)[number];

/** keep: nothing removed or taken; own-only: only what this caller itself created is undone. */
type Direction = 'keep' | 'own-only';
interface FailureRow {
  readonly direction: Direction;
  readonly end: string;
}

const FAILURE_TABLE = {
  'F1-kill0-eperm': { direction: 'keep', end: 'read alive: not taken, not recovered; own → deferred' },
  'F2-kill0-other': { direction: 'keep', end: 'unknown: refused(unk) / guard kept with LRO_UNKNOWN' },
  'F3-ps-lstart-judge': { direction: 'keep', end: 'unknown: refused(unk) / guard kept' },
  'F4-ps-lstart-at-write': { direction: 'keep', end: 'an empty lstart= is judged by the pid alone (an older reader would take it: §4)' },
  'F5-mkdir-lock': { direction: 'keep', end: 'refused(unk), nothing made' },
  'F6-owner-create-exists': { direction: 'keep', end: 'not acquired, nothing removed' },
  'F7-owner-create-open': { direction: 'own-only', end: 'rmdir of the <lock> this mkdir made (only when empty)' },
  'F8-owner-write-or-readback': { direction: 'own-only', end: 'rm -f of the owner this create opened, then rmdir <lock>' },
  'F9-owner-unlink': { direction: 'keep', end: '<lock> and the half owner left ("could not be taken out again")' },
  'F10-lock-rmdir': { direction: 'keep', end: 'an empty <lock> left; the head takes it out after 60 s' },
  'F11-mv-aside-enoent': { direction: 'keep', end: 'absent: someone removed it first' },
  'F12-mv-aside-other': { direction: 'keep', end: 'not recovered; the same token is not broken twice; refused / kept' },
  'F13-restore-mkdir': { direction: 'keep', end: 'restore-failed: the moved-aside record kept and read as held while alive' },
  'F14-restore-rename': { direction: 'keep', end: 'the empty <lock> taken out, the moved-aside record kept' },
  'F15-rm-gone': { direction: 'keep', end: "a dead record's moved-aside directory left; the next head settles it" },
  'F16-rm-release-held': { direction: 'keep', end: "answers released; the supervisor's own record left, recovered after it exits" },
  'F17-rm-release-as-head': { direction: 'keep', end: 'answers released; the dead record left, recovered by the next head' },
  'F18-ticket-ln': { direction: 'keep', end: 'refused (cannot publish a ticket) / not-head' },
  'F19-queue-list': { direction: 'keep', end: 'refused without a mkdir / not-head after the budget' },
  'F20-ps-etime': { direction: 'keep', end: 'a ticket ahead is not read as reused: waited for' },
  'F21-loader': { direction: 'keep', end: 'acquire refused (exit 75); the guard skips only the lock recovery' },
  'F22-hostname': { direction: 'keep', end: 'a record of another host= is alive: never recovered' },
} as const satisfies Record<Failure, FailureRow>;

// ------------------------------------------------------------------ the table checks itself

describe('Issue #4288 PR1c table (design §2): shape', () => {
  it('has every combination: 7 forms × 9 callers × 3 observations = 189 cells, 13 unreachable, 176 rows', () => {
    expect(FORMS).toHaveLength(7);
    expect(CALLERS).toHaveLength(9);
    expect(CELLS).toHaveLength(189);
    expect(UNREACHABLE).toHaveLength(13);
    expect(ROWS).toHaveLength(176);
  });

  it('the unreachable cells are only own × acquire / guard and own × release-main × gone', () => {
    expect(UNREACHABLE.every((e) => e.form === 'own')).toBe(true);
    expect(
      UNREACHABLE.filter((e) => e.caller === 'release-main').map((e) => e.obs),
    ).toEqual(['gone']);
    expect(new Set(UNREACHABLE.map((e) => e.caller))).toEqual(
      new Set(['acquire-head', 'acquire-behind', 'guard-head', 'guard-behind', 'release-main']),
    );
  });

  it('every observation of every form is defined, and the failure table has 22 rows', () => {
    for (const form of FORMS) for (const obs of OBS) expect(OBS_MEANING[form][obs].length).toBeGreaterThan(0);
    expect(Object.keys(FAILURE_TABLE)).toEqual([...FAILURES]);
    expect(FAILURES).toHaveLength(22);
  });

  it.each(ROWS)('row $caller × $form × $obs: a result the caller can answer, a known lock end', ({ caller, cell }) => {
    expect((RESULTS[caller] as readonly string[]).includes(cell.result)).toBe(true);
    expect((LOCK_AFTER as readonly string[]).includes(cell.lock)).toBe(true);
    // A refused acquisition names its message; nothing else does.
    expect(cell.message !== undefined).toBe(cell.result === 'refused');
    if (cell.message !== undefined) expect((MESSAGES as readonly string[]).includes(cell.message)).toBe(true);
  });
});

describe('Issue #4288 PR1c table: the table keeps the invariants (a) (design §1, §2.3)', () => {
  const removes = (e: ReachableEntry) => e.cell.lock === 'absent' || e.cell.lock === 'mine';

  it('1 (S2): acquired only by acquire-head, and then the lock is mine; mine only when acquired', () => {
    for (const e of ROWS) {
      expect(e.cell.result === 'acquired', `${e.caller} × ${e.form} × ${e.obs}`).toBe(e.cell.lock === 'mine');
      if (e.cell.result === 'acquired') expect(e.caller).toBe('acquire-head');
    }
  });

  it('2 (S1, S3): a caller that is not the head moves nothing', () => {
    for (const e of ROWS.filter((r) => r.caller.endsWith('-behind'))) expect(e.cell.lock).toBe('unchanged');
  });

  it('3 (S3): an unknown observation never takes, removes or releases', () => {
    for (const e of ROWS.filter((r) => r.obs === 'unknown')) {
      expect(['unchanged', 'restored'], `${e.caller} × ${e.form}`).toContain(e.cell.lock);
      expect(['acquired', 'released', 'removed', 'needs-head→released']).not.toContain(e.cell.result);
    }
  });

  it("4 (S3): another token's record is removed only by a head on gone; a corrupt one by nobody", () => {
    for (const e of ROWS.filter((r) => r.form !== 'own' && removes(r) && r.form !== 'absent')) {
      expect(['acquire-head', 'guard-head'], `${e.caller} × ${e.form} × ${e.obs}`).toContain(e.caller);
      expect(e.obs).toBe('gone');
    }
    expect(ROWS.filter((r) => r.form === 'corrupt' && r.cell.lock !== 'unchanged')).toEqual([]);
  });

  it('5 (S4, S5): the own record is removed only by the main shell, or through D5 on gone', () => {
    const removing = ROWS.filter((r) => r.form === 'own' && r.cell.lock === 'absent').map((r) => `${r.caller}/${r.obs}`);
    expect(removing.sort()).toEqual(['release-as-head/gone', 'release-main/alive', 'release-subshell/gone']);
  });

  it('6 (S6): a subshell never removes directly — only through needs-head → D5', () => {
    for (const e of ROWS.filter((r) => r.caller === 'release-subshell')) expect(e.cell.result).not.toBe('released');
  });

  it('7 (S4): a release with no hold mark does nothing (once only)', () => {
    for (const e of ROWS.filter((r) => r.caller === 'release-unheld')) expect(e.cell).toEqual(NONE);
  });

  it('8 (S4): no release removes a record that is not its own', () => {
    for (const e of ROWS.filter((r) => r.caller.startsWith('release') && r.form !== 'own')) expect(e.cell.lock).toBe('unchanged');
  });

  it('9 (§3): only what the caller itself created is undone on a failure', () => {
    const ownOnly = FAILURES.filter((f) => FAILURE_TABLE[f].direction === 'own-only');
    expect(ownOnly).toEqual(['F7-owner-create-open', 'F8-owner-write-or-readback']);
  });
});

// ------------------------------------------------------------------ behaviour (the implementation contract)

describe.each(CALLERS)('Issue #4288 PR1c behaviour: %s (to implement: lib.sh / deadline-guard.sh)', (caller) => {
  for (const e of ROWS.filter((r) => r.caller === caller)) {
    const msg = e.cell.message ? ` (${e.cell.message})` : '';
    it.todo(`${e.form} × ${e.obs} → ${e.cell.result}${msg} / ${e.cell.lock}`);
  }
});

describe('Issue #4288 PR1c failure directions (design §3, to implement)', () => {
  for (const f of FAILURES) it.todo(`${f}: ${FAILURE_TABLE[f].direction} — ${FAILURE_TABLE[f].end}`);
});
