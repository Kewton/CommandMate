/**
 * Issue #4288 §2.8 — every observation the lock decisions read answers alive / gone / unknown, and
 * unknown never takes, deletes or releases (the PM's invariant, workspace pm-decision-4288-prereview).
 *
 *   1. The table (lock-observation-points-4288.ts) is the design document's table, row for row.
 *   2. The points the three implementations name are exactly the table's — collected from the source
 *      text — and every raw kill -0 / mkdir / mv / listing / owner read sits in an observer or in a
 *      listed exemption. A seeded new observation that bypasses the observers makes the scan fail
 *      (self-test).
 *   3. Every reader row (point × bash / TS / sync JS) gets an injected failure (EPERM / EACCES / EIO /
 *      a listing that failed) and must not take, delete or release — while the same state without the
 *      injection does the opposite (each row is its own control: the injection is what changes the
 *      verdict). Waits end at their budget and name what was unknown: point, path, errno.
 *   4. Positive controls: the fix taken out (the reader that reads a failed listing as "nothing there",
 *      the group check that reads only kill -0's success) takes or releases under the same failure.
 *
 * The writer rows (handoff-*) are injected in tests/unit/skills/cmate-verify/verify-run-holder-group-4288.test.ts.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OBSERVATION_POINTS, RAW_CALL_ALLOWANCES } from './lock-observation-points-4288';
import { scanObservationPoints, scanRawCalls, type Impl } from './lock-observation-scan-4288';
import {
  HOST,
  IMPLS,
  REPO,
  VERIFY_RUN,
  deadPid,
  goneEntries,
  isRoot,
  killStarted,
  lockOf,
  mutatedBash,
  mutatedSync,
  readOwnerToken,
  removeRoot,
  take,
  writeOwner,
  type TakeResult,
} from './lock-4288-harness';

const SOURCES: Record<Impl, string> = {
  bash: '.claude/skills/cmate-verify/scripts/verify-run.sh',
  ts: 'src/lib/verification/machine-lock.ts',
  sync: 'scripts/orchestrate/machine-lock-sync.mjs',
};
const DESIGN = path.join(REPO, 'docs/design/verify-lock-holder-group-4288.md');
const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-obs-4288-'));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

describe('the observation-point table (§2.8)', () => {
  it('is the design document\'s table, row for row (point and implementations)', () => {
    const doc = fs.readFileSync(DESIGN, 'utf8');
    const section = doc.slice(doc.indexOf('### 2.8'), doc.indexOf('## 3.'));
    const rows = [...section.matchAll(/^\| `([a-z-]+)` \| ([^|]+) \|/gm)].map((m) => ({
      point: m[1],
      impls: m[2].trim().split(/[・、,]\s*/).map((s) => ({ bash: 'bash', TS: 'ts', '同期 JS': 'sync' })[s.trim()] ?? s.trim()).sort(),
    }));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows).toEqual(OBSERVATION_POINTS.map((p) => ({ point: p.point, impls: [...p.impls].sort() })));
  });

  it.each(IMPLS)('%s: the points the code names are exactly the table\'s', (impl) => {
    const named = [...scanObservationPoints(impl, read(SOURCES[impl]))].sort();
    expect(named).toEqual(OBSERVATION_POINTS.filter((p) => p.impls.includes(impl)).map((p) => p.point).sort());
  });

  it.each(IMPLS)('%s: every raw kill -0 / mkdir / mv / listing / owner read is in an observer or listed with its reason', (impl) => {
    const found = Object.fromEntries(scanRawCalls(impl, read(SOURCES[impl])));
    const allowed = Object.fromEntries(RAW_CALL_ALLOWANCES.filter((a) => a.impl === impl).map((a) => [`${a.fn}|${a.primitive}`, a.count]));
    expect(found).toEqual(allowed);
  });

  describe('self-test: the scan is not vacuous', () => {
    it('a new raw kill -0 / readdirSync in a new function is found and is not in the list', () => {
      const bash = `${read(SOURCES.bash)}\nnew_probe() {\n  kill -0 "$1" 2>/dev/null || return 0\n  for g in "$LOCK_PATH".gone-*; do :; done\n}\n`;
      const found = scanRawCalls('bash', bash);
      expect(found.get('new_probe|kill -0')).toBe(1);
      expect(found.get('new_probe|glob .gone-*')).toBe(1);
      expect(RAW_CALL_ALLOWANCES.some((a) => a.fn === 'new_probe')).toBe(false);
      const ts = `${read(SOURCES.ts)}\nfunction newProbe(dir: string): boolean {\n  return readdirSync(dir).length === 0;\n}\n`;
      expect(scanRawCalls('ts', ts).get('newProbe|readdirSync')).toBe(1);
    });

    it('a second raw call in an exempted function changes its count', () => {
      const sync = read(SOURCES.sync).replace('function collectGarbage(queueDir, now) {', 'function collectGarbage(queueDir, now) {\n  fs.readdirSync(queueDir);');
      expect(scanRawCalls('sync', sync).get('collectGarbage|readdirSync')).toBe(2);
    });

    it('a new observation point is found, and one the table lacks fails the comparison', () => {
      const ts = read(SOURCES.ts).replace("obs.list('list-queue', queueDir);", "obs.list('list-queue-2', queueDir);");
      const named = scanObservationPoints('ts', ts);
      expect(named.has('list-queue-2')).toBe(true);
      expect(OBSERVATION_POINTS.some((p) => p.point === 'list-queue-2')).toBe(false);
      const bash = read(SOURCES.bash).replace('lock_obs_list list-queue "$la_queue"', 'lock_obs_list list-queue-x "$la_queue"');
      expect(scanObservationPoints('bash', bash).has('list-queue-x')).toBe(true);
    });
  });
});

/** A moved-aside lock: `<name>.lock.gone-<S>/owner`. */
const writeGone = (name: string, suffix: string, owner: Record<string, unknown>) => writeOwner(path.join(root, `${name}.lock.gone-${suffix}`), owner);

interface Scenario {
  /** errno injected */
  code: string;
  setup: (name: string) => void;
  /** The verdict with the injection: nothing taken, deleted or released. */
  injected: (r: TakeResult, name: string, impl: Impl) => void;
  /** The same state without the injection: the opposite happens (the injection is what kept it). */
  control: (r: TakeResult, name: string, impl: Impl) => void;
  /** The wait ends at its budget naming the unknown (point, path, errno). */
  reported?: boolean;
  between?: (name: string) => { fn: () => void; sh: string };
}

const deadOwner = (token: string, extra: Record<string, unknown> = {}) => ({ pid: deadPid(), host: HOST, token, acquiredAt: 0, ...extra });
const liveOwner = (token: string) => ({ pid: process.pid, host: HOST, token, acquiredAt: 0 });
const notTaken = (r: TakeResult, impl: Impl) => {
  expect(r.acquired, `${impl} took the lock`).toBe(false);
};

const SCENARIOS: Record<string, Scenario> = {
  pid: {
    code: 'EPERM',
    reported: true,
    setup: (name) => writeOwner(lockOf(root, name), deadOwner('dead')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(readOwnerToken(lockOf(root, name))).toBe('dead');
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  group: {
    code: 'EPERM',
    reported: true,
    setup: (name) => writeOwner(lockOf(root, name), deadOwner('dead-group', { pgid: deadPid() })),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(readOwnerToken(lockOf(root, name))).toBe('dead-group');
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  'list-queue': {
    code: 'EIO',
    reported: true,
    setup: () => {},
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(fs.existsSync(lockOf(root, name))).toBe(false);
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  'list-root': {
    code: 'EACCES',
    reported: true,
    setup: () => {},
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(fs.existsSync(lockOf(root, name))).toBe(false);
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  'gone-lstat': {
    code: 'EIO',
    reported: true,
    setup: (name) => writeGone(name, '111-1', deadOwner('dead-gone')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-111-1`]);
    },
    control: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([]);
    },
  },
  'gone-owner': {
    code: 'EACCES',
    reported: true,
    setup: (name) => writeGone(name, '111-1', deadOwner('dead-gone')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-111-1`]);
    },
    control: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([]);
    },
  },
  'lock-owner': {
    code: 'EACCES',
    reported: true,
    setup: (name) => writeOwner(lockOf(root, name), deadOwner('dead')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(readOwnerToken(lockOf(root, name))).toBe('dead');
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  'lock-list': {
    code: 'EIO',
    // A put-back that stopped after its mkdir (§2.7 A) whose record is gone: the empty <lock> is removed first.
    setup: (name) => {
      fs.mkdirSync(lockOf(root, name));
      writeGone(name, '111-1', deadOwner('dead-gone'));
    },
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(fs.existsSync(lockOf(root, name))).toBe(true);
    },
    control: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([]);
    },
  },
  'mkdir-lock': {
    code: 'EACCES',
    setup: () => {},
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(fs.existsSync(lockOf(root, name))).toBe(false);
      // TS / sync JS end the acquisition with the errno; bash waits out its budget and names it.
      const said = impl === 'bash' ? r.unknown : r.error;
      expect(said).toMatch(/point=mkdir-lock path=\S+ errno=EACCES/);
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  'rename-aside': {
    code: 'EIO',
    setup: (name) => writeOwner(lockOf(root, name), deadOwner('dead')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(readOwnerToken(lockOf(root, name))).toBe('dead');
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  'recover-owner': {
    code: 'EIO',
    setup: (name) => writeOwner(lockOf(root, name), deadOwner('dead')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      // Not known to be the record judged: put back, not deleted.
      expect(readOwnerToken(lockOf(root, name))).toBe('dead');
      expect(goneEntries(root, name)).toEqual([]);
    },
    control: (r) => expect(r.acquired).toBe(true),
  },
  'restore-mkdir': {
    code: 'EACCES',
    // A put-back that failed earlier: the moved-aside record is alive (§2.7 row 2).
    setup: (name) => writeGone(name, '222-1', liveOwner('live-T1')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(fs.existsSync(lockOf(root, name))).toBe(false);
      expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-222-1`]);
    },
    control: (r, name, impl) => {
      notTaken(r, impl);
      expect(readOwnerToken(lockOf(root, name))).toBe('live-T1');
      expect(goneEntries(root, name)).toEqual([]);
    },
  },
  'restore-rename': {
    code: 'EIO',
    setup: (name) => writeGone(name, '222-1', liveOwner('live-T1')),
    injected: (r, name, impl) => {
      notTaken(r, impl);
      expect(fs.existsSync(lockOf(root, name))).toBe(false);
      expect(readOwnerToken(path.join(root, `${name}.lock.gone-222-1`))).toBe('live-T1');
    },
    control: (r, name, impl) => {
      notTaken(r, impl);
      expect(readOwnerToken(lockOf(root, name))).toBe('live-T1');
    },
  },
  'reclaim-rename': {
    code: 'EIO',
    setup: (name) => writeGone(name, '111-1', deadOwner('dead-gone')),
    injected: (r, name) => {
      // The record is positively gone, so the lock may be taken — but the moved-aside one is not deleted.
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-111-1`]);
    },
    control: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([]);
    },
  },
  'reclaim-owner': {
    code: 'EIO',
    setup: (name) => writeGone(name, '111-1', deadOwner('dead-gone')),
    injected: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toHaveLength(1);
    },
    control: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([]);
    },
  },
  'release-owner': {
    code: 'EIO',
    setup: () => {},
    injected: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(r.release).toBe('kept');
      expect(fs.existsSync(lockOf(root, name))).toBe(true);
    },
    control: (r, name) => {
      expect(r.release).toBe('released');
      expect(fs.existsSync(lockOf(root, name))).toBe(false);
    },
  },
  'release-list': {
    code: 'EACCES',
    setup: () => {},
    // While held, someone moved this holder's lock aside (and its put-back failed): §2.7 row 7.
    between: (name) => {
      const from = lockOf(root, name);
      const to = path.join(root, `${name}.lock.gone-999-1`);
      return { fn: () => fs.renameSync(from, to), sh: `mv "${from}" "${to}"` };
    },
    injected: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-999-1`]);
    },
    control: (r, name) => {
      expect(r.acquired).toBe(true);
      expect(goneEntries(root, name)).toEqual([]);
    },
  },
};

const READER_ROWS = OBSERVATION_POINTS.filter((p) => !p.point.startsWith('handoff-')).flatMap((p) => p.impls.map((impl) => ({ point: p.point, impl, unknown: p.unknown })));

describe('every reader row: an injected failure is unknown, and unknown takes, deletes and releases nothing', () => {
  it('has a scenario for every reader point of the table', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...new Set(READER_ROWS.map((r) => r.point))].sort());
  });

  it.each(READER_ROWS)('$impl $point → $unknown', async ({ point, impl }) => {
    const s = SCENARIOS[point];
    const name = `obs-${point}`;
    s.setup(name);
    const injected = await take(impl, root, name, { fault: `${point}=${s.code}`, between: s.between?.(name) });
    s.injected(injected, name, impl);
    if (s.reported) {
      // fail-closed does not wedge: the wait ended at its budget, naming what it could not observe.
      expect(injected.unknown, `${impl} named the unknown`).toMatch(new RegExp(`^point=${point} path=\\S.* errno=${s.code}$`));
    }

    // The control: the same state, nothing injected.
    removeRoot(root);
    fs.mkdirSync(root);
    s.setup(name);
    s.control(await take(impl, root, name, { between: s.between?.(name) }), name, impl);
  }, 30000);
});

describe('real failures, not injected ones', () => {
  it.skipIf(isRoot).each(IMPLS)('%s: a lock root that can be written and searched but not listed (0333) is not read as "nothing moved aside"', async (impl) => {
    const name = 'obs-0333';
    fs.chmodSync(root, 0o333);
    const r = await take(impl, root, name);
    fs.chmodSync(root, 0o755);
    expect(r.acquired).toBe(false);
    expect(r.unknown).toMatch(/^point=list-root path=\S.* errno=EACCES$/);
    // Readable again: taken.
    expect((await take(impl, root, name)).acquired).toBe(true);
  }, 30000);
});

describe('positive controls: the fix taken out takes under the same failure', () => {
  it.skipIf(isRoot)('bash: a reader that globs the root (an unexpanded pattern read as "none") takes past a live moved-aside record when the root cannot be listed', async () => {
    const name = 'obs-glob';
    const legacy = mutatedBash(root, (s) =>
      s.replace(/lock_gone_candidates\(\) \{ # <point> <lock-path>\n/, `lock_gone_candidates() { # <point> <lock-path>
  LGC_LIST=""
  for lgc_g in "$2".gone-*; do [ -d "$lgc_g" ] && LGC_LIST="$LGC_LIST$lgc_g
"; done
  return 0
`),
    );
    writeGone(name, '222-1', liveOwner('live-T1'));
    fs.chmodSync(root, 0o333);
    const legacyResult = await take('bash', root, name, { bashScript: legacy, keep: true });
    const fixed = await (async () => {
      fs.rmSync(lockOf(root, name), { recursive: true, force: true });
      return take('bash', root, name, { keep: true });
    })();
    fs.chmodSync(root, 0o755);
    expect(legacyResult.acquired, 'the glob form took the lock over a live record it could not see').toBe(true);
    expect(fixed.acquired).toBe(false);
  }, 30000);

  it.skipIf(isRoot)('sync JS: a reader that reads a failed root listing as empty takes past a live moved-aside record', async () => {
    const name = 'obs-empty';
    const legacy = await mutatedSync(root, (s) =>
      s.replace("if (listed.state === 'unknown') return { unknown: { point, path: ctx.root, code: listed.code } };", 'if (listed.state === \'unknown\') return { list: [] };'),
    );
    writeGone(name, '222-1', liveOwner('live-T1'));
    fs.chmodSync(root, 0o333);
    const legacyResult = await take('sync', root, name, { syncModule: legacy, keep: true });
    const fixed = await (async () => {
      fs.rmSync(lockOf(root, name), { recursive: true, force: true });
      return take('sync', root, name, { keep: true });
    })();
    fs.chmodSync(root, 0o755);
    expect(legacyResult.acquired).toBe(true);
    expect(fixed.acquired).toBe(false);
  }, 30000);

  it('bash (5th review P2): the same EPERM to the old and the new group check — only the formula differs', () => {
    // The old check (4th version): "someone is there" only when kill -0 succeeds, so any failure read
    // as empty. Both read lock_kill0_raw, where the EPERM is injected, so the comparison is the formula.
    const script = `
eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$1")"
old_group_is_empty() { lock_kill0_raw group "-$1"; [ "$LKR_RC" -ne 0 ]; }
g=$2
if old_group_is_empty "$g"; then echo "old=empty"; else echo "old=occupied"; fi
if lock_group_is_empty "$g"; then echo "new=empty"; else echo "new=occupied"; fi
`;
    const dead = deadPid();
    const run = (fault: string) =>
      spawnSync('bash', ['-c', script, 'bash', VERIFY_RUN, String(dead)], {
        encoding: 'utf8',
        env: { ...process.env, CM_VERIFY_LOCK_ROOT: root, CM_VERIFY_TEST_OBS_FAULT: fault },
      }).stdout.trim().split('\n');
    expect(run('group=EPERM')).toEqual(['old=empty', 'new=occupied']);
    // Without the injection the group is really empty (ESRCH): both say so.
    expect(run('')).toEqual(['old=empty', 'new=empty']);
  });
});
