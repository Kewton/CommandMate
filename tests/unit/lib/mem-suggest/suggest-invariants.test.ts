/**
 * Issue #4226 (design `docs/design/mem-prompt-4226.md` §7.3): the invariants of every
 * entrance of the prompts, table-driven where the design asks for a table.
 *
 * Every state lives in a migrated SQLite file under `os.tmpdir()` (`mkdtemp`, removed in
 * `afterEach`); git and gh are fakes. Nothing real is written: no hook settings, no
 * production database (Vitest's `tests/setup.ts` isolates `CM_DB_PATH`, #4086).
 *
 * Each "positive control" is an assertion that the named broken implementation fails;
 * the comment next to it says which one.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'fs';
import path from 'path';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { createRepository } from '@/lib/db/db-repository';
import { openBoundary } from '@/lib/db/session-brief-db';
import { readShown } from '@/lib/db/suggestion-shown-db';
import { renameWorktreeIdPreservingChildren } from '@/lib/db/migrations/worktree-id-rename';
import { getInstanceIncarnation, startInstanceIncarnation } from '@/lib/mem/incarnation';
import { memAddItem, memCloseItem, memList, memUpdateItem } from '@/lib/mem/service';
import { suggestionScopeHash } from '@/lib/mem-suggest/fingerprint';
import { formatQuietLine, MEM_SUGGEST_QUIET_LINE_MAX_BYTES } from '@/lib/mem-suggest/rules';
import { MEM_SUGGEST_AWAITS, type MemSuggestAwaitId } from '@/lib/mem-suggest/service';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import type { MemListResponse, MemWriteResponse } from '@/types/mem';
import type { MemSuggestResponse } from '@/types/mem-suggest';
import { fail, ghPath, ok } from '../mem/mem-4222-harness';
import { BASE, DAY, SuggestWorld } from './suggest-harness';

const w = new SuggestWorld();
const GHP = `ghp_${'d'.repeat(36)}`;

beforeEach(() => {
  w.open('mem-suggest-4226-');
  w.worktree('wt-1');
  w.on();
});
afterEach(() => {
  vi.useRealTimers();
  w.close();
});

const bodyOf = (outcome: { body: unknown }) => outcome.body as MemSuggestResponse;
const issueClosed = () => ok(JSON.stringify({ state: 'closed', state_reason: 'completed' }));

/** A stale `now` of claude on feature/x: the one prompt of the baseline. */
async function staleNow(): Promise<void> {
  await w.writeNow();
  w.t += 2 * DAY;
}

async function addItem(kind: string, extra: Record<string, unknown> = {}, worktreeId = 'wt-1', instanceId = 'claude') {
  const outcome = await memAddItem(w.db, worktreeId, { instanceId, kind, text: `${kind} item`, ...extra }, w.deps());
  if (outcome.status >= 300) throw new Error(`add failed: ${JSON.stringify(outcome.body)}`);
  return (outcome.body as MemWriteResponse).item;
}

/** No prompt and no record: `disabled`, or 200 with nothing (discarded / disabledBy). */
function expectNothing(outcome: { status: number; body: unknown }, recordsBefore = 0) {
  if (outcome.status === 409) expect((outcome.body as { code: string }).code).toBe('disabled');
  else {
    expect(outcome.status).toBe(200);
    expect(bodyOf(outcome).suggestions).toEqual([]);
    expect(bodyOf(outcome).quietLine ?? null).toBeNull();
  }
  expect(w.shown()).toBe(recordsBefore);
}

// ---------------------------------------------------------------------------
// I-F1: off / derived / promptOnEvents=false prompt nothing
// ---------------------------------------------------------------------------

describe('I-F1: off and derived prompt nothing; promptOnEvents=false neither', () => {
  it.each(['off', 'derived'] as const)('%s: full answers disabled (CLI exit 50) from W3, without memList; quiet records nothing', async (mode) => {
    await staleNow();
    w.setMode(mode);
    const full = await w.suggest(true);
    expect(full.status).toBe(409);
    expect((full.body as { code: string }).code).toBe('disabled');
    // P2-4 positive control: an implementation that calls memList on a T0 already off/derived reaches W4.
    expect(w.steps).toEqual(['W3']);
    w.steps = [];
    expectNothing(await w.suggest(false));
    expect(w.steps).toEqual(['W2', 'W5']);
  });

  it('promptOnEvents=false: full answers disabledBy (exit 0) from W3; quiet nothing', async () => {
    await staleNow();
    w.on({ promptOnEvents: false });
    const full = await w.suggest(true);
    expect(full.status).toBe(200);
    expect(bodyOf(full)).toMatchObject({ suggestions: [], disabledBy: 'promptOnEvents', discarded: null });
    expect(w.steps).toEqual(['W3']);
    expectNothing(await w.suggest(false));
  });

  it('(negative control) on with prompts on: a stale now is prompted', async () => {
    await staleNow();
    expect(w.codes(bodyOf(await w.suggest(true)))).toEqual(['now_stale']);
    expect(w.codes(await w.quiet())).toEqual(['now_stale']);
    expect(w.shown()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// I-F2: once for the same state (persistent)
// ---------------------------------------------------------------------------

describe('I-F2: the same state is prompted once', () => {
  it('three quiet calls: the first only; full shows it every time (shown: true) and records nothing', async () => {
    await staleNow();
    const first = await w.quiet();
    expect(first.quietLine).toContain('now_stale');
    expect((await w.quiet()).quietLine).toBeNull();
    expect((await w.quiet()).quietLine).toBeNull();
    const full = bodyOf(await w.suggest(true));
    expect(full.suggestions).toMatchObject([{ code: 'now_stale', shown: true }]);
    expect(w.shown()).toBe(1);
  });

  it('a new version of the now, stale again → once more; a new boundary → once; another branch → once', async () => {
    await staleNow();
    await w.quiet();
    await w.writeNow('claude', 'wt-1', { text: 'next step' });
    w.t += 2 * DAY;
    expect(w.codes(await w.quiet())).toEqual(['now_stale']);
    expect((await w.quiet()).suggestions).toEqual([]);
    openBoundary(w.db, {
      worktreeId: 'wt-1',
      instanceId: 'claude',
      cliToolId: 'claude',
      lifetime: { incarnation: null, incarnationToolId: null, incarnationIssuedBy: null, onRoster: true },
      kind: 'reset',
      evidence: 'hook',
      openedAt: w.t,
    });
    expect(w.codes(await w.quiet())).toEqual(['now_stale']);
    expect((await w.quiet()).suggestions).toEqual([]);
    w.head = { ...w.head, branch: 'main' };
    expect(w.codes(await w.quiet())).toEqual(['now_missing']);
  });

  it('another instance is prompted on its own; an id neither on the roster nor with an incarnation is not', async () => {
    setAgentInstances(w.db, 'wt-1', [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'codex', cliTool: 'codex', alias: '', order: 1 },
    ]);
    expect(w.codes(await w.quiet('claude'))).toEqual(['now_missing']);
    expect(w.codes(await w.quiet('codex'))).toEqual(['now_missing']);
    expect((await w.quiet('nobody')).suggestions).toEqual([]);
    expect(w.shown()).toBe(2);
  });

  it('a rename of the worktree id moves the record (no prompt again) and keeps one’s own items in the rules', async () => {
    await addItem('next', { closeWhen: 'manual' });
    w.t += 8 * DAY;
    expect(w.codes(await w.quiet())).toEqual(['now_missing', 'manual_stale']);
    w.db.transaction(() => renameWorktreeIdPreservingChildren(w.db, 'wt-1', 'wt-renamed', w.t))();
    // Positive control: a record not moved by the rename (or items chosen by owner.worktreeId) prompts again / loses manual_stale.
    expect((await w.quiet('claude', 'wt-renamed')).suggestions).toEqual([]);
    expect(w.codes(bodyOf(await w.suggest(true, 'claude', 'wt-renamed')))).toEqual(['now_missing', 'manual_stale']);
  });

  it('a rule that stops holding loses its row; holding again prompts once', async () => {
    for (let i = 0; i < 10; i += 1) await addItem('next', { closeWhen: 'manual' }, 'wt-1', 'claude');
    expect(w.codes(await w.quiet())).toContain('open_count');
    const items = w.db.prepare("SELECT id FROM mem_items WHERE kind = 'next'").all() as Array<{ id: string }>;
    await memCloseItem(w.db, 'wt-1', items[0].id, { instanceId: 'claude' }, w.deps());
    expect((await w.quiet()).suggestions).toEqual([]);
    expect(w.count("SELECT COUNT(*) n FROM suggestion_shown WHERE code = 'open_count'")).toBe(0);
    await addItem('next', { closeWhen: 'manual' });
    expect(w.codes(await w.quiet())).toEqual(['open_count']);
  });

  it('an instance off the roster loses its rows at the next quiet of the worktree; the worktree’s delete takes them all', async () => {
    setAgentInstances(w.db, 'wt-1', [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'codex', cliTool: 'codex', alias: '', order: 1 },
    ]);
    await w.quiet('claude');
    await w.quiet('codex');
    expect(w.shown()).toBe(2);
    setAgentInstances(w.db, 'wt-1', [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
    await w.quiet('claude');
    expect(w.count("SELECT COUNT(*) n FROM suggestion_shown WHERE instance_id = 'codex'")).toBe(0);
    w.db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-1');
    expect(w.shown()).toBe(0);
  });

  it('branches back and forth (A→B→A→B) prompt each once; changing B only prompts B again (through readShown)', async () => {
    const at = (branch: string) => (w.head = { ...w.head, branch });
    at('feature/x');
    expect(w.codes(await w.quiet())).toEqual(['now_missing']);
    at('main');
    expect(w.codes(await w.quiet())).toEqual(['now_missing']);
    at('feature/x');
    expect((await w.quiet()).suggestions).toEqual([]);
    at('main');
    expect((await w.quiet()).suggestions).toEqual([]);
    // The same code in two scopes: readShown answers the current scope's row only.
    expect([...readShown(w.db, 'wt-1', 'claude', suggestionScopeHash(w.repo, 'main')).keys()]).toEqual(['now_missing']);
    expect(w.count("SELECT COUNT(*) n FROM suggestion_shown WHERE code = 'now_missing'")).toBe(2);
    await addItem('next', { closeWhen: 'manual' });
    w.t += 8 * DAY;
    expect(w.codes(await w.quiet())).toEqual(['manual_stale']);
    at('feature/x');
    expect((await w.quiet()).suggestions).toEqual([]);
  });

  it('101 branches visited, 100 gone from git: their rows go, within 7 × (b + 2) per instance', async () => {
    const all = Array.from({ length: 101 }, (_, i) => `b-${i}`);
    w.branchListing = { ok: true, stdout: all.map((b) => `${b} refs/heads/${b}`).join('\n') };
    for (const branch of all) {
      w.head = { ...w.head, branch };
      await w.quiet();
    }
    expect(w.shown()).toBe(101);
    w.branchListing = { ok: true, stdout: 'b-100 refs/heads/b-100' };
    await w.quiet();
    // Positive control: without the clean-up the 100 rows stay.
    expect(w.shown()).toBeLessThanOrEqual(7 * (1 + 2));
    expect(w.shown()).toBe(1);
  });

  it('a failed branch listing prompts nothing and records nothing', async () => {
    w.branchListing = { ok: false, stdout: '' };
    const body = await w.quiet();
    expect(body.suggestions).toEqual([]);
    expect(body.skipped).toEqual([{ code: 'all', reason: 'branches_unknown' }]);
    expect(w.shown()).toBe(0);
  });

  it('storage roots back and forth (R1→R2→R1→R2) prompt each once; R2 unregistered loses its rows; R2′ prompts once', async () => {
    const rootB = path.join(w.dir, 'root-b');
    const r2 = createRepository(w.db, { name: 'repo-b', path: rootB, cloneSource: 'local', enabled: false }).id;
    w.on({ promptOnEvents: true }, r2);
    const swap = (enabledA: boolean) => {
      w.db.prepare('UPDATE repositories SET enabled = ? WHERE id = ?').run(enabledA ? 1 : 0, w.repo);
      w.db.prepare('UPDATE repositories SET enabled = ? WHERE id = ?').run(enabledA ? 0 : 1, r2);
    };
    expect(w.codes(await w.quiet())).toEqual(['now_missing']);
    swap(false);
    expect(w.codes(await w.quiet())).toEqual(['now_missing']);
    swap(true);
    // Positive control: a version that drops the rows of every root but the current storage prompts here.
    expect((await w.quiet()).suggestions).toEqual([]);
    swap(false);
    expect((await w.quiet()).suggestions).toEqual([]);
    expect(w.shown()).toBe(2);
    swap(true);
    w.db.prepare('DELETE FROM repositories WHERE id = ?').run(r2);
    await w.quiet();
    expect(w.shown()).toBe(1);
    const r2b = createRepository(w.db, { name: 'repo-b2', path: rootB, cloneSource: 'local', enabled: false }).id;
    w.on({ promptOnEvents: true }, r2b);
    swap(true);
    w.db.prepare('UPDATE repositories SET enabled = 0 WHERE id = ?').run(w.repo);
    w.db.prepare('UPDATE repositories SET enabled = 1 WHERE id = ?').run(r2b);
    expect(w.codes(await w.quiet())).toEqual(['now_missing']);
    expect(w.shown()).toBeLessThanOrEqual(7 * 2 * (3 + 2));
  });

  it('P2-3: an incarnation issued lazily (null → X) for the same tool is the same lifetime: no prompt again, the row is rewritten', async () => {
    w.worktree('wt-2');
    for (let i = 0; i < 10; i += 1) await addItem('next', { closeWhen: 'manual' }, 'wt-2', 'claude');
    w.worktree('wt-p', null); // no roster rows: claude is the derived primary
    expect(getInstanceIncarnation(w.db, 'wt-p', 'claude')).toBeNull();
    expect(w.codes(await w.quiet('claude', 'wt-p'))).toEqual(['now_missing', 'open_count']);
    await addItem('next', { closeWhen: 'manual' }, 'wt-p', 'claude'); // the first write issues the lazy incarnation
    const issued = getInstanceIncarnation(w.db, 'wt-p', 'claude')?.incarnation;
    expect(issued).toBeTruthy();
    // Positive control: comparing the stored null with X as values prompts both again.
    expect((await w.quiet('claude', 'wt-p')).suggestions).toEqual([]);
    expect(w.count('SELECT COUNT(*) n FROM suggestion_shown WHERE worktree_id = ? AND instance_incarnation = ?', 'wt-p', issued)).toBe(2);
  });
});

describe('I-F2: 1,001 keys three times, and a restart', () => {
  it('168 (worktree, instance) × 6 codes = 1,008 keys: every key once in round 1, none in rounds 2 and 3, none after a reopen', async () => {
    const instances = [
      { id: 'claude', cliTool: 'claude' as const },
      { id: 'claude-2', cliTool: 'claude' as const },
      { id: 'codex', cliTool: 'codex' as const },
      { id: 'codex-2', cliTool: 'codex' as const },
    ];
    const pairs: Array<{ worktreeId: string; instanceId: string; branch: string }> = [];
    const branchOf = new Map<string, string>();
    const baseDeps = w.deps();
    for (let n = 0; n < 42; n += 1) {
      const worktreeId = `wt-k${n}`;
      const wtPath = w.worktree(worktreeId, null);
      setAgentInstances(w.db, worktreeId, instances.map((entry, order) => ({ ...entry, alias: '', order })));
      branchOf.set(wtPath, `k-${n}`);
      for (const { id } of instances) pairs.push({ worktreeId, instanceId: id, branch: `k-${n}` });
    }
    const observe = async (p: string) => ({ ...w.head, branch: branchOf.get(p) ?? 'feature/x' });
    const deps = { ...baseDeps, observe };
    for (const pair of pairs) {
      const root = path.join(w.dir, pair.worktreeId);
      writeFileSync(path.join(root, `ev-${pair.instanceId}.txt`), 'x');
      for (const [kind, extra] of [
        ['decision', {}],
        ['next', { closeWhen: 'manual' }],
        ['note', { evidence: [`path:ev-${pair.instanceId}.txt`] }],
      ] as const) {
        const added = await memAddItem(w.db, pair.worktreeId, { instanceId: pair.instanceId, kind, text: 'x', ...extra }, deps);
        expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
      }
      rmSync(path.join(root, `ev-${pair.instanceId}.txt`));
    }
    // open_count: 10 open `next` on every branch.
    for (let n = 0; n < 42; n += 1) {
      for (let i = 0; i < 6; i += 1) {
        await memAddItem(w.db, `wt-k${n}`, { instanceId: 'claude', kind: 'next', text: 'pad', closeWhen: 'manual' }, deps);
      }
    }
    w.t += 15 * DAY;
    const listing = { ok: true, stdout: [...branchOf.values()].map((b) => `${b} refs/heads/${b}`).join('\n') };
    const loaded = (await import('@/lib/mem-suggest/service')).memSuggest;
    const round = async (db = w.db, run = loaded) => {
      let lines = 0;
      for (const pair of pairs) {
        const outcome = await run(db, pair.worktreeId, { instanceId: pair.instanceId, full: false }, { ...deps, listBranches: async () => listing });
        const body = bodyOf(outcome);
        expect(outcome.status).toBe(200);
        lines += body.suggestions.length;
      }
      return lines;
    };
    expect(await round()).toBe(pairs.length * 6);
    expect(w.shown()).toBe(1008);
    // Positive control: a 1,000-entry LRU prompts every key again here.
    expect(await round()).toBe(0);
    expect(await round()).toBe(0);
    // A restart: the same file opened again, the modules loaded again.
    const file = path.join(w.dir, 'cm.db');
    w.db.close();
    w.db = openMigratedFileDb(file, { foreignKeys: true });
    vi.resetModules();
    const fresh = (await import('@/lib/mem-suggest/service')).memSuggest;
    expect(await round(w.db, fresh)).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// I-F4: no model run, nothing resident; the order and number of the awaits
// ---------------------------------------------------------------------------

describe('I-F4: the awaits and what they ask', () => {
  it('quiet: W2 then W5 (one membership), two observes, one listing, no query of the conditions, no timer left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    await staleNow();
    await w.quiet();
    expect(w.steps).toEqual(['W2', 'W5']);
    expect(w.observeCalls).toBe(2);
    expect(w.listCalls).toBe(1);
    expect(w.fake.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('full: W3, W4, W5 (two memberships of F; memList’s own is not counted), no timer left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    await staleNow();
    await w.suggest(true);
    expect(w.steps).toEqual(['W3', 'W4', 'W5']);
    expect(w.steps.filter((id) => id === 'W3' || id === 'W5')).toHaveLength(2);
    expect(w.listCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a HEAD that moves between the two observes: tried again (4 observes, one W5), judged by the new HEAD', async () => {
    w.setRules([{ match: 'glob', pattern: 'feature/off', mode: 'off' }, { match: 'glob', pattern: '**', mode: 'on' }], { promptOnEvents: true });
    await staleNow();
    w.betweenObserves = () => (w.head = { ...w.head, branch: 'main' });
    const body = await w.quiet();
    expect(w.observeCalls).toBe(4);
    expect(w.steps).toEqual(['W2', 'W5']);
    expect(body.branch).toBe('main');
    expect(w.codes(body)).toEqual(['now_missing']);
  });
});

// ---------------------------------------------------------------------------
// I-F7: no free input in what is shown; the quiet line's bound
// ---------------------------------------------------------------------------

describe('I-F7: what is shown carries no free input', () => {
  it('item text, a secret-like value, U+202E and a BOM never reach the answer; a secret-like branch is replaced', async () => {
    const marker = 'MARKER-4226-TEXT';
    const decision = await addItem('decision');
    await addItem('next', { closeWhen: 'manual', text: marker });
    // Stored as it is (the entrance refuses controls; a stored value is what the exit must not repeat).
    w.db.prepare('UPDATE mem_items SET text = ? WHERE id = ?').run(`${marker} \u202Eevil\uFEFF`, decision.id);
    w.t += 15 * DAY;
    const full = JSON.stringify(bodyOf(await w.suggest(true)));
    const quiet = JSON.stringify(await w.quiet());
    for (const text of [full, quiet]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain('\u202E');
      expect(text).not.toContain('\uFEFF');
    }
    w.head = { ...w.head, branch: `feature/${GHP}` };
    const secret = bodyOf(await w.suggest(true));
    expect(secret.branch).toBeNull();
    expect(JSON.stringify(secret)).not.toContain(GHP);
  });

  it('the longest quiet line (6 codes, 999+) is within 280 bytes', () => {
    const codes = ['now_missing', 'decision_unreflected', 'manual_stale', 'open_count', 'evidence_missing', 'decision_no_destination'] as const;
    const line = formatQuietLine(codes.map((code) => ({ code, itemIds: Array.from({ length: 200 }, (_, i) => `id-${i}`) }))) as string;
    expect(line).toContain('999+');
    // Positive control: 240 (the 1st edition's bound) is too small for it.
    expect(Buffer.byteLength(line)).toBeGreaterThan(240);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MEM_SUGGEST_QUIET_LINE_MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------
// I-F10: missing material and results of another version are not prompted
// ---------------------------------------------------------------------------

describe('I-F10: the rules read the store, not the list, and bind results by version', () => {
  it('(1) a now closed by its condition (the real close, archiveSlot): now_condition_met only, no now_missing, no version_changed', async () => {
    w.fake.handler = issueClosed;
    await w.writeNow('claude', 'wt-1', { closeWhen: 'issue:#1' });
    const body = bodyOf(await w.suggest(true));
    expect(w.codes(body)).toEqual(['now_condition_met']);
    expect(body.skipped.filter((s) => s.reason === 'version_changed')).toEqual([]);
  });

  it('(2) a close that lost its version race is not now_condition_met', async () => {
    const now = await w.writeNow('claude', 'wt-1', { closeWhen: 'issue:#1' });
    w.fake.handler = () => {
      w.db.prepare('UPDATE session_notes SET version = version + 1 WHERE mem_item_id = ?').run(now.id);
      return issueClosed();
    };
    const body = bodyOf(await w.suggest(true));
    expect(w.codes(body)).not.toContain('now_condition_met');
  });

  it('(3) the now of the same instance id in another worktree is not the caller’s', async () => {
    w.worktree('wt-2');
    await w.writeNow('claude', 'wt-2');
    w.t += 2 * DAY;
    await w.writeNow('claude', 'wt-1');
    expect(w.codes(bodyOf(await w.suggest(true)))).toEqual([]);
  });

  it.each([9, 10, 11])('(4) open_count with %i open items: quiet, full and memList’s warnings agree', async (n) => {
    for (let i = 0; i < n; i += 1) await addItem('next', { closeWhen: 'manual' });
    const quiet = (await w.quiet()).suggestions.some((s) => s.code === 'open_count');
    const full = bodyOf(await w.suggest(true)).suggestions.some((s) => s.code === 'open_count');
    const listed = bodyOf(await memList(w.db, { via: 'worktree', worktreeId: 'wt-1' }, {}, w.deps())) as unknown as MemListResponse;
    const warned = listed.warnings.some((warning) => warning.code === 'open_count' && warning.kind === 'next');
    expect([quiet, full]).toEqual([warned, warned]);
    expect(warned).toBe(n >= 10);
  });

  it('(5)(6) a withheld decision with a destination is not decision_no_destination; a withheld item’s evidence is skipped', async () => {
    writeFileSync(path.join(w.dir, 'wt-1', 'a.txt'), 'x');
    const decision = await addItem('decision', { promoteTo: 'path:docs/x.md' });
    const note = await addItem('note', { evidence: ['path:a.txt'] });
    // A value that a rule added later finds: withheld (checked under an older rule set).
    w.db.prepare('UPDATE mem_items SET text = ?, checked_rules_version = 0 WHERE id IN (?, ?)').run(`x ${GHP}`, decision.id, note.id);
    const body = bodyOf(await w.suggest(true));
    // Positive control: reading promoteTo from the presented (withheld) item says "no destination".
    expect(w.codes(body)).not.toContain('decision_no_destination');
    expect(body.skipped).toContainEqual({ code: 'evidence_missing', reason: 'withheld', itemId: note.id });
  });

  it('(7) a decision updated to v2 while v1’s condition was asked: no unreflected prompt, version_changed', async () => {
    const decision = await addItem('decision', { closeWhen: 'issue:#1' });
    w.fake.handler = async () => {
      await memUpdateItem(w.db, 'wt-1', decision.id, { instanceId: 'claude', ifVersion: decision.version, closeWhen: 'issue:#2' }, w.deps());
      return issueClosed();
    };
    const body = bodyOf(await w.suggest(true));
    expect(w.codes(body)).not.toContain('decision_unreflected');
    expect(body.skipped).toContainEqual({ code: 'decision_unreflected', reason: 'version_changed', itemId: decision.id });
  });

  it('(8) an item whose reference is gone, changed during the query: no ref_unknown, version_changed; unchanged: ref_unknown', async () => {
    const item = await addItem('next', { closeWhen: 'issue:#1' });
    w.fake.handler = (call) => (ghPath(call) ? fail(1, 'gh: Not Found (HTTP 404)') : fail(1));
    expect(w.codes(bodyOf(await w.suggest(true)))).toEqual(['now_missing', 'ref_unknown']);
    w.fake.handler = () => {
      w.db.prepare('UPDATE mem_items SET version = version + 1 WHERE id = ?').run(item.id);
      return fail(1, 'gh: Not Found (HTTP 404)');
    };
    const body = bodyOf(await w.suggest(true));
    expect(w.codes(body)).not.toContain('ref_unknown');
    expect(body.skipped).toContainEqual({ code: 'ref_unknown', reason: 'version_changed', itemId: item.id });
  });
});

// ---------------------------------------------------------------------------
// I-F11: a change during a request prompts and records nothing (table-driven over MEM_SUGGEST_AWAITS)
// ---------------------------------------------------------------------------

type Change = { name: string; quietOnly?: boolean; kind: 'off' | 'lifetime'; setup?: () => void; apply: () => void };

const CHANGES: Change[] = [
  {
    name: 'HEAD A(on) → B(off)',
    kind: 'off',
    setup: () => w.setRules([{ match: 'glob', pattern: 'feature/off', mode: 'off' }, { match: 'glob', pattern: '**', mode: 'on' }], { promptOnEvents: true }),
    apply: () => (w.head = { ...w.head, branch: 'feature/off' }),
  },
  { name: 'on → off', kind: 'off', apply: () => w.setMode('off') },
  { name: 'promptOnEvents=false', kind: 'off', apply: () => w.on({ promptOnEvents: false }) },
  {
    name: 'the membership moves to R2 (prompts off there)',
    kind: 'off',
    setup: () => {
      const r2 = createRepository(w.db, { name: 'repo-b', path: path.join(w.dir, 'root-b'), cloneSource: 'local', enabled: false }).id;
      w.on({ promptOnEvents: false }, r2);
      (w as unknown as { r2: string }).r2 = r2;
    },
    apply: () => {
      w.db.prepare('UPDATE repositories SET enabled = 0 WHERE id = ?').run(w.repo);
      w.db.prepare('UPDATE repositories SET enabled = 1 WHERE id = ?').run((w as unknown as { r2: string }).r2);
    },
  },
  {
    name: 'the instance removed and added again',
    kind: 'lifetime',
    apply: () => {
      setAgentInstances(w.db, 'wt-1', [{ id: 'codex', cliTool: 'codex', alias: '', order: 0 }]);
      setAgentInstances(w.db, 'wt-1', [
        { id: 'codex', cliTool: 'codex', alias: '', order: 0 },
        { id: 'claude', cliTool: 'claude', alias: '', order: 1 },
      ]);
    },
  },
  {
    name: 'the worktree deleted and made again (same id, same path)',
    kind: 'lifetime',
    apply: () => {
      w.db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-1');
      w.db
        .prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`)
        .run('wt-1', 'wt-1', path.join(w.dir, 'wt-1'), w.root);
      setAgentInstances(w.db, 'wt-1', [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
    },
  },
  {
    name: 'a new boundary',
    kind: 'lifetime',
    quietOnly: true,
    apply: () =>
      void openBoundary(w.db, {
        worktreeId: 'wt-1',
        instanceId: 'claude',
        cliToolId: 'claude',
        lifetime: { incarnation: null, incarnationToolId: null, incarnationIssuedBy: null, onRoster: true },
        kind: 'reset',
        evidence: 'hook',
        openedAt: w.t,
      }),
  },
];

const ROWS: Array<[string, boolean, MemSuggestAwaitId, Change]> = [];
for (const id of Object.keys(MEM_SUGGEST_AWAITS) as MemSuggestAwaitId[]) {
  for (const full of [false, true]) {
    const paths = MEM_SUGGEST_AWAITS[id].paths as readonly string[];
    if (!paths.includes(full ? 'full' : 'quiet')) continue;
    for (const change of CHANGES) {
      if (change.quietOnly && full) continue;
      ROWS.push([`${id} ${full ? 'full' : 'quiet'}: ${change.name}`, full, id, change]);
    }
  }
}

describe('I-F11: a change right after an await of the table', () => {
  it('the table has every await of the design (W1〜W5) and both paths reach W5', () => {
    expect(Object.keys(MEM_SUGGEST_AWAITS)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5']);
    expect(ROWS.filter(([, , id]) => id === 'W5').length).toBeGreaterThan(0);
  });

  it.each(ROWS)('%s', async (_name, full, id, change) => {
    change.setup?.();
    await staleNow();
    if (id === 'W1') {
      // Before the fix: the request answers the state after the change.
      change.apply();
      const outcome = await w.suggest(full);
      if (change.kind === 'off') expectNothing(outcome);
      else expect(outcome.status === 200 ? bodyOf(outcome).discarded : 'refused').toBeNull();
      return;
    }
    if (id === 'W5') {
      // After W5 resolved, the build has judged and recorded (INV-A's edge): the prompt stays.
      w.inject = { at: id, change: change.apply };
      const outcome = await w.suggest(full);
      expect(bodyOf(outcome).suggestions.length).toBeGreaterThan(0);
      // (a delete of the worktree after the build takes the record with it, as a child row)
      expect(w.shown()).toBe(full || change.name.includes('deleted and made again') ? 0 : 1);
      // During W5's wait (between its two observes): the build sees the change.
      w.close();
      w.open('mem-suggest-4226-');
      w.worktree('wt-1');
      w.on();
      change.setup?.();
      await staleNow();
      if (full) {
        // Skip W3's observes: change between the two observes of W5 (the 5th and 6th of memList's are W4's).
        w.inject = { at: 'W4', change: () => (w.betweenObserves = change.apply) };
      } else {
        w.betweenObserves = change.apply;
      }
      expectNothing(await w.suggest(full));
      return;
    }
    w.inject = { at: id, change: change.apply };
    expectNothing(await w.suggest(full));
  });

  it('(negative control) a lazy incarnation issued during the request (C0 from the real roster’s cliTool) is the same lifetime', async () => {
    w.worktree('wt-p', null);
    w.inject = { at: 'W3', change: () => void startInstanceIncarnation(w.db, 'wt-p', 'claude', 'claude', w.t, 'lazy') };
    const body = bodyOf(await w.suggest(true, 'claude', 'wt-p'));
    expect(body.discarded).toBeNull();
    expect(w.codes(body)).toEqual(['now_missing']);
  });

  it('(negative control) a worktree whose lifetime was never fixed: the first full is answered, not discarded', async () => {
    w.worktree('wt-new');
    expect(w.count('SELECT COUNT(*) n FROM mem_worktree_incarnations WHERE worktree_id = ?', 'wt-new')).toBe(0);
    const body = bodyOf(await w.suggest(true, 'claude', 'wt-new'));
    expect(body.discarded).toBeNull();
    expect(w.codes(body)).toEqual(['now_missing']);
  });

  it('(negative control) a display name changed during the request does not discard', async () => {
    await staleNow();
    w.inject = { at: 'W2', change: () => void w.db.prepare("UPDATE repositories SET display_name = 'renamed' WHERE id = ?").run(w.repo) };
    expect(w.codes(await w.quiet())).toEqual(['now_stale']);
  });

  it('a worktree deleted and made again during memList closes nothing of the new lifetime', async () => {
    await staleNow();
    w.inject = {
      at: 'W3',
      change: () => {
        CHANGES[5].apply();
      },
    };
    const body = bodyOf(await w.suggest(true));
    expect(body.discarded).toBe('worktree_lifetime');
    // memList was not called: the check before it discarded.
    expect(w.steps).toEqual(['W3']);
  });

  it('the quiet deadline: past 3 seconds at W5’s build, nothing is recorded', async () => {
    await staleNow();
    w.inject = { at: 'W2', change: () => (w.t += 3001) };
    const body = await w.quiet();
    expect(body.discarded).toBe('deadline');
    expect(w.shown()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E-R: the route's body, directly
// ---------------------------------------------------------------------------

describe('E-R: the body as the route hands it', () => {
  it('refuses a full that is not a boolean, a hook not in the table and an empty instance id', async () => {
    const { memSuggest } = await import('@/lib/mem-suggest/service');
    expect((await memSuggest(w.db, 'wt-1', { instanceId: 'claude' }, w.suggestDeps())).status).toBe(400);
    expect((await memSuggest(w.db, 'wt-1', { full: false, hook: 'stop' }, w.suggestDeps())).status).toBe(400);
    expect((await memSuggest(w.db, 'wt-1', { full: false, instanceId: '' }, w.suggestDeps())).status).toBe(400);
    expect((await memSuggest(w.db, 'nope', { full: false }, w.suggestDeps())).status).toBe(404);
    expect(bodyOf(await memSuggest(w.db, 'wt-1', { full: false, instanceId: 'claude', hook: 'pre_compact' }, w.suggestDeps())).hook).toBe('pre_compact');
  });

  it('a derived primary (no roster row, no incarnation) is answered; an unknown id is not, and records nothing', async () => {
    w.worktree('wt-p', null);
    expect(w.codes(await w.quiet('claude', 'wt-p'))).toEqual(['now_missing']);
    expect(await w.quiet('stranger', 'wt-p')).toMatchObject({ suggestions: [], instanceId: null });
    expect(w.shown('wt-p')).toBe(1);
  });

  it('no identity: full applies the rest with now_* skipped; quiet does nothing', async () => {
    const full = bodyOf(await w.suggest(true, null));
    expect(full.skipped).toContainEqual({ code: 'now_missing', reason: 'no_instance' });
    const quiet = await w.quiet(null);
    expect(quiet.suggestions).toEqual([]);
    expect(w.steps.filter((id) => id === 'W2')).toEqual([]);
    expect(w.shown()).toBe(0);
  });

  it('the clock of the requests is the deps’, not a real one (sanity)', () => {
    expect(w.t).toBe(BASE);
  });
});
