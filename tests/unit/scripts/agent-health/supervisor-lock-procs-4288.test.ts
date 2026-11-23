/**
 * Issue #4288 PR1c, AC-3 (design S1): supervisor.lock held by separate processes — two supervisors
 * (`product_lock_acquire`) and a guard (`product_lock_recover_only`) on one temporary PRODUCT_BASE.
 *
 * Every participant is its own /bin/bash process that sources lib.sh. Each logs to one shared events file
 * (O_APPEND, one line per write): `acq <token>` right after its acquisition returned, `rel <token>` right
 * before its release, and the test writes `dead` after it killed a holder (SIGKILL) and saw it exit. The
 * logged interval of a token lies inside the real one (the owner is published before `acq`, removed after
 * `rel`), so two logged intervals that overlap are two real holders. Compared here:
 *  - the intervals of two tokens never overlap (and a holder's `mkdir <base>/inside` never fails);
 *  - a live holder's owner is never replaced or moved aside while it holds (it reads its own token back);
 *  - no owner is ever published under the guard's token (every token the guard sees was acquired by a
 *    supervisor, and none carries the guard's pid).
 *
 * Rows: the plain contention; a holder killed by SIGKILL, recovered by the guard or by the next waiter;
 * a recoverer stopped after its judgement and before its re-read (the guard at `recover-only-judged`, an
 * acquirer at `recover-judged`), while the next supervisor takes the lock and a third one lists the
 * moved-aside records — closed by #4559's re-read (B1, c94e0be99): it must not move the live lock and no
 * second holder may appear. The window of #4559 that stays (a stop after the re-read and before the
 * rename) is out of the scope of this file; it is closed by another PR.
 *
 * Nothing waits on wall time for its order: the stops and resumes are the pause seams of the lock section
 * (CM_VERIFY_TEST_HANDOFF=pause:<stage>, `<stage>.reached` / `<stage>.go` files), the ticket deadline is
 * passed with a fake clock (lock_now_ms / lock_pid_start_ms shifted by 200 s in the one process that has
 * to see it, standing for a stall past the deadline + 60 s), and every budget is 0 (one round). The polls
 * below only wait for a file or an exit, bounded by a count.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LIB_SH = path.join(REPO_ROOT, 'scripts/agent-health/product/lib.sh');
const HOST = os.hostname();
const TIMEOUT = 60_000;

/** One participant. $1 role (sup | guard), $2 label, $3 rounds. */
const CHILD_SH = `set -u
role=$1; label=$2; n=\${3:-1}
out="$OUT/$label"
PRODUCT_BASE=$BASE
. "$LIB"
ev() { printf '%s %s\\n' "$label" "$*" >> "$OUT/events"; }
tok() { sed -n 's/^token=//p' "$BASE/supervisor.lock/owner" 2>/dev/null | head -n 1; }
# The fake clock: "now" later by CLOCK_OFFSET_MS, and every other process started that much earlier.
if [ "\${CLOCK_OFFSET_MS:-0}" != 0 ]; then
  eval "orig_$(declare -f lock_now_ms)"
  lock_now_ms() { echo $(( $(orig_lock_now_ms) + CLOCK_OFFSET_MS )); }
  eval "orig_$(declare -f lock_pid_start_ms)"
  lock_pid_start_ms() { local s rc; s=$(orig_lock_pid_start_ms "$@"); rc=$?; [ -z "$s" ] || echo $(( s - CLOCK_OFFSET_MS )); return $rc; }
fi
# Scheduling only: stop right after the listing of the moved-aside records returned.
if [ "\${PAUSE_AFTER_SETTLE:-0}" = 1 ]; then
  eval "orig_$(declare -f lock_settle_gone)"
  lock_settle_gone() { local r; orig_lock_settle_gone "$@"; r=$?; lock_test_pause after-settle; return $r; }
fi
ev "pid $$"
i=0
while [ $i -lt "$n" ]; do
  i=$((i + 1))
  if [ "$role" = guard ]; then
    product_lock_recover_only
    ev "guard $PRODUCT_LOCK_RESULT $(tok)"
    continue
  fi
  product_lock_acquire "$label"; rc=$?
  if [ "$rc" != 0 ]; then
    ev "refused $PRODUCT_LOCK_RESULT \${PRODUCT_LOCK_KIND:-}"
    : > "$out.failed"
    continue
  fi
  t=$LOCK_HELD_TOKEN
  ev "acq $t"
  mkdir "$BASE/inside" 2>/dev/null || ev "overlap $t"
  [ "$(tok)" = "$t" ] || ev "foreign $t [$(tok)]"
  echo "$t" > "$out.acquired"
  if [ "\${HOLD:-0}" = 1 ]; then
    while [ ! -e "$out.release" ]; do sleep 0.05; done
    [ "$(tok)" = "$t" ] || ev "foreign $t [$(tok)]"
  fi
  rmdir "$BASE/inside" 2>/dev/null || ev "inside-gone $t"
  ev "rel $t"
  product_lock_release
  [ "$PRODUCT_LOCK_RESULT" = released ] || ev "release-$PRODUCT_LOCK_RESULT $t"
done
: > "$out.done"
`;

interface Run {
  root: string;
  base: string;
  out: string;
  child: string;
}
interface Proc {
  label: string;
  proc: ChildProcess;
  exited: Promise<number | null>;
}

const roots: string[] = [];
const procs: Proc[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.proc.exitCode === null && p.proc.signalCode === null) p.proc.kill('SIGKILL');
    await p.exited;
  }
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function setup(): Run {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sup-procs-'));
  roots.push(root);
  const run = { root, base: path.join(root, 'base'), out: path.join(root, 'out'), child: path.join(root, 'child.sh') };
  fs.mkdirSync(run.base);
  fs.mkdirSync(run.out);
  fs.writeFileSync(run.child, CHILD_SH);
  return run;
}

function start(run: Run, role: 'sup' | 'guard', label: string, rounds: number, env: Record<string, string> = {}): Proc {
  fs.mkdirSync(path.join(run.out, label), { recursive: true });
  const proc = spawn('/bin/bash', [run.child, role, label, String(rounds)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: run.root,
      TMPDIR: os.tmpdir(),
      LC_ALL: 'C',
      BASE: run.base,
      OUT: run.out,
      LIB: LIB_SH,
      CM_PRODUCT_LOCK_GUARD_BUDGET_SEC: '0',
      CM_VERIFY_TEST_HANDOFF_DIR: path.join(run.out, label),
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  proc.stderr?.resume();
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  const p = { label, proc, exited };
  procs.push(p);
  return p;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

/** Waits for the first of the files; bounded by a count of polls (a hang is a failure, not a pass). */
async function waitFile(...files: string[]): Promise<string> {
  for (let i = 0; i < 800; i++) {
    const hit = files.find((f) => fs.existsSync(f));
    if (hit) return hit;
    await tick();
  }
  throw new Error(`none of ${files.join(', ')} appeared`);
}

async function finish(p: Proc): Promise<void> {
  const code = await p.exited;
  expect(code, `${p.label} exit`).toBe(0);
}

function events(run: Run): string[] {
  const f = path.join(run.out, 'events');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

const ownerToken = (run: Run): string => {
  const f = path.join(run.base, 'supervisor.lock', 'owner');
  if (!fs.existsSync(f)) return '';
  return (/^token=(.*)$/m.exec(fs.readFileSync(f, 'utf8')) ?? ['', ''])[1];
};
const goneDirs = (run: Run): string[] => fs.readdirSync(run.base).filter((n) => n.startsWith('supervisor.lock.gone-'));

/** A pid that has exited (and been reaped): the holder of a lock it left behind. */
function deadPid(): number {
  return Number(spawnSync('/bin/bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
}

function writeDeadHolder(run: Run): void {
  fs.mkdirSync(path.join(run.base, 'supervisor.lock'));
  fs.writeFileSync(path.join(run.base, 'supervisor.lock', 'owner'), `pid=${deadPid()}\nhost=${HOST}\ntoken=dead-token\nv=1\nlabel=dead\n`);
}

interface Verdict {
  /** pairs of tokens whose logged intervals overlap */
  overlaps: string[];
  /** lines a participant wrote because the invariant broke under it (overlap, foreign, inside-gone, release-*) */
  broken: string[];
  /** tokens the guard saw at the lock that no supervisor acquired, or that carry the guard's pid */
  guardTokens: string[];
  acquired: Record<string, string[]>;
}

/** The intervals of the events file, replayed in the order they were written. */
function judge(lines: string[]): Verdict {
  const pids: Record<string, string> = {};
  const acquired: Record<string, string[]> = {};
  const all = new Set<string>();
  for (const l of lines) {
    const [label, what, t] = l.split(' ');
    if (what === 'pid') pids[label] = t;
    if (what === 'acq') {
      (acquired[label] ??= []).push(t);
      all.add(t);
    }
  }
  const v: Verdict = { overlaps: [], broken: [], guardTokens: [], acquired };
  let holder: { label: string; token: string } | null = null;
  for (const l of lines) {
    const [label, what, ...rest] = l.split(' ');
    if (what === 'acq') {
      if (holder) v.overlaps.push(`${holder.label}:${holder.token} + ${label}:${rest[0]}`);
      holder = { label, token: rest[0] };
    } else if (what === 'rel' || what === 'dead') {
      if (holder?.label === label) holder = null;
    } else if (what === 'guard') {
      const seen = rest[1] ?? '';
      if (seen && (!all.has(seen) || seen.startsWith(`${pids[label]}-`))) v.guardTokens.push(seen);
    } else if (/^(overlap|foreign|inside-gone|release-)/.test(what)) {
      v.broken.push(l);
    }
  }
  return v;
}

function expectNoBreak(v: Verdict): void {
  expect({ overlaps: v.overlaps, broken: v.broken, guardTokens: v.guardTokens }).toEqual({ overlaps: [], broken: [], guardTokens: [] });
}

/** After every participant ended: no lock, nothing moved aside, no ticket left that is not done. */
function expectSettled(run: Run): void {
  expect(fs.existsSync(path.join(run.base, 'supervisor.lock')), 'no <lock> left').toBe(false);
  expect(goneDirs(run)).toEqual([]);
  const q = path.join(run.base, 'supervisor.queue');
  const live = fs.existsSync(q)
    ? fs
        .readdirSync(q)
        .filter((n) => /^\d{12}$/.test(n))
        .filter((n) => !fs.readFileSync(path.join(q, n), 'utf8').includes('"done":true'))
    : [];
  expect(live, 'no live ticket left').toEqual([]);
}

/** Kills a holder that is holding (SIGKILL: its EXIT trap never runs) and marks the end of its interval. */
async function killHolder(run: Run, h: Proc): Promise<void> {
  h.proc.kill('SIGKILL');
  await h.exited;
  fs.appendFileSync(path.join(run.out, 'events'), `${h.label} dead\n`);
  // the holder's own mark of being inside, left by its death (not the lock)
  fs.rmSync(path.join(run.base, 'inside'), { recursive: true, force: true });
}

describe('Issue #4288 PR1c AC-3: supervisor.lock held by separate processes (two supervisors, one guard)', () => {
  it(
    'plain contention: the intervals of two tokens never overlap, no live owner is replaced, the guard publishes nothing',
    async () => {
      const run = setup();
      const ps = [start(run, 'sup', 'S1', 25), start(run, 'sup', 'S2', 25), start(run, 'guard', 'G', 25)];
      for (const p of ps) await finish(p);
      const v = judge(events(run));
      expectNoBreak(v);
      expect((v.acquired.S1?.length ?? 0) + (v.acquired.S2?.length ?? 0), 'someone took the lock').toBeGreaterThan(0);
      expectSettled(run);
    },
    TIMEOUT,
  );

  it(
    'a holder killed by SIGKILL is recovered by the guard (removed), and the next supervisor takes the lock',
    async () => {
      const run = setup();
      const h = start(run, 'sup', 'H', 1, { HOLD: '1' });
      await waitFile(path.join(run.out, 'H.acquired'));
      const th = fs.readFileSync(path.join(run.out, 'H.acquired'), 'utf8').trim();
      expect(ownerToken(run)).toBe(th);
      await killHolder(run, h);

      const g = start(run, 'guard', 'G', 1);
      await finish(g);
      expect(events(run).filter((l) => l.startsWith('G guard'))).toEqual(['G guard removed ']);
      expect(fs.existsSync(path.join(run.base, 'supervisor.lock'))).toBe(false);

      const s = start(run, 'sup', 'S', 1);
      await finish(s);
      const v = judge(events(run));
      expectNoBreak(v);
      expect(v.acquired.S).toHaveLength(1);
      expectSettled(run);
    },
    TIMEOUT,
  );

  it(
    'a holder killed by SIGKILL is recovered by the next waiter, which takes the lock (one holder at a time)',
    async () => {
      const run = setup();
      const h = start(run, 'sup', 'H', 1, { HOLD: '1' });
      await waitFile(path.join(run.out, 'H.acquired'));
      // while H lives, the waiter is refused and H's owner stays
      const w = start(run, 'sup', 'W', 1);
      await finish(w);
      expect(fs.existsSync(path.join(run.out, 'W.failed'))).toBe(true);
      expect(ownerToken(run)).toBe(fs.readFileSync(path.join(run.out, 'H.acquired'), 'utf8').trim());
      await killHolder(run, h);

      const s = start(run, 'sup', 'S', 1);
      await finish(s);
      const v = judge(events(run));
      expectNoBreak(v);
      expect(v.acquired.S).toHaveLength(1);
      expect(v.acquired.W).toBeUndefined();
      expectSettled(run);
    },
    TIMEOUT,
  );

  // The recoverer R judged the dead holder D gone and stops before it reads the owner again. A (its clock
  // 200 s ahead: past R's ticket deadline + 60 s) retires R's ticket, recovers D and takes the lock. B lists
  // the moved-aside records (none) and stops before its mkdir. R resumes: before #4559's re-read it moved
  // A's live lock aside (`recover-moved`), B's mkdir got in, and A and B both held. Now R reads A's record,
  // leaves it, and B is refused. (#4559's window after the re-read and before the rename: out of scope.)
  const STALLED = [
    { who: 'the guard', role: 'guard' as const, judged: 'recover-only-judged' },
    { who: 'an acquirer', role: 'sup' as const, judged: 'recover-judged' },
  ];
  for (const s of STALLED) {
    it(
      `a recoverer stopped after its judgement and before its re-read (${s.who}, ${s.judged}) does not move the live lock: no second holder`,
      async () => {
        const run = setup();
        writeDeadHolder(run);
        const r = start(run, s.role, 'R', 1, { CM_VERIFY_TEST_HANDOFF: `pause:${s.judged},pause:recover-moved` });
        const rdir = path.join(run.out, 'R');
        await waitFile(path.join(rdir, `${s.judged}.reached`));

        const a = start(run, 'sup', 'A', 1, { HOLD: '1', CLOCK_OFFSET_MS: '200000' });
        await waitFile(path.join(run.out, 'A.acquired'), path.join(run.out, 'A.done'));
        const ta = fs.readFileSync(path.join(run.out, 'A.acquired'), 'utf8').trim();
        expect(ownerToken(run)).toBe(ta);

        const b = start(run, 'sup', 'B', 1, { HOLD: '1', PAUSE_AFTER_SETTLE: '1', CM_VERIFY_TEST_HANDOFF: 'pause:after-settle' });
        const bdir = path.join(run.out, 'B');
        await waitFile(path.join(bdir, 'after-settle.reached'));

        fs.writeFileSync(path.join(rdir, `${s.judged}.go`), '');
        const where = await waitFile(path.join(rdir, 'recover-moved.reached'), path.join(run.out, 'R.done'));
        const moved = where.endsWith('recover-moved.reached');
        const afterR = { owner: ownerToken(run), gone: goneDirs(run).length };

        fs.writeFileSync(path.join(bdir, 'after-settle.go'), '');
        await waitFile(path.join(run.out, 'B.acquired'), path.join(run.out, 'B.done'));
        const bTook = fs.existsSync(path.join(run.out, 'B.acquired'));
        if (moved) fs.writeFileSync(path.join(rdir, 'recover-moved.go'), '');
        await finish(r);

        fs.writeFileSync(path.join(run.out, 'A.release'), '');
        if (bTook) fs.writeFileSync(path.join(run.out, 'B.release'), '');
        await finish(a);
        await finish(b);

        const v = judge(events(run));
        expect({ moved, afterR, bTook }).toEqual({ moved: false, afterR: { owner: ta, gone: 0 }, bTook: false });
        expectNoBreak(v);
        expect(v.acquired.R).toBeUndefined();
        if (s.role === 'guard') expect(events(run).filter((l) => l.startsWith('R guard'))).toEqual([`R guard kept ${ta}`]);
        expectSettled(run);
      },
      TIMEOUT,
    );
  }
});
