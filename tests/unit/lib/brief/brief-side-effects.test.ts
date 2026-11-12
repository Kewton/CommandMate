/**
 * I8 (Issue #4223, design §1.4・§7): the brief makes no copy and its read changes no
 * state — no table outside the allowed writes, no file, no auto-yes / latch / wait
 * rewrite, no relay or wait subscriber told, none of the functions that would.
 *
 * Each check is shown to bite: a reader doing what the first draft did (reading
 * auto-yes through `getAutoYesState`, observing a wait, writing a row) fails it.
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
vi.mock('@/lib/auto-yes-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auto-yes-state')>();
  return { ...actual, getAutoYesState: vi.fn(actual.getAutoYesState), disableAutoYes: vi.fn(actual.disableAutoYes) };
});
vi.mock('@/lib/session/status-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/status-evidence')>();
  return {
    ...actual,
    getLastKnownStatus: vi.fn(actual.getLastKnownStatus),
    forgetLastKnownStatus: vi.fn(actual.forgetLastKnownStatus),
    observeStatusEvidence: vi.fn(actual.observeStatusEvidence),
  };
});

import { createHash } from 'crypto';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import * as autoYes from '@/lib/auto-yes-state';
import * as evidence from '@/lib/session/status-evidence';
import { episodes, onWaitingEpisodeTransition, onWaitingTransition } from '@/lib/session/waiting-episode-state-store';
import { observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import { createModuleGraph, repoRelative } from '../../guards/route-tmux-reach';
import type { BriefSourceReader } from '@/lib/brief/sources';
import { BriefWorld, resetBriefMemory } from './brief-4223-harness';

const world = new BriefWorld();

/** Tables the brief may write (design §1.4): #4222's close and the lifetimes. */
const ALLOWED = new Set(['mem_items', 'mem_close_records', 'mem_notices', 'mem_worktree_incarnations']);

function snapshot(): Map<string, string> {
  const tables = world.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  const out = new Map<string, string>();
  for (const { name } of tables) {
    const rows = world.db.prepare(`SELECT * FROM "${name}"`).all();
    out.set(name, createHash('sha256').update(JSON.stringify(rows)).digest('hex'));
  }
  return out;
}
const changed = (before: Map<string, string>, after: Map<string, string>): string[] =>
  [...after.keys()].filter((name) => before.get(name) !== after.get(name)).sort();

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) files(full, out);
    else if (!/cm\.db(-wal|-shm|-journal)?$/.test(name)) out.push(`${repoRelative(full)}:${stat.size}:${stat.mtimeMs}`);
  }
  return out.sort();
}

const latches = (): Map<string, unknown> => (globalThis as { __lastKnownStatusByKey?: Map<string, unknown> }).__lastKnownStatusByKey!;

let transitions: unknown[];
let unsubscribe: Array<() => void>;

beforeEach(async () => {
  resetBriefMemory();
  world.open('brief-side-effects-4223-');
  world.worktree('wt-1', [
    { id: 'claude', cliTool: 'claude' },
    { id: 'codex', cliTool: 'codex' },
  ]);
  world.setMode('on');
  world.head = { ...world.head, branch: 'feature/4223-x' };
  await world.add('next', 'manual', { text: 'next step' });
  await world.add('waiting', 'at:2020-01-01T00:00+00:00', { text: 'ended' });
  world.task({ title: 'task' });
  world.runLog('2026-11-09', '4223', [{ issue: 4223, stage: 'verify', result: 'ok', at: '2026-11-09T00:00:00.000Z' }]);
  // State that a careless read would rewrite: an auto-yes grant past its deadline,
  // a latch past its TTL, an open wait.
  const past = Date.now() - 10 * 3_600_000;
  vi.spyOn(Date, 'now').mockReturnValue(past);
  autoYes.setAutoYesEnabled('wt-1', 'claude', true, 3_600_000, undefined, 'claude');
  vi.mocked(Date.now).mockRestore();
  evidence.observeStatusEvidence(autoYes.buildCompositeKey('wt-1', 'codex', 'codex'), { status: 'running', reason: 'x', evidence: 'positive' }, past);
  observeWaitingEdge({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex', waiting: true, now: past });
  transitions = [];
  unsubscribe = [onWaitingTransition((t) => transitions.push(t)), onWaitingEpisodeTransition((t) => transitions.push(t))];
  vi.mocked(autoYes.getAutoYesState).mockClear();
  vi.mocked(autoYes.disableAutoYes).mockClear();
  vi.mocked(evidence.getLastKnownStatus).mockClear();
  vi.mocked(evidence.forgetLastKnownStatus).mockClear();
  vi.mocked(evidence.observeStatusEvidence).mockClear();
});
afterEach(() => {
  for (const off of unsubscribe) off();
  world.close();
  resetBriefMemory();
});

interface Observed {
  tables: string[];
  files: boolean;
  autoYesRewritten: boolean;
  latchesKept: boolean;
  episodesKept: boolean;
  transitions: number;
  forbiddenCalls: number;
}

async function observe(readers: Parameters<BriefWorld['brief']>[1] = {}): Promise<Observed> {
  const before = snapshot();
  const filesBefore = files(world.dir);
  const grant = autoYes.peekAutoYesState('wt-1', 'claude', 'claude');
  const latchCount = latches().size;
  const episodeCount = episodes.size;
  for (const format of [null, 'json'] as const) {
    const run = await world.brief({ format, all: '1' }, readers);
    expect(run.exit).toBe(0);
  }
  const forbidden = [
    autoYes.getAutoYesState,
    autoYes.disableAutoYes,
    evidence.getLastKnownStatus,
    evidence.forgetLastKnownStatus,
    evidence.observeStatusEvidence,
  ].reduce((sum, fn) => sum + vi.mocked(fn).mock.calls.length, 0);
  return {
    tables: changed(before, snapshot()),
    files: files(world.dir).join('\n') === filesBefore.join('\n'),
    autoYesRewritten: autoYes.peekAutoYesState('wt-1', 'claude', 'claude') !== grant,
    latchesKept: latches().size === latchCount,
    episodesKept: episodes.size === episodeCount,
    transitions: transitions.length,
    forbiddenCalls: forbidden,
  };
}

describe('I8 the brief changes nothing it reads', () => {
  it('only the allowed tables, no file, no memory state, no subscriber, none of the forbidden calls', async () => {
    const seen = await observe();
    expect(seen.tables.every((name) => ALLOWED.has(name))).toBe(true);
    expect(seen.tables).toContain('mem_items'); // #4222's close of the met condition is the allowed write
    expect(seen).toMatchObject({ files: true, autoYesRewritten: false, latchesKept: true, episodesKept: true, transitions: 0, forbiddenCalls: 0 });
  });

  it('positive control: a reader that reads auto-yes the old way rewrites the grant and is counted', async () => {
    const careless: BriefSourceReader = (ctx) => {
      autoYes.getAutoYesState(ctx.worktreeId, 'claude', 'claude');
      return { status: 'ok', items: [] };
    };
    const seen = await observe({ readers: { 'auto-yes': careless } });
    expect(seen.autoYesRewritten).toBe(true);
    expect(seen.forbiddenCalls).toBeGreaterThan(0);
  });

  it('positive control: a reader that observes a wait tells the subscribers; one that writes a row changes a table', async () => {
    const observing: BriefSourceReader = (ctx) => {
      observeWaitingEdge({ worktreeId: ctx.worktreeId, cliToolId: 'claude', instanceId: 'claude', waiting: true, now: ctx.now });
      return { status: 'ok', items: [] };
    };
    expect((await observe({ readers: { state: observing } })).transitions).toBeGreaterThan(0);
    const writing: BriefSourceReader = (ctx) => {
      ctx.db.prepare("UPDATE tasks SET title = 'copied'").run();
      return { status: 'ok', items: [] };
    };
    expect((await observe({ readers: { task: writing } })).tables).toContain('tasks');
  });

  it('negative control: the ordinary monitoring still reaches the subscribers (the spy is wired)', () => {
    observeWaitingEdge({ worktreeId: 'wt-1', cliToolId: 'claude', instanceId: 'claude', waiting: true, now: Date.now() });
    expect(transitions.length).toBeGreaterThan(0);
  });

  // `waiting-episode-binding` is in the closure (status-evidence → agent-event-state
  // imports it) but never called: the transitions check above is what holds that.
  it('the brief reaches none of the modules that detect state or deliver relays', () => {
    const graph = createModuleGraph();
    const reach = new Set(
      [...graph.closure(path.join(process.cwd(), 'src/app/api/worktrees/[id]/mem/brief/route.ts')), ...graph.closure(path.join(process.cwd(), 'src/lib/brief/provider.ts'))].map(repoRelative)
    );
    for (const module of [
      'src/lib/session/worktree-status-helper.ts',
      'src/lib/relay/relay-triggers.ts',
      'src/lib/relay/relay-delivery.ts',
      'src/lib/relay/relay-service.ts',
    ]) {
      expect(reach.has(module)).toBe(false);
    }
  });
});
