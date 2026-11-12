/**
 * Issue #4288 PR1b — the state-transition table of daily.sh's traps (PM: pm-trap-table-4288-pr1b.md, 21 sections ×
 * INT/TERM / a second TERM while the first one's handler runs / the ends), driven cell by cell.
 *
 * TRAP_TABLE holds the cells under the ids of that table (A0–A3, B0, B0f, C0–C12, X0, X1; the emit points p0–p3 of
 * §2.2). A row is named `<id><point> × <column>` (`C7p1 × TERM2`) and is one of:
 *   drive  — daily.sh is run (a fake origin and a fake `npx`, all under one mkdtemp root) and the signal is sent at the
 *            point the driver stops at; the outcome is the invariants I1–I4 of the table: the AGENT_HEALTH_SYNC lines
 *            (none / failed / ok, the same line twice only between its echo and its mark), the exit, the lock, run.ts,
 *            and no `cm-daily-hand.*` left behind;
 *   same   — the state at that point is the one of another cell (nothing runs between them that a test can stop at);
 *   na     — the column cannot happen in that section (no handler yet, or the section ends in another one);
 *   theory — no command to stop at; what is left and where it is handed (△(e), PR1d).
 * The stops: a function named like an external command (or `trap` / `echo`), defined through BASH_ENV in daily.sh only
 * ($0), that waits at a gate; the handover pauses of verify-run.sh (CM_VERIFY_TEST_HANDOFF=pause:<stage>); the fake
 * install command. `x0` holds daily_on_exit at its `trap '' INT TERM` (before or after the builtin) while a second TERM
 * and an INT are sent: X0 of the table.
 *
 * R-SIG (pm-rule-4288-signal-traps.md): INT, TERM, HUP, PIPE and QUIT each have a handler whose first command ignores
 * all five, then exit 128+n. The rows `C4 × <SIG>` / `X0 × TERM2（R-SIG …）` hold 既定の死／明示の trap × 5 signals × the
 * first / second signal: the explicit ones must be green, the copies without a part of R-SIG (a trap removed, a signal
 * left out of the ignores) must be red (`red`: they must NOT meet the R-SIG outcome). The bash version is in the describe.
 *
 * The X0 positive control runs a copy of daily.sh with the fix taken out (the handlers without their first `trap ""`,
 * daily_exit without it), committed in the sandbox clone only: a second TERM at X0 leaves no line and the lock (✗(a)).
 *
 * Moved here from run-lock-machine-lock-4288.test.ts (pr1b-4 / pr1b-5 / pr1b-6 and the emit_sync_line scan): their
 * cells are C4 × TERM, B0 × TERM, C11 × EXIT, C1 × EXIT, C12 × EXIT, C7p1/p2 × TERM, C5p1/p2, C1p1/p2, C11p1/p2.
 *
 * @vitest-environment node
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REAL_SHELL_TEST_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO = path.resolve(__dirname, '../../../..');
const DAILY = 'scripts/agent-health/daily.sh';

// ================================================================ the table

const SECTIONS = ['A0', 'A1', 'A2', 'A3', 'B0', 'B0f', 'C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'X0', 'X1'] as const;
type Section = (typeof SECTIONS)[number];
type Point = 'p0' | 'p1' | 'p2' | 'p3';
/** TERM / INT: the first signal; TERM2: a second TERM (and an INT) while daily_on_exit runs after it; EXIT: the end
 * without a signal; EXIT+TERM@X0: that end with a TERM (and an INT) at X0; INT+TERM: both at once. */
type Column = 'TERM' | 'INT' | 'HUP' | 'PIPE' | 'QUIT' | 'INT+TERM' | 'TERM2' | 'EXIT' | 'EXIT+TERM@X0';
/** the first signal of a column (EXIT / EXIT+TERM@X0 send none first; TERM2 sends TERM first) */
const FIRST: Record<Column, NodeJS.Signals[]> = {
  TERM: ['SIGTERM'],
  INT: ['SIGINT'],
  HUP: ['SIGHUP'],
  PIPE: ['SIGPIPE'],
  QUIT: ['SIGQUIT'],
  'INT+TERM': ['SIGINT', 'SIGTERM'],
  TERM2: ['SIGTERM'],
  EXIT: [],
  'EXIT+TERM@X0': [],
};
/** the exit code of each handler (`trap '<ignore all five>; exit <code>' <signal>`) */
const CODE = { INT: 130, TERM: 143, HUP: 129, PIPE: 141, QUIT: 131 } as const;
type Sig = 'INT' | 'TERM' | 'HUP' | 'PIPE' | 'QUIT';
const SIGS: readonly Sig[] = ['INT', 'TERM', 'HUP', 'PIPE', 'QUIT'];
const IGNORE_ALL = 'INT TERM HUP PIPE QUIT';
/** The R-SIG parts taken out, one at a time, in a copy of daily.sh committed in the sandbox clone only. */
type Mutant = { kind: 'pre-fix' } | { kind: 'no-trap'; signal: Sig } | { kind: 'not-ignored'; signal: Sig };

/** Where the driver stops (one gate name each). */
type Stop =
  | 'node-start' // A0: the first `node` (STARTED_AT)
  | 'owner-lock-made' // A2: inside run_lock_acquire (verify-run.sh's pause)
  | 'trap-int' // A3: the EXIT trap is set, the INT/TERM handlers are not yet
  | 'npm-install' // B0: the install command
  | 'fail-cut' // p0 of fail_sync: the `cut` of its line
  | 'echo-before' // p1: the planned line is set, not echoed
  | 'echo-after' // p2: echoed, not marked
  | 'fail-node' // p3 of fail_sync: the report is being written
  | 'daily-exit' // p3 / the end: daily_exit before its `trap ''`
  | 'mktemp' // C0: the sync line is decided, HAND is not made (the hook fails mktemp: nothing is left)
  | 'deadline-date' // C2: HAND is made, the child is not started
  | 'tmp' // C4: inside run_lock_set_pid before `go` (verify-run.sh's pause)
  | 'ack-loop' // C6: the parent waits for `ack` (the child holds it back)
  | 'run-ts' // C8: run.ts runs
  | 'drain'; // C9: run.ts was reaped, its group is being drained

type Sync = 'none' | { status: 'ok' } | { status: 'failed'; reason: RegExp };
type Expect = {
  sync: Sync;
  /** a signal that ended bash (no trap), or the exit code */
  exit: number | 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGPIPE' | 'SIGQUIT' | readonly number[];
  lock: 'free' | 'left' | 'not-checked';
  runTs: 'never' | 'stopped' | 'ended' | 'not-checked';
  member?: 'stopped';
  /** the release that did not remove the lock is said on stderr (I4) */
  stderr?: RegExp;
  /** the next run can take the lock that was left (a dead holder) */
  nextTakesOver?: boolean;
};
type Drive = {
  /** the gates passed in order; the signal of the column is sent at the last one */
  stops: Stop[];
  args?: string[];
  env?: Record<string, string>;
  setup?: Array<'dirty' | 'lock-changed' | 'no-run-lock' | 'held' | 'pre-fix'>;
  /** echo-before / echo-after stop on this line (a glob) */
  echo?: string;
  /** kill the waiting child (before `go`) at the `tmp` pause */
  killChild?: boolean;
  /** daily_on_exit is held at its `trap '' INT TERM`: before / after the builtin */
  x0?: 'before' | 'after';
  /** what is sent at x0 (default: a second TERM and an INT) */
  x0Signals?: NodeJS.Signals[];
  /** run a copy of daily.sh with a part of R-SIG taken out (the positive controls) */
  mutant?: Mutant;
};
type Cell =
  /** red: a positive control — the copy of daily.sh with a part taken out must NOT meet `expect` (the R-SIG outcome) */
  | { kind: 'drive'; drive: Drive; expect: Expect; disposition?: string; red?: boolean }
  | { kind: 'same'; as: string; why: string }
  | { kind: 'na'; why: string }
  | { kind: 'theory'; why: string; disposition: string };
type Row = { section: Section; point?: Point; column: Column; variant?: string; cell: Cell };

const OK: Sync = { status: 'ok' };
const failed = (reason: RegExp): Sync => ({ status: 'failed', reason });
const INTERRUPTED = (code: number): Sync => failed(new RegExp(`^interrupted exit=${code} before=[0-9a-f]{8}$`));
const DIRTY = failed(/^dirty-worktree before=/);
const MV = failed(/^handoff-failed stage=mv before=/);
const ACK = failed(/^handoff-failed stage=ack before=/);
const freed = (sync: Sync, exit: Expect['exit'], extra: Partial<Expect> = {}): Expect => ({ sync, exit, lock: 'free', runTs: 'not-checked', ...extra });
const drive = (d: Drive, e: Expect, disposition?: string): Cell => ({ kind: 'drive', drive: d, expect: e, disposition });
const red = (d: Drive, e: Expect, disposition: string): Cell => ({ kind: 'drive', drive: d, expect: e, disposition, red: true });
const NO_HANDLER = 'INT/TERM の handler がまだ無い（既定の死）。2 本目も既定で死ぬだけで、X0 は無い';

/** the emit points of a route (§2.2): p0 – p3, each with TERM and TERM2 (the same stop plus x0) */
const emitPoints = (
  section: Section,
  base: Omit<Drive, 'stops'> & { pre?: Stop[] },
  line: Sync,
  p0: Cell | ((col: 'TERM' | 'TERM2') => Cell),
  p3: Cell | ((col: 'TERM' | 'TERM2') => Cell),
  exitAfter: Expect['exit'] = 143,
  extra: Partial<Expect> = {}
): Row[] => {
  const pre = base.pre ?? [];
  const { pre: _pre, ...rest } = base;
  const rows: Row[] = [];
  for (const column of ['TERM', 'TERM2'] as const) {
    const x0 = column === 'TERM2' ? { x0: 'before' as const } : {};
    rows.push({ section, point: 'p0', column, cell: typeof p0 === 'function' ? p0(column) : p0 });
    rows.push({ section, point: 'p1', column, cell: drive({ ...rest, ...x0, stops: [...pre, 'echo-before'] }, freed(line, exitAfter, extra)) });
    rows.push({ section, point: 'p2', column, cell: drive({ ...rest, ...x0, stops: [...pre, 'echo-after'] }, freed(line, exitAfter, extra)) });
    rows.push({ section, point: 'p3', column, cell: typeof p3 === 'function' ? p3(column) : p3 });
  }
  return rows;
};

const TRAP_TABLE: Row[] = [
  // A0 起動・引数・BEFORE: 既定の死、何も持たない
  { section: 'A0', column: 'TERM', cell: drive({ stops: ['node-start'] }, { sync: 'none', exit: 'SIGTERM', lock: 'free', runTs: 'never' }) },
  { section: 'A0', column: 'TERM2', cell: { kind: 'na', why: NO_HANDLER } },
  { section: 'A0', column: 'EXIT', cell: { kind: 'na', why: '引数の誤り・rev-parse の失敗の exit 2 は trap とロックの前（行もロックも無い）' } },
  // A1 run-lock.sh の source
  { section: 'A1', column: 'TERM', cell: { kind: 'same', as: 'A0 × TERM', why: 'trap の前の既定の死でロックも無い。source の中に止める口は無い（状態は A0 と同じ）' } },
  { section: 'A1', column: 'TERM2', cell: { kind: 'na', why: NO_HANDLER } },
  { section: 'A1', column: 'EXIT', cell: drive({ stops: [], setup: ['no-run-lock'] }, { sync: failed(/^run-lock: scripts\/uat\/run-lock\.sh not found before=/), exit: 2, lock: 'free', runTs: 'never' }) },
  // A2 run_lock_acquire の中（取得済み、trap の前）
  {
    section: 'A2',
    column: 'TERM',
    cell: drive(
      { stops: ['owner-lock-made'] },
      { sync: 'none', exit: 'SIGTERM', lock: 'left', runTs: 'never' },
      '△(d) → PR1d（取得から trap までの割込み。ロックは死んだ $$ の取りかけで残る。直さない）'
    ),
  },
  { section: 'A2', column: 'TERM2', cell: { kind: 'na', why: NO_HANDLER } },
  { section: 'A2', column: 'EXIT', cell: drive({ stops: [], setup: ['held'] }, { sync: failed(/^run-locked: /), exit: 2, lock: 'not-checked', runTs: 'never' }) },
  // A3 EXIT trap は張った・INT/TERM はまだ既定
  {
    section: 'A3',
    column: 'TERM',
    cell: drive(
      { stops: ['trap-int'] },
      // bash runs the EXIT trap on a fatal signal too (termsig_handler -> run_exit_trap): the lock is released
      { sync: 'none', exit: 'SIGTERM', lock: 'free', runTs: 'never' },
      '✓（PM の表の訂正: bash 3.2 は INT・TERM・HUP・PIPE の既定の死の前に EXIT trap を走らせ release する。△(d) は A2 だけ）'
    ),
  },
  { section: 'A3', column: 'TERM2', cell: { kind: 'na', why: NO_HANDLER } },
  { section: 'A3', column: 'EXIT', cell: { kind: 'na', why: '205–207 の間に終わる命令は無い' } },
  // B0 同期中（npm install）
  { section: 'B0', column: 'TERM', cell: drive({ stops: ['npm-install'], setup: ['lock-changed'] }, freed('none', 143, { runTs: 'never' })) },
  { section: 'B0', column: 'INT', cell: drive({ stops: ['npm-install'], setup: ['lock-changed'] }, freed('none', 130, { runTs: 'never' })) },
  { section: 'B0', column: 'TERM2', cell: drive({ stops: ['npm-install'], setup: ['lock-changed'], x0: 'before' }, freed('none', 143, { runTs: 'never' }), '△(c) 閉じた（同期前の 2 本目でも release される）') },
  { section: 'B0', column: 'EXIT', cell: { kind: 'na', why: 'B0 の終わりは C0（成功）か B0f（fail_sync）' } },
  // B0f 同期の中の fail_sync（dirty-worktree）
  ...emitPoints(
    'B0f',
    { setup: ['dirty'], echo: 'AGENT_HEALTH_SYNC status=failed reason=dirty-worktree*' },
    DIRTY,
    (column) => drive({ setup: ['dirty'], stops: ['fail-cut'], ...(column === 'TERM2' ? { x0: 'before' as const } : {}) }, freed('none', 143)),
    (column) => drive({ setup: ['dirty'], stops: ['fail-node'], ...(column === 'TERM2' ? { x0: 'before' as const } : {}) }, freed(DIRTY, 143)),
    143,
    { runTs: 'never' }
  ),
  { section: 'B0f', column: 'EXIT', cell: drive({ stops: [], setup: ['dirty'] }, freed(DIRTY, 2, { runTs: 'never' })) },
  { section: 'B0f', column: 'EXIT+TERM@X0', cell: drive({ stops: [], setup: ['dirty'], x0: 'before' }, freed(DIRTY, 2, { runTs: 'never' }), '△(c) 閉じた') },
  // C0 同期の境（OK 確定、HAND の前）
  { section: 'C0', column: 'TERM', cell: drive({ stops: ['mktemp'] }, freed(INTERRUPTED(143), 143, { runTs: 'never' })) },
  { section: 'C0', column: 'INT', cell: drive({ stops: ['mktemp'] }, freed(INTERRUPTED(130), 130, { runTs: 'never' })) },
  { section: 'C0', column: 'TERM2', cell: drive({ stops: ['mktemp'], x0: 'before' }, freed(INTERRUPTED(143), 143, { runTs: 'never' }), '✗(a) 閉じた') },
  { section: 'C0', column: 'EXIT', cell: { kind: 'na', why: 'C0 は 1 行の代入。終わりは C1（--sync-only）か C2 以降' } },
  // C1 --sync-only の emit
  ...emitPoints(
    'C1',
    { args: ['--sync-only'], echo: 'AGENT_HEALTH_SYNC status=ok*' },
    OK,
    { kind: 'same', as: 'C0 × TERM', why: 'p0（予定の代入の前）は OK 有・予定 空で C0 と同じ状態。`[ "$SYNC_ONLY" -eq 1 ]` の間に止める口は無い' },
    (column) => drive({ args: ['--sync-only'], stops: ['daily-exit'], ...(column === 'TERM2' ? { x0: 'before' as const } : {}) }, freed(OK, 143)),
    143,
    { runTs: 'never' }
  ),
  { section: 'C1', column: 'EXIT', cell: drive({ stops: [], args: ['--sync-only'] }, freed(OK, 0, { runTs: 'never' })) },
  { section: 'C1', column: 'EXIT+TERM@X0', cell: drive({ stops: [], args: ['--sync-only'], x0: 'before' }, freed(OK, 0, { runTs: 'never' }), '△(c) 閉じた') },
  // C2 HAND・GO/ACK・DEADLINE
  { section: 'C2', column: 'TERM', cell: drive({ stops: ['deadline-date'] }, freed(INTERRUPTED(143), 143, { runTs: 'never' })) },
  { section: 'C2', column: 'TERM2', cell: drive({ stops: ['deadline-date'], x0: 'before' }, freed(INTERRUPTED(143), 143, { runTs: 'never' }), '✗(a) 閉じた') },
  { section: 'C2', column: 'EXIT', cell: drive({ stops: [], env: { CM_T_MKTEMP_FAIL: '1' } }, freed(failed(/^handoff-failed stage=arg before=/), 2, { runTs: 'never' })) },
  { section: 'C2', column: 'EXIT+TERM@X0', cell: drive({ stops: [], env: { CM_T_MKTEMP_FAIL: '1' }, x0: 'before' }, freed(failed(/^handoff-failed stage=arg before=/), 2, { runTs: 'never' }), '△(c) 閉じた') },
  // C3 fork → CHILD=$! の前
  {
    section: 'C3',
    column: 'TERM',
    cell: {
      kind: 'theory',
      why: '`&` と `CHILD=$!` の間に命令は無い。X1 は子を知らないが、HAND が消えるので子は `go` を作れず自分で 75 で退く',
      disposition: '△(e) 記録のみ（害が小さい。この PR で直さない）',
    },
  },
  {
    section: 'C3',
    column: 'TERM',
    variant: 'グループへ',
    cell: {
      kind: 'theory',
      why: 'fork 直後の子が継いだ EXIT trap は daily_on_exit の BASH_SUBSHELL の guard で戻る（子は `( exec … ) &` で fork の窓でも BASH_SUBSHELL=1）。窓は駆動できないので構造の走査で見る',
      disposition: '?(f) 閉じた（構造の走査）',
    },
  },
  { section: 'C3', column: 'TERM2', cell: { kind: 'same', as: 'C3 × TERM', why: 'C3 の 1 本目は駆動できない。2 本目は X0 の規則（handler の最初の無視）で閉じる' } },
  { section: 'C3', column: 'EXIT', cell: { kind: 'na', why: 'C3 は fork の 1 文' } },
  // C4 run_lock_set_pid（go の前）
  { section: 'C4', column: 'TERM', cell: drive({ stops: ['tmp'] }, freed(INTERRUPTED(143), 143, { runTs: 'never' })) },
  { section: 'C4', column: 'INT', cell: drive({ stops: ['tmp'] }, freed(INTERRUPTED(130), 130, { runTs: 'never' })) },
  { section: 'C4', column: 'INT+TERM', cell: drive({ stops: ['tmp'] }, freed(failed(/^interrupted exit=(130|143) before=[0-9a-f]{8}$/), [130, 143], { runTs: 'never' })) },
  { section: 'C4', column: 'TERM2', cell: drive({ stops: ['tmp'], x0: 'before' }, freed(INTERRUPTED(143), 143, { runTs: 'never' }), '✗(a) 閉じた（①の駆動）') },
  { section: 'C4', column: 'EXIT', cell: { kind: 'na', why: 'C4 の終わりは C5（失敗）か C6（go の後）' } },
  // C5 daily_handoff_fail（handoff-publish=EIO → stage=mv）
  ...emitPoints(
    'C5',
    { env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' }, echo: 'AGENT_HEALTH_SYNC status=failed reason=handoff-failed stage=mv*' },
    MV,
    (column) => drive({ env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' }, stops: ['fail-cut'], ...(column === 'TERM2' ? { x0: 'before' as const } : {}) }, freed(INTERRUPTED(143), 143)),
    (column) => drive({ env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' }, stops: ['fail-node'], ...(column === 'TERM2' ? { x0: 'before' as const } : {}) }, freed(MV, 143)),
    143,
    { runTs: 'never' }
  ),
  { section: 'C5', column: 'EXIT', cell: drive({ stops: [], env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' } }, freed(MV, 2, { runTs: 'never' })) },
  {
    section: 'C5',
    column: 'EXIT',
    variant: 'token',
    cell: drive(
      { stops: [], env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-token=EIO release-owner=EIO' } },
      { sync: failed(/^handoff-failed stage=token before=/), exit: 2, lock: 'left', runTs: 'never', stderr: /daily\.sh: the run lock was not released \(/ }
    ),
  },
  { section: 'C5', column: 'EXIT', variant: 'signal', cell: drive({ stops: [], env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-signal=EIO' } }, freed(failed(/^handoff-failed stage=signal before=/), 2, { runTs: 'never' })) },
  { section: 'C5', column: 'EXIT+TERM@X0', cell: drive({ stops: [], env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-publish=EIO' }, x0: 'before' }, freed(MV, 2, { runTs: 'never' }), '△(c) 閉じた') },
  // C6 ACK 待ち
  { section: 'C6', column: 'TERM', cell: drive({ stops: ['ack-loop'] }, freed(INTERRUPTED(143), 143, { runTs: 'never' })) },
  { section: 'C6', column: 'TERM2', cell: drive({ stops: ['ack-loop'], x0: 'before' }, freed(INTERRUPTED(143), 143, { runTs: 'never' }), '✗(a)(b) 閉じた（子は X1 が止める）') },
  { section: 'C6', column: 'EXIT', cell: { kind: 'na', why: 'C6 の終わりは C7（ack あり）か C8（ack なし）' } },
  // C7 ack ありの ok の emit（run.ts 実行中）
  ...emitPoints(
    'C7',
    { env: { FAKE_WAIT: '1' }, echo: 'AGENT_HEALTH_SYNC status=ok*' },
    OK,
    { kind: 'same', as: 'C6 × TERM', why: 'p0（ack を見てから emit の前）は予定 空で C6 と同じ状態（行は interrupted 1 本）。`[ -e "$ACK" ]` の間に止める口は無い' },
    { kind: 'same', as: 'C8 × TERM', why: 'p3（印の後）の次は `wait "$CHILD"`（C8）' },
    143,
    { runTs: 'stopped' }
  ),
  { section: 'C7', column: 'EXIT', cell: { kind: 'na', why: 'C7 の終わりは C8' } },
  // C8 wait CHILD（run.ts 実行中）
  { section: 'C8', column: 'TERM', cell: drive({ stops: ['run-ts'], env: { FAKE_WAIT: '1' } }, freed(OK, 143, { runTs: 'stopped' })) },
  { section: 'C8', column: 'INT', cell: drive({ stops: ['run-ts'], env: { FAKE_WAIT: '1' } }, freed(OK, 130, { runTs: 'stopped' })) },
  { section: 'C8', column: 'TERM2', cell: drive({ stops: ['run-ts'], env: { FAKE_WAIT: '1' }, x0: 'before' }, freed(OK, 143, { runTs: 'stopped' }), '✗(b) 閉じた') },
  {
    section: 'C8',
    column: 'TERM',
    variant: '284–285',
    cell: { kind: 'same', as: 'C9 × TERM', why: '`wait` と CHILD_REAPED=1 の間に命令は無い。回収済み・G 未 drain の状態は C9 と同じ規則（EXIT が drain する）で閉じる' },
  },
  { section: 'C8', column: 'EXIT', cell: { kind: 'na', why: 'C8 の終わりは C9' } },
  // C9 lock_drain_group（残りが TERM を無視する）
  {
    section: 'C9',
    column: 'TERM',
    cell: drive({ stops: ['drain'], env: { FAKE_LEAVE_DEAF: '1', FAKE_EXIT: '4' } }, freed(OK, 143, { runTs: 'ended', member: 'stopped' }), '△(g) 閉じた（EXIT が drain をやり直す）'),
  },
  {
    section: 'C9',
    column: 'TERM2',
    cell: drive({ stops: ['drain'], env: { FAKE_LEAVE_DEAF: '1', FAKE_EXIT: '4' }, x0: 'before' }, freed(OK, 143, { runTs: 'ended', member: 'stopped' }), '△(g)(c) 閉じた'),
  },
  { section: 'C9', column: 'EXIT', cell: drive({ stops: [], env: { FAKE_LEAVE_DEAF: '1', FAKE_EXIT: '4' } }, freed(OK, 4, { runTs: 'ended', member: 'stopped' })) },
  // C10 75 かつ ack 無し → fail_sync stage=ack
  ...emitPoints(
    'C10',
    { env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-ack=EIO' }, echo: 'AGENT_HEALTH_SYNC status=failed reason=handoff-failed stage=ack*' },
    ACK,
    (column) => drive({ env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-ack=EIO' }, stops: ['fail-cut'], ...(column === 'TERM2' ? { x0: 'before' as const } : {}) }, freed(INTERRUPTED(143), 143, { runTs: 'never' })),
    (column) => drive({ env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-ack=EIO' }, stops: ['fail-node'], ...(column === 'TERM2' ? { x0: 'before' as const } : {}) }, freed(ACK, 143, { runTs: 'never' })),
    143,
    { runTs: 'never' }
  ),
  { section: 'C10', column: 'EXIT', cell: drive({ stops: [], env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-ack=EIO' } }, freed(ACK, 2, { runTs: 'never' })) },
  { section: 'C10', column: 'EXIT+TERM@X0', cell: drive({ stops: [], env: { CM_VERIFY_TEST_OBS_FAULT: 'handoff-ack=EIO' }, x0: 'before' }, freed(ACK, 2, { runTs: 'never' }), '△(c) 閉じた') },
  // C11 ack 無し・75 以外（子が外から殺された）→ ok の emit
  ...emitPoints(
    'C11',
    { pre: ['tmp'], killChild: true, echo: 'AGENT_HEALTH_SYNC status=ok*' },
    OK,
    { kind: 'same', as: 'C0 × TERM', why: 'p0 は OK 有・予定 空・子は回収済みで、行の規則は C0 と同じ（interrupted 1 本）。`[ "$SYNC_LINE_PRINTED" != 1 ]` の間に止める口は無い' },
    { kind: 'same', as: 'C12 × TERM', why: 'p3（印の後）の次は daily_exit（C12）' },
    143,
    { runTs: 'never' }
  ),
  { section: 'C11', column: 'EXIT', cell: drive({ stops: ['tmp'], killChild: true }, freed(OK, 137, { runTs: 'never' })) },
  // C12 exit "$CODE"
  { section: 'C12', column: 'TERM', cell: drive({ stops: ['daily-exit'] }, freed(OK, 143, { runTs: 'ended' })) },
  { section: 'C12', column: 'TERM2', cell: drive({ stops: ['daily-exit'], x0: 'before' }, freed(OK, 143, { runTs: 'ended' })) },
  { section: 'C12', column: 'EXIT', cell: drive({ stops: [], env: { FAKE_EXIT: '0' } }, freed(OK, 0, { runTs: 'ended' })) },
  { section: 'C12', column: 'EXIT', variant: 'run.ts の終了コード', cell: drive({ stops: [], env: { FAKE_EXIT: '3' } }, freed(OK, 3, { runTs: 'ended' })) },
  { section: 'C12', column: 'EXIT+TERM@X0', cell: drive({ stops: [], x0: 'before' }, freed(OK, 0, { runTs: 'ended' }), '△(c) 閉じた') },
  // X0 EXIT の入口
  {
    section: 'X0',
    column: 'TERM2',
    variant: 'builtin の前・直す前の形（陽性対照）',
    cell: red(
      { stops: ['tmp'], x0: 'before', setup: ['pre-fix'] },
      freed(INTERRUPTED(143), 143, { runTs: 'never' }),
      '直す前の赤の記録: ✗(a)（b4b7d1b38 の形では X0 の 2 本目で EXIT 本体が途中で終わる）'
    ),
  },
  { section: 'X0', column: 'TERM2', variant: 'builtin の前・直した形', cell: drive({ stops: ['tmp'], x0: 'before' }, freed(INTERRUPTED(143), 143, { runTs: 'never' }), '✗(a) 閉じた') },
  { section: 'X0', column: 'TERM2', variant: 'builtin の後', cell: drive({ stops: ['tmp'], x0: 'after' }, freed(INTERRUPTED(143), 143, { runTs: 'never' })) },
  { section: 'X0', column: 'EXIT+TERM@X0', cell: drive({ stops: [], x0: 'before', env: { FAKE_EXIT: '0' } }, freed(OK, 0, { runTs: 'ended' }), '△(c) 閉じた') },
  // X0 の 2 本目が HUP・PIPE・QUIT（PM 追補 2: 無視の対象に HUP PIPE、QUIT にも同じ形の trap）
  ...(['SIGHUP', 'SIGPIPE', 'SIGQUIT'] as const).map(
    (signal): Row => ({
      section: 'X0',
      column: 'EXIT+TERM@X0',
      variant: `X0 に ${signal.slice(3)}`,
      cell: drive({ stops: [], x0: 'before', x0Signals: [signal], env: { FAKE_EXIT: '0' } }, freed(OK, 0, { runTs: 'ended' }), '追補 2 で閉じた'),
    })
  ),
  // X1 EXIT 本体
  { section: 'X1', column: 'TERM', cell: drive({ stops: [], x0: 'after', env: { FAKE_EXIT: '0' } }, freed(OK, 0, { runTs: 'ended' })) },
  { section: 'X1', column: 'TERM2', cell: drive({ stops: ['run-ts'], env: { FAKE_WAIT: '1' }, x0: 'after' }, freed(OK, 143, { runTs: 'stopped' })) },
];

// HUP・PIPE・QUIT（PM 追補 2）: the sections a stop reaches, each signal once. HUP and PIPE end bash through the EXIT
// trap even with no handler (A3); QUIT does not, so it has a handler of the same shape as INT/TERM from 205–207 on.
const OTHER = ['HUP', 'PIPE', 'QUIT'] as const;
const sigDeath = (signal: (typeof OTHER)[number]): Expect['exit'] => `SIG${signal}` as Expect['exit'];
const OTHER_SIGNAL_ROWS: Row[] = OTHER.flatMap((signal): Row[] => {
  const code = CODE[signal];
  const rows: Array<[Section, Drive, Expect, string?]> = [
    ['A0', { stops: ['node-start'] }, { sync: 'none', exit: sigDeath(signal), lock: 'free', runTs: 'never' }],
    ['A2', { stops: ['owner-lock-made'] }, { sync: 'none', exit: sigDeath(signal), lock: 'left', runTs: 'never' }, '△(d) → PR1d'],
    [
      'A3',
      { stops: ['trap-int'] },
      signal === 'QUIT'
        ? { sync: 'none', exit: 'SIGQUIT', lock: 'left', runTs: 'never', nextTakesOver: true }
        : { sync: 'none', exit: sigDeath(signal), lock: 'free', runTs: 'never' },
      signal === 'QUIT' ? 'QUIT の既定の死は EXIT trap を走らせない。handler の前の A3 は △(d) と同じ（死んだ $$ の記録）→ PR1d' : '✓（EXIT trap が走る）',
    ],
    ['B0', { stops: ['npm-install'], setup: ['lock-changed'] }, freed('none', code, { runTs: 'never' })],
    ['C0', { stops: ['mktemp'] }, freed(INTERRUPTED(code), code, { runTs: 'never' })],
    ['C2', { stops: ['deadline-date'] }, freed(INTERRUPTED(code), code, { runTs: 'never' })],
    ['C6', { stops: ['ack-loop'] }, freed(INTERRUPTED(code), code, { runTs: 'never' })],
    ['C8', { stops: ['run-ts'], env: { FAKE_WAIT: '1' } }, freed(OK, code, { runTs: 'stopped' })],
    ['C9', { stops: ['drain'], env: { FAKE_LEAVE_DEAF: '1', FAKE_EXIT: '4' } }, freed(OK, code, { runTs: 'ended', member: 'stopped' })],
    ['C12', { stops: ['daily-exit'] }, freed(OK, code, { runTs: 'ended' })],
  ];
  const same: Section[] = ['A1', 'B0f', 'C1', 'C3', 'C5', 'C7', 'C10', 'C11'];
  return [
    ...rows.map(([section, d, e, disposition]): Row => ({ section, column: signal, cell: drive(d, e, disposition) })),
    ...same.map(
      (section): Row => ({
        section,
        column: signal,
        cell:
          section === 'A1'
            ? { kind: 'same', as: `A0 × ${signal}`, why: 'trap の前の既定の死でロックも無い（A0 と同じ状態）' }
            : section === 'C3'
              ? { kind: 'same', as: 'C3 × TERM', why: 'fork の窓は駆動できない。handler は TERM と同じ形' }
              : { kind: 'same', as: `${section}p1 × TERM`, why: `${signal} の handler は TERM と同じ形（無視を張ってから exit ${code}）。emit の点の規則は TERM の行と同じ` },
      })
    ),
  ];
});
TRAP_TABLE.push(...OTHER_SIGNAL_ROWS);

// R-SIG (pm-rule-4288-signal-traps.md): 既定の死／明示の trap × 5 信号 × 1 本目・2 本目, all at C4 (the sync is done, the
// child waits for `go`, the lock is T0: one interrupted line and the release are what an end must give).
//   明示 × 1 本目: the signal's own handler;  明示 × 2 本目: TERM first, the signal at X0 (daily_on_exit held);
//   既定の死 × 1 本目: a copy without that signal's trap (the red of what R-SIG closes);
//   既定の死 × 2 本目: a copy where that signal is not in the ignores (handlers, daily_exit, daily_on_exit).
const R_SIG_ROWS: Row[] = SIGS.flatMap((signal): Row[] => [
  {
    section: 'C4',
    column: signal,
    variant: 'R-SIG 明示の trap・1 本目',
    cell:
      signal === 'INT' || signal === 'TERM'
        ? { kind: 'same', as: `C4 × ${signal}`, why: 'C4 の INT/TERM の行そのもの（明示の trap の 1 本目）' }
        : drive({ stops: ['tmp'] }, freed(INTERRUPTED(CODE[signal]), CODE[signal], { runTs: 'never' })),
  },
  {
    section: 'X0',
    column: 'TERM2',
    variant: `R-SIG 明示の trap・2 本目 ${signal}`,
    cell: drive({ stops: ['tmp'], x0: 'before', x0Signals: [`SIG${signal}` as NodeJS.Signals] }, freed(INTERRUPTED(143), 143, { runTs: 'never' })),
  },
  {
    section: 'C4',
    column: signal,
    variant: 'R-SIG 既定の死・1 本目（陽性対照: trap を消した写し）',
    cell: red(
      { stops: ['tmp'], mutant: { kind: 'no-trap', signal } },
      freed(INTERRUPTED(CODE[signal]), CODE[signal], { runTs: 'never' }),
      '直す前の赤の記録（その信号の明示の trap が無いと既定の死: 終了コード・行が R-SIG の形にならない）'
    ),
  },
  {
    section: 'X0',
    column: 'TERM2',
    variant: `R-SIG 既定の死・2 本目 ${signal}（陽性対照: 無視の対象から外した写し）`,
    cell: red(
      { stops: ['tmp'], x0: 'before', x0Signals: [`SIG${signal}` as NodeJS.Signals], mutant: { kind: 'not-ignored', signal } },
      freed(INTERRUPTED(143), 143, { runTs: 'never' }),
      '直す前の赤の記録（2 本目が handler の途中で EXIT 本体を終わらせる）'
    ),
  },
]);
TRAP_TABLE.push(...R_SIG_ROWS);

const rowName = (row: Row): string => `${row.section}${row.point ?? ''} × ${row.column}${row.variant ? `（${row.variant}）` : ''}`;

// ================================================================ the table itself

describe('#4288 PR1b, the trap table of daily.sh (pm-trap-table-4288-pr1b.md)', () => {
  it('names every one of the 21 sections, and each row once', () => {
    expect(new Set(TRAP_TABLE.map((row) => row.section))).toEqual(new Set(SECTIONS));
    const names = TRAP_TABLE.map(rowName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has the INT/TERM, TERM2, HUP, PIPE and QUIT columns for every section (driven, same as another, or why not)', () => {
    for (const section of SECTIONS) {
      const columns = new Set(TRAP_TABLE.filter((row) => row.section === section).map((row) => row.column));
      if (section === 'X0' || section === 'X1') continue;
      expect([section, columns.has('TERM')]).toEqual([section, true]);
      expect([section, columns.has('TERM2')]).toEqual([section, true]);
      for (const other of OTHER) expect([section, other, columns.has(other)]).toEqual([section, other, true]);
    }
  });

  it.each(TRAP_TABLE.filter((row) => row.cell.kind !== 'drive').map((row) => [rowName(row), row] as const))('%s: not driven, and says why', (_name, row) => {
    const cell = row.cell;
    if (cell.kind === 'same') {
      const target = TRAP_TABLE.find((other) => rowName(other) === cell.as);
      expect(target, cell.as).toBeDefined();
      // a cell is the same as a driven one, or as one that says why it cannot be driven (C3)
      expect(['drive', 'theory']).toContain(target!.cell.kind);
    }
    if (cell.kind !== 'drive') expect(cell.why.length).toBeGreaterThan(10);
  });
});

// ================================================================ daily.sh, driven

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** BASH_ENV of the runs: the stops, defined in daily.sh only ($0), and the child's hold of `ack`. */
const HOOK = String.raw`
cm_t_hit() { # <stop> -> 0 after waiting at it, once per run; 1 when it is not a stop of this run
  case ",$CM_T_STOP," in *",$1,"*) ;; *) return 1 ;; esac
  builtin test -e "$CM_T_GATE/$1.reached" && return 1
  : > "$CM_T_GATE/$1.reached"
  while ! builtin test -e "$CM_T_GATE/$1.go"; do command sleep 0.05; done
  return 0
}
# $0 is not the script's name yet while BASH_ENV is read: which script runs is asked at each call
cm_t_daily() { case "$0" in */daily.sh) return 0 ;; esac; return 1; }
node() {
  if cm_t_daily; then
    if [ -z "\${STARTED_AT:-}" ]; then cm_t_hit node-start; fi
    if [ "\${FUNCNAME[1]:-}" = fail_sync ]; then cm_t_hit fail-node; fi
  fi
  command node "$@"
}
cut() {
  if cm_t_daily && [ "\${FUNCNAME[1]:-}" = fail_sync ]; then cm_t_hit fail-cut; fi
  command cut "$@"
}
echo() {
  if cm_t_daily && [ "\${FUNCNAME[1]:-}" = emit_sync_line ] && [ -n "\${CM_T_ECHO:-}" ]; then
    case "$1" in
      $CM_T_ECHO)
        cm_t_hit echo-before
        builtin echo "$@"
        cm_t_hit echo-after
        return 0 ;;
    esac
  fi
  builtin echo "$@"
}
mktemp() {
  if cm_t_daily; then
    case "$*" in
      *cm-daily-hand*)
        if cm_t_hit mktemp; then return 1; fi
        if [ "\${CM_T_MKTEMP_FAIL:-}" = 1 ]; then return 1; fi ;;
    esac
  fi
  command mktemp "$@"
}
date() {
  if cm_t_daily && [ "$*" = +%s ] && [ -n "\${HAND:-}" ] && [ -z "\${CHILD:-}" ] && [ -z "\${DEADLINE:-}" ] && [ "\${FUNCNAME[1]:-main}" = main ]; then cm_t_hit deadline-date; fi
  command date "$@"
}
sleep() {
  if cm_t_daily; then
    if [ "\${FUNCNAME[1]:-main}" = main ] && [ -n "\${CHILD:-}" ]; then cm_t_hit ack-loop; fi
    if [ "\${FUNCNAME[1]:-}" = lock_drain_group ] && [ "\${FUNCNAME[2]:-}" = main ]; then cm_t_hit drain; fi
  fi
  command sleep "$@"
}
trap() {
  local s
  if cm_t_daily; then
    if [ "$#" -eq 2 ] && [ "$2" = INT ] && [ -n "$1" ]; then cm_t_hit trap-int; fi
    if [ -z "$1" ] && [ "\${FUNCNAME[1]:-}" = daily_exit ]; then cm_t_hit daily-exit; fi
    if [ -z "$1" ] && [ "\${FUNCNAME[1]:-}" = daily_on_exit ] && [ "\${CM_T_X0:-}" = before ]; then cm_t_hit x0; fi
  fi
  builtin trap "$@"
  s=$?
  if cm_t_daily && [ -z "$1" ] && [ "\${FUNCNAME[1]:-}" = daily_on_exit ] && [ "\${CM_T_X0:-}" = after ]; then cm_t_hit x0; fi
  return $s
}
# not a stop: marks that the main shell is past its AGENT_HEALTH_SYNC line and its mark, at its wait for the child (C8)
wait() {
  if cm_t_daily && [ "\${FUNCNAME[1]:-main}" = main ] && [ -n "\${CHILD:-}" ] && [ "$*" = "$CHILD" ]; then : > "$CM_T_GATE/main-wait.reached"; fi
  builtin wait "$@"
}
mkdir() {
  if [ "$0" = cm-daily-child ] && [ -n "\${CM_T_HOLD_ACK:-}" ]; then
    case "$*" in */ack) cm_t_hit ack-hold ;; esac
  fi
  command mkdir "$@"
}
`.replace(/\\\$/g, '$');

const mutate = (text: string, m: Mutant): string => {
  let out = text;
  const must = (from: string | RegExp, to: string): void => {
    const next = out.replace(from, to);
    if (next === out) throw new Error(`mutant ${JSON.stringify(m)}: ${String(from)} did not apply`);
    out = next;
  };
  if (m.kind === 'pre-fix') {
    // what daily.sh was at b4b7d1b38 in these places: INT/TERM end in a bare exit, no other handler, daily_exit and
    // daily_on_exit ignore INT/TERM only, daily_exit does not ignore
    for (const signal of SIGS) {
      const line = `trap 'trap "" ${IGNORE_ALL}; exit ${CODE[signal]}' ${signal}\n`;
      must(line, signal === 'INT' || signal === 'TERM' ? `trap 'exit ${CODE[signal]}' ${signal}\n` : '');
    }
    must(`daily_exit() { # <code>\n  trap '' ${IGNORE_ALL}\n`, 'daily_exit() { # <code>\n');
    must(`  trap '' ${IGNORE_ALL}\n  local rc`, `  trap '' INT TERM\n  local rc`);
  } else if (m.kind === 'no-trap') {
    must(`trap 'trap "" ${IGNORE_ALL}; exit ${CODE[m.signal]}' ${m.signal}\n`, '');
  } else {
    const without = IGNORE_ALL.split(' ').filter((name) => name !== m.signal).join(' ');
    out = out.split(`trap "" ${IGNORE_ALL};`).join(`trap "" ${without};`).split(`trap '' ${IGNORE_ALL}`).join(`trap '' ${without}`);
    if (out.includes(IGNORE_ALL)) throw new Error(`mutant ${JSON.stringify(m)}: not every ignore was changed`);
  }
  return out;
};

/** the bash the rows run under (bash 3.2 on macOS, bash 5 on CI's Linux): in the name of the describe, so a report says it */
const BASH_UNDER_TEST = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }).stdout.trim();

describe(`#4288 PR1b, daily.sh driven at every cell of the trap table (bash ${BASH_UNDER_TEST})`, () => {
  let root: string;
  let work: string;
  let gate: string;
  let lockDir: string;
  let fakeOut: string;
  let tmp: string;
  const spawned: ChildProcess[] = [];

  const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const git = (cwd: string, ...args: string[]): string => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).stdout.trim();
  const dailyEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('CM_VERIFY_TEST_') && key !== 'BASH_ENV')) as NodeJS.ProcessEnv;
    return {
      ...env,
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      TMPDIR: tmp,
      CM_RUN_LOCK_DIR: lockDir,
      CM_RUN_LOCK_TOKEN: '',
      FAKE_OUT: fakeOut,
      BASH_ENV: path.join(root, 'hook.sh'),
      CM_T_GATE: gate,
      ...extra,
    };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-daily-trap-4288-'));
    lockDir = path.join(root, 'run.lock');
    fakeOut = path.join(root, 'fake-out');
    gate = path.join(root, 'gate');
    tmp = path.join(root, 'tmp');
    fs.mkdirSync(gate);
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(root, 'hook.sh'), HOOK);
    fs.writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = develop\n');
    // a fake `npx tsx scripts/agent-health/run.ts …`: says who it is, then ends, waits, or leaves a member in its group
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(
      path.join(root, 'bin', 'npx'),
      `#!/bin/bash
{ echo "TOKEN=$CM_RUN_LOCK_TOKEN"; echo "PID=$$"; } > "$FAKE_OUT"
if [ -n "\${FAKE_LEAVE_DEAF:-}" ]; then ( trap '' TERM; exec sleep 3600 ) >/dev/null 2>&1 </dev/null & echo $! > "$FAKE_OUT.member"; exit \${FAKE_EXIT:-0}; fi
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
    for (const file of [DAILY, 'scripts/uat/run-lock.sh', 'scripts/lib/machine-lock.sh', '.claude/skills/cmate-verify/scripts/verify-run.sh']) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.copyFileSync(path.join(REPO, file), path.join(seed, file));
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
    for (const child of spawned.splice(0)) child.kill('SIGKILL');
    const member = `${fakeOut}.member`;
    if (fs.existsSync(member)) {
      try {
        process.kill(Number(fs.readFileSync(member, 'utf8').trim()), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    removeTempDir(root);
  });

  const until = async (file: string, ms = 30_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!fs.existsSync(file) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fs.existsSync(file), `${path.basename(file)} was not reached`).toBe(true);
  };
  const waitingChild = (parent: number): number[] =>
    spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .stdout.split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[1] === String(parent) && cols.slice(2).join(' ').includes('cm-daily-child'))
      .map((cols) => Number(cols[0]));

  const prepare = (d: Drive): void => {
    for (const step of d.setup ?? []) {
      if (step === 'dirty') fs.writeFileSync(path.join(work, 'package-lock.json'), '{"lockfileVersion":3,"dirty":true}\n');
      if (step === 'lock-changed') {
        const seed = path.join(root, 'seed');
        fs.writeFileSync(path.join(seed, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
        git(seed, 'commit', '-q', '-am', 'lock changed');
        git(seed, 'push', '-q', 'origin', 'HEAD:develop');
      }
      if (step === 'no-run-lock') fs.rmSync(path.join(work, 'scripts/uat/run-lock.sh'));
    }
    const mutant: Mutant | undefined = d.setup?.includes('pre-fix') ? { kind: 'pre-fix' } : d.mutant;
    if (mutant) {
      const file = path.join(work, DAILY);
      fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8'), mutant));
      git(work, 'commit', '-q', '-am', 'mutant (test only)');
    }
  };
  const hold = async (): Promise<void> => {
    // another run holds the lock: a shell that took it with its own pid and stays
    const holder = spawn('bash', ['-c', `. scripts/uat/run-lock.sh && run_lock_acquire hold $$ hold-$$-1 && : > '${path.join(gate, 'held')}' && exec sleep 3600`], {
      cwd: work,
      env: { ...dailyEnv({}), BASH_ENV: '' },
      stdio: 'ignore',
    });
    spawned.push(holder);
    await until(path.join(gate, 'held'));
  };

  type Outcome = { code: number | null; signal: NodeJS.Signals | null; lines: string[]; stderr: string; childPid: number };
  const run = async (column: Column, d: Drive): Promise<Outcome> => {
    prepare(d);
    if (d.setup?.includes('held')) await hold();
    const env: Record<string, string> = { ...(d.env ?? {}) };
    const hookStops: string[] = d.stops.filter((stop) => stop !== 'tmp' && stop !== 'owner-lock-made' && stop !== 'npm-install' && stop !== 'run-ts');
    if (d.x0) hookStops.push('x0');
    if (d.stops.includes('ack-loop')) {
      hookStops.push('ack-hold');
      env.CM_T_HOLD_ACK = '1';
    }
    env.CM_T_STOP = hookStops.join(',');
    if (d.x0) env.CM_T_X0 = d.x0;
    if (d.echo) env.CM_T_ECHO = d.echo;
    const pauses = d.stops.filter((stop) => stop === 'tmp' || stop === 'owner-lock-made');
    if (pauses.length > 0) {
      env.CM_VERIFY_TEST_HANDOFF = pauses.map((stop) => `pause:${stop}`).join(',');
      env.CM_VERIFY_TEST_HANDOFF_DIR = gate;
    }
    if (d.stops.includes('npm-install')) env.AGENT_HEALTH_NPM_INSTALL_CMD = `: > '${gate}/npm-install.reached'; while [ ! -e '${gate}/npm-install.go' ]; do sleep 0.05; done`;
    if (d.stops.includes('run-ts')) env.FAKE_WAIT = '1';

    const child = spawn('bash', [path.join(work, DAILY), '--out', path.join(root, 'report.json'), ...(d.args ?? [])], { cwd: root, env: dailyEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    spawned.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const signals = FIRST[column];

    for (const [index, stop] of d.stops.entries()) {
      const last = index === d.stops.length - 1;
      if (stop === 'run-ts') {
        const end = Date.now() + 30_000;
        while (!(fs.existsSync(fakeOut) && fs.readFileSync(fakeOut, 'utf8').includes('PID=')) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(fs.existsSync(fakeOut)).toBe(true);
        // run.ts can be running before the main shell has made its line (its ack loop polls): C8 is the `wait`
        await until(path.join(gate, 'main-wait.reached'));
      } else {
        await until(path.join(gate, `${stop}.reached`));
      }
      if (stop === 'tmp' && d.killChild) {
        const waiting = waitingChild(child.pid!);
        expect(waiting).toHaveLength(1);
        process.kill(waiting[0], 'SIGKILL');
      }
      if (last) for (const signal of signals) process.kill(child.pid!, signal);
      if (stop !== 'run-ts') fs.writeFileSync(path.join(gate, `${stop}.go`), '');
      // the child's `ack` stays held: it must not exec run.ts while the EXIT trap has not stopped it yet
    }
    if (d.x0) {
      await until(path.join(gate, 'x0.reached'), 60_000);
      // the second TERM, and an INT, while daily_on_exit is held at its `trap '' INT TERM`
      for (const signal of d.x0Signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])) process.kill(child.pid!, signal);
      await new Promise((resolve) => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(gate, 'x0.go'), '');
    }
    const { code, signal } = await exited;
    return { code, signal, lines: stdout.split('\n').filter((line) => line.startsWith('AGENT_HEALTH_SYNC ')), stderr, childPid: child.pid! };
  };

  const handChildren = (): string[] =>
    spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((line) => line.includes('cm-daily-child') && line.includes(`${tmp}/cm-daily-hand`));
  const check = async (outcome: Outcome, e: Expect, d: Drive, row: Row): Promise<void> => {
    const { lines } = outcome;
    // I1: the AGENT_HEALTH_SYNC lines
    if (e.sync === 'none') {
      expect(lines, outcome.stderr).toEqual([]);
    } else {
      expect(lines.length, outcome.stderr).toBeGreaterThanOrEqual(1);
      // the same line twice only when the signal landed between its echo and its mark (p2)
      expect(lines.length).toBeLessThanOrEqual(row.point === 'p2' ? 2 : 1);
      expect(new Set(lines).size).toBe(1);
      if (e.sync.status === 'ok') expect(lines[0]).toMatch(/^AGENT_HEALTH_SYNC status=ok before=[0-9a-f]{8} after=[0-9a-f]{8} npm_install=(skipped|done)$/);
      else expect(lines[0].replace(/^AGENT_HEALTH_SYNC status=failed reason=/, '')).toMatch(e.sync.reason);
    }
    // the end
    if (typeof e.exit === 'string') expect([outcome.code, outcome.signal]).toEqual([null, e.exit]);
    else if (typeof e.exit === 'number') expect([outcome.code, outcome.signal]).toEqual([e.exit, null]);
    else expect(e.exit).toContain(outcome.code);
    // I4: the lock
    if (e.lock === 'free') expect(fs.existsSync(lockDir), outcome.stderr).toBe(false);
    if (e.lock === 'left') expect(fs.existsSync(lockDir)).toBe(true);
    if (e.stderr) expect(outcome.stderr).toMatch(e.stderr);
    // I3: run.ts and what it left
    if (e.runTs === 'never') expect(fs.existsSync(fakeOut)).toBe(false);
    if (e.runTs === 'stopped' || e.runTs === 'ended') {
      const pid = Number(/PID=(\d+)/.exec(fs.readFileSync(fakeOut, 'utf8'))![1]);
      expect(isAlive(pid)).toBe(false);
    }
    if (e.member === 'stopped') {
      const member = Number(fs.readFileSync(`${fakeOut}.member`, 'utf8').trim());
      expect(member).toBeGreaterThan(1);
      expect(isAlive(member)).toBe(false);
    }
    // no child of this run is left waiting for `go` (it withdrew or was stopped): its arguments name the HAND under tmp
    const end = Date.now() + 5_000;
    while (handChildren().length > 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handChildren()).toEqual([]);
    // no handover directory is left behind (pm-return: cm-daily-hand.* that stayed in $TMPDIR)
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith('cm-daily-hand.'))).toEqual(d.setup?.includes('pre-fix') || d.mutant ? expect.any(Array) : []);
  };

  it.each(TRAP_TABLE.filter((row) => row.cell.kind === 'drive').map((row) => [rowName(row), row] as const))(
    '%s',
    async (_name, row) => {
      const cell = row.cell as Extract<Cell, { kind: 'drive' }>;
      const outcome = await run(row.column, cell.drive);
      // the record of each run (bash version, lines, exit, lock), for the closing table of the contract
      if (process.env.CM_T_REPORT) {
        const version = spawnSync('bash', ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }).stdout.trim();
        fs.appendFileSync(
          process.env.CM_T_REPORT,
          `${JSON.stringify({ row: rowName(row), bash: version, red: !!cell.red, lines: outcome.lines, code: outcome.code, signal: outcome.signal, lockLeft: fs.existsSync(lockDir) })}\n`
        );
      }
      if (cell.red) {
        let failure: unknown;
        try {
          await check(outcome, cell.expect, cell.drive, row);
        } catch (error) {
          failure = error;
        }
        expect(failure, 'the copy with a part of the fix taken out met the fixed outcome: the control does not show the defect').toBeDefined();
        return;
      }
      await check(outcome, cell.expect, cell.drive, row);
      if (cell.expect.nextTakesOver) {
        // what is left is a dead holder's: the next run takes it over (the record names a pid that is gone)
        const next = spawnSync('bash', [path.join(work, DAILY), '--out', path.join(root, 'report2.json'), '--sync-only'], {
          cwd: root,
          env: dailyEnv({ CM_T_STOP: '' }),
          encoding: 'utf8',
          timeout: 90_000,
        });
        expect(next.status, next.stderr).toBe(0);
        expect(fs.existsSync(lockDir)).toBe(false);
      }
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  // ---------------------------------------------------------------- the structure (案 A の 1〜3, I2)

  const text = (): string[] => fs.readFileSync(path.join(REPO, DAILY), 'utf8').split('\n');
  /** the line without what is in single quotes (another shell's text) and without its comment */
  const code = (line: string): string => line.replace(/'[^']*'/g, "''").replace(/(^|\s)#.*$/, '');

  it('R-SIG structure: each of INT, TERM, HUP, PIPE and QUIT has a handler whose first command ignores all five, then exit 128+n', () => {
    const lines = text();
    for (const signal of SIGS) {
      const set = lines.filter((line) => new RegExp(`^trap '.*' ${signal}$`).test(line));
      expect(set).toEqual([`trap 'trap "" ${IGNORE_ALL}; exit ${CODE[signal]}' ${signal}`]);
    }
    // the EXIT handler ignores the five as its first statement after the main-shell guard
    const at = lines.findIndex((line) => line.startsWith('daily_on_exit() {'));
    expect(lines.slice(at + 1, at + 4).filter((line) => !line.trim().startsWith('#'))[1]).toBe(`  trap '' ${IGNORE_ALL}`);
    // every `trap ''` / `trap ""` that ignores names all five
    const ignores = lines
      .filter((line) => !line.trim().startsWith('#'))
      .flatMap((line) => [...line.matchAll(/\btrap (?:""|'') ([A-Z ]+?)\s*(?:;|$)/g)].map((match) => match[1]));
    expect(ignores.length).toBe(SIGS.length + 2);
    for (const names of ignores) expect(names).toBe(IGNORE_ALL);
  });

  it('X0 structure: after the trap is set, no end is a bare `exit` (every end goes through daily_exit, which ignores the five first)', () => {
    const lines = text();
    const start = lines.findIndex((line) => line.startsWith('daily_exit() {'));
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start, start + 4)).toEqual(['daily_exit() { # <code>', `  trap '' ${IGNORE_ALL}`, '  exit "$1"', '}']);
    const trapAt = lines.findIndex((line) => line.startsWith("trap 'daily_on_exit"));
    expect(trapAt).toBeGreaterThan(start);
    // from the end of daily_exit on (fail_sync and the handover run after the trap is set)
    const bare = lines
      .map((line, index) => ({ index: index + 1, line: code(line) }))
      .slice(start + 4)
      // `exit` in the position of a command (not `exit=` in a line's text)
      .filter(({ line }) => /(^|[;&|{(]|\b(then|else|do))\s*exit(\s|;|$)/.test(line));
    expect(bare).toEqual([]);
  });

  it('?(f) structure: daily_on_exit runs in the main shell only, and the child is a subshell that execs', () => {
    const lines = text();
    const at = lines.findIndex((line) => line.startsWith('daily_on_exit() {'));
    expect(lines[at + 1]).toBe('  [ "${BASH_SUBSHELL:-0}" -eq 0 ] || return 0');
    expect(lines).toContain(`trap 'daily_on_exit "$?"' EXIT`);
    const fork = lines.findIndex((line) => line.includes('cm-daily-child'));
    expect(lines[fork - 1]).toMatch(/^\( exec \/bin\/bash -c '/);
    expect(lines.slice(fork - 1, fork + 3).join('\n')).toMatch(/\) <\/dev\/null &\nCHILD=\$!/);
  });

  it('△(g) structure: the EXIT trap drains a group that was not drained, and says a release that did not remove the lock', () => {
    const lines = text();
    const at = lines.findIndex((line) => line.startsWith('daily_on_exit() {'));
    const end = lines.findIndex((line, index) => index > at && line === '}');
    const body = lines.slice(at, end).join('\n');
    expect(body).toMatch(/if \[ -n "\$RUN_LOCK_G" \] && \[ "\$GROUP_DRAINED" != 1 \]; then\n.*\n {4}lock_drain_group "\$RUN_LOCK_G" 0/);
    expect(body).toMatch(/case "\$RUN_LOCK_RESULT" in\n {4}released \| none\) ;;\n {4}\*\) echo "daily\.sh: the run lock was not released .*>&2 ;;/);
  });

  it('I1 structure (pr1b-6 scan): daily.sh prints an AGENT_HEALTH_SYNC line only inside emit_sync_line', () => {
    const lines = text();
    const start = lines.findIndex((line) => line.startsWith('emit_sync_line()'));
    expect(start).toBeGreaterThan(0);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    const printing = (line: string): boolean => /^\s*(echo|printf)\b/.test(line) && (/AGENT_HEALTH_SYNC/.test(line) || /\$\{?SYNC_(PLANNED|OK)_LINE/.test(line));
    const outside = lines.map((line, index) => ({ line, index })).filter(({ line, index }) => printing(line) && (index < start || index > end));
    expect(outside).toEqual([]);
    expect(lines.slice(start, end).filter(printing)).toHaveLength(1);
  });
});
