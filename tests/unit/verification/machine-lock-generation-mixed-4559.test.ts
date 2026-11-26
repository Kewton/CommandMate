/**
 * Issue #4559 PR-2, T5 (docs/design/machine-lock-generation-4559.md §6, §8.1): the mixed period. Between
 * PR-2 and PR-3 the new JS (the generation chain, with the <lock> as the beacon) and today's bash
 * (verify-run.sh's lock section, which reads only the <lock>, its moved-aside records and the tickets)
 * share a lock; so do the new JS and the develop copy of the sync JS before #4559
 * (tests/fixtures/machine-lock-legacy/, pinned by sha256).
 *
 *   - S5: an older version never takes while the new one holds (it sees the beacon), and the new one never
 *     takes while an older one holds (the beacon is its record, no `g`: M1 — named, waited for).
 *   - an older holder that died is recovered by the new one with today's steps (§6.1, P-4 stays `mixed`).
 *   - the `g` codec: the older readers read a beacon record that has `g` (bash lock_owner_field, the
 *     develop JS readOwner).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { cleanAll, freshRoot, loadLegacy, readGens } from './lock-generation-4559-harness';
import { deadPid, HOST, startPausedBash, until } from './lock-holder-identity-4558-harness';

afterEach(() => cleanAll());

/** The new JS on `<root>/x.lock` (a lock outside the machine-lock root: its generations are by path). */
const newJs = (root: string, timeoutMs: number, warn?: (l: string) => void) =>
  lockSync.acquireMachineLockSync('x', { lockPath: path.join(root, 'x.lock'), timeoutMs, pollMs: 10, ...(warn ? { warn } : {}) });

describe('#4559 T5: the new JS × today\'s bash', () => {
  it('while the new JS holds, today\'s bash does not take (it reads the beacon); after the release it does', async () => {
    const root = freshRoot('t5-js-holds');
    const held = newJs(root, 0);
    expect(held.acquired).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'x.lock', 'owner'), 'utf8'))).toMatchObject({ token: held.token, g: held.gen });
    const busy = startPausedBash(root, 'lock_acquire x 1; echo "rc=$?"', []);
    await busy.exited;
    expect(busy.out().trim()).toBe('rc=1');
    // the g codec: bash reads the beacon's fields with `g` in it
    const field = startPausedBash(root, 'lock_owner_field "$LK" token', [], { LK: path.join(root, 'x.lock') });
    await field.exited;
    expect(field.out().trim()).toBe(held.token);
    expect(held.release()).toBe('released');
    const free = startPausedBash(root, 'lock_acquire x 1; echo "rc=$?"; lock_release "$LOCK_PATH" "$LOCK_TOKEN"; echo done', []);
    await free.exited;
    expect(free.out().trim().split('\n')).toEqual(['rc=0', 'done']);
  }, 30000);

  it('while today\'s bash holds, the new JS does not take (M1: an older holder is named and waited for) and ends its own generation', async () => {
    const root = freshRoot('t5-bash-holds');
    const hold = startPausedBash(root, 'lock_acquire x 1; echo "rc=$?"; lock_test_pause held; lock_release "$LOCK_PATH" "$LOCK_TOKEN"', ['held']);
    expect(await until(() => hold.reached('held'))).toBe(true);
    const warnings: string[] = [];
    const r = newJs(root, 300, (l) => warnings.push(l));
    expect(r.acquired).toBe(false);
    expect(warnings.join('\n')).toContain('machine-lock-legacy-writer');
    // the beacon's deadline: the own generation is ended (released), nobody waits on it
    const gens = [...readGens(lockSync.genDirOf(path.join(root, 'x.lock'))).values()];
    expect(gens.length).toBeGreaterThanOrEqual(1);
    expect(gens.every((g) => g.end !== null)).toBe(true);
    hold.go('held');
    await hold.exited;
    expect(hold.out().trim()).toBe('rc=0');
    const after = newJs(root, 1000);
    expect(after.acquired).toBe(true);
    expect(after.release()).toBe('released');
  }, 30000);

  it('a dead holder of today\'s bash (its record in the beacon, no `g`) is recovered by the new JS with today\'s steps', () => {
    const root = freshRoot('t5-bash-dead');
    fs.mkdirSync(path.join(root, 'x.lock'));
    fs.writeFileSync(path.join(root, 'x.lock', 'owner'), JSON.stringify({ pid: deadPid(), host: HOST, token: 'B', acquiredAt: 0, v: 1 }));
    const warnings: string[] = [];
    const r = newJs(root, 1000, (l) => warnings.push(l));
    expect(r.acquired).toBe(true);
    expect(warnings.join('\n')).toContain('machine-lock-broken-stale');
    expect(r.release()).toBe('released');
  });
});

describe('#4559 T5: the develop copy of the sync JS × the new JS', () => {
  it('each waits while the other holds; the develop copy reads the beacon with `g`', async () => {
    const root = freshRoot('t5-legacy');
    const legacy = await loadLegacy(root);
    const lockPath = path.join(root, 'x.lock');
    const n = newJs(root, 0);
    expect(n.acquired).toBe(true);
    expect(legacy.readOwner(lockPath)?.token).toBe(n.token);
    expect(legacy.acquireMachineLockSync('x', { lockPath, timeoutMs: 100, pollMs: 10 }).acquired).toBe(false);
    expect(n.release()).toBe('released');
    const old = legacy.acquireMachineLockSync('x', { lockPath, timeoutMs: 0 });
    expect(old.acquired).toBe(true);
    expect(newJs(root, 100).acquired).toBe(false);
    expect(old.release()).toBe('released');
    const again = newJs(root, 500);
    expect(again.acquired).toBe(true);
    expect(again.release()).toBe('released');
  });
});
