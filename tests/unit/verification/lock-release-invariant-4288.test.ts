/**
 * Issue #4288 PR1a-c — the holder's own release as one invariant (design D12, §1.14), for the three
 * implementations (bash's lock_release_held in scripts/lib/machine-lock.sh, the sync JS's handle
 * release in machine-lock-sync.mjs, machine-lock.ts's handle release):
 *
 *   The holder removes the lock itself only when the recorded pid is the caller itself and, when the
 *   record names a pgid, that group G is empty. A group that still has a member (or cannot be shown
 *   empty) keeps it: 'deferred'. Every other record — a recorded pid that is not the caller, alive,
 *   gone, after a handOff or the initial ownerPid alike — is not removed: 'needs-head' (the caller
 *   releases with D5, as the head, which re-reads the token and judges the holder), and 'deferred'
 *   when the pid cannot be observed (unknown is never read as anything).
 *   The one record G is not consulted for: pid = pgid = the caller (the caller leads its own group —
 *   merge-pr's `pgid: process.pid`), where the caller is a member of G by definition.
 *
 *   1. (codex-2 review-4288-pr1ab P2-1) a recorded pid that is not the caller is read alive, then dies;
 *      the head recovers it and takes T2; the holder's release must not remove T2.
 *   2. (codex-2 P2-2) the initial ownerPid (no handOff) with a pgid whose group lives: the release must
 *      judge G as it does after a handOff.
 *   3. The table: {self, other alive, other dead, other unknown} × {no pgid, G empty, G alive} ×
 *      {initial, after handOff} (a handOff always names a group: the 4 "no pgid, after handOff" rows
 *      do not exist), for bash and the sync JS; machine-lock.ts writes only the self / no pgid /
 *      initial record (no ownerPid, no pgid, no handOff — D9), shown here, and that row.
 *
 * Every root is under os.tmpdir(); nothing under ~/.commandmate.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { acquireMachineLock } from '@/lib/verification/machine-lock';
import { REPO, VERIFY_RUN, deadPid, killStarted, liveGroup, mutatedSync, removeRoot } from './lock-4288-harness';

const LOADER = path.join(REPO, 'scripts/lib/machine-lock.sh');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-release-inv-4288-'));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

function bash(script: string, env: Record<string, string> = {}, loader = LOADER) {
  const r = spawnSync('bash', ['-c', `set -u\n. '${loader}' || { echo LOAD-FAILED; exit 3; }\n${script}`], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CM_VERIFY_LOCK_ROOT: path.join(root, 'verify-root'),
      CM_VERIFY_TEST_OBS_FAULT: '',
      CM_VERIFY_TEST_HANDOFF: '',
      CM_VERIFY_TEST_HANDOFF_DIR: '',
      MACHINE_LOCK_VERIFY_RUN: '',
      ...env,
    },
  });
  return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '', status: r.status };
}

const ACQ = `if lock_acquire_path "$LK" "$(machine_lock_queue_of "$LK")" 0; then echo acquired; else echo "refused $LOCK_HELD_BY"; fi\n`;
const lockIn = () => path.join(root, 'run', 'commandmate-run.lock');
const ownerToken = (lock: string): string | null => {
  try {
    const text = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
    return /^token=(.*)$/m.exec(text)?.[1] ?? JSON.parse(text).token ?? null;
  } catch {
    return null;
  }
};

/** A loader copy with `edit` applied (the fix taken out); it loads this repository's verify-run.sh. */
function mutatedLoader(edit: (source: string) => string): string {
  const source = fs.readFileSync(LOADER, 'utf8');
  const out = edit(source);
  if (out === source) throw new Error('the mutation changed nothing');
  const file = path.join(root, `machine-lock-mutated-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, out);
  return file;
}

describe('1. codex-2 P2-1: a recorded pid read alive that dies before the delete', () => {
  /**
   * The holder's record names a pid that is not the caller. Inside the holder's release — at its pid
   * observation — that pid is reported alive (it was, at the kill -0) and is in fact gone: B, the head,
   * recovers the dead record and takes the lock under its own token. The release must not then remove
   * B's lock.
   */
  async function syncRace(mod: typeof lockSync) {
    const lock = lockIn();
    const dead = deadPid();
    let releasing = false;
    let successor: ReturnType<typeof lockSync.acquireMachineLockSync> | null = null;
    const a = mod.acquireMachineLockSync('x', {
      lockPath: lock,
      timeoutMs: 0,
      token: 'T0',
      ownerPid: dead,
      hooks: {
        pidAlive: (pid: number) => {
          if (releasing && pid === dead) {
            successor ??= lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'T2' });
            return true;
          }
          return lockSync.pidAlive(pid);
        },
      },
    });
    expect(a.acquired).toBe(true);
    releasing = true;
    const result = a.release();
    return { lock, result, successor: successor as ReturnType<typeof lockSync.acquireMachineLockSync> | null };
  }

  it('sync JS: needs-head, B\'s lock (T2) stays; the head release keeps it', async () => {
    const { lock, result, successor } = await syncRace(lockSync);
    expect(successor?.acquired).toBe(true);
    expect(result).toBe('needs-head');
    expect(ownerToken(lock)).toBe('T2');
    expect(lockSync.releaseAsHead(lock, ['T0'], { timeoutMs: 0 }).result).toBe('kept');
    expect(ownerToken(lock)).toBe('T2');
    expect(successor?.release()).toBe('released');
  });

  it('positive control (sync JS): removing on "alive" (PR1a-b) removes B\'s lock', async () => {
    const legacy = await mutatedSync(root, (s) =>
      s.replace(
        "const holder = obs.pid('pid', current.owner.pid);",
        "const holder = obs.pid('pid', current.owner.pid); if (holder.state === 'alive') { released = true; fs.rmSync(lockPath, { recursive: true, force: true }); return 'released'; }",
      ),
    );
    const { lock, result, successor } = await syncRace(legacy);
    expect(successor?.acquired).toBe(true);
    expect(result).toBe('released');
    expect(fs.existsSync(lock), 'B\'s lock was removed under it').toBe(false);
  });

  /** bash: lock_obs_kill0 for the recorded pid runs B (another bash) and answers alive. */
  const bashRace = (loader = LOADER) => {
    const lock = lockIn();
    const dead = deadPid();
    const r = bash(
      `machine_lock_use_kv_codec
LOCK_OWNER_PID=${dead}
${ACQ}T0=$LOCK_TOKEN
eval "lock_obs_kill0_real() $(declare -f lock_obs_kill0 | sed 1d)"
lock_obs_kill0() {
  if [ "$1" = pid ] && [ "$2" = ${dead} ]; then
    bash -c "set -u; . '${loader}'; machine_lock_use_kv_codec; LOCK_WANT_TOKEN=T2; lock_acquire_path '$LK' \\"\\$(machine_lock_queue_of '$LK')\\" 0 && echo successor-acquired >&2" >/dev/null
    echo alive
    return 0
  fi
  lock_obs_kill0_real "$@"
}
lock_release_held "$LK"; echo "held=$LRH_RESULT"
if [ "$LRH_RESULT" = needs-head ]; then lock_release_as_head "$LK" "$(machine_lock_queue_of "$LK")" 10 "$T0"; echo "head=$LRAH_RESULT"; fi`,
      // A loader copy outside the repository names this repository's verify-run.sh.
      { LK: lock, MACHINE_LOCK_VERIFY_RUN: loader === LOADER ? '' : VERIFY_RUN },
      loader,
    );
    return { lock, r };
  };

  it('bash: needs-head, B\'s lock (T2) stays; lock_release_as_head keeps it', () => {
    const { lock, r } = bashRace();
    expect(r.err).toContain('successor-acquired');
    expect(r.out.split('\n'), r.err).toEqual(['acquired', 'held=needs-head', 'head=kept']);
    expect(ownerToken(lock)).toBe('T2');
  });

  it('positive control (bash): removing on "alive" (PR1a-b) removes B\'s lock', () => {
    const loader = mutatedLoader((s) => s.replace('    alive|gone)\n      LRH_RESULT=needs-head', '    alive)\n      rm -rf "$lrh_lock"; LRH_RESULT=released; return 0;;\n    gone)\n      LRH_RESULT=needs-head'));
    const { lock, r } = bashRace(loader);
    expect(r.err).toContain('successor-acquired');
    expect(r.out.split('\n'), r.err).toEqual(['acquired', 'held=released']);
    expect(fs.existsSync(lock), 'B\'s lock was removed under it').toBe(false);
  });
});

describe('2. codex-2 P2-2: the initial record (no handOff) is judged by its group too', () => {
  it('sync JS: ownerPid not the caller, its live group on record → deferred, the lock stays', () => {
    const lock = lockIn();
    const g = liveGroup();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'T0', ownerPid: g, pgid: g });
    expect(r.release()).toBe('deferred');
    expect(ownerToken(lock)).toBe('T0');
  });

  it('sync JS: the caller\'s own pid with another live group on record → deferred, the lock stays', () => {
    const lock = lockIn();
    const g = liveGroup();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, token: 'T0', pgid: g });
    expect(r.release()).toBe('deferred');
    expect(ownerToken(lock)).toBe('T0');
  });

  it('bash (the same scene; bash judged every record\'s group already): deferred', () => {
    const lock = lockIn();
    const g = liveGroup();
    const r = bash(`machine_lock_use_kv_codec\nLOCK_OWNER_PID=${g}\nLOCK_OWNER_EXTRA=pgid=${g}\n${ACQ}lock_release_held "$LK"; echo "held=$LRH_RESULT"`, { LK: lock });
    expect(r.out.split('\n'), r.err).toEqual(['acquired', 'held=deferred']);
    expect(fs.existsSync(lock)).toBe(true);
  });
});

type Pid = 'self' | 'alive' | 'dead' | 'unknown';
type Group = 'none' | 'empty' | 'alive';
type Via = 'initial' | 'handOff';
type Row = { pid: Pid; group: Group; via: Via; result: 'released' | 'needs-head' | 'deferred'; asHead?: 'released' | 'deferred' };

/** The invariant, written once: the expected result of every row. */
function expected(pid: Pid, group: Group): Pick<Row, 'result' | 'asHead'> {
  if (group === 'alive') return { result: 'deferred' };
  if (pid === 'self') return { result: 'released' };
  if (pid === 'unknown') return { result: 'deferred' };
  return { result: 'needs-head', asHead: pid === 'dead' ? 'released' : 'deferred' };
}

const ROWS: Row[] = (['self', 'alive', 'dead', 'unknown'] as Pid[]).flatMap((pid) =>
  (['none', 'empty', 'alive'] as Group[]).flatMap((group) =>
    (['initial', 'handOff'] as Via[])
      // A handOff always names a group (T1 = <T0>-g<G>): no "no pgid, after handOff" record exists.
      .filter((via) => !(via === 'handOff' && group === 'none'))
      .map((via) => ({ pid, group, via, ...expected(pid, group) })),
  ),
);

describe('3. the table (D12 / §1.14): one invariant, the same rows for bash and the sync JS', () => {
  it('has the 20 rows of the enumeration, the initial ownerPid rows included', () => {
    expect(ROWS).toHaveLength(20);
    expect(ROWS.filter((r) => r.via === 'initial' && r.pid !== 'self')).toHaveLength(9);
    // Removed directly only under the caller's own pid and an empty (or no) group.
    expect(ROWS.filter((r) => r.result === 'released').map((r) => `${r.pid}/${r.group}`).sort()).toEqual(['self/empty', 'self/empty', 'self/none']);
  });

  const pidOf = (pid: Pid): number | 'self' => (pid === 'self' ? 'self' : pid === 'alive' ? liveGroup() : deadPid());
  const groupOf = (group: Group): number | null => (group === 'none' ? null : group === 'alive' ? liveGroup() : deadPid());

  it.each(ROWS)('sync JS: pid $pid, group $group, $via → $result', ({ pid, group, via, result, asHead }) => {
    const lock = lockIn();
    const p = pidOf(pid);
    const g = groupOf(group);
    let faulting = false;
    const r = lockSync.acquireMachineLockSync('x', {
      lockPath: lock,
      timeoutMs: 0,
      token: 'T0',
      ...(via === 'initial' && p !== 'self' ? { ownerPid: p } : {}),
      ...(via === 'initial' && g !== null ? { pgid: g } : {}),
      hooks: { fault: (point: string) => (faulting && pid === 'unknown' && point === 'pid' ? 'EPERM' : undefined) },
    });
    expect(r.acquired).toBe(true);
    const tokens = ['T0'];
    if (via === 'handOff') {
      const handed = r.handOff(p === 'self' ? process.pid : p, g as number);
      expect(handed.ok).toBe(true);
      tokens.push(handed.token as string);
    }
    faulting = true;
    expect(r.release()).toBe(result);
    faulting = false;
    expect(fs.existsSync(lock)).toBe(result !== 'released');
    if (result === 'needs-head') {
      expect(r.release(), 'needs-head is once').toBe('none');
      expect(lockSync.releaseAsHead(lock, tokens, { timeoutMs: 0 }).result).toBe(asHead);
      expect(fs.existsSync(lock)).toBe(asHead !== 'released');
    }
  });

  it.each(ROWS)('bash: pid $pid, group $group, $via → $result', ({ pid, group, via, result, asHead }) => {
    const lock = lockIn();
    const p = pidOf(pid);
    const g = groupOf(group);
    const pidSh = p === 'self' ? '$$' : String(p);
    const init = via === 'initial' ? `${p === 'self' ? '' : `LOCK_OWNER_PID=${p}\n`}${g !== null ? `LOCK_OWNER_EXTRA=pgid=${g}\n` : ''}` : '';
    const hand = via === 'handOff' ? `lock_hand_off "$LK" "$LOCK_TOKEN" ${pidSh} ${g}; T1=$LHO_TOKEN; echo "stage=[$LHO_STAGE]"\n` : 'echo "stage=[]"\n';
    const r = bash(
      `machine_lock_use_kv_codec
${init}${ACQ}T0=$LOCK_TOKEN; T1=
${hand}[ "$PID_KIND" != unknown ] || CM_VERIFY_TEST_OBS_FAULT="pid=EPERM"
lock_release_held "$LK"; echo "held=$LRH_RESULT"
CM_VERIFY_TEST_OBS_FAULT=
if [ "$LRH_RESULT" = needs-head ]; then lock_release_as_head "$LK" "$(machine_lock_queue_of "$LK")" 10 "$T0" $T1; echo "head=$LRAH_RESULT"; fi`,
      { LK: lock, PID_KIND: pid },
    );
    const lines = r.out.split('\n');
    expect(lines.slice(0, 3), r.err).toEqual(['acquired', 'stage=[]', `held=${result}`]);
    if (result === 'needs-head') {
      expect(lines[3], r.err).toBe(`head=${asHead}`);
      expect(fs.existsSync(lock)).toBe(asHead !== 'released');
    } else {
      expect(fs.existsSync(lock)).toBe(result !== 'released');
    }
  });

  it('TS: the only record it writes is the caller\'s own pid, no pgid, no handOff — and that row is released', async () => {
    const r = await acquireMachineLock('x', { root, timeoutMs: 0 });
    if (!r.acquired) throw new Error('not acquired');
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'x.lock', 'owner'), 'utf8'));
    expect(owner.pid).toBe(process.pid);
    expect(owner).not.toHaveProperty('pgid');
    expect(r.handle).not.toHaveProperty('handOff');
    r.handle.release();
    expect(fs.existsSync(path.join(root, 'x.lock'))).toBe(false);
  });
});

describe('4. the caller\'s own group (pid = pgid = the caller: merge-pr\'s pgid: process.pid) is not judged', () => {
  it('sync JS: released though the group reads alive (the caller is in it)', () => {
    const lock = lockIn();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, pgid: process.pid, hooks: { groupAlive: () => true } });
    expect(r.release()).toBe('released');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('negative (sync JS): another pid leading that group is still judged — deferred', () => {
    const lock = lockIn();
    const r = lockSync.acquireMachineLockSync('x', { lockPath: lock, timeoutMs: 0, pgid: process.pid + 1, hooks: { groupAlive: () => true } });
    expect(r.release()).toBe('deferred');
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('bash: pid = pgid = $$ is released though the group cannot be shown empty', () => {
    const lock = lockIn();
    const r = bash(`machine_lock_use_kv_codec\nLOCK_OWNER_EXTRA="pgid=$$"\n${ACQ}CM_VERIFY_TEST_OBS_FAULT=group=EPERM\nlock_release_held "$LK"; echo "held=$LRH_RESULT"`, { LK: lock });
    expect(r.out.split('\n'), r.err).toEqual(['acquired', 'held=released']);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('negative (bash): the same unknown group under the caller\'s pid but another pgid → deferred', () => {
    const lock = lockIn();
    const r = bash(`machine_lock_use_kv_codec\nLOCK_OWNER_EXTRA="pgid=$(( $$ + 1 ))"\n${ACQ}CM_VERIFY_TEST_OBS_FAULT=group=EPERM\nlock_release_held "$LK"; echo "held=$LRH_RESULT"`, { LK: lock });
    expect(r.out.split('\n'), r.err).toEqual(['acquired', 'held=deferred']);
    expect(fs.existsSync(lock)).toBe(true);
  });
});
