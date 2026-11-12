/**
 * Issue #3045: scripts/agent-health/dispatch-main.ts. gh / commandmate go
 * through an injected `exec` stub (nothing is really sent); the record lives
 * under os.tmpdir() and is removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, writeNotSent, writeSent, type DispatchDeps, type Exec } from '../../../../scripts/agent-health/dispatch-main';
import { main as releaseReportMain } from '../../../../scripts/agent-health/release-report-main';
import {
  acquireReservation,
  beginSend,
  forceReleaseReservation,
  readReservation,
  takeoverReservation,
  type ReservationEnv,
  type ReservationGeneration,
} from '@/lib/agent-health/claude3-reservation';

let root: string;
let stateDir: string;
let lines: string[];
let calls: Array<[string, string[]]>;
let sleeps: number[];

const recordFile = () => path.join(stateDir, 'dispatch', '2026-10-01.json');
const ALL_LABELS = ['agent-health', 'metrics', 'security', 'catalog-drift', 'auto-dispatched', 'bug'];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dispatch-'));
  stateDir = path.join(root, 'state');
  lines = [];
  calls = [];
  sleeps = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function ghIssue(number: number, labels: string[], createdAt: string, login = 'Kewton') {
  return { number, title: `t${number}`, author: { login }, labels: labels.map((name) => ({ name })), createdAt };
}

function lsWith(status: Record<string, unknown> | null) {
  return JSON.stringify([
    {
      id: 'mycodebranchdesk',
      agentInstances: [{ id: 'claude', cliTool: 'claude' }, { id: 'claude-3', cliTool: 'claude' }],
      sessionStatusByInstance: status ? { 'claude-3': status } : {},
    },
  ]);
}

const READY = { isRunning: true, isProcessing: false, isWaitingForResponse: false };
const BUSY = { isRunning: true, isProcessing: true, isWaitingForResponse: false, sessionStatusReason: 'thinking_indicator' };

interface World {
  issues?: unknown[];
  labels?: string[] | null;
  /** Successive `commandmate ls --json` answers; the last one repeats. */
  ls?: Array<Record<string, unknown> | null>;
  /** Successive exit codes of `commandmate send`; the last one repeats. */
  send?: number[];
  ghWrite?: number;
  /** The terms file cannot be written. */
  writeFails?: boolean;
}

function stub(world: World): Exec {
  let lsIndex = 0;
  let sendIndex = 0;
  return (command, args) => {
    calls.push([command, [...args]]);
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify(world.issues ?? []) };
    }
    if (command === 'gh' && args[0] === 'label') {
      return world.labels === null
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: JSON.stringify((world.labels ?? ALL_LABELS).map((name) => ({ name }))) };
    }
    if (command === 'gh') return { status: world.ghWrite ?? 0, stdout: '' };
    if (command === 'commandmate' && args[0] === 'ls') {
      const answers = world.ls ?? [READY];
      const answer = answers[Math.min(lsIndex++, answers.length - 1)];
      return { status: 0, stdout: lsWith(answer) };
    }
    if (command === 'commandmate' && args[0] === 'send') {
      const codes = world.send ?? [0];
      return { status: codes[Math.min(sendIndex++, codes.length - 1)], stdout: '' };
    }
    return { status: null, stdout: '' };
  };
}

async function run(world: World, argv: string[] = []): Promise<number> {
  return main(['--state-dir', stateDir, ...argv], {
    exec: stub(world),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date('2026-10-01T00:30:00Z'),
    env: {} as NodeJS.ProcessEnv,
    homedir: path.join(root, 'home'),
    repoRoot: path.join(root, 'repo'),
    ...(world.writeFails ? { writeText: () => { throw new Error('EACCES'); } } : {}),
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
}

const termsFile = (suffix: string) => path.join(root, 'repo', 'workspace', 'agent-health', '2026-10-01', `dispatch-terms-${suffix}.md`);
const record = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
const sends = () => calls.filter(([command, args]) => command === 'commandmate' && args[0] === 'send').map(([, args]) => args);
const ghWrites = () => calls.filter(([command, args]) => command === 'gh' && args[0] === 'issue' && args[1] !== 'list').map(([, args]) => args);

describe('dispatch main', () => {
  it('sends /clear then the request to claude-3, labels and comments, and records it', async () => {
    const code = await run({
      issues: [
        ghIssue(3051, ['metrics'], '2026-09-30T00:00:00Z'),
        ghIssue(3050, ['agent-health', 'bug'], '2026-09-30T01:00:00Z'),
        ghIssue(3099, ['agent-health'], '2026-09-01T00:00:00Z', 'stranger'),
      ],
      ls: [READY, BUSY, READY],
    });
    expect(code).toBe(0);
    expect(sends()).toEqual([
      ['send', 'mycodebranchdesk', '/clear', '--instance', 'claude-3'],
      ['send', 'mycodebranchdesk', expect.stringMatching(/^\/orchestrate 3050 3051 [^\n]*dispatch-terms-3050-3051\.md の条件に従うこと$/), '--instance', 'claude-3', '--auto-yes', '--duration', '8h'],
    ]);
    // Waited for Claude 3 to come back to its prompt between the two sends.
    expect(calls.filter(([c, a]) => c === 'commandmate' && a[0] === 'ls')).toHaveLength(3);
    expect(ghWrites()).toEqual([
      ['issue', 'edit', '3050', '--repo', 'Kewton/CommandMate', '--add-label', 'auto-dispatched'],
      ['issue', 'comment', '3050', '--repo', 'Kewton/CommandMate', '--body', expect.stringContaining('agent-health-dispatch:2026-10-01')],
      ['issue', 'edit', '3051', '--repo', 'Kewton/CommandMate', '--add-label', 'auto-dispatched'],
      ['issue', 'comment', '3051', '--repo', 'Kewton/CommandMate', '--body', expect.stringContaining('同時に依頼: #3050')],
    ]);
    expect(record()).toEqual({
      schemaVersion: 1,
      date: '2026-10-01',
      status: 'sent',
      sentAt: '2026-10-01T00:30:00.000Z',
      issues: [
        { number: 3050, kind: 'bug', title: 't3050' },
        { number: 3051, kind: 'metrics', title: 't3051' },
      ],
      deferred: [],
      runSuffix: '3050-3051',
    });
    expect(lines).toContain('AGENT_HEALTH_DISPATCH date=2026-10-01 status=sent issues=3050,3051 deferred=-');
    expect(fs.existsSync(path.join(root, 'home'))).toBe(false);
  });

  it('never runs a kill / respond / auto-yes command or sends to another instance', async () => {
    await run({ issues: [ghIssue(1, ['agent-health'], 'a')] });
    for (const [command, args] of calls) {
      if (command !== 'commandmate') continue;
      expect(['ls', 'send']).toContain(args[0]);
      if (args[0] === 'send') {
        expect(args[1]).toBe('mycodebranchdesk');
        expect(args[args.indexOf('--instance') + 1]).toBe('claude-3');
      }
    }
  });

  it('does not send when Claude 3 is working: skipped-busy, everything carried over', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health'], 'a'), ghIssue(2, ['agent-health'], 'b')], ls: [BUSY] });
    expect(code).toBe(0);
    expect(sends()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(record()).toMatchObject({ status: 'skipped-busy', issues: [], deferred: [1, 2] });
    expect(lines).toContain(
      'AGENT_HEALTH_DISPATCH date=2026-10-01 status=skipped-busy issues=- deferred=1,2 reason="Claude 3 が作業中（thinking_indicator）"'
    );
  });

  it('does not send when there is nothing to hand: no-target', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health', 'auto-dispatched'], 'a')] });
    expect(code).toBe(0);
    expect(sends()).toEqual([]);
    expect(calls.some(([c]) => c === 'commandmate')).toBe(false);
    expect(record()).toEqual({ schemaVersion: 1, date: '2026-10-01', status: 'no-target', issues: [], deferred: [] });
    expect(lines).toContain('AGENT_HEALTH_DISPATCH date=2026-10-01 status=no-target issues=- deferred=-');
  });

  it('fails without sending when a label is missing, and says which', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health'], 'a')], labels: ['agent-health', 'bug'] });
    expect(code).toBe(2);
    expect(sends()).toEqual([]);
    expect(record()).toMatchObject({ status: 'skipped-busy', deferred: [1], reason: expect.stringContaining('metrics, security, catalog-drift, auto-dispatched') });
    expect(lines.join('\n')).toMatch(/status=skipped-busy issues=- deferred=1 reason=".*auto-dispatched/);
  });

  it('fails when the Issue list cannot be read', async () => {
    const code = await main(['--state-dir', stateDir], {
      exec: () => ({ status: 1, stdout: '' }),
      sleep: async () => {},
      now: () => new Date('2026-10-01T00:30:00Z'),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(record()).toMatchObject({ status: 'skipped-busy', reason: expect.stringContaining('一覧') });
  });

  it('fails when claude-3 is not in the roster', async () => {
    const exec: Exec = (command, args) => {
      calls.push([command, [...args]]);
      if (command === 'commandmate') return { status: 0, stdout: JSON.stringify([{ id: 'mycodebranchdesk', agentInstances: [] }]) };
      return stub({ issues: [ghIssue(1, ['agent-health'], 'a')] })(command, args);
    };
    const code = await main(['--state-dir', stateDir], {
      exec,
      sleep: async () => {},
      now: () => new Date('2026-10-01T00:30:00Z'),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(sends()).toEqual([]);
  });

  it('resends once after 2 minutes on a cold start (exit 99)', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health'], 'a')], ls: [null, READY], send: [99, 0, 0] });
    expect(code).toBe(0);
    expect(sends().map((args) => args[2].replace(/ \/.*$/, ''))).toEqual(['/clear', '/clear', '/orchestrate 1']);
    expect(sleeps[0]).toBe(120_000);
  });

  it('gives up after the one resend and does not label anything', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health'], 'a')], send: [99, 99] });
    expect(code).toBe(2);
    expect(sends()).toHaveLength(2);
    expect(ghWrites()).toEqual([]);
    expect(record()).toMatchObject({ status: 'skipped-busy', deferred: [1], reason: '/clear を送れなかった' });
  });

  it('does not send the request when Claude 3 does not come back to its prompt after /clear', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health'], 'a')], ls: [READY, BUSY] });
    expect(code).toBe(2);
    expect(sends()).toHaveLength(1);
    expect(ghWrites()).toEqual([]);
    expect(record().reason).toContain('入力待ちに戻らなかった');
  });

  it('exits 1 but records sent when labelling fails', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health'], 'a')], ghWrite: 1 });
    expect(code).toBe(1);
    expect(record()).toMatchObject({ status: 'sent', reason: expect.stringContaining('#1 にラベルを付けられなかった') });
  });

  it('writes the terms file before sending, with the terms content', async () => {
    const code = await run({ issues: [ghIssue(3050, ['agent-health'], 'a')] });
    expect(code).toBe(0);
    const terms = fs.readFileSync(termsFile('3050'), 'utf8');
    expect(terms).toContain('summary-3050.md');
    expect(terms).toContain('release-report.ts --date 2026-10-01');
  });

  it('does not send and records skipped-busy when the terms file cannot be written', async () => {
    const code = await run({ issues: [ghIssue(3050, ['agent-health'], 'a')], writeFails: true });
    expect(code).toBe(2);
    expect(sends()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(record()).toMatchObject({ status: 'skipped-busy', deferred: [3050], reason: expect.stringContaining('条件ファイルを書けなかった') });
  });

  it('does not hand anything again on a day already sent', async () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    const earlier = { schemaVersion: 1, date: '2026-10-01', status: 'sent', issues: [{ number: 1, kind: 'bug', title: '' }], deferred: [] };
    fs.writeFileSync(recordFile(), JSON.stringify(earlier));
    const code = await run({ issues: [ghIssue(2, ['agent-health'], 'a')] });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(record()).toEqual(earlier);
  });

  it('--dry-run sends, labels and writes nothing', async () => {
    const code = await run({ issues: [ghIssue(1, ['agent-health'], 'a')], labels: [] }, ['--dry-run']);
    expect(code).toBe(0);
    expect(sends()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(fs.existsSync(termsFile('1'))).toBe(false);
    expect(lines.some((line) => line.startsWith('  /orchestrate 1 '))).toBe(true);
    expect(lines).toContain('DRY_RUN AGENT_HEALTH_DISPATCH date=2026-10-01 status=sent issues=1 deferred=-');
  });

  it('exits 2 on an unknown argument without calling anything', async () => {
    expect(await run({}, ['--instance', 'claude'])).toBe(2);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue #4243: the Claude 3 reservation (design docs/design/claude3-dispatch-exclusion-4243.md §6).
// The reservation lives under the test's tmp root (deps.reservationDir), never under the home directory.

describe('dispatch main under the claude-3 reservation (#4243)', () => {
  const NOW = Date.parse('2026-10-01T00:30:00Z');
  let clock: number;
  const resDir = () => path.join(root, 'reservation');
  const resEnv = (pid = 7, extra: Partial<ReservationEnv> = {}): ReservationEnv => ({
    dir: resDir(),
    now: () => new Date(clock),
    pid,
    isAlive: () => true,
    ...extra,
  });
  const current = (): ReservationGeneration => {
    const read = readReservation(resDir());
    if (!read.ok) throw new Error(read.message);
    return read.current;
  };
  const holdPm = (hours = 8): string => {
    const r = acquireReservation(resEnv(), { holder: 'pm', label: '#4243', hours });
    if (!r.ok) throw new Error(r.message);
    return r.generation.token as string;
  };

  beforeEach(() => {
    clock = NOW;
  });

  async function runReserved(world: World, argv: string[] = [], extra: Partial<DispatchDeps> = {}, exec?: Exec): Promise<number> {
    return main(['--state-dir', stateDir, ...argv], {
      exec: exec ?? stub(world),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => new Date(clock),
      env: {} as NodeJS.ProcessEnv,
      homedir: path.join(root, 'home'),
      repoRoot: path.join(root, 'repo'),
      reservationDir: resDir(),
      pid: 4243,
      isAlive: () => false,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
      ...extra,
    });
  }
  const one = [ghIssue(1, ['agent-health'], 'a'), ghIssue(2, ['agent-health'], 'b')];

  // 6.1
  it('positive: PM holds claude-3 — neither /clear nor the request is sent, nothing is labelled, skipped-busy is recorded', async () => {
    holdPm();
    const before = current();
    const code = await runReserved({ issues: one });
    expect(code).toBe(0);
    expect(sends()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(fs.existsSync(termsFile('1-2'))).toBe(false);
    expect(record()).toMatchObject({ status: 'skipped-busy', issues: [], deferred: [1, 2], reason: expect.stringContaining('PM が予約中') });
    expect(current()).toEqual(before);
  });

  it('positive: PM holds claude-3 on --dry-run — nothing is sent and no generation or record is written', async () => {
    holdPm();
    const before = fs.readdirSync(resDir());
    const code = await runReserved({ issues: one }, ['--dry-run']);
    expect(code).toBe(0);
    expect(sends()).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(fs.readdirSync(resDir())).toEqual(before);
  });

  it('negative: no reservation — /clear then the request as today, and the run keeps held(dispatch) for today', async () => {
    const code = await runReserved({ issues: one, ls: [READY, BUSY, READY] });
    expect(code).toBe(0);
    expect(sends().map((args) => args[2].replace(/ \/.*$/, ''))).toEqual(['/clear', '/orchestrate 1 2']);
    expect(current()).toMatchObject({ state: 'held', holder: 'dispatch', date: '2026-10-01', sending: null });
    expect(record()).toMatchObject({ status: 'sent' });
  });

  it('negative: a released generation behaves the same as none', async () => {
    const t = holdPm();
    expect(forceReleaseReservation(resEnv(), t).ok).toBe(true);
    const code = await runReserved({ issues: one });
    expect(code).toBe(0);
    expect(sends()).toHaveLength(2);
    expect(current()).toMatchObject({ holder: 'dispatch' });
  });

  // 6.2
  it('positive: PM’s reservation past reviewAfter still blocks — reason says 期限超過・要確認, generation unchanged', async () => {
    holdPm(1);
    clock += 2 * 3_600_000;
    const before = current();
    expect(await runReserved({ issues: one })).toBe(0);
    expect(sends()).toEqual([]);
    expect(record().reason).toContain('期限超過・要確認');
    expect(current()).toEqual(before);
  });

  it('negative: the terms file tells the run to finish (mark, then release) with the dispatch token', async () => {
    await runReserved({ issues: [ghIssue(3050, ['agent-health'], 'a')] });
    const token = current().token as string;
    expect(fs.readFileSync(termsFile('3050'), 'utf8')).toContain(`npx tsx scripts/agent-health/claude3-reserve.ts finish --token ${token}`);
  });

  it('positive: another day’s dispatch run still holding — skipped-busy naming that day', async () => {
    const r = acquireReservation(resEnv(), { holder: 'dispatch', label: '#9', date: '2026-09-30' });
    expect(r.ok).toBe(true);
    expect(await runReserved({ issues: one })).toBe(0);
    expect(sends()).toEqual([]);
    expect(record()).toMatchObject({ status: 'skipped-busy', reason: expect.stringContaining('前日（2026-09-30）の自動依頼の run が') });
  });

  // 6.3
  it('positive: a takeover / force release before the finally — dispatch changes nothing', async () => {
    let taken: string | null = null;
    const exec: Exec = (command, args) => {
      if (command === 'commandmate' && args[0] === 'ls' && taken === null) {
        // Between the reservation and the state check a person releases it and PM reserves.
        const held = current();
        expect(forceReleaseReservation(resEnv(), held.token as string).ok).toBe(true);
        taken = holdPm();
        calls.push([command, [...args]]);
        return { status: 0, stdout: lsWith(BUSY) };
      }
      return stub({ issues: one })(command, args);
    };
    expect(await runReserved({}, [], {}, exec)).toBe(0);
    expect(sends()).toEqual([]);
    expect(current()).toMatchObject({ holder: 'pm', token: taken });
  });

  // 6.4
  it('positive: a takeover after /clear and before the request — the request is not sent', async () => {
    let lsCount = 0;
    const exec: Exec = (command, args) => {
      if (command === 'commandmate' && args[0] === 'ls') {
        lsCount++;
        if (lsCount === 2) {
          const held = current();
          fs.mkdirSync(path.join(root, 'repo', 'workspace', 'agent-health', '2026-10-01'), { recursive: true });
          expect(takeoverReservation(resEnv(), { fromToken: held.token as string, reason: 'dispatch-finished', finished: () => true }).ok).toBe(true);
        }
      }
      return stub({ issues: one })(command, args);
    };
    expect(await runReserved({}, [], {}, exec)).toBe(0);
    expect(sends().map((args) => args[2])).toEqual(['/clear']);
    expect(ghWrites()).toEqual([]);
    expect(record()).toMatchObject({ status: 'skipped-busy', reason: expect.stringContaining('予約が途中で引き継がれた') });
    expect(current()).toMatchObject({ holder: 'pm' });
  });

  it('positive: a force release during the 120-second resend wait — no resend', async () => {
    const code = await runReserved({ issues: one, send: [99, 0] }, [], {
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === 120_000) expect(forceReleaseReservation(resEnv(), current().token as string).ok).toBe(true);
      },
    });
    expect(code).toBe(0);
    expect(sends()).toHaveLength(1);
    expect(current().state).toBe('released');
  });

  it('positive: a slow first state check (31 min) does not end the reservation', async () => {
    let pmCode: boolean | null = null;
    // Issue #4288: the ready wait after /clear is now bounded to 90 s of real time, so the slow
    // part is the first state check (31 min); the later ones are instant.
    const base = stub({ issues: one, ls: [READY, BUSY, READY] });
    let lsSeen = 0;
    const exec: Exec = (command, args) => {
      if (command === 'commandmate' && args[0] === 'ls') {
        if (lsSeen++ === 0) clock += 31 * 60_000;
        if (clock - NOW > 30 * 60_000 && pmCode === null) {
          pmCode = acquireReservation(resEnv(), { holder: 'pm', label: 'late' }).ok;
        }
      }
      return base(command, args);
    };
    expect(await runReserved({}, [], {}, exec)).toBe(0);
    expect(pmCode).toBe(false);
    expect(sends()).toHaveLength(2);
  });

  it('positive: a send in progress (parent alive) refuses another sender', async () => {
    const t = holdPm();
    expect(beginSend(resEnv(1), t).ok).toBe(true);
    expect(forceReleaseReservation(resEnv(2), t)).toMatchObject({ ok: false, code: 3 });
  });

  it('negative: the request still exit 99 after the resend (not sent) — released again', async () => {
    const code = await runReserved({ issues: one, send: [0, 99, 99] });
    expect(code).toBe(2);
    expect(record()).toMatchObject({ status: 'skipped-busy', reason: '依頼を送れなかった' });
    expect(current().state).toBe('released');
  });

  it('positive: the request exits 1 (may have arrived) — held(dispatch) is kept and the reason says so', async () => {
    const code = await runReserved({ issues: one, send: [0, 1] });
    expect(code).toBe(2);
    expect(record().reason).toContain('届いたか不明');
    expect(current()).toMatchObject({ state: 'held', holder: 'dispatch' });
  });

  it('negative: stops before the request (busy, /clear failure) release the reservation', async () => {
    expect(await runReserved({ issues: one, ls: [BUSY] })).toBe(0);
    expect(current().state).toBe('released');
    lines = [];
    calls = [];
    fs.rmSync(recordFile(), { force: true });
    expect(await runReserved({ issues: one, send: [1] })).toBe(2);
    expect(current().state).toBe('released');
  });

  // 6.6
  it('positive: D1 reserves, sends and records sent while D2 is past the sent check — D2 sends nothing and writes no record', async () => {
    let d1: number | null = null;
    const d2Exec: Exec = (command, args) => {
      calls.push([command, [...args]]);
      if (command === 'gh' && args[0] === 'label' && d1 === null) {
        // D1 holds today's reservation and has written today's sent record.
        const r = acquireReservation(resEnv(11), { holder: 'dispatch', label: '#1 #2', date: '2026-10-01' });
        expect(r.ok).toBe(true);
        fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
        fs.writeFileSync(recordFile(), JSON.stringify({ schemaVersion: 1, date: '2026-10-01', status: 'sent', issues: [{ number: 1, kind: 'bug', title: '' }], deferred: [] }));
        d1 = 0;
      }
      return stub({ issues: one })(command, args);
    };
    const before = fs.existsSync(recordFile()) ? fs.readFileSync(recordFile(), 'utf8') : null;
    expect(before).toBeNull();
    expect(await runReserved({}, [], {}, d2Exec)).toBe(0);
    expect(sends()).toEqual([]);
    expect(record().status).toBe('sent');
    expect(lines.some((line) => line.includes('同じ日付（2026-10-01）の自動依頼が claude-3 を予約中'))).toBe(true);
  });

  it('positive: a sent record is never replaced by a skip of another reason', async () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    const sent = { schemaVersion: 1, date: '2026-10-01', status: 'sent', issues: [{ number: 1, kind: 'bug', title: '' }], deferred: [] };
    const exec: Exec = (command, args) => {
      calls.push([command, [...args]]);
      if (command === 'gh' && args[0] === 'label' && !fs.existsSync(recordFile())) {
        fs.writeFileSync(recordFile(), JSON.stringify(sent));
        holdPm();
      }
      return stub({ issues: one })(command, args);
    };
    expect(await runReserved({}, [], {}, exec)).toBe(0);
    expect(sends()).toEqual([]);
    expect(record()).toEqual(sent);
  });

  it('positive: the re-read after the reservation finds today sent — nothing is sent and the reservation is released', async () => {
    const sent = { schemaVersion: 1, date: '2026-10-01', status: 'sent', issues: [{ number: 1, kind: 'bug', title: '' }], deferred: [] };
    const code = await runReserved({ issues: one }, [], {
      beforePublish: (next) => {
        if (next.state === 'held' && next.holder === 'dispatch' && !fs.existsSync(recordFile())) {
          fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
          fs.writeFileSync(recordFile(), JSON.stringify(sent));
        }
      },
    });
    expect(code).toBe(0);
    expect(sends()).toEqual([]);
    expect(current().state).toBe('released');
    expect(record()).toEqual(sent);
  });

  it('positive (P2-1): a sent published between the skip’s check and its rename is written back over the skip', () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    const marker = `${recordFile()}.sent`;
    const sent = { schemaVersion: 1 as const, date: '2026-10-01', status: 'sent' as const, issues: [{ number: 1, kind: 'bug' as const, title: '' }], deferred: [] };
    const skip = { schemaVersion: 1 as const, date: '2026-10-01', status: 'skipped-busy' as const, issues: [], deferred: [1], reason: 'x' };
    // D2 checked (no sent) → D1 publishes sent → D2 renames its skip.
    const result = writeNotSent(recordFile(), marker, skip, { afterCheck: () => expect(writeSent(recordFile(), marker, sent)).toBeNull() });
    expect(result).toBe('kept-sent');
    expect(record()).toEqual(sent);
  });

  it('positive (P2-1): a sent published right after the skip’s rename still ends as sent', () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    const marker = `${recordFile()}.sent`;
    const sent = { schemaVersion: 1 as const, date: '2026-10-01', status: 'sent' as const, issues: [{ number: 1, kind: 'bug' as const, title: '' }], deferred: [] };
    const skip = { schemaVersion: 1 as const, date: '2026-10-01', status: 'no-target' as const, issues: [], deferred: [] };
    writeNotSent(recordFile(), marker, skip, { afterRename: () => expect(writeSent(recordFile(), marker, sent)).toBeNull() });
    expect(record()).toEqual(sent);
    // A second sent is not written over the first.
    expect(writeSent(recordFile(), marker, { ...sent, issues: [] })).toContain('置き換えない');
    expect(record()).toEqual(sent);
  });

  it('negative (P2-1): without a sent the skip is written as before', () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    const skip = { schemaVersion: 1 as const, date: '2026-10-01', status: 'skipped-busy' as const, issues: [], deferred: [1], reason: 'x' };
    expect(writeNotSent(recordFile(), `${recordFile()}.sent`, skip)).toBeNull();
    expect(record()).toEqual(skip);
  });

  it('positive (P2-1): a pre-reservation stop (gh failure) does not replace a marked sent', async () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    const sent = { schemaVersion: 1 as const, date: '2026-10-01', status: 'sent' as const, issues: [{ number: 1, kind: 'bug' as const, title: '' }], deferred: [] };
    // D1's sent lands just after D2 passed the early check (the Issue list call).
    const exec: Exec = (command, args) => {
      calls.push([command, [...args]]);
      if (command === 'gh' && args[1] === 'list') {
        expect(writeSent(recordFile(), `${recordFile()}.sent`, sent)).toBeNull();
        return { status: 1, stdout: '' };
      }
      return { status: null, stdout: '' };
    };
    expect(await runReserved({}, [], {}, exec)).toBe(2);
    expect(record()).toEqual(sent);
  });

  it('negative: the release report reads a reservation skip record without failing', async () => {
    holdPm();
    await runReserved({ issues: one });
    const out = path.join(root, 'out', 'release-readiness.html');
    const reportLines: string[] = [];
    const code = await releaseReportMain(
      ['--date', '2026-10-01', '--out', out, '--state-dir', stateDir, '--runs-dir', path.join(root, 'runs'), '--no-gh', '--no-audit'],
      {
        exec: () => ({ status: null, stdout: '' }),
        now: () => new Date('2026-10-01T10:00:00Z'),
        env: {} as NodeJS.ProcessEnv,
        homedir: path.join(root, 'home'),
        repoDir: root,
        stdout: (line) => reportLines.push(line),
        stderr: (line) => reportLines.push(line),
      }
    );
    expect(code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain('PM が予約中');
  });

  // 6.7
  it('positive: a generation whose target is not claude-3 — nothing is sent, exit 2', async () => {
    fs.mkdirSync(resDir(), { recursive: true });
    fs.writeFileSync(
      path.join(resDir(), 'gen-1.json'),
      JSON.stringify({
        schemaVersion: 1, generation: 1, target: { worktreeId: 'mycodebranchdesk', instanceId: 'claude', cliTool: 'claude' },
        state: 'released', holder: null, token: null, label: null, date: null, heldSince: null, reviewAfter: null, sending: null, previousToken: null,
      })
    );
    expect(await runReserved({ issues: one })).toBe(2);
    expect(sends()).toEqual([]);
  });

  it('positive: a new main() sees the reservation the previous one left (no in-process state)', async () => {
    await runReserved({ issues: [ghIssue(1, ['agent-health'], 'a')] });
    lines = [];
    calls = [];
    clock += 24 * 3_600_000;
    expect(await runReserved({ issues: [ghIssue(2, ['agent-health'], 'b')] })).toBe(0);
    expect(sends()).toEqual([]);
  });

  it('negative: with an injected reservationDir nothing is created under the real home directory', async () => {
    const real = path.join(os.homedir(), '.commandmate', 'agent-health', 'claude3.reservation');
    const existed = fs.existsSync(real);
    await runReserved({ issues: one });
    expect(fs.existsSync(real)).toBe(existed);
    expect(fs.existsSync(path.join(root, 'home'))).toBe(false);
  });

  it('negative: there is no argument to move the reservation', async () => {
    expect(await runReserved({}, ['--reservation-dir', path.join(root, 'x')])).toBe(2);
    expect(calls).toEqual([]);
  });
});
