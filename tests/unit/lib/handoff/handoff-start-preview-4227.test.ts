/**
 * G-3's preview (Issue #4227 G-PR3, design `mem-ui-4227.md` §3.1・§3.1.1, §7.4 H20(a)・H22).
 *
 * The questions waiting for a person are counted by classification of C's real JSON — made
 * by `briefForRoute` with the real readers (`readStateSource`, `readRelaySource`) or a reader
 * that fails, never a hand-written JSON — and keyed by `(worktree, instance)`. Whatever
 * cannot be read is "unknown", never "none".
 *
 * The DB is a migrated file under `os.tmpdir()`, removed after each test.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import { openBoundary, readInstanceLifetime } from '@/lib/db/session-brief-db';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_ID_LENGTH } from '@/lib/cli-tools/types';
import {
  classifyHumanQuestions,
  handoffStartPreview,
  PREVIEW_INSTANCE_ID,
  PREVIEW_INSTANCE_ID_MAX,
  type StartPreviewResponse,
} from '@/lib/handoff/preview';
import { readStateSource } from '@/lib/brief/sources';
import type { BriefBuildDeps } from '@/lib/brief/build';
import type { BriefJson } from '@/types/brief';
import { BriefWorld, resetBriefMemory } from '../brief/brief-4223-harness';

const world = new BriefWorld();

beforeEach(() => {
  resetBriefMemory();
  world.open('handoff-start-preview-4227-');
  world.worktree('wt-1', [
    { id: 'claude', cliTool: 'claude' },
    { id: 'codex', cliTool: 'codex' },
  ]);
  world.worktree('wt-2', [{ id: 'claude', cliTool: 'claude' }]);
  world.setMode('on');
});
afterEach(() => {
  world.close();
  resetBriefMemory();
});

/** C's JSON as the route makes it (all entries). */
async function briefJson(extra: BriefBuildDeps = {}): Promise<BriefJson> {
  const run = await world.brief({ format: 'json', all: '1' }, extra);
  return JSON.parse(run.stdout) as BriefJson;
}
const failingState: BriefBuildDeps = { readers: { state: () => { throw new Error('state store gone'); } } };
const questions = async (extra: BriefBuildDeps = {}) => classifyHumanQuestions(await briefJson(extra), 'wt-1', 'claude');

describe('H22 classifying the questions (C’s real JSON)', () => {
  it('(a)(g) no question and the state source failing → count 0, unknown [state] (never "no questions")', async () => {
    const json = await briefJson(failingState);
    // The fixture is C's own: the status row (fields.unavailable) and sources[].status.
    expect(json.entries.some((entry) => entry.source === 'state' && 'unavailable' in entry.fields)).toBe(true);
    expect(json.sources.find((source) => source.id === 'state')?.status).toBe('unavailable');
    expect(classifyHumanQuestions(json, 'wt-1', 'claude')).toEqual({ count: 0, unknownSources: ['state'] });
  });

  it('(g) the status row alone and sources[] alone each make it unknown', async () => {
    const json = await briefJson(failingState);
    const rowOnly = { ...json, sources: json.sources.map((source) => (source.id === 'state' ? { ...source, status: 'ok' as const } : source)) };
    const sourceOnly = { ...json, entries: json.entries.filter((entry) => !(entry.source === 'state' && 'unavailable' in entry.fields)) };
    expect(classifyHumanQuestions(rowOnly, 'wt-1', 'claude').unknownSources).toEqual(['state']);
    expect(classifyHumanQuestions(sourceOnly, 'wt-1', 'claude').unknownSources).toEqual(['state']);
  });

  it('(g) negative: nobody waiting, read fine → count 0, nothing unknown (the rows without `waiting` are not counted)', async () => {
    const json = await briefJson();
    expect(json.entries.filter((entry) => entry.source === 'state').every((entry) => !('waiting' in entry.fields))).toBe(true);
    expect(classifyHumanQuestions(json, 'wt-1', 'claude')).toEqual({ count: 0, unknownSources: [] });
  });

  it('positive control: rank 1 is not the count (the failing state’s status row is rank 1)', async () => {
    const json = await briefJson(failingState);
    expect(json.entries.filter((entry) => entry.rank === 1).length).toBeGreaterThan(0);
    expect(classifyHumanQuestions(json, 'wt-1', 'claude').count).toBe(0);
  });

  it('(b) one real wait → 1', async () => {
    observeWaitingEdge({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex', waiting: true, now: Date.now() });
    expect(await questions()).toEqual({ count: 1, unknownSources: [] });
  });

  it('(c) the same wait twice: state’s waiting of claude and the relay this instance owes in prompt → 1', async () => {
    observeWaitingEdge({ worktreeId: 'wt-1', cliToolId: 'claude', instanceId: 'claude', waiting: true, now: Date.now() });
    world.relay({ worktreeId: 'wt-2', instanceId: 'claude' }, { worktreeId: 'wt-1', instanceId: 'claude' }, 'prompt');
    expect(await questions()).toEqual({ count: 1, unknownSources: [] });
  });

  it('(c) two relays awaiting the same peer in prompt → 1', async () => {
    world.relay({ worktreeId: 'wt-1', instanceId: 'claude' }, { worktreeId: 'wt-2', instanceId: 'claude' }, 'prompt');
    world.relay({ worktreeId: 'wt-1', instanceId: 'claude' }, { worktreeId: 'wt-2', instanceId: 'claude' }, 'prompt');
    expect(await questions()).toEqual({ count: 1, unknownSources: [] });
  });

  it('(d) the same name in another worktree: this worktree’s claude waiting and a relay awaiting wt-2’s claude → 2', async () => {
    observeWaitingEdge({ worktreeId: 'wt-1', cliToolId: 'claude', instanceId: 'claude', waiting: true, now: Date.now() });
    world.relay({ worktreeId: 'wt-1', instanceId: 'claude' }, { worktreeId: 'wt-2', instanceId: 'claude' }, 'prompt');
    expect(await questions()).toEqual({ count: 2, unknownSources: [] });
  });

  it('(e) both directions: owed (this instance stopped) and awaiting (the peer stopped) → 2; each alone → 1', async () => {
    world.relay({ worktreeId: 'wt-2', instanceId: 'claude' }, { worktreeId: 'wt-1', instanceId: 'claude' }, 'prompt');
    expect((await questions()).count).toBe(1);
    world.relay({ worktreeId: 'wt-1', instanceId: 'claude' }, { worktreeId: 'wt-2', instanceId: 'claude' }, 'prompt');
    expect((await questions()).count).toBe(2);
  });

  it('(f) a relay row whose peer is not of the shape → not counted, unknown [relay]', async () => {
    world.relay({ worktreeId: 'wt-1', instanceId: 'claude' }, { worktreeId: 'wt-2', instanceId: 'claude' }, 'prompt');
    const json = await briefJson();
    const broken = {
      ...json,
      entries: json.entries.map((entry) => (entry.source === 'relay' ? { ...entry, fields: { ...entry.fields, peer: 'wt-2/clau[U+200B]de' } } : entry)),
    };
    expect(classifyHumanQuestions(broken, 'wt-1', 'claude')).toEqual({ count: 0, unknownSources: ['relay'] });
  });

  it('rank 1 cut by the limits (omitted.byRank[1]) is unknown, not none', () => {
    expect(classifyHumanQuestions({ entries: [], sources: [], omitted: { count: 1, byRank: { '1': 1 } } }, 'wt-1', 'claude')).toEqual({
      count: 0,
      unknownSources: ['omitted'],
    });
  });

  it('the instance-id shape is cli-tools’ (pinned equal, not imported by the lib)', () => {
    expect(PREVIEW_INSTANCE_ID.source).toBe(INSTANCE_ID_PATTERN.source);
    expect(PREVIEW_INSTANCE_ID_MAX).toBe(MAX_INSTANCE_ID_LENGTH);
  });
});

// --- the service ----------------------------------------------------------

function openPending(instanceId = 'claude'): string {
  return openBoundary(world.db, {
    worktreeId: 'wt-1',
    instanceId,
    cliToolId: 'claude',
    lifetime: readInstanceLifetime(world.db, 'wt-1', instanceId),
    kind: 'launch',
    evidence: 'launch',
    openedAt: Date.now(),
  }).id;
}

function setFeatures(features: { popup?: boolean; injectOnStart?: boolean }, mode: 'on' | 'derived' | 'off' = 'on'): void {
  const current = getMemSettings(world.db, world.repo);
  saveMemSettings(world.db, world.repo, {
    version: current.version,
    features: { ...current.features, ...features },
    rules: [{ match: 'glob', pattern: '**', mode }],
  });
}

async function preview(extra: BriefBuildDeps = {}): Promise<StartPreviewResponse> {
  const outcome = await handoffStartPreview(world.db, 'wt-1', 'claude', { mem: world.deps(), brief: world.briefDeps(extra) });
  expect(outcome.status).toBe(200);
  return outcome.body as StartPreviewResponse;
}

describe('the preview’s show conditions (§3.2) and its lines', () => {
  it('attended, on, injectOnStart, a pending boundary: shown with the boundary and three lines', async () => {
    setFeatures({ popup: true, injectOnStart: true });
    await world.add('decision', undefined, { text: 'decide' });
    await world.add('note', undefined, { text: 'note' });
    const id = openPending();
    const body = await preview();
    expect(body).toMatchObject({ ok: true, show: true, mode: 'on', boundary: { id, kind: 'launch' } });
    if (!body.show) return;
    expect(body.preview?.open.count).toBe(2);
    expect(body.preview?.humanQuestions).toEqual({ count: 0, unknownSources: [] });
    expect(body.preview?.lastUpdatedAt).not.toBeNull();
  });

  it('derived: shown, the lines from A’s frozen list (C reads no hand-written item in derived)', async () => {
    await world.add('decision', undefined, { text: 'decide' });
    await world.add('note', undefined, { text: 'note' });
    setFeatures({ popup: true, injectOnStart: true }, 'derived');
    openPending();
    const body = await preview();
    expect(body).toMatchObject({ ok: true, show: true, mode: 'derived' });
    if (body.show) expect(body.preview?.open.count).toBe(2);
  });

  it('H20 (a) attended with injectOnStart false → show:false (nothing would be attached whatever is chosen)', async () => {
    setFeatures({ popup: true, injectOnStart: false });
    openPending();
    expect(await preview()).toEqual({ ok: true, show: false, attended: true, injectOnStart: false });
  });

  it('unattended (popup 0, the default) → show:false, attended:false', async () => {
    setFeatures({ popup: false, injectOnStart: true });
    openPending();
    expect(await preview()).toEqual({ ok: true, show: false, attended: false });
  });

  it('off → show:false', async () => {
    setFeatures({ popup: true, injectOnStart: true }, 'off');
    openPending();
    expect(await preview()).toEqual({ ok: true, show: false });
  });

  it('no pending boundary → show:false', async () => {
    setFeatures({ popup: true, injectOnStart: true });
    expect(await preview()).toMatchObject({ ok: true, show: false });
  });

  it('a failing state source: still shown, the questions unknown (H22 (a) through the service)', async () => {
    setFeatures({ popup: true, injectOnStart: true });
    openPending();
    const body = await preview(failingState);
    expect(body.show).toBe(true);
    if (body.show) expect(body.preview?.humanQuestions).toEqual({ count: 0, unknownSources: ['state'] });
  });

  it('a read: the boundary stays pending, nothing is reserved', async () => {
    setFeatures({ popup: true, injectOnStart: true });
    const id = openPending();
    await preview();
    const row = world.db.prepare('SELECT state, claim_token FROM session_brief_boundaries WHERE id = ?').get(id) as { state: string; claim_token: string | null };
    expect(row).toEqual({ state: 'pending', claim_token: null });
  });

  it('an invalid instance is 400', async () => {
    const outcome = await handoffStartPreview(world.db, 'wt-1', 'bad/id', { mem: world.deps() });
    expect(outcome.status).toBe(400);
  });
});

// --- G-PR6: the boundary read again after the lines (design §3.1) ---------------------------

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A state reader that stops on its first call until released (the real reader answers). */
function heldStateReader() {
  const reached = deferred();
  const gate = deferred();
  let calls = 0;
  const reader: NonNullable<BriefBuildDeps['readers']>['state'] = async (ctx) => {
    calls += 1;
    if (calls === 1) {
      reached.resolve();
      await gate.promise;
    }
    return readStateSource(ctx);
  };
  return { reached: reached.promise, release: () => gate.resolve(), calls: () => calls, deps: { readers: { state: reader } } as BriefBuildDeps };
}

const boundaryState = (id: string): string =>
  (world.db.prepare('SELECT state FROM session_brief_boundaries WHERE id = ?').get(id) as { state: string }).state;

describe.each(['on', 'derived'] as const)('G-PR6 mode %s: the boundary changes while the lines are read', (mode) => {
  beforeEach(() => setFeatures({ popup: true, injectOnStart: true }, mode));

  it('A → B under the read: 409 boundary_changed, A’s lines under no id, C built once (#4224 R5)', async () => {
    const a = openPending();
    const held = heldStateReader();
    const running = handoffStartPreview(world.db, 'wt-1', 'claude', { mem: world.deps(), brief: world.briefDeps(held.deps) });
    await held.reached;
    const b = openPending();
    held.release();
    const outcome = await running;
    expect(a).not.toBe(b);
    expect(boundaryState(a)).toBe('superseded');
    expect(boundaryState(b)).toBe('pending');
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ ok: false, code: 'boundary_changed' });
    expect(JSON.stringify(outcome.body)).not.toContain(a);
    expect(JSON.stringify(outcome.body)).not.toContain('"show"');
    expect(held.calls()).toBe(1); // never built again
    // Read again (the screen's "try again"): B is asked about.
    expect(await preview()).toMatchObject({ ok: true, show: true, mode, boundary: { id: b } });
  });

  it('A used under the read (no pending boundary now): a valid show:false, not A', async () => {
    const a = openPending();
    const held = heldStateReader();
    const running = handoffStartPreview(world.db, 'wt-1', 'claude', { mem: world.deps(), brief: world.briefDeps(held.deps) });
    await held.reached;
    world.db.prepare("UPDATE session_brief_boundaries SET state = 'sent', settled_at = ? WHERE id = ?").run(Date.now(), a);
    held.release();
    const outcome = await running;
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ ok: true, show: false, attended: true, injectOnStart: true, mode });
  });

  it('the mode changes under the read: 409 boundary_changed (A’s lines were read for the old mode)', async () => {
    openPending();
    const held = heldStateReader();
    const running = handoffStartPreview(world.db, 'wt-1', 'claude', { mem: world.deps(), brief: world.briefDeps(held.deps) });
    await held.reached;
    setFeatures({ popup: true, injectOnStart: true }, mode === 'on' ? 'derived' : 'on');
    held.release();
    const outcome = await running;
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ ok: false, code: 'boundary_changed' });
    // (C's own re-check before drawing may read its sources again on a mode change — that is C's
    // rule inside its one pinned request, not the preview building again.)
  });

  it('A → B while the target is resolved again after the lines (P2-3): 409 boundary_changed, never A', async () => {
    const a = openPending();
    const base = world.deps();
    const inner = base.observe!;
    let calls = 0;
    let trigger = Number.POSITIVE_INFINITY;
    const mem = {
      ...base,
      observe: async (path: string) => {
        calls += 1;
        if (calls === trigger) openPending(); // B opens while this (the last) observe is awaited
        return inner(path);
      },
    };
    // Baseline: how many times the preview resolves the target (its last one is the final re-read).
    const baseline = await handoffStartPreview(world.db, 'wt-1', 'claude', { mem, brief: world.briefDeps() });
    expect(baseline.body).toMatchObject({ ok: true, show: true, boundary: { id: a } });
    const total = calls;
    calls = 0;
    trigger = total;
    const outcome = await handoffStartPreview(world.db, 'wt-1', 'claude', { mem, brief: world.briefDeps() });
    expect(boundaryState(a)).toBe('superseded');
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ ok: false, code: 'boundary_changed' });
    expect(JSON.stringify(outcome.body)).not.toContain(a);
  });

  it('negative: nothing changes under the read — one build, the boundary as it was', async () => {
    const a = openPending();
    const held = heldStateReader();
    const running = handoffStartPreview(world.db, 'wt-1', 'claude', { mem: world.deps(), brief: world.briefDeps(held.deps) });
    await held.reached;
    held.release();
    const outcome = await running;
    expect(outcome.body).toMatchObject({ ok: true, show: true, mode, boundary: { id: a } });
    expect(held.calls()).toBe(1);
  });
});
