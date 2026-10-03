/**
 * Issue #3045: scripts/agent-health/dispatch-main.ts. gh / commandmate go
 * through an injected `exec` stub (nothing is really sent); the record lives
 * under os.tmpdir() and is removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Exec } from '../../../../scripts/agent-health/dispatch-main';

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
