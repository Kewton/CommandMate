/**
 * The relay watch of `tick` (Issue #4418, docs/design/flow-relay-watch-4418.md §7).
 *
 * The server is never called: the `relay-io.mjs` child is answered by a fake `run` from a
 * fixture snapshot (the receivers' history and the PM's relays), and `relay-io.mjs` itself is
 * tested with a fake `fetch`. Every case has its own tmpdir for the record, the lock and home.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../../scripts/flow/flow.mjs';
import { RELAY_IO_FILE, isAllowedCall, makeRunBounded } from '../../../../scripts/flow/runner.mjs';
import { NO_RELAY_TOLD_BY_DEFAULT, readRawFlowConfig } from '../../../../scripts/flow/config.mjs';
import { evaluateWatch, emptyState, readLastWatch } from '../../../../scripts/flow/relay-watch.mjs';
import { activityOf, footerShowsBackground, readSnapshot, relayIdOfRequest, screenHash, sendNotice } from '../../../../scripts/flow/relay-io.mjs';
import { TempDirs, fakeRun, ghByKind, io, ok, type Call, type RunAnswer } from './flow-fakes';

const temps = new TempDirs();
afterEach(() => temps.cleanup());

type Deps = NonNullable<Parameters<typeof main>[1]>;

const AT = Date.parse('2026-11-13T10:00:03.120Z');
const MIN = 60_000;
const SLUG = 'kewton.commandmate';
const PM = { worktreeId: 'mycodebranchdesk', instanceId: 'claude' };
const LEADER = { worktreeId: 'mycodebranchdesk', instanceId: 'claude-3' };
const JUDGE = { worktreeId: 'mycodebranchdesk', instanceId: 'claude-2' };
const WATCH_YAML = `relayWatch:
  pm: { worktreeId: mycodebranchdesk, instanceId: claude }
  receivers:
    - { worktreeId: mycodebranchdesk, instanceId: claude-3 }
    - { worktreeId: mycodebranchdesk, instanceId: claude-2 }
`;
function rolesWith(over: { launched?: Record<string, unknown> | null; cliToolId?: string; instanceId?: string } = {}) {
  return {
    '/api/worktrees/mycodebranchdesk/instances/roles': {
      success: true,
      instances: [
        {
          instanceId: over.instanceId ?? 'claude',
          cliToolId: over.cliToolId ?? 'claude',
          application: { launched: over.launched === undefined ? { sessionGeneration: 'gen-1', injectionFingerprint: 'fp-1' } : over.launched },
        },
      ],
    },
  };
}
const ROLES_OK = rolesWith();
/** Check 1 told (the switch back after #4420, design §5.1); the default only records it. */
const TELL_YAML = `${WATCH_YAML}  notifyNoRelay: true\n`;
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';

const iso = (ms: number) => new Date(ms).toISOString();
/** A receiver that finished its turn long ago and shows nothing running: what a real stall looks like. */
const IDLE = { sessionStatus: 'ready', thinking: false, lastEventType: 'stop', lastEventDetail: null, lastEventAt: AT - 90 * 60_000, backgroundFooter: false };

interface RelayFixture {
  id: string;
  to?: typeof LEADER;
  from?: typeof PM;
  state?: string;
  createdAt?: number;
  inputBoundaryAt?: number | null;
  expiresAt?: number;
  holdReason?: string | null;
  deliveryHold?: { state: string; payloadId: string; reason: string } | null;
  lastDeliveryBlock?: { reason: string } | null;
}

function relay(f: RelayFixture) {
  const createdAt = f.createdAt ?? AT - 30 * MIN;
  return {
    from: PM,
    to: LEADER,
    state: 'pending',
    hops: 1,
    sentRequestId: null,
    pendingKind: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + 24 * 60 * MIN,
    deliveredAt: null,
    inputBoundaryAt: createdAt + 1_000,
    holdReason: null,
    deliveryHold: null,
    lastDeliveryBlock: null,
    ...f,
  };
}

function msg(id: string, at: number, content = 'Issue #1 をお願いします', extra: Record<string, unknown> = {}) {
  const text = String(content);
  return {
    id,
    role: 'user',
    messageType: 'normal',
    instanceId: LEADER.instanceId,
    at: iso(at),
    requestId: null,
    head: text.slice(0, 80),
    startsWithFrom: text.startsWith('[from '),
    startsWithSlash: text.startsWith('/'),
    ...extra,
  };
}

interface Snapshot {
  awaiting: ReturnType<typeof relay>[];
  held: ReturnType<typeof relay>[] | null;
  closedBlocked: ReturnType<typeof relay>[];
  lookedUp: ReturnType<typeof relay>[];
  lookupFailed: string[];
  receivers: Array<{ worktreeId: string; instanceId: string; messages: ReturnType<typeof msg>[] | null; why: string | null }>;
  screens: Record<string, { isRunning: boolean | null; hash: string | null; activity?: Record<string, unknown> }>;
  verifyRunning?: Record<string, boolean | null>;
}

function snapshot(s: Partial<Omit<Snapshot, 'receivers'>> & { leader?: ReturnType<typeof msg>[] | null; judge?: ReturnType<typeof msg>[] | null; leaderScreen?: string; pmRunning?: boolean; leaderActivity?: Record<string, unknown> } = {}): Snapshot {
  return {
    awaiting: s.awaiting ?? [],
    held: s.held === undefined ? [] : s.held,
    closedBlocked: s.closedBlocked ?? [],
    lookedUp: s.lookedUp ?? [],
    lookupFailed: s.lookupFailed ?? [],
    receivers: [
      { ...LEADER, messages: s.leader === undefined ? [] : s.leader, why: s.leader === null ? 'http-500' : null },
      { ...JUDGE, messages: s.judge === undefined ? [] : s.judge, why: null },
    ],
    screens: {
      'mycodebranchdesk/claude': { isRunning: s.pmRunning ?? true, hash: 'pm-screen' },
      'mycodebranchdesk/claude-3': { isRunning: true, hash: s.leaderScreen ?? 'leader-screen-a', activity: s.leaderActivity ?? IDLE },
      'mycodebranchdesk/claude-2': { isRunning: true, hash: 'judge-screen' },
    },
    ...(s.screens ? { screens: s.screens } : {}),
    verifyRunning: s.verifyRunning ?? { mycodebranchdesk: false },
  };
}

interface CheckLine {
  state: string;
  count: number | null;
  items: Array<{ key: string } & Record<string, unknown>>;
}

interface WatchLine extends Record<string, unknown> {
  kind: string;
  status?: string;
  checks: { noRelay: CheckLine; stall: CheckLine; heldOrExpired: CheckLine };
  notice: { keys: string[]; attempt: boolean; why: string | null; recordOnly: string[] };
}

interface SnapshotOut {
  lookedUp: Array<{ id: string }>;
  receivers: Array<{ messages: Array<Record<string, unknown>> }>;
  screens: Record<string, unknown>;
}

interface World {
  deps: Deps;
  calls: Call[];
  nodeCalls: Array<{ action: string; input: Record<string, unknown> }>;
  io: ReturnType<typeof io>;
  flowDir: string;
  tick: (at: number, snap: Snapshot | RunAnswer, id?: string) => number;
  ticks: () => Array<Record<string, unknown>>;
  watch: () => WatchLine[];
}

function world(options: { yaml?: string; notify?: RunAnswer } = {}): World {
  const base = temps.make('flow-4418-');
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, '.commandmate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.commandmate', 'flow.yaml'), options.yaml ?? WATCH_YAML);
  const flowDir = path.join(base, 'flow');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const calls: Call[] = [];
  const nodeCalls: World['nodeCalls'] = [];
  const out = io();
  let answer: Snapshot | RunAnswer = snapshot();
  const git = fakeRun({}, ghByKind(ok('[]'), ok('[]')), calls);
  const run = (cmd: string, args: string[], opts: Call['options']): RunAnswer => {
    if (cmd !== process.execPath) return git(cmd, args, opts);
    calls.push({ cmd, args: [...args], options: opts });
    nodeCalls.push({ action: args[1], input: JSON.parse(args[2]) });
    if (args[1] === 'notify') return options.notify ?? ok('{"outcome":"sent"}\n');
    if ('status' in answer) return answer as RunAnswer;
    return ok(`${JSON.stringify(answer)}\n`);
  };
  let t = 0;
  const deps: Deps = {
    run,
    monoNow: () => (t += 1),
    now: () => AT,
    env: { CM_FLOW_DIR: flowDir, CM_VERIFY_LOCK_ROOT: path.join(base, 'locks') },
    home,
    cwd: root,
    stdout: out.stdout,
    stderr: out.stderr,
    uuid: () => 'tick-1',
  };
  const readLines = (dir: string): WatchLine[] =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((n) => n.endsWith('.jsonl'))
          .sort()
          .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
      : [];
  return {
    deps,
    calls,
    nodeCalls,
    io: out,
    flowDir,
    tick: (at, snap, id = `tick-${at}`) => {
      answer = snap;
      return main(['tick'], { ...deps, now: () => at, uuid: () => id });
    },
    ticks: () => readLines(path.join(flowDir, SLUG)),
    watch: () => readLines(path.join(flowDir, SLUG, 'relay-watch')),
  };
}

const lastWatch = (w: World) => w.watch().filter((l) => l.kind === 'relay-watch').pop()!;
const notices = (w: World) => w.nodeCalls.filter((c) => c.action === 'notify');

describe('#4418 check 1: a request with no relay', () => {
  it('a request in a receiver with no relay bound to it is found and told to the PM once', () => {
    const w = world({ yaml: TELL_YAML });
    expect(w.tick(AT, snapshot({ leader: [msg('m1', AT - 40 * MIN)] }))).toBe(0);
    const line = lastWatch(w);
    expect(line.status).toBe('ok');
    expect(line.checks.noRelay).toMatchObject({ state: 'found', count: 1, items: [{ key: 'no-relay:m1', to: LEADER }] });
    expect(notices(w)).toHaveLength(1);
    const text = String(notices(w)[0].input.text);
    expect(text.startsWith('[from flow-watch / mycodebranchdesk] ')).toBe(true);
    expect(text).toContain('relay なしの依頼 mycodebranchdesk/claude-3');
    expect(notices(w)[0].input.pm).toEqual(PM);
    expect(w.watch().filter((l) => l.kind === 'relay-watch-notice')).toEqual([expect.objectContaining({ outcome: 'sent', keys: ['no-relay:m1'] })]);
  });

  it.each([
    ['bound by inputBoundaryAt (open relay)', { awaiting: [relay({ id: R1, createdAt: AT - 41 * MIN, inputBoundaryAt: AT - 40 * MIN + 800 })] }],
    ['bound by a delivered relay the PM history names', { lookedUp: [relay({ id: R1, state: 'delivered', createdAt: AT - 41 * MIN, inputBoundaryAt: AT - 40 * MIN })] }],
    ['bound by a legacy relay (no boundary) opened just before', { awaiting: [relay({ id: R1, createdAt: AT - 40 * MIN - 30_000, inputBoundaryAt: null })] }],
  ])('(control) %s: not found', (_name, s) => {
    const w = world({ yaml: TELL_YAML });
    expect(w.tick(AT, snapshot({ leader: [msg('m1', AT - 40 * MIN)], ...s }))).toBe(0);
    expect(lastWatch(w).checks.noRelay).toEqual({ state: 'unobserved', count: 0, items: [] });
    expect(notices(w)).toHaveLength(0);
  });

  it('(control) a relay to another session, or one 6 s off, does not bind it', () => {
    const w = world();
    const s = snapshot({
      leader: [msg('m1', AT - 40 * MIN)],
      awaiting: [relay({ id: R1, to: JUDGE, inputBoundaryAt: AT - 40 * MIN }), relay({ id: R2, inputBoundaryAt: AT - 40 * MIN + 6_000 })],
    });
    expect(w.tick(AT, s)).toBe(0);
    expect(lastWatch(w).checks.noRelay.state).toBe('found');
  });

  it('relay deliveries, slash commands, prompt answers and assistant rows are not requests; older than 24 h is out', () => {
    const w = world();
    const s = snapshot({
      leader: [
        msg('a', AT - 10 * MIN, '[from Codex / x] reply'),
        msg('b', AT - 10 * MIN, '/clear'),
        msg('c', AT - 10 * MIN, 'yes', { messageType: 'prompt_response' }),
        msg('d', AT - 10 * MIN, 'done', { role: 'assistant' }),
        msg('e', AT - 25 * 60 * MIN),
      ],
    });
    expect(w.tick(AT, s)).toBe(0);
    expect(lastWatch(w).checks.noRelay.state).toBe('unobserved');
  });

  it('0 requests is recorded as "unobserved" (not 0 found), for every check', () => {
    const w = world();
    expect(w.tick(AT, snapshot())).toBe(0);
    const line = lastWatch(w);
    expect(line.checks).toEqual({
      noRelay: { state: 'unobserved', count: 0, items: [] },
      stall: { state: 'unobserved', count: 0, items: [], waiting: [] },
      heldOrExpired: { state: 'unobserved', count: 0, items: [] },
    });
    expect(line.notice).toMatchObject({ keys: [], attempt: false, why: 'nothing-new' });
    expect(notices(w)).toHaveLength(0);
  });

  it('a receiver whose history could not be read makes the check "unknown", not "unobserved"', () => {
    const w = world();
    expect(w.tick(AT, snapshot({ leader: null }))).toBe(0);
    expect(lastWatch(w).checks.noRelay).toMatchObject({ state: 'unknown', count: null });
  });
});

describe('#4418 check 1 is recorded, not told, until #4420 (design §5.1)', () => {
  it('by default a request with no relay is recorded on every tick but never told', () => {
    const w = world();
    const s = snapshot({ leader: [msg('m1', AT - 40 * MIN)] });
    expect(w.tick(AT - 15 * MIN, s)).toBe(0);
    expect(w.tick(AT, s)).toBe(0);
    const line = lastWatch(w);
    expect(line.checks.noRelay).toMatchObject({ state: 'found', count: 1, items: [{ key: 'no-relay:m1' }] });
    expect(line.notice).toEqual({ keys: [], attempt: false, why: 'record-only', recordOnly: ['no-relay:m1'] });
    expect(line.reported).toEqual([]);
    expect(notices(w)).toHaveLength(0);
    expect(w.watch().filter((l) => l.kind === 'relay-watch-notice')).toEqual([]);
  });

  it('with STALL and held in the same tick, only those are told; the request with no relay stays record-only', () => {
    const w = world();
    const pending = relay({ id: R1, createdAt: AT - 100 * MIN, inputBoundaryAt: AT - 100 * MIN });
    const held = relay({ id: R2, deliveryHold: { state: 'uncertain', payloadId: 'p1', reason: 'timeout' } });
    w.tick(AT - 30 * MIN, snapshot({ awaiting: [pending], leader: [msg('m1', AT - 40 * MIN)] }));
    w.tick(AT, snapshot({ awaiting: [pending, held], held: [held], leader: [msg('m1', AT - 40 * MIN)] }));
    const all = notices(w).map((n) => String(n.input.text)).join('\n');
    expect(all).toContain('STALL の疑い');
    expect(all).toContain('配送の保留');
    expect(all).not.toContain('relay なしの依頼');
    expect(w.watch().filter((l) => l.kind === 'relay-watch-notice').flatMap((l) => l.keys as string[])).not.toContain('no-relay:m1');
    expect(lastWatch(w).notice.recordOnly).toEqual(['no-relay:m1']);
  });

  it('(switch back) notifyNoRelay: true tells it once; after the switch the recorded one is told on the first tick', () => {
    const before = world();
    const s = snapshot({ leader: [msg('m1', AT - 40 * MIN)] });
    before.tick(AT - 15 * MIN, s);
    expect(notices(before)).toHaveLength(0);
    const after = world({ yaml: TELL_YAML });
    after.tick(AT, s);
    after.tick(AT + 15 * MIN, s);
    expect(notices(after)).toHaveLength(1);
    expect(String(notices(after)[0].input.text)).toContain('relay なしの依頼');
  });

  it('notifyNoRelay must be a boolean (exit 2)', () => {
    const w = world({ yaml: `${WATCH_YAML}  notifyNoRelay: "yes"\n` });
    expect(main(['tick'], w.deps)).toBe(2);
    expect(w.io.err.join('\n')).toContain('relayWatch.notifyNoRelay');
  });

  it('the repository flow.yaml keeps check 1 record-only', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const raw = readRawFlowConfig(repoRoot) as { settings?: { relayWatch?: { notifyNoRelay?: unknown } } };
    expect(raw.settings?.relayWatch).toBeDefined();
    expect(raw.settings?.relayWatch?.notifyNoRelay ?? NO_RELAY_TOLD_BY_DEFAULT).toBe(false);
    expect(NO_RELAY_TOLD_BY_DEFAULT).toBe(false);
  });

  it('lane b stands alone: the watch imports nothing outside scripts/flow and node: (no pm-send entry)', () => {
    const dir = path.resolve(__dirname, '../../../../scripts/flow');
    for (const f of ['relay-watch.mjs', 'relay-io.mjs']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const specs = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
      for (const spec of specs) expect(spec.startsWith('node:') || spec.startsWith('./')).toBe(true);
      expect(src).not.toMatch(/pm-send/);
    }
  });
});

describe('#4418 check 2: STALL', () => {
  const pending = relay({ id: R1, createdAt: AT - 100 * MIN, inputBoundaryAt: AT - 100 * MIN });

  it('pending 60 min or more and the screen unchanged 20 min or more across ticks: STALL', () => {
    const w = world();
    expect(w.tick(AT - 30 * MIN, snapshot({ awaiting: [pending] }))).toBe(0);
    expect(lastWatch(w).checks.stall.state).toBe('unobserved');
    expect(w.tick(AT - 15 * MIN, snapshot({ awaiting: [pending] }))).toBe(0);
    expect(lastWatch(w).checks.stall.state).toBe('unobserved');
    expect(w.tick(AT, snapshot({ awaiting: [pending] }))).toBe(0);
    expect(lastWatch(w).checks.stall).toMatchObject({ state: 'found', items: [{ key: `stall:${R1}`, pendingMinutes: 100, screenMinutes: 30 }] });
    expect(notices(w)).toHaveLength(1);
    const text = String(notices(w)[0].input.text);
    expect(text).toContain(`STALL の疑い relay=${R1.slice(0, 8)}`);
    expect(text).toContain('画面 30 分不変・動いている証拠なし。待機中の可能性は残る');
  });

  it('(control) the screen changed between ticks: not STALL', () => {
    const w = world();
    w.tick(AT - 30 * MIN, snapshot({ awaiting: [pending], leaderScreen: 'a' }));
    w.tick(AT - 15 * MIN, snapshot({ awaiting: [pending], leaderScreen: 'b' }));
    w.tick(AT, snapshot({ awaiting: [pending], leaderScreen: 'b' }));
    expect(lastWatch(w).checks.stall.state).toBe('unobserved');
  });

  it('(control) pending under 60 min, a prompt relay, and a closed relay are not STALL', () => {
    const w = world();
    const young = relay({ id: R2, createdAt: AT - 50 * MIN, inputBoundaryAt: AT - 50 * MIN });
    const prompt = relay({ id: R3, state: 'prompt', createdAt: AT - 100 * MIN });
    w.tick(AT - 30 * MIN, snapshot({ awaiting: [young, prompt] }));
    w.tick(AT, snapshot({ awaiting: [young, prompt], lookedUp: [relay({ id: R1, state: 'delivered', createdAt: AT - 100 * MIN })] }));
    expect(lastWatch(w).checks.stall.state).toBe('unobserved');
  });

  it('the thresholds come from flow.yaml', () => {
    const w = world({ yaml: `${WATCH_YAML}  pendingMinutes: 120\n` });
    w.tick(AT - 30 * MIN, snapshot({ awaiting: [pending] }));
    w.tick(AT, snapshot({ awaiting: [pending] }));
    expect(lastWatch(w).checks.stall.state).toBe('unobserved');
  });
});

describe('#4418 check 2: an unchanged screen with evidence of work is not STALL (design §4.2 (A)(B))', () => {
  const pending = relay({ id: R1, createdAt: AT - 100 * MIN, inputBoundaryAt: AT - 100 * MIN });
  const twoTicks = (w: World, s: Partial<Parameters<typeof snapshot>[0]>) => {
    w.tick(AT - 30 * MIN, snapshot({ awaiting: [pending], ...s }));
    return w.tick(AT, snapshot({ awaiting: [pending], ...s }));
  };

  it.each([
    ['background shells (claude stop with self_resume_pending)', { leaderActivity: { ...IDLE, lastEventDetail: 'self_resume_pending' } }, 'background-pending'],
    ['background shells shown in the footer', { leaderActivity: { ...IDLE, backgroundFooter: true } }, 'background-footer'],
    ['the session is processing', { leaderActivity: { ...IDLE, sessionStatus: 'running' } }, 'session-running'],
    ['thinking', { leaderActivity: { ...IDLE, thinking: true } }, 'thinking'],
    ['a recent tool hook event', { leaderActivity: { ...IDLE, lastEventType: 'post_tool_use', lastEventAt: AT - 5 * MIN } }, 'recent-hook-event'],
    ['a verification run in the receiver worktree', { verifyRunning: { mycodebranchdesk: true } }, 'verify-running'],
  ])('(negative) %s: not STALL, not told, recorded as waiting with the evidence', (_name, s, evidence) => {
    const w = world();
    expect(twoTicks(w, s as Partial<Parameters<typeof snapshot>[0]>)).toBe(0);
    const stall = lastWatch(w).checks.stall as CheckLine & { waiting: Array<{ key: string; evidence: string[] }> };
    expect(stall.state).toBe('unobserved');
    expect(stall.waiting).toEqual([expect.objectContaining({ key: `waiting:${R1}`, evidence: expect.arrayContaining([evidence]) })]);
    expect(notices(w)).toHaveLength(0);
  });

  it('(positive control) a recent stop is the end of work, not work: still STALL', () => {
    const w = world();
    expect(twoTicks(w, { leaderActivity: { ...IDLE, lastEventAt: AT - 5 * MIN } })).toBe(0);
    expect(lastWatch(w).checks.stall).toMatchObject({ state: 'found', items: [{ key: `stall:${R1}` }] });
    expect(notices(w)).toHaveLength(1);
  });

  it('(positive control) the activity unknown (an older server) is no evidence: STALL', () => {
    const w = world();
    expect(twoTicks(w, { leaderActivity: {}, verifyRunning: { mycodebranchdesk: null } })).toBe(0);
    expect(lastWatch(w).checks.stall.state).toBe('found');
  });

  it('(B) waiting with evidence for 4 × pendingMinutes is told once as a long wait, naming the evidence', () => {
    const w = world();
    const old = relay({ id: R1, createdAt: AT - 250 * MIN, inputBoundaryAt: AT - 250 * MIN });
    const s = { awaiting: [old], leaderActivity: { ...IDLE, lastEventDetail: 'self_resume_pending' } };
    w.tick(AT - 30 * MIN, snapshot(s));
    w.tick(AT, snapshot(s));
    w.tick(AT + 15 * MIN, snapshot(s));
    expect(lastWatch(w).checks.stall.items[0]).toMatchObject({ key: `stall-long:${R1}`, evidence: ['background-pending'] });
    expect(notices(w)).toHaveLength(1);
    expect(String(notices(w)[0].input.text)).toContain('長い待機');
    expect(String(notices(w)[0].input.text)).toContain('background-pending');
  });
});

describe('#4418 check 3: held or expired', () => {
  it.each([
    ['a delivery hold (uncertain)', { held: [relay({ id: R1, deliveryHold: { state: 'uncertain', payloadId: 'p1', reason: 'submit-unconfirmed' } })] }, `held:${R1}:p1`],
    ['a send binding hold', { awaiting: [relay({ id: R1, holdReason: 'send_unknown' })] }, `hold:${R1}:send_unknown`],
    ['an expired relay read by id', { lookedUp: [relay({ id: R1, state: 'expired', expiresAt: AT - 5 * MIN })] }, `expired:${R1}`],
    ['an expiry notice not delivered', { closedBlocked: [relay({ id: R1, state: 'expired', lastDeliveryBlock: { reason: 'prompt_waiting' } })] }, `expired:${R1}`],
    ['an open relay past expiresAt', { awaiting: [relay({ id: R1, expiresAt: AT - MIN })] }, `expired:${R1}`],
  ])('%s is found', (_name, s, key) => {
    const w = world();
    expect(w.tick(AT, snapshot(s as Partial<Snapshot>))).toBe(0);
    expect(lastWatch(w).checks.heldOrExpired).toMatchObject({ state: 'found', items: [{ key }] });
    expect(notices(w)).toHaveLength(1);
  });

  it.each([
    ['a hold still attempting', { held: [relay({ id: R1, deliveryHold: { state: 'attempting', payloadId: 'p1', reason: '' } })] }],
    ['a delivered relay', { lookedUp: [relay({ id: R1, state: 'delivered' })] }],
    ['a cancelled relay', { lookedUp: [relay({ id: R1, state: 'cancelled' })] }],
    ['a held relay the PM is not owed', { held: [relay({ id: R1, from: JUDGE, to: PM, deliveryHold: { state: 'uncertain', payloadId: 'p1', reason: 'x' } })] }],
  ])('(control) %s is not', (_name, s) => {
    const w = world();
    expect(w.tick(AT, snapshot(s as Partial<Snapshot>))).toBe(0);
    expect(lastWatch(w).checks.heldOrExpired.state).toBe('unobserved');
  });

  it('a relay seen open and gone from the list is read by id on the next tick', () => {
    const w = world();
    w.tick(AT - 15 * MIN, snapshot({ awaiting: [relay({ id: R1 })] }));
    w.tick(AT, snapshot({ lookedUp: [relay({ id: R1, state: 'expired', expiresAt: AT - MIN })] }));
    expect(w.nodeCalls.filter((c) => c.action === 'read')[1].input.lookupIds).toEqual([R1]);
    expect(lastWatch(w).checks.heldOrExpired.items[0].key).toBe(`expired:${R1}`);
  });
});

describe('#4418 telling the PM', () => {
  it('the same finding is not told again on the second tick; a new one is', () => {
    const w = world({ yaml: TELL_YAML });
    const first = snapshot({ leader: [msg('m1', AT - 40 * MIN)] });
    w.tick(AT - 15 * MIN, first);
    w.tick(AT, first);
    expect(notices(w)).toHaveLength(1);
    expect(lastWatch(w).checks.noRelay.state).toBe('found');
    expect(lastWatch(w).notice).toMatchObject({ keys: [], attempt: false });
    w.tick(AT + 15 * MIN, snapshot({ leader: [msg('m1', AT - 40 * MIN), msg('m2', AT + 5 * MIN)] }));
    expect(notices(w)).toHaveLength(2);
    expect(lastWatch(w).notice.keys).toEqual(['no-relay:m2']);
  });

  it('(mutation) without the previous line every tick would tell it again', () => {
    const w = world({ yaml: TELL_YAML });
    const first = snapshot({ leader: [msg('m1', AT - 40 * MIN)] });
    w.tick(AT - 15 * MIN, first);
    fs.rmSync(path.join(w.flowDir, SLUG, 'relay-watch'), { recursive: true });
    w.tick(AT, first);
    expect(notices(w)).toHaveLength(2);
  });

  it('the PM not running: nothing sent and not marked as told, so the next tick sends it', () => {
    const w = world({ yaml: TELL_YAML });
    w.tick(AT - 15 * MIN, snapshot({ leader: [msg('m1', AT - 40 * MIN)], pmRunning: false }));
    expect(notices(w)).toHaveLength(0);
    expect(lastWatch(w).notice).toMatchObject({ attempt: false, why: 'pm-not-running' });
    w.tick(AT, snapshot({ leader: [msg('m1', AT - 40 * MIN)] }));
    expect(notices(w)).toHaveLength(1);
  });

  it('the attempt is marked before the send: an unknown outcome is not sent again', () => {
    const w = world({ yaml: TELL_YAML, notify: { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } } });
    const s = snapshot({ leader: [msg('m1', AT - 40 * MIN)] });
    w.tick(AT - 15 * MIN, s);
    w.tick(AT, s);
    expect(notices(w)).toHaveLength(1);
    expect(w.watch().filter((l) => l.kind === 'relay-watch-notice')).toEqual([expect.objectContaining({ outcome: 'unknown' })]);
  });

  it('more than 5 new items: one line naming 5 and the rest as a count', () => {
    const w = world({ yaml: TELL_YAML });
    w.tick(AT, snapshot({ leader: Array.from({ length: 7 }, (_, i) => msg(`m${i}`, AT - (i + 1) * MIN)) }));
    const text = String(notices(w)[0].input.text);
    expect(text).not.toContain('\n');
    expect(text).toContain('新しく 7 件');
    expect(text).toContain('ほか 2 件');
  });
});

describe('#4418 the measurement is kept', () => {
  it.each([
    ['the child timed out', { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }, 'timeout'],
    ['the child failed', { status: 1, stdout: '', stderr: 'boom' }, 'fail'],
    ['the server is down', ok('{"error":"server-down"}\n'), 'server-down'],
    ['the child printed garbage', ok('not json\n'), 'schema'],
  ])('%s: the tick line is written as before, exit 0, the watch line is "unknown"', (_name, answer, why) => {
    const w = world();
    expect(w.tick(AT, answer as RunAnswer)).toBe(0);
    const ticks = w.ticks();
    expect(ticks).toHaveLength(1);
    expect(Object.keys(ticks[0]).sort()).toEqual(['at', 'base', 'durationMs', 'kind', 'metrics', 'repo', 'tickId', 'v', 'window'].sort());
    expect(Object.keys(ticks[0].metrics as object).sort()).toEqual(['prCreated', 'prMerged']);
    expect(lastWatch(w)).toMatchObject({ status: 'unknown', why, checks: { noRelay: { state: 'unknown' }, stall: { state: 'unknown' }, heldOrExpired: { state: 'unknown' } } });
    expect(w.io.err.some((l) => l.startsWith('flow: relay watch:'))).toBe(true);
    expect(notices(w)).toHaveLength(0);
  });

  it('a failed read keeps what was told: the next good tick does not tell it again', () => {
    const w = world({ yaml: TELL_YAML });
    const s = snapshot({ leader: [msg('m1', AT - 40 * MIN)] });
    w.tick(AT - 30 * MIN, s);
    w.tick(AT - 15 * MIN, { status: 1, stdout: '', stderr: '' });
    w.tick(AT, s);
    expect(notices(w)).toHaveLength(1);
  });

  it('an unfinished tail in the watch record: nothing sent, the tick line still written', () => {
    const w = world();
    const dir = path.join(w.flowDir, SLUG, 'relay-watch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11-13.jsonl'), '{"half":');
    expect(main(['tick'], { ...w.deps, env: { ...w.deps.env, TZ: 'UTC' } })).toBe(0);
    expect(w.ticks()).toHaveLength(1);
    expect(notices(w)).toHaveLength(0);
    expect(w.io.err.some((l) => l.includes('nothing sent'))).toBe(true);
  });

  it('the watch calls run under the watch budget through the runner, only the allowed form', () => {
    const w = world({ yaml: TELL_YAML });
    w.tick(AT, snapshot({ leader: [msg('m1', AT - 40 * MIN)] }));
    const node = w.calls.filter((c) => c.cmd === process.execPath);
    expect(node.map((c) => c.args[1])).toEqual(['read', 'notify']);
    for (const c of w.calls) expect(isAllowedCall(c.cmd, c.args), JSON.stringify(c.args.slice(0, 2))).toBe(true);
    expect(node[0].options).toMatchObject({ timeout: 45_000, killSignal: 'SIGKILL' });
  });

  it('(control) without relayWatch in flow.yaml: no Node child, no watch record, one output line', () => {
    const w = world({ yaml: 'version: 1\n' });
    expect(main(['tick'], w.deps)).toBe(0);
    expect(w.calls.filter((c) => c.cmd === process.execPath)).toEqual([]);
    expect(fs.existsSync(path.join(w.flowDir, SLUG, 'relay-watch'))).toBe(false);
    expect(w.io.out).toHaveLength(1);
    expect(w.io.out[0]).not.toContain('relayWatch');
  });

  it('status and report read the tick lines only (the watch dir is not a record file)', () => {
    const w = world();
    w.tick(AT, snapshot({ leader: [msg('m1', AT - 40 * MIN)] }));
    const out = io();
    expect(main(['status', '--json'], { ...w.deps, stdout: out.stdout })).toBe(0);
    expect(JSON.parse(out.out[0])).toMatchObject({ state: 'observed', corruptLines: 0, truncated: false, unfinishedTail: false });
    const rep = io();
    expect(main(['report', '--from', '2026-11-13T00:00:00Z', '--to', '2026-11-14T00:00:00Z', '--json'], { ...w.deps, stdout: rep.stdout })).toBe(0);
    expect(JSON.parse(rep.out[0]).observations).toHaveLength(1);
  });
});

describe('#4418 a read that failed is not a resolution (design §5)', () => {
  const pending = relay({ id: R1, createdAt: AT - 100 * MIN, inputBoundaryAt: AT - 100 * MIN });
  const leaderDown = (s: Snapshot): Snapshot => ({ ...s, screens: { ...s.screens, 'mycodebranchdesk/claude-3': { isRunning: null, hash: null } } });

  it('only current-output failing (500) for one tick between: the same STALL is not told again', () => {
    const w = world();
    w.tick(AT - 30 * MIN, snapshot({ awaiting: [pending] }));
    w.tick(AT - 15 * MIN, snapshot({ awaiting: [pending] }));
    w.tick(AT, snapshot({ awaiting: [pending] }));
    expect(notices(w)).toHaveLength(1);
    w.tick(AT + 15 * MIN, leaderDown(snapshot({ awaiting: [pending] })));
    const failed = lastWatch(w);
    expect(failed.checks.stall.state).toBe('unknown');
    expect(failed.reported).toContain(`stall:${R1}`);
    for (const k of [30, 45, 60]) w.tick(AT + k * MIN, snapshot({ awaiting: [pending] }));
    expect(notices(w)).toHaveLength(1);
    expect(lastWatch(w).checks.stall).toMatchObject({ state: 'found', items: [{ key: `stall:${R1}` }] });
  });

  it('(control) read and resolved — the relay closed — forgets it; a later STALL of the same relay is told again', () => {
    const w = world();
    w.tick(AT - 30 * MIN, snapshot({ awaiting: [pending] }));
    w.tick(AT, snapshot({ awaiting: [pending] }));
    expect(notices(w)).toHaveLength(1);
    w.tick(AT + 15 * MIN, snapshot({ awaiting: [] }));
    expect(lastWatch(w).reported).toEqual([]);
    w.tick(AT + 30 * MIN, snapshot({ awaiting: [pending] }));
    expect(notices(w)).toHaveLength(2);
  });

  it('a receiver history or the held list that could not be read keeps their told keys', () => {
    const w = world({ yaml: TELL_YAML });
    const held = relay({ id: R2, deliveryHold: { state: 'uncertain', payloadId: 'p1', reason: 'timeout' } });
    w.tick(AT - 15 * MIN, snapshot({ leader: [msg('m1', AT - 40 * MIN)], held: [held] }));
    expect(notices(w)).toHaveLength(1);
    w.tick(AT, snapshot({ leader: null, held: null }));
    expect([...(lastWatch(w).reported as string[])].sort()).toEqual([`held:${R2}:p1`, 'no-relay:m1'].sort());
    w.tick(AT + 15 * MIN, snapshot({ leader: [msg('m1', AT - 40 * MIN)], held: [held] }));
    expect(notices(w)).toHaveLength(1);
  });

  it('a notice the server refused (not_sent: the PM stopped) is tried again on the next tick; unknown is not', () => {
    const w = world({ notify: ok('{"outcome":"not_sent","why":"role_condition_unmet"}\n') });
    const held = relay({ id: R2, deliveryHold: { state: 'uncertain', payloadId: 'p1', reason: 'timeout' } });
    w.tick(AT - 15 * MIN, snapshot({ held: [held] }));
    w.tick(AT, snapshot({ held: [held] }));
    expect(notices(w)).toHaveLength(2);
    expect(w.watch().filter((l) => l.kind === 'relay-watch-notice').map((l) => l.outcome)).toEqual(['not_sent', 'not_sent']);
  });
});

describe('#4418 the state past the record size limit (design §6.1)', () => {
  it('a day file over 16 MiB: the newest state is read from its end; nothing is told twice, nothing removed', () => {
    const w = world();
    const held = relay({ id: R2, deliveryHold: { state: 'uncertain', payloadId: 'p1', reason: 'timeout' } });
    w.tick(AT - 30 * MIN, snapshot());
    const dir = path.join(w.flowDir, SLUG, 'relay-watch');
    const [name] = fs.readdirSync(dir);
    const file = path.join(dir, name);
    fs.appendFileSync(file, `${JSON.stringify({ v: 1, kind: 'relay-watch-notice', pad: 'x'.repeat(17 * 1024 * 1024) })}\n`);
    w.tick(AT - 15 * MIN, snapshot({ held: [held] }));
    expect(fs.statSync(file).size).toBeGreaterThan(16 * 1024 * 1024);
    w.tick(AT, snapshot({ held: [held] }));
    expect(notices(w)).toHaveLength(1);
    expect(lastWatch(w).reported).toEqual([`held:${R2}:p1`]);
    expect(fs.readdirSync(dir)).toEqual([name]);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(5);
  });

  it('readLastWatch grows its window from the end until a state line is in it', () => {
    const dir = temps.make('flow-4418-tail-');
    const scope = { repo: 'kewton/commandmate', base: 'develop' };
    const state = { v: 1, kind: 'relay-watch', ...scope, tickId: 't1', at: iso(AT), screens: {}, relays: {}, reported: ['held:x:p'] };
    const notice = (i: number) => JSON.stringify({ v: 1, kind: 'relay-watch-notice', ...scope, tickId: `n${i}`, outcome: 'sent', keys: [] });
    const lines = [JSON.stringify({ ...state, reported: ['old'] }), JSON.stringify(state), ...Array.from({ length: 40 }, (_, i) => notice(i))];
    fs.writeFileSync(path.join(dir, '2026-11-13.jsonl'), `${lines.join('\n')}\n{"unfinished":`);
    expect(readLastWatch(dir, scope, { firstBytes: 64, maxBytes: 1 << 20 }).reported).toEqual(['held:x:p']);
    expect(readLastWatch(dir, scope, { firstBytes: 64, maxBytes: 256 }).reported).toEqual([]);
  });
});

describe('#4418 settings', () => {
  const tickWith = (yaml: string) => {
    const w = world({ yaml });
    return { code: main(['tick'], w.deps), w };
  };

  it.each([
    ['no pm', 'relayWatch:\n  receivers: [{ worktreeId: a, instanceId: b }]\n', 'relayWatch.pm'],
    ['no receivers', 'relayWatch:\n  pm: { worktreeId: a, instanceId: b }\n', 'relayWatch.receivers'],
    ['the PM as a receiver', 'relayWatch:\n  pm: { worktreeId: a, instanceId: b }\n  receivers: [{ worktreeId: a, instanceId: b }]\n', 'the PM itself'],
    ['an unknown key', `${WATCH_YAML}  notifyTo: x\n`, 'relayWatch.notifyTo'],
    ['a remote url', `${WATCH_YAML}  url: http://example.com:3000\n`, 'relayWatch.url'],
    ['a bad instance id', 'relayWatch:\n  pm: { worktreeId: a, instanceId: "b c" }\n  receivers: [{ worktreeId: a, instanceId: d }]\n', 'instanceId'],
    ['pendingMinutes 0', `${WATCH_YAML}  pendingMinutes: 0\n`, 'pendingMinutes'],
  ])('%s: exit 2 before the lock, nothing called', (_name, yaml, said) => {
    const { code, w } = tickWith(yaml);
    expect(code).toBe(2);
    expect(w.io.err.join('\n')).toContain(said);
    expect(w.calls.filter((c) => c.cmd !== 'git')).toEqual([]);
  });

  it('(control) a localhost url is accepted and passed to the child; flow-wip still reads the file', () => {
    const yaml = `${WATCH_YAML}  url: http://127.0.0.1:3015\n`;
    const { code, w } = tickWith(yaml);
    expect(code).toBe(0);
    expect(w.nodeCalls[0].input.url).toBe('http://127.0.0.1:3015');
    const root = path.join(path.dirname(w.flowDir), 'repo');
    expect(readRawFlowConfig(root)).not.toHaveProperty('error');
  });

  it('the repository flow.yaml is accepted', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    expect(readRawFlowConfig(repoRoot)).not.toHaveProperty('error');
  });
});

describe('#4418 evaluateWatch (pure)', () => {
  it('the screen "since" moves only when the hash changes', () => {
    const settings = { pm: PM, receivers: [LEADER], pendingMinutes: 60, screenMinutes: 20 };
    const s = snapshot();
    const a = evaluateWatch({ snapshot: s, previous: emptyState(), settings, nowMs: AT });
    const b = evaluateWatch({ snapshot: s, previous: { ...emptyState(), screens: a.screens }, settings, nowMs: AT + 15 * MIN });
    expect(b.screens['mycodebranchdesk/claude-3'].since).toBe(iso(AT));
  });
});

describe('#4418 relay-io.mjs (fake fetch, no server)', () => {
  function fakeFetch(routes: Record<string, unknown>, seen: Array<{ url: string; init: RequestInit }>) {
    return async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      if (!key) return new Response(JSON.stringify({ error: 'nf' }), { status: 404 });
      const value = routes[key] as { __status?: number; body?: unknown };
      if (value && typeof value === 'object' && '__status' in value) return new Response(JSON.stringify(value.body), { status: value.__status });
      return new Response(JSON.stringify(routes[key]), { status: 200 });
    };
  }

  it('read: the PM relays, ids from the PM history read by id, receiver history, screen hashes', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const routes = {
      '/api/relays?worktree=mycodebranchdesk&instance=claude': { awaiting: [relay({ id: R1 })], held: [], closedBlocked: [], counts: {} },
      '/api/worktrees/mycodebranchdesk/messages?instance=claude&limit=200': [
        { id: 'p1', role: 'user', content: '[from x] y', timestamp: iso(AT), messageType: 'relay', requestId: `relay:${R2}` },
        { id: 'p2', role: 'user', content: 'z', timestamp: iso(AT), requestId: `relay-sys:${R1}:expired` },
      ],
      [`/api/relays/${R2}`]: { relay: relay({ id: R2, state: 'delivered' }) },
      '/api/worktrees/mycodebranchdesk/messages?instance=claude-3&limit=100': [{ id: 'm1', role: 'user', content: 'do it', timestamp: iso(AT), messageType: 'normal', instanceId: 'claude-3' }],
      '/api/worktrees/mycodebranchdesk/current-output?instance=claude': { isRunning: true, fullOutput: 'pm' },
      '/api/worktrees/mycodebranchdesk/current-output?instance=claude-3': { isRunning: true, fullOutput: 'working 12s', sessionStatus: 'ready', structuredEvents: { lastEventType: 'stop', lastEventDetail: 'self_resume_pending', lastEventAt: AT } },
      '/api/worktrees/mycodebranchdesk/verify/runs?limit=5': { runs: [{ id: 'v1', status: 'passed' }, { id: 'v2', status: 'running' }] },
    };
    const snap = (await readSnapshot({ url: 'http://localhost:3015', pm: PM, receivers: [LEADER] }, { fetch: fakeFetch(routes, seen) as never, env: { CM_AUTH_TOKEN: 'tok' } })) as unknown as SnapshotOut;
    expect(snap.lookedUp.map((r) => r.id)).toEqual([R2]);
    expect(snap.receivers[0].messages[0]).toMatchObject({ id: 'm1', head: 'do it', startsWithFrom: false });
    expect(snap.screens['mycodebranchdesk/claude-3']).toEqual({
      isRunning: true,
      hash: screenHash('working 99s'),
      activity: { sessionStatus: 'ready', thinking: false, lastEventType: 'stop', lastEventDetail: 'self_resume_pending', lastEventAt: AT, backgroundFooter: false },
    });
    expect((snap as unknown as { verifyRunning: Record<string, boolean> }).verifyRunning).toEqual({ mycodebranchdesk: true });
    expect(seen.every((s) => s.url.startsWith('http://localhost:3015/') && (s.init.method ?? 'GET') === 'GET')).toBe(true);
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('read: the server down is { error }', async () => {
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await readSnapshot({ pm: PM, receivers: [LEADER] }, { fetch: down as never, env: {} })).toEqual({ error: 'server-down' });
  });

  it('notify: one POST to the PM send API, one line', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await sendNotice({ pm: PM, text: 'a\nb' }, { fetch: fakeFetch({ ...ROLES_OK, '/api/worktrees/mycodebranchdesk/send': { sendOutcome: 'sent' } }, seen) as never, env: { CM_PORT: '3015' } });
    expect(result).toEqual({ outcome: 'sent' });
    const posts = seen.filter((c) => c.init.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('http://localhost:3015/api/worktrees/mycodebranchdesk/send');
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ content: 'a b', instanceId: 'claude', expectedRole: { injectionFingerprint: 'fp-1', sessionGeneration: 'gen-1' } });
  });

  describe('notify never starts a stopped PM (design §5.2)', () => {
    const post = (seen: Array<{ init: RequestInit }>) => seen.filter((c) => c.init.method === 'POST');

    it('the send is pinned to the running generation read from the roles API (GET first, then POST)', async () => {
      const seen: Array<{ url: string; init: RequestInit }> = [];
      await sendNotice({ pm: PM, text: 'x' }, { fetch: fakeFetch({ ...ROLES_OK, '/api/worktrees/mycodebranchdesk/send': { sendOutcome: 'sent' } }, seen) as never, env: {} });
      expect(seen.map((c) => `${c.init.method} ${c.url.replace('http://localhost:3000', '')}`)).toEqual([
        'GET /api/worktrees/mycodebranchdesk/instances/roles',
        'POST /api/worktrees/mycodebranchdesk/send',
      ]);
    });

    it('the PM stopped after the check: the API refuses the pinned send (409), not_sent with its code, nothing started', async () => {
      const seen: Array<{ url: string; init: RequestInit }> = [];
      const result = await sendNotice(
        { pm: PM, text: 'x' },
        { fetch: fakeFetch({ ...ROLES_OK, '/api/worktrees/mycodebranchdesk/send': { __status: 409, body: { error: 'gone', code: 'role_condition_unmet' } } }, seen) as never, env: {} },
      );
      expect(result).toEqual({ outcome: 'not_sent', why: 'role_condition_unmet' });
    });

    it.each([
      ['no launch evidence (after a server restart)', rolesWith({ launched: null }), 'pm-launch-unknown'],
      ['a tool whose send may relaunch', rolesWith({ cliToolId: 'codex' }), 'pm-tool-not-pinnable'],
      ['the PM not in the roster', rolesWith({ instanceId: 'other' }), 'pm-not-in-roster'],
      ['the roles API failing', { '/api/worktrees/mycodebranchdesk/instances/roles': { __status: 500, body: {} } }, 'pin-http-500'],
    ])('%s: no POST at all (an unpinned send could start the PM)', async (_name, routes, why) => {
      const seen: Array<{ url: string; init: RequestInit }> = [];
      const result = await sendNotice({ pm: PM, text: 'x' }, { fetch: fakeFetch({ ...routes, '/api/worktrees/mycodebranchdesk/send': { sendOutcome: 'sent' } }, seen) as never, env: {} });
      expect(result).toEqual({ outcome: 'not_sent', why });
      expect(post(seen)).toEqual([]);
    });

    it('what the guarantee rests on, in the unchanged server: a pinned send is refused before a start; claude sends never relaunch', () => {
      const root = path.resolve(__dirname, '../../../..');
      const route = fs.readFileSync(path.join(root, 'src/app/api/worktrees/[id]/send/route.ts'), 'utf8');
      const notRunning = route.indexOf('if (!running) {');
      expect(notRunning).toBeGreaterThan(0);
      const refuse = route.indexOf('refuseGonePinnedProcess(roleGate', notRunning);
      const start = route.indexOf('startSessionForSend({', notRunning);
      expect(refuse).toBeGreaterThan(notRunning);
      expect(refuse).toBeLessThan(start);
      const role = fs.readFileSync(path.join(root, 'src/app/api/worktrees/[id]/send/send-role.ts'), 'utf8');
      expect(role).toMatch(/if \(!gate \|\| \(gate\.condition\?\.sessionGeneration \?\? null\) === null\) return null;/);
      expect(role).toMatch(/sessionGeneration: sessionGeneration \?\? null/);
      const claude = fs.readFileSync(path.join(root, 'src/lib/session/claude-session.ts'), 'utf8');
      const body = claude.slice(claude.indexOf('export async function sendMessageToClaude('), claude.indexOf('export async function captureClaudeOutput('));
      expect(body).not.toMatch(/startSession|relaunch|startClaude/);
    });
  });

  it('footerShowsBackground reads only the bottom lines', () => {
    expect(footerShowsBackground('output\n> \n  ⏵⏵ accept edits on · 2 shells\n')).toBe(true);
    expect(footerShowsBackground('done\n\u001b[2m1 background task\u001b[0m')).toBe(true);
    expect(footerShowsBackground(`I listed 3 tasks\n${'line\n'.repeat(10)}> `)).toBe(false);
    expect(footerShowsBackground('> \n  ? for shortcuts')).toBe(false);
    expect(activityOf({ fullOutput: '· 1 shell' }).backgroundFooter).toBe(true);
    expect(activityOf(null)).toMatchObject({ sessionStatus: null, thinking: false, lastEventAt: null, backgroundFooter: false });
  });

  it('relayIdOfRequest reads relay: and relay-sys: only', () => {
    expect(relayIdOfRequest(`relay:${R1}`)).toBe(R1);
    expect(relayIdOfRequest(`relay-sys:${R1}:expired`)).toBe(R1);
    expect(relayIdOfRequest('req-1')).toBeNull();
  });

  it('isAllowedCall: only this Node, this file, read|notify and one JSON object', () => {
    const json = '{"pm":{}}';
    expect(isAllowedCall(process.execPath, [RELAY_IO_FILE, 'read', json])).toBe(true);
    expect(isAllowedCall(process.execPath, [RELAY_IO_FILE, 'notify', json])).toBe(true);
    const refused: Array<[string, string[]]> = [
      ['node', [RELAY_IO_FILE, 'read', json]],
      [process.execPath, ['/tmp/other.mjs', 'read', json]],
      [process.execPath, [RELAY_IO_FILE, 'write', json]],
      [process.execPath, [RELAY_IO_FILE, 'read', '[1]']],
      [process.execPath, [RELAY_IO_FILE, 'read', json, 'x']],
      [process.execPath, ['-e', 'process.exit(0)']],
    ];
    const calls: unknown[] = [];
    const runBounded = makeRunBounded({ run: (...a: unknown[]) => (calls.push(a), { status: 0, stdout: '' }), monoNow: () => 0 });
    for (const [cmd, args] of refused) {
      expect(isAllowedCall(cmd, args)).toBe(false);
      expect(runBounded(cmd, args, { deadlineMono: 1e9, capMs: 1000 })).toEqual({ status: 'refused', called: false });
    }
    expect(calls).toEqual([]);
  });
});
