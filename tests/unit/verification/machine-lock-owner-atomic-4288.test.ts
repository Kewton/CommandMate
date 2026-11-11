/**
 * Issue #4288 PR1a-f — the owner written atomically (tmp → link), the owner-less <lock> holding only
 * temporaries (the new `.owner-*` and the older run-lock / supervisor.lock `owner.tmp.*`) taken out by
 * a graced head, a corrupt owner named and never removed, and D7's reuse check made independent of the
 * time zone (ps lstart AND etime / started_at). Design: docs/design/machine-lock-owner-atomic-4288.md.
 *
 * UPSTREAM SKELETON (the design stage). This file holds the tables of §2 (T: owner form × caller ×
 * three-valued observation → result; K: the interruption points of an acquisition × implementation →
 * the form left) and §3 (F: the failures of the external calls → which way they fall), built from
 * enumerations so that a cell left out (or one too many) fails the typecheck (`satisfies`). Nothing
 * here calls the implementation yet: every behaviour row is an `it.todo`, and the implementation
 * contract of PR1a-f turns them red → green (verify-run.sh's lock section, scripts/lib/machine-lock.sh,
 * scripts/orchestrate/machine-lock-sync.mjs, src/lib/verification/machine-lock.ts). What runs now is
 * the tables checking themselves against the invariants of §1 (a).
 *
 * Counts (written in the design §2.4): T 11 forms × 4 callers × 3 observations = 132 cells, 15
 * unreachable, 117 rows; K 5 points × 3 implementations = 15 rows; F 25 rows. 157 rows in all.
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
 *   - positive controls: the current implementation (develop fd2f4a589) gives the `now` of a row.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

// ------------------------------------------------------------------ enumerations (§2.1)

const FORMS = [
  'empty-dir',
  'tmp-new',
  'tmp-old',
  'tmp-stray',
  'empty-owner',
  'garbage-owner',
  'lstart-match',
  'lstart-tz',
  'lstart-reused',
  'lstart-ps-fails',
  'lstart-legacy',
] as const;
type Form = (typeof FORMS)[number];

/** The forms judged by D7 (a kv record with an lstart= line): only the loader's callers read them. */
const D7_FORMS = ['lstart-match', 'lstart-tz', 'lstart-reused', 'lstart-ps-fails', 'lstart-legacy'] as const satisfies readonly Form[];

const CALLERS = ['acquire-head-grace', 'acquire-head-nograce', 'acquire-behind', 'guard-head'] as const;
type Caller = (typeof CALLERS)[number];

const OBS = ['alive', 'gone', 'unknown'] as const;
type Obs = (typeof OBS)[number];

/** The results each caller can answer (lock_acquire_path's 0/1, LRO_RESULT / recoverIfDead's result). */
const RESULTS = {
  'acquire-head-grace': ['acquired', 'refused'],
  'acquire-head-nograce': ['acquired', 'refused'],
  'acquire-behind': ['refused'],
  'guard-head': ['removed', 'kept'],
} as const satisfies Record<Caller, readonly string[]>;
type ResultOf<C extends Caller> = (typeof RESULTS)[C][number];

const LOCK_AFTER = ['unchanged', 'mine', 'absent'] as const;
type LockAfter = (typeof LOCK_AFTER)[number];

/** The kind of a refusal's wording (stderr / logTail / the error). corrupt and stray are new (I3, I4). */
const MESSAGES = ['rec', 'taking', 'queue', 'unk', 'corrupt', 'stray'] as const;
type Message = (typeof MESSAGES)[number];

interface Row<C extends Caller> {
  readonly result: ResultOf<C>;
  readonly lock: LockAfter;
  readonly message?: Message;
  /** The result of the implementation before PR1a-f, when it differs (the positive control). */
  readonly now?: ResultOf<C>;
}
interface Unreachable {
  readonly unreachable: string;
}
type Cell<C extends Caller> = Row<C> | Unreachable;
type Table = { readonly [F in Form]: { readonly [C in Caller]: { readonly [O in Obs]: Cell<C> } } };

/** What the decisive observation of each form is, per value (§2.1). */
const AGE = {
  alive: 'the <lock> (and every temporary in it) is 60 s old or younger',
  gone: 'older than 60 s (fs.utimesSync)',
  unknown: 'the listing, an lstat, an mtime or the owner read fails (lock-list / ownerless-tmp-lstat / ownerless-mtime / lock-owner = EIO)',
} as const;
const KILL0 = {
  alive: 'kill -0 of the recorded pid answers (a live sleep)',
  gone: 'ESRCH',
  unknown: 'EPERM (a process of another user; CM_VERIFY_TEST_KILL0_CMD)',
} as const;
const OBS_MEANING = {
  'empty-dir': AGE,
  'tmp-new': AGE,
  'tmp-old': AGE,
  'tmp-stray': AGE,
  'empty-owner': { ...AGE, alive: 'young (must not matter: a corrupt owner is never removed)', gone: 'old (must not matter)' },
  'garbage-owner': { ...AGE, alive: 'young (must not matter)', gone: 'old (must not matter)' },
  'lstart-match': KILL0,
  'lstart-tz': KILL0,
  'lstart-reused': KILL0,
  'lstart-ps-fails': KILL0,
  'lstart-legacy': KILL0,
} as const satisfies Record<Form, Record<Obs, string>>;

/** What the form is, for the row's setup. */
const FORM_MEANING = {
  'empty-dir': '<lock> with no owner and nothing in it (K1; D3 as today)',
  'tmp-new': '<lock> holding only `.owner-<token>` (K2 / K3 of the new create, or an undo whose unlink failed: F11)',
  'tmp-old': '<lock> holding only `owner.tmp.<pid>` (the older run-lock.sh:62 / lib.sh:174 killed before its mv)',
  'tmp-stray': '<lock> with no owner holding a temporary and a name that is not one (a file `x`, a directory)',
  'empty-owner': 'an owner of 0 bytes (PR1a\'s `: >` / openSync then the write, killed in between: E1, E2)',
  'garbage-owner': 'an owner that does not parse',
  'lstart-match': 'kv record with lstart= equal to ps -o lstart= (LC_ALL=C) and started_at= after the start',
  'lstart-tz': 'the same holder, its lstart= written under another TZ= (the string differs), started_at= after the start',
  'lstart-reused': 'lstart= differs and the process under the pid started > started_at= + 2 s (a reused pid)',
  'lstart-ps-fails': 'ps -o lstart= / etime= fail or print nothing (a ps shim; CM_VERIFY_TEST_OBS_FAULT=lstart=EIO / etime=EIO)',
  'lstart-legacy': 'lstart= that differs and no started_at= (the older supervisor.lock record)',
} as const satisfies Record<Form, string>;

// ------------------------------------------------------------------ table T (§2.3)

const same = <const T,>(cell: T): Readonly<Record<Obs, T>> => ({ alive: cell, gone: cell, unknown: cell });

const NO_KV_FOR_NOGRACE =
  'the callers without a grace (verify gate, merge-pr, precheck, gate-runner) keep JSON owners at their own paths and do not load the loader\'s D7';

const ACQUIRED = { result: 'acquired', lock: 'mine' } as const;
const KEPT = { result: 'kept', lock: 'unchanged' } as const;
const REMOVED = { result: 'removed', lock: 'absent' } as const;
const refused = <const M extends Message>(message: M) => ({ result: 'refused', lock: 'unchanged', message }) as const;
const QUEUE = same(refused('queue'));

/** An owner-less <lock> of temporaries only: a graced head takes it out past the grace (I3). */
const TMP_ONLY = {
  'acquire-head-grace': { alive: refused('taking'), gone: { ...ACQUIRED, now: 'refused' }, unknown: refused('unk') },
  'acquire-head-nograce': { alive: refused('taking'), gone: refused('taking'), unknown: refused('unk') },
  'acquire-behind': QUEUE,
  'guard-head': { alive: KEPT, gone: { ...REMOVED, now: 'kept' }, unknown: KEPT },
} as const;

/** A corrupt owner: nobody removes it, every refusal names it (I4). */
const CORRUPT = {
  'acquire-head-grace': { alive: refused('corrupt'), gone: refused('corrupt'), unknown: refused('unk') },
  'acquire-head-nograce': { alive: refused('corrupt'), gone: refused('corrupt'), unknown: refused('unk') },
  'acquire-behind': QUEUE,
  'guard-head': same(KEPT),
} as const;

const d7 = <const A extends Cell<'acquire-head-grace'>, const U extends Cell<'acquire-head-grace'>, const GA extends Cell<'guard-head'>, const GU extends Cell<'guard-head'>>(
  alive: A,
  unknown: U,
  guardAlive: GA,
  guardUnknown: GU,
) =>
  ({
    'acquire-head-grace': { alive, gone: ACQUIRED, unknown },
    'acquire-head-nograce': same({ unreachable: NO_KV_FOR_NOGRACE }),
    'acquire-behind': QUEUE,
    'guard-head': { alive: guardAlive, gone: REMOVED, unknown: guardUnknown },
  }) as const;

const TABLE = {
  'empty-dir': {
    'acquire-head-grace': { alive: refused('taking'), gone: ACQUIRED, unknown: refused('unk') },
    'acquire-head-nograce': { alive: refused('taking'), gone: refused('taking'), unknown: refused('unk') },
    'acquire-behind': QUEUE,
    'guard-head': { alive: KEPT, gone: REMOVED, unknown: KEPT },
  },
  'tmp-new': TMP_ONLY,
  'tmp-old': TMP_ONLY,
  'tmp-stray': {
    'acquire-head-grace': { alive: refused('stray'), gone: refused('stray'), unknown: refused('unk') },
    'acquire-head-nograce': { alive: refused('taking'), gone: refused('taking'), unknown: refused('unk') },
    'acquire-behind': QUEUE,
    'guard-head': same(KEPT),
  },
  'empty-owner': CORRUPT,
  'garbage-owner': CORRUPT,
  'lstart-match': d7(refused('rec'), refused('unk'), KEPT, KEPT),
  'lstart-tz': d7({ ...refused('rec'), now: 'acquired' }, refused('unk'), { ...KEPT, now: 'removed' }, KEPT),
  'lstart-reused': d7(ACQUIRED, { ...ACQUIRED, now: 'refused' }, REMOVED, { ...REMOVED, now: 'kept' }),
  'lstart-ps-fails': d7(refused('unk'), refused('unk'), KEPT, KEPT),
  'lstart-legacy': d7({ ...refused('rec'), now: 'acquired' }, refused('unk'), { ...KEPT, now: 'removed' }, KEPT),
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

// ------------------------------------------------------------------ table K (§2.5)

const KILL_POINTS = ['K1-after-mkdir', 'K2-tmp-half-written', 'K3-tmp-written', 'K4-linked', 'K5-tmp-removed'] as const;
type KillPoint = (typeof KILL_POINTS)[number];
const IMPLS = ['bash', 'sync', 'ts'] as const;
type Impl = (typeof IMPLS)[number];

/** The form an acquisition killed at the point leaves: one of T's forms, or a complete record. */
type Left = 'empty-dir' | 'tmp-new' | 'complete+tmp' | 'complete';
interface KillRow {
  readonly left: Left;
  /** Who takes it out once the killed acquirer is gone. */
  readonly by: 'graced-head-after-grace' | 'recover-when-pid-gone';
}
const KILL_BY_POINT = {
  'K1-after-mkdir': { left: 'empty-dir', by: 'graced-head-after-grace' },
  'K2-tmp-half-written': { left: 'tmp-new', by: 'graced-head-after-grace' },
  'K3-tmp-written': { left: 'tmp-new', by: 'graced-head-after-grace' },
  'K4-linked': { left: 'complete+tmp', by: 'recover-when-pid-gone' },
  'K5-tmp-removed': { left: 'complete', by: 'recover-when-pid-gone' },
} as const satisfies Record<KillPoint, KillRow>;
/** The same rule in every implementation (I6); a row per implementation. */
const KILL_TABLE = Object.fromEntries(IMPLS.map((impl) => [impl, KILL_BY_POINT])) as Record<Impl, Record<KillPoint, KillRow>>;
const KILL_ROWS = IMPLS.flatMap((impl) => KILL_POINTS.map((point) => ({ impl, point, ...KILL_TABLE[impl][point] })));
/** What the implementation before PR1a-f leaves between the open and the write (E1, E2). */
const KILL_NOW: Left | 'empty-owner' = 'empty-owner';

// ------------------------------------------------------------------ table F (§3)

const FAILURES = [
  'F1-mkdir-lock',
  'F2-tmp-create-exists',
  'F3-tmp-create-other',
  'F4-tmp-write',
  'F5-link-exists',
  'F6-link-enoent',
  'F7-link-other',
  'F8-readback-unknown',
  'F9-readback-not-ours',
  'F10-tmp-unlink-after-publish',
  'F11-undo-tmp-unlink',
  'F12-undo-lock-rmdir',
  'F13-ownerless-list',
  'F14-ownerless-tmp-lstat',
  'F15-ownerless-mtime',
  'F16-ownerless-tmp-unlink',
  'F17-ownerless-rmdir-notempty',
  'F18-ownerless-rmdir-other',
  'F19-kill0-other',
  'F20-ps-lstart',
  'F21-ps-etime',
  'F22-started-at',
  'F23-hostname',
  'F24-clock-back-and-tz',
  'F25-corrupt-owner',
] as const;
type Failure = (typeof FAILURES)[number];

/** keep: nothing removed or taken; own-only: only what this caller itself made is undone; residual: may fall to the removing side (conditions in the design). */
type Direction = 'keep' | 'own-only' | 'residual';
interface FailureRow {
  readonly direction: Direction;
  readonly end: string;
}

const FAILURE_TABLE = {
  'F1-mkdir-lock': { direction: 'keep', end: 'refused(unk), nothing made' },
  'F2-tmp-create-exists': { direction: 'own-only', end: 'the tmp not opened, not removed; rmdir <lock> (not empty: left); refused' },
  'F3-tmp-create-other': { direction: 'own-only', end: 'rmdir of the <lock> this mkdir made; point owner-create' },
  'F4-tmp-write': { direction: 'own-only', end: 'own tmp removed, rmdir <lock>; machine-lock-owner-write-failed' },
  'F5-link-exists': { direction: 'own-only', end: 'own tmp removed; the owner and <lock> left (owner-exists)' },
  'F6-link-enoent': { direction: 'own-only', end: 'own tmp removed if there, rmdir <lock> only when empty; refused' },
  'F7-link-other': { direction: 'own-only', end: 'own tmp removed, rmdir <lock>; point owner-publish (new)' },
  'F8-readback-unknown': { direction: 'own-only', end: 'the owner this link made and the tmp removed, rmdir <lock> (as 70+i today)' },
  'F9-readback-not-ours': { direction: 'own-only', end: 'own tmp removed; nothing else (owner-not-ours)' },
  'F10-tmp-unlink-after-publish': { direction: 'keep', end: 'acquired; the tmp beside the owner goes with the rm -rf of release / recovery' },
  'F11-undo-tmp-unlink': { direction: 'keep', end: '<lock> with own `.owner-<token>` left (tmp-new); a graced head takes it out after the grace' },
  'F12-undo-lock-rmdir': { direction: 'keep', end: 'an empty <lock> left (as today)' },
  'F13-ownerless-list': { direction: 'keep', end: 'no mkdir this poll (unk)' },
  'F14-ownerless-tmp-lstat': { direction: 'keep', end: 'no mkdir this poll (unk); point ownerless-tmp-lstat (new)' },
  'F15-ownerless-mtime': { direction: 'keep', end: 'no mkdir this poll (unk)' },
  'F16-ownerless-tmp-unlink': { direction: 'keep', end: 'no rmdir, no mkdir this poll (unk); point ownerless-tmp-unlink (new)' },
  'F17-ownerless-rmdir-notempty': { direction: 'keep', end: 'taken in between: nothing removed, judged as a record next poll' },
  'F18-ownerless-rmdir-other': { direction: 'keep', end: 'no mkdir this poll (unk); point ownerless-rmdir' },
  'F19-kill0-other': { direction: 'keep', end: 'unknown stays (D7 not applied)' },
  'F20-ps-lstart': { direction: 'keep', end: 'alive → unknown:lstart:<errno>; EPERM stays' },
  'F21-ps-etime': { direction: 'keep', end: 'alive → unknown:etime:<errno>; EPERM stays (point etime, new)' },
  'F22-started-at': { direction: 'keep', end: 'D7 not applied: the pid alone' },
  'F23-hostname': { direction: 'keep', end: 'another host= is alive (D7 not applied)' },
  'F24-clock-back-and-tz': {
    direction: 'residual',
    end: 'a clock stepped back > 2 s between the holder\'s start and its acquire AND another TZ: both witnesses agree on a live holder',
  },
  'F25-corrupt-owner': { direction: 'keep', end: 'never removed; the refusal and D6 name <lock>/owner (I4)' },
} as const satisfies Record<Failure, FailureRow>;

// ------------------------------------------------------------------ the tables check themselves

describe('Issue #4288 PR1a-f tables (design §2.4): shape', () => {
  it('T has every combination: 11 forms × 4 callers × 3 observations = 132 cells, 15 unreachable, 117 rows', () => {
    expect(FORMS).toHaveLength(11);
    expect(CALLERS).toHaveLength(4);
    expect(CELLS).toHaveLength(132);
    expect(UNREACHABLE).toHaveLength(15);
    expect(ROWS).toHaveLength(117);
  });

  it('the unreachable cells are exactly acquire-head-nograce × the D7 forms', () => {
    expect(UNREACHABLE.every((e) => e.caller === 'acquire-head-nograce')).toBe(true);
    expect(new Set(UNREACHABLE.map((e) => e.form))).toEqual(new Set(D7_FORMS));
  });

  it('K has 5 points × 3 implementations = 15 rows, F has 25 rows: 157 rows in all', () => {
    expect(KILL_ROWS).toHaveLength(15);
    expect(Object.keys(FAILURE_TABLE)).toEqual([...FAILURES]);
    expect(FAILURES).toHaveLength(25);
    expect(ROWS.length + KILL_ROWS.length + FAILURES.length).toBe(157);
  });

  it('every form and every observation of it is defined', () => {
    for (const form of FORMS) {
      expect(FORM_MEANING[form].length).toBeGreaterThan(0);
      for (const obs of OBS) expect(OBS_MEANING[form][obs].length).toBeGreaterThan(0);
    }
  });

  it.each(ROWS)('row $caller × $form × $obs: a result the caller can answer, a known lock end', ({ caller, cell }) => {
    expect((RESULTS[caller] as readonly string[]).includes(cell.result)).toBe(true);
    expect((LOCK_AFTER as readonly string[]).includes(cell.lock)).toBe(true);
    // A refused acquisition names its message; nothing else does.
    expect(cell.message !== undefined).toBe(cell.result === 'refused');
    if (cell.message !== undefined) expect((MESSAGES as readonly string[]).includes(cell.message)).toBe(true);
    if (cell.now !== undefined) {
      expect(cell.now).not.toBe(cell.result);
      expect((RESULTS[caller] as readonly string[]).includes(cell.now)).toBe(true);
    }
  });
});

describe('Issue #4288 PR1a-f tables keep the invariants (a) (design §1)', () => {
  const removes = (e: ReachableEntry) => e.cell.lock !== 'unchanged';

  it('I0-b: a caller that is not the head moves nothing', () => {
    for (const e of ROWS.filter((r) => r.caller === 'acquire-behind')) expect(e.cell).toEqual(refused('queue'));
  });

  it('I0-c: an unknown observation never takes or removes — except a reused pid read EPERM by both witnesses (I5)', () => {
    for (const e of ROWS.filter((r) => r.obs === 'unknown' && removes(r))) {
      expect(`${e.form}/${e.caller}`).toMatch(/^lstart-reused\//);
    }
  });

  it('I1, K: no interruption point leaves an empty or half owner, in any implementation; today one does', () => {
    for (const k of KILL_ROWS) expect(['empty-dir', 'tmp-new', 'complete+tmp', 'complete']).toContain(k.left);
    expect(KILL_ROWS.some((k) => (k.left as string) === KILL_NOW)).toBe(false);
    for (const impl of IMPLS) expect(KILL_TABLE[impl]).toEqual(KILL_BY_POINT);
  });

  it('I3: an owner-less <lock> is taken out only by a graced head, past the grace, and only when it holds temporaries alone', () => {
    const ownerless: readonly Form[] = ['empty-dir', 'tmp-new', 'tmp-old', 'tmp-stray'];
    for (const e of ROWS.filter((r) => ownerless.includes(r.form) && removes(r))) {
      expect(['acquire-head-grace', 'guard-head']).toContain(e.caller);
      expect(e.obs).toBe('gone');
      expect(e.form).not.toBe('tmp-stray');
    }
    for (const e of ROWS.filter((r) => r.caller === 'acquire-head-nograce' && ownerless.includes(r.form))) expect(removes(e)).toBe(false);
  });

  it('I4: a corrupt owner is removed by nobody, and every head that meets it names it', () => {
    const corrupt: readonly Form[] = ['empty-owner', 'garbage-owner'];
    for (const e of ROWS.filter((r) => corrupt.includes(r.form))) {
      expect(e.cell.lock).toBe('unchanged');
      if (e.caller.startsWith('acquire-head') && e.obs !== 'unknown') expect(e.cell.message).toBe('corrupt');
    }
  });

  it('I5: D7 turns nothing alive into taken except a reused pid; a live holder under another TZ or an older record is kept', () => {
    for (const e of ROWS.filter((r) => (D7_FORMS as readonly Form[]).includes(r.form) && r.obs !== 'gone' && removes(r))) {
      expect(e.form).toBe('lstart-reused');
    }
    for (const form of ['lstart-tz', 'lstart-legacy'] as const) {
      expect(TABLE[form]['acquire-head-grace'].alive).toMatchObject({ result: 'refused', now: 'acquired' });
      expect(TABLE[form]['guard-head'].alive).toMatchObject({ result: 'kept', now: 'removed' });
    }
  });

  it('§3: only own-only rows undo anything, and the one residual row is F24 (two independent conditions)', () => {
    expect(FAILURES.filter((f) => FAILURE_TABLE[f].direction === 'residual')).toEqual(['F24-clock-back-and-tz']);
    expect(FAILURES.filter((f) => FAILURE_TABLE[f].direction === 'own-only')).toEqual([
      'F2-tmp-create-exists',
      'F3-tmp-create-other',
      'F4-tmp-write',
      'F5-link-exists',
      'F6-link-enoent',
      'F7-link-other',
      'F8-readback-unknown',
      'F9-readback-not-ours',
    ]);
  });

  it('the positive controls (rows whose result changes) are the ones the design marks', () => {
    const changed = ROWS.filter((r) => r.cell.now !== undefined).map((r) => `${r.form}/${r.caller}/${r.obs}`);
    expect(changed.sort()).toEqual(
      [
        'tmp-new/acquire-head-grace/gone',
        'tmp-new/guard-head/gone',
        'tmp-old/acquire-head-grace/gone',
        'tmp-old/guard-head/gone',
        'lstart-tz/acquire-head-grace/alive',
        'lstart-tz/guard-head/alive',
        'lstart-reused/acquire-head-grace/unknown',
        'lstart-reused/guard-head/unknown',
        'lstart-legacy/acquire-head-grace/alive',
        'lstart-legacy/guard-head/alive',
      ].sort(),
    );
  });
});

// ------------------------------------------------------------------ behaviour (the implementation contract)

describe.each(CALLERS)('Issue #4288 PR1a-f behaviour T: %s (to implement)', (caller) => {
  for (const e of ROWS.filter((r) => r.caller === caller)) {
    const msg = e.cell.message ? ` (${e.cell.message})` : '';
    const now = e.cell.now ? ` [today: ${e.cell.now}]` : '';
    it.todo(`${e.form} × ${e.obs} → ${e.cell.result}${msg} / ${e.cell.lock}${now}`);
  }
});

describe('Issue #4288 PR1a-f behaviour K: an acquisition killed at each point (design §2.5, to implement)', () => {
  for (const k of KILL_ROWS) it.todo(`${k.impl} ${k.point}: leaves ${k.left}, taken out by ${k.by}`);
});

describe('Issue #4288 PR1a-f failure directions F (design §3, to implement)', () => {
  for (const f of FAILURES) it.todo(`${f}: ${FAILURE_TABLE[f].direction} — ${FAILURE_TABLE[f].end}`);
});
