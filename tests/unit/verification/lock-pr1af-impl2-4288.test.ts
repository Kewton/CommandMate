/**
 * Issue #4288 PR1a-f, the first round after the implementation (pm-return-4288-pr1af-impl-1, items 2 and
 * 5–8, 10): the same line in bash (verify-run.sh's lock section through scripts/lib/machine-lock.sh) and
 * the sync JS (scripts/orchestrate/machine-lock-sync.mjs), read on a real lock under os.tmpdir().
 *
 *   2. I3 takes out regular files only: a FIFO named like a temporary is `stray` in both (codex P2-2).
 *   5. setOwnerFields / handOff: the clean-up of the own tmp never throws (codex P3, PM Claude P3-5).
 *   6. An owner of only a newline is corrupt (not empty) in bash as in the sync JS (PM Claude P3-4).
 *   7. I3's observation of an older tmp's pid with the clock stepping back is ECLOCK (F53, PM Claude P3-8).
 *   8. LOCK_OWNER_EXTRA is not inherited from the environment (PM Claude P3-7).
 *  10. lock_obs_create's exit-code bands hold for the count of LOCK_ERRNOS (PM Claude P3-10).
 *
 * Nothing under ~/.commandmate; no server, no tmux.
 *
 * @vitest-environment node
 */
import fsMod from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import * as H from './lock-owner-atomic-4288-harness';

// The harness imports machine-lock.ts, which imports the logger: kept quiet here (as the table's file does).
vi.mock('@/lib/logger', () => {
  const g = globalThis as { __pr1afLogs?: string[] };
  const LOGS = (g.__pr1afLogs ??= []);
  const push = (event: string, data?: unknown) => LOGS.push(`${event} ${JSON.stringify(data ?? {})}`);
  const logger = { warn: push, info: () => {}, error: push, debug: () => {}, withContext: () => logger };
  return { createLogger: () => logger };
});

const REPO = path.resolve(__dirname, '../../..');
const VERIFY_RUN = path.join(REPO, '.claude/skills/cmate-verify/scripts/verify-run.sh');

let root = '';
const freshRoot = (): string => (root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1af-impl2-4288-')));
afterEach(() => {
  vi.restoreAllMocks();
  H.killChildren();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

const namesIn = (dir: string): string[] | null => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);
const agedAll = (dir: string, ageMs: number): void => {
  for (const n of fs.readdirSync(dir)) H.age(path.join(dir, n), ageMs);
  H.age(dir, ageMs);
};

describe('item 2 (codex P2-2): I3 takes out regular files only — a FIFO named as a temporary is stray in bash and the sync JS', () => {
  for (const name of ['.owner-abc', 'owner.tmp.12345']) {
    for (const impl of ['bash', 'sync'] as const) {
      for (const who of ['guard-head', 'acquire-head-grace'] as const) {
        it(`${impl} ${who}: an owner-less <lock> holding a FIFO ${name} past the grace is kept, the FIFO left`, async () => {
          const r = freshRoot();
          const lock = H.lockPathIn(r);
          fs.mkdirSync(lock);
          expect(spawnSync('mkfifo', [path.join(lock, name)]).status).toBe(0);
          agedAll(lock, H.OLD_MS);
          const out = await H.drive(impl, who, r);
          expect(out.code).toBe(who === 'guard-head' ? 'kept' : 'refused:stray');
          expect(out.log).toContain(`machine-lock-ownerless-stray ${lock} (${name} is not a temporary`);
          expect(namesIn(lock)).toEqual([name]);
          expect(fs.lstatSync(path.join(lock, name)).isFIFO()).toBe(true);
        }, 60000);
      }
    }
  }

  it('negative control: the same name as a regular file past the grace is taken out by both (I3 unchanged)', async () => {
    for (const impl of ['bash', 'sync'] as const) {
      const r = freshRoot();
      const lock = H.lockPathIn(r);
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, '.owner-abc'), 'x');
      agedAll(lock, H.OLD_MS);
      expect([impl, (await H.drive(impl, 'guard-head', r)).code]).toEqual([impl, 'removed']);
      expect(fs.existsSync(lock)).toBe(false);
      fs.rmSync(r, { recursive: true, force: true });
    }
  }, 60000);
});

describe('item 6 (PM Claude P3-4): an owner of only a newline is corrupt in bash as in the sync JS — named, kept, not reclaimed', () => {
  for (const impl of ['bash', 'sync'] as const) {
    for (const who of ['acquire-head-grace', 'acquire-head-nograce', 'guard-head'] as const) {
      it(`${impl} ${who}: "\\n" past 10 min is corrupt (machine-lock-owner-corrupt), the <lock> and the owner left`, async () => {
        const r = freshRoot();
        const lock = H.lockPathIn(r);
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, 'owner'), '\n');
        agedAll(lock, H.OLD_MS);
        const out = await H.drive(impl, who, r);
        expect(out.code).toBe(who === 'guard-head' ? 'kept' : 'refused:corrupt');
        expect(out.log).toContain('machine-lock-owner-corrupt');
        expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe('\n');
        expect(namesIn(lock)).toEqual(['owner']);
      }, 60000);
    }
  }

  it('negative control: an owner of 0 bytes past 10 min is still taken out by the head (I4) in both', async () => {
    for (const impl of ['bash', 'sync'] as const) {
      const r = freshRoot();
      const lock = H.lockPathIn(r);
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), '');
      agedAll(lock, H.OLD_MS);
      expect([impl, (await H.drive(impl, 'guard-head', r)).code]).toEqual([impl, 'removed']);
      fs.rmSync(r, { recursive: true, force: true });
    }
  }, 60000);
});

describe('item 7 (PM Claude P3-8, F53): I3 reading an older tmp pid while the clock steps back says ECLOCK, not EINVAL', () => {
  /** An owner-less <lock> with an older writer's tmp of a live pid, past the grace. */
  const oldTmp = (r: string): number => {
    const live = H.liveSleep();
    const lock = H.lockPathIn(r);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, `owner.tmp.${live}`), 'pid=1\n');
    agedAll(lock, H.OLD_MS);
    return live;
  };
  // Every other read of the clock is 30 s back: each window around ps sees now_after < now_before or a
  // difference of 30 s (either is ECLOCK), and the clock still moves on, so the poll's deadline passes.
  const BASH_BACK = 'C="$LK.clock"; : > "$C"\nlock_now_ms() { if [ -s "$C" ]; then : > "$C"; lnm_b=30000; else echo 1 > "$C"; lnm_b=0; fi; echo $(( $(perl -MTime::HiRes=time -e \'printf("%d", time()*1000)\') - lnm_b )); }\n';
  const syncBack = (): (() => number) => {
    let n = 0;
    return () => Date.now() - (n++ % 2 === 1 ? 30_000 : 0);
  };

  for (const impl of ['bash', 'sync'] as const) {
    for (const who of ['acquire-head-grace', 'guard-head'] as const) {
      it(`${impl} ${who}: unknown etime ECLOCK, nothing taken out`, async () => {
        const r = freshRoot();
        oldTmp(r);
        const before = H.snapshot(r);
        const out = await H.drive(impl, who, r, impl === 'bash' ? { bashPre: BASH_BACK } : { hooks: { now: syncBack() } });
        expect(out.code).toBe(who === 'guard-head' ? 'kept' : 'refused:unk');
        expect(out.unknown).toMatch(/^point=etime path=\S+owner\.tmp\.\d+ errno=ECLOCK$/);
        expect(H.snapshot(r)).toBe(before);
      }, 60000);
    }
  }

  it('negative control: ps that cannot say (a malformed etime) stays EINVAL in both', async () => {
    for (const impl of ['bash', 'sync'] as const) {
      const r = freshRoot();
      const live = oldTmp(r);
      const out = await H.drive(impl, 'guard-head', r, { pathPrefix: H.psShim(r), env: { FAKE_ETIME_PID: String(live), FAKE_ETIME: 'garbage' } });
      expect([impl, out.code, out.unknown]).toEqual([impl, 'kept', expect.stringMatching(/^point=etime .* errno=EINVAL$/)]);
      fs.rmSync(r, { recursive: true, force: true });
    }
  }, 60000);

  it('sync processStartMs says why it answered null: ECLOCK for the clock, EINVAL for ps', () => {
    const why: { code?: string } = {};
    expect(lockSync.processStartMs(process.pid, 1_000_000, () => 970_100, why)).toBeNull();
    expect(why.code).toBe('ECLOCK');
    const why2: { code?: string } = {};
    expect(lockSync.processStartMs(H.dead(), Date.now(), () => Date.now(), why2)).toBeNull();
    expect(why2.code).toBe('EINVAL');
  });
});

describe('item 8 (PM Claude P3-7): LOCK_OWNER_EXTRA is not inherited from the environment', () => {
  for (const who of ['acquire-head-nograce', 'acquire-head-grace'] as const) {
    it(`bash ${who}: an exported LOCK_OWNER_EXTRA=pgid=… does not refuse the acquisition, nor reach the record`, async () => {
      const r = freshRoot();
      const out = await H.drive('bash', who, r, { env: { LOCK_OWNER_EXTRA: 'pgid=4242' } });
      expect([out.code, out.log]).toEqual(['acquired', expect.not.stringContaining('machine-lock-owner-field-reserved')]);
      expect(fs.readFileSync(path.join(H.lockPathIn(r), 'owner'), 'utf8')).not.toContain('4242');
    }, 60000);
  }

  it('negative control: set by the caller after the load, a reserved key is still refused (I1-c, F68)', async () => {
    const r = freshRoot();
    const out = await H.drive('bash', 'acquire-head-grace', r, { bashPre: 'LOCK_OWNER_EXTRA=pgid=4242\n' });
    expect([out.code, fs.existsSync(H.lockPathIn(r))]).toEqual(['refused:unk', false]);
    expect(out.log).toContain('machine-lock-owner-field-reserved');
  }, 60000);
});

describe('item 5 (codex P3, PM Claude P3-5): the own tmp\'s clean-up after a failed write never throws', () => {
  const acquire = (r: string, warnings: string[]) =>
    lockSync.acquireMachineLockSync('x', { lockPath: H.lockPathIn(r), timeoutMs: 0, pollMs: 20, warn: (l: string) => warnings.push(l) });
  const failing = (code: string) => {
    throw Object.assign(new Error(`${code}: injected`), { code });
  };

  it('setOwnerFields: the rename fails and the tmp cannot be removed (EACCES) → false, the tmp named, nothing thrown', () => {
    const r = freshRoot();
    const warnings: string[] = [];
    const lock = acquire(r, warnings);
    expect(lock.acquired).toBe(true);
    const rename = fsMod.renameSync;
    vi.spyOn(fsMod, 'renameSync').mockImplementation((a, b) => (String(b).endsWith('/owner') ? failing('EIO') : rename(a, b)));
    vi.spyOn(fsMod, 'rmSync').mockImplementation(() => failing('EACCES'));
    let answer: boolean | string = 'threw';
    try {
      answer = lock.setOwnerFields({ phase: 'merge' });
    } finally {
      vi.restoreAllMocks();
    }
    expect(answer).toBe(false);
    expect(warnings.join('\n')).toMatch(/machine-lock-tmp-left \S+\/\.owner-\S+ \(EACCES; /);
    expect(lock.release()).toBe('released');
  });

  it('handOff: the tmp write and its removal both fail → { ok: false, stage: tmp }, the tmp named, nothing thrown', () => {
    const r = freshRoot();
    const warnings: string[] = [];
    const lock = acquire(r, warnings);
    expect(lock.acquired).toBe(true);
    const write = fsMod.writeFileSync;
    vi.spyOn(fsMod, 'writeFileSync').mockImplementation((f, d, o) => (String(f).includes('/.owner-') ? failing('ENOSPC') : write(f, d, o)));
    vi.spyOn(fsMod, 'rmSync').mockImplementation(() => failing('EIO'));
    let answer: unknown = 'threw';
    try {
      answer = lock.handOff(process.pid, process.pid);
    } finally {
      vi.restoreAllMocks();
    }
    expect(answer).toMatchObject({ ok: false, stage: 'tmp' });
    expect(warnings.join('\n')).toMatch(/machine-lock-tmp-left \S+\/\.owner-\S+ \(EIO; /);
  });
});

describe('item 10 (PM Claude P3-10): lock_obs_create\'s exit-code bands hold for the count of LOCK_ERRNOS', () => {
  it('every band (10+i, 40+i, 70+i, 85+i, 100+i) stays below the next code the caller reads differently', () => {
    const source = fs.readFileSync(VERIFY_RUN, 'utf8');
    const m = /^LOCK_ERRNOS="([^"]*)"$/m.exec(source);
    expect(m).not.toBeNull();
    const errnos = (m as RegExpExecArray)[1].split(/\s+/).filter(Boolean);
    expect(errnos[errnos.length - 1]).toBe('EUNKNOWN'); // a name not listed is the last index
    const n = errnos.length;
    // [base, the first code read otherwise by lock_acquire_path's case]: 99 is F11's (ENOENT: no rmdir).
    const bands: Array<[number, number]> = [
      [10, 40],
      [40, 70],
      [70, 85],
      [85, 99],
      [100, 256],
    ];
    for (const [base, next] of bands) expect([base, base + n - 1 < next]).toEqual([base, true]);
    // and the caller's case decodes each band with these bases
    for (const base of [10, 40, 70, 85, 100]) expect(source).toContain(`$(( la_rc - ${base} ))`);
    for (const base of [10, 40, 85]) expect(source).toContain(`return $(( ${base} + LEI_INDEX ))`);
  });
});
