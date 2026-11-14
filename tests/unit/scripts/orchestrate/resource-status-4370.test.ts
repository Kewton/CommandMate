/**
 * resource.mjs status: read only (Issue #4370 PR1a, docs/design/resource-4370.md §2.3.3・§9.2 rows
 * S1〜S10). The root (`CM_VERIFY_LOCK_ROOT`) and the config (`CM_RESOURCE_CONFIG`) are a fresh
 * os.tmpdir() directory, removed after. `main` runs in this process and every observation (`kill -0`,
 * `ps`, the load) is a hook, so no process is started; a failed listing and a record that vanished are
 * injected through the `readdir` / `readFile` hooks rather than file modes (prereview 3 P3-2: a root user
 * reads a 0000 directory).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../../../scripts/orchestrate/resource.mjs';

const HOST = 'host-a';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';

let dir: string;
let root: string;
let configFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-resource-status-4370-'));
  root = path.join(dir, 'locks');
  configFile = path.join(dir, 'resource.yaml');
  fs.writeFileSync(configFile, 'ncpu: 10\ncommandmate_share: 0.5\nweights: { cpu_heavy: 0 }\nci_vm: { cpus: 2 }\n'); // S 5, C 3
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Hooks = Record<string, unknown>;
const baseHooks = (o: Hooks = {}): Hooks => ({
  host: HOST,
  now: () => 5_000,
  loadavg: () => [1, 1, 1],
  pidAlive: () => true,
  groupAlive: () => 'alive',
  startOf: () => 1_000,
  ...o,
});

function run(argv: string[], hooks: Hooks = {}) {
  let out = '';
  let err = '';
  const exit = main(argv, {
    env: { CM_VERIFY_LOCK_ROOT: root, CM_RESOURCE_CONFIG: configFile },
    hooks: baseHooks(hooks),
    stdout: (s: string) => {
      out += s;
    },
    stderr: (s: string) => {
      err += s;
    },
  });
  return { exit, out, err, json: () => JSON.parse(out) };
}

const sem = (...parts: string[]) => path.join(root, 'cpu.sem', ...parts);
function put(rel: string, content: unknown) {
  const file = sem(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}
const holderRec = (token: string, o: Record<string, unknown> = {}) => ({
  v: 1, token, pid: 500, host: HOST, pgid: 500, leaderStart: 1_000, createdAt: 1_000, priority: 'P2', weight: 1, ownCapacity: 3, admittedCapacity: 3, reason: 'test', waitedMs: 0, ...o,
});
const waiterRec = (p: number, n: number, o: Record<string, unknown> = {}) => ({
  v: 1, token: `w-${p}-${n}`, pid: 600 + n, host: HOST, createdAt: 1_000, deadline: 100_000, priority: `P${p}`, weight: 1, ownCapacity: 3, reason: 'test', ...o,
});
const wname = (p: number, n: number) => `${p}-${String(n).padStart(12, '0')}.json`;

/** Every entry under `top`: its relative path, content and mtime. */
function snapshot(top: string): string[] {
  if (!fs.existsSync(top)) return ['<absent>'];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(top, p)} ${st.mtimeMs} ${st.isDirectory() ? '<dir>' : fs.readFileSync(p, 'utf8')}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(top);
  return out;
}

function seedS1() {
  put(`holders/${T1}.json`, holderRec(T1, { weight: 1 }));
  put(`holders/${T2}.json`, holderRec(T2, { pgid: 900, weight: 1 }));
  put(`waiters/${wname(2, 1)}`, waiterRec(2, 1));
  put(`waiters/${wname(0, 2)}`, waiterRec(0, 2));
  put('state.json', { v: 1, gate: 'open', copy: { capacity: 3, configHash: 'x', next: 3 } });
}

describe('S1: two holders, two waiters and state.json — shown, nothing changed', () => {
  it('shows S, own, the effective C, both gates, the order, the reclaim candidates and the next', () => {
    seedS1();
    const before = snapshot(root);
    const r = run(['status', '--json'], { groupAlive: (pgid: number) => (pgid === 900 ? 'gone' : 'alive') });
    expect(r.exit).toBe(0);
    const s = r.json();
    expect(s).toMatchObject({ S: 5, ownC: 3, effectiveC: { state: 'ok', capacity: 3 }, participantsMin: { state: 'ok', capacity: 3 }, gateSaved: 'open', gateNext: 'open', load1: 1, used: 1 });
    expect(s.holders.find((h: { name: string }) => h.name === `${T2}.json`).retirable).toBe('group-gone');
    expect(s.order).toEqual([wname(0, 2), wname(2, 1)]);
    expect(s.next).toEqual({ name: wname(0, 2), admissible: true });
    expect(snapshot(root)).toEqual(before);

    const text = run(['status']);
    expect(text.exit).toBe(0);
    expect(text.out).toContain('S=5 own C=3 effective C=3');
    expect(text.out).toContain('取得の許可ではない');
    expect(snapshot(root)).toEqual(before);
  });

  it('the gate the load would set is shown apart from the saved one', () => {
    seedS1();
    const s = run(['status', '--json'], { loadavg: () => [6, 6, 6] }).json(); // ceiling 1.0 × ncpu 10 → closes only at 10
    expect([s.gateSaved, s.gateNext]).toEqual(['open', 'open']);
    const closed = run(['status', '--json'], { loadavg: () => [10, 6, 6] }).json();
    expect([closed.gateSaved, closed.gateNext]).toEqual(['open', 'closed']);
  });
});

describe('S2: no root', () => {
  it('"参加者なし", exit 0, and the root is not created', () => {
    const r = run(['status']);
    expect(r.exit).toBe(0);
    expect(r.out).toContain('参加者なし');
    expect(fs.existsSync(root)).toBe(false);
    const j = run(['status', '--json']).json();
    expect(j).toMatchObject({ present: false, effectiveC: { state: 'ok', capacity: 3 }, gateSaved: null, gateNext: 'closed' });
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('S3: holders cannot be listed', () => {
  it('"不明", exit 3 — never shown as empty', () => {
    seedS1();
    const failing = (d: string) => {
      if (d.endsWith(`${path.sep}holders`)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return fs.readdirSync(d);
    };
    const r = run(['status'], { readdir: failing });
    expect(r.exit).toBe(3);
    expect(r.out).toContain('不明');
    expect(r.out).not.toContain('参加者なし');
    expect(r.err).toContain('resource: unknown point=list-holders');
    expect(r.err).toContain('errno=EACCES');
    const j = run(['status', '--json'], { readdir: failing }).json();
    expect(j.effectiveC).toMatchObject({ state: 'unknown', point: 'list-holders' });
  });
});

describe('S4: the records a person has to look at are named', () => {
  it('corrupt / another host / leaderStart null / pid dead with the group alive', () => {
    put(`holders/${T1}.json`, '{"half": ');
    put(`holders/${T2}.json`, holderRec(T2, { host: 'host-b' }));
    put(`holders/${T3}.json`, holderRec(T3, { leaderStart: null, pid: 501, pgid: 777 }));
    const r = run(['status', '--json'], { pidAlive: (pid: number) => pid !== 501 });
    expect(r.exit).toBe(0);
    const s = r.json();
    expect(s.effectiveC).toMatchObject({ state: 'unknown', point: 'ownCapacity', name: `${T1}.json` });
    const w = s.warnings.join('\n');
    expect(w).toContain(`corrupt holder record holders/${T1}.json`);
    expect(w).toContain(`holder ${T2}.json is from another host (host-b)`);
    expect(w).toContain(`holder ${T3}.json has leaderStart: null`);
    expect(w).toContain(`holder ${T3}.json: pid 501 is dead but its group 777 lives`);
    expect(run(['status']).out).toContain('effective C=不明');
  });
});

describe('S5: the copy in state.json differs from the observed effective C', () => {
  it('both are shown and the difference is warned', () => {
    put(`waiters/${wname(2, 1)}`, waiterRec(2, 1, { ownCapacity: 2 }));
    put('state.json', { v: 1, gate: 'open', copy: { capacity: 3, configHash: 'x', next: 2 } });
    const s = run(['status', '--json']).json();
    expect(s).toMatchObject({ copyCapacity: 3, effectiveC: { state: 'ok', capacity: 2 } });
    expect(s.warnings.join('\n')).toContain('state.json copy.capacity=3 differs from the observed effective capacity 2');
  });
});

describe('S6 (negative, I9): the cpu.heavy lock is not touched', () => {
  it('its owner and tickets are the same before and after', () => {
    seedS1();
    fs.mkdirSync(path.join(root, 'cpu.heavy.lock'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cpu.heavy.lock', 'owner'), JSON.stringify({ pid: 1, host: HOST, token: 't' }));
    fs.mkdirSync(path.join(root, 'cpu.heavy.queue'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cpu.heavy.queue', '000000000001'), JSON.stringify({ token: 'q' }));
    const before = snapshot(root);
    expect(run(['status']).exit).toBe(0);
    expect(run(['status', '--json']).exit).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('S7: a broken config', () => {
  it('exit 2 with resource: refused', () => {
    fs.writeFileSync(configFile, 'ncpu: [1, 2\n');
    const r = run(['status']);
    expect(r.exit).toBe(2);
    expect(r.err).toMatch(/^resource: refused config /);
    expect(r.out).toBe('');
  });

  it('an unknown command is refused too (run is PR1b)', () => {
    expect(run(['run', '--', 'true']).exit).toBe(2);
    expect(run(['status', '--bogus']).exit).toBe(2);
  });
});

describe('S9 (prereview 3 H1): a tmp left in holders/ is not a participant', () => {
  it('the effective C stays ok and the tmp is only warned', () => {
    put(`holders/${T1}.json`, holderRec(T1));
    put(`holders/.tmp-${T2}`, '{"half": ');
    put(`waiters/.tmp-w-2-1`, '{');
    const before = snapshot(root);
    const r = run(['status', '--json']);
    expect(r.exit).toBe(0);
    const s = r.json();
    expect(s.effectiveC).toEqual({ state: 'ok', capacity: 3 });
    expect(s.holders.map((h: { name: string }) => h.name)).toEqual([`${T1}.json`]);
    expect(s.warnings.join('\n')).toContain(`tmp left in holders/: .tmp-${T2} (not a participant)`);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('S10 (prereview 3 H1): a record that vanished between the listing and the read has left', () => {
  it('not corrupt, exit 0', () => {
    put(`holders/${T1}.json`, holderRec(T1, { ownCapacity: 2 }));
    put(`holders/${T2}.json`, holderRec(T2));
    const vanishing = (file: string) => {
      if (file.endsWith(`${T1}.json`)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return fs.readFileSync(file, 'utf8');
    };
    const r = run(['status', '--json'], { readFile: vanishing });
    expect(r.exit).toBe(0);
    const s = r.json();
    expect(s.effectiveC).toEqual({ state: 'ok', capacity: 3 });
    expect(s.holders.map((h: { name: string }) => h.name)).toEqual([`${T2}.json`]);
    expect(s.warnings.join('\n')).not.toContain('corrupt');
  });

  it('a read that fails otherwise (EIO) is still a record that cannot be read: unknown', () => {
    put(`holders/${T1}.json`, holderRec(T1));
    const failing = (file: string) => {
      if (file.endsWith(`${T1}.json`)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return fs.readFileSync(file, 'utf8');
    };
    const s = run(['status', '--json'], { readFile: failing }).json();
    expect(s.effectiveC).toMatchObject({ state: 'unknown', point: 'ownCapacity' });
  });
});
