/**
 * Issue #4418 (I3'): what pm-send checked is what it sends to — the same server
 * and the same ids — or nothing is sent (exit 2).
 *
 * Everything is a fake "world": two servers (pm-send's endpoint and another one),
 * each with its worktrees and agent-instance rosters, and a fake `commandmate`
 * that dials one of them (the endpoint it was pinned to, or the one its own config
 * names) and resolves `--instance` the way `GET /api/worktrees/:id/resolve-target`
 * does (an id with a row first, then a tool id, then an alias). Nothing real runs:
 * no server, no tmux, no agy (an antigravity row is a string in a fake roster).
 * The reservation lives under os.tmpdir() and is removed after each test.
 *
 * The roster changes "after the first resolution": the moment PM's check has
 * read it, as a person editing the roster between the check and the send would.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type PmSendDeps, type TargetApi } from '../../../../scripts/orchestrate/pm-send-main';
import { main as reserveMain, type Exec } from '../../../../scripts/agent-health/claude3-reserve-main';

interface Row {
  id: string;
  cliTool: string;
  alias?: string;
}
interface Worktree {
  id: string;
  path: string;
  roster: Row[];
}
interface Server {
  port: string;
  worktrees: Record<string, Worktree>;
}
interface Delivery {
  port: string;
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  message: string;
  argv: string[];
}

const TOOLS = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode'];
const READY = { isRunning: true, isProcessing: false, isWaitingForResponse: false };

let root: string;
let servers: Record<string, Server>;
/** pm-send's own endpoint. */
let pmPort: string;
/** What the fake CLI dials when nothing is pinned (its own config). */
let cliConfigPort: string;
/** The fake CLI honors pinned CM_PORT (true) or reads its own config regardless (false). */
let cliHonorsPin: boolean;
/** What pm-send pinned for its children. */
let pinned: Record<string, string> | null;
let deliveries: Delivery[];
let err: string[];
/** Run once, right after the first instance resolution is answered (by either the API or the CLI). */
let afterFirstResolution: (() => void) | null;

function resolved(): void {
  const hook = afterFirstResolution;
  afterFirstResolution = null;
  hook?.();
}

function select(wt: Worktree, selector: string): { instanceId: string; cliToolId: string } | { ambiguous: true } {
  const row = wt.roster.find((r) => r.id === selector);
  if (row) return { instanceId: row.id, cliToolId: row.cliTool };
  if (TOOLS.includes(selector)) return { instanceId: selector, cliToolId: selector };
  const matches = wt.roster.filter((r) => r.alias === selector);
  if (matches.length === 1) return { instanceId: matches[0].id, cliToolId: matches[0].cliTool };
  if (matches.length > 1) return { ambiguous: true };
  return { instanceId: selector, cliToolId: 'claude' };
}

function worktreeOn(port: string, id: string): Worktree | undefined {
  return servers[port]?.worktrees[id];
}

/** The fake `commandmate`: which server it dials. */
function cliPort(): string {
  return cliHonorsPin && pinned?.CM_PORT ? pinned.CM_PORT : cliConfigPort;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `commandmate send <wt> [message] … [-- message]` as commander reads it. */
function sendMessageOf(argv: readonly string[]): string {
  const dashes = argv.indexOf('--');
  if (dashes >= 0) return argv[dashes + 1];
  return argv[2];
}

function cliSend(argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const port = cliPort();
  const wt = worktreeOn(port, argv[1]);
  if (!wt) return { status: 2, stdout: '', stderr: `Error: Worktree '${argv[1]}' not found\n` };
  const target = select(wt, flag(argv, '--instance') as string);
  if ('ambiguous' in target) return { status: 2, stdout: '', stderr: 'Error: ambiguous\n' };
  deliveries.push({ port, worktreeId: wt.id, ...target, message: sendMessageOf(argv), argv: [...argv] });
  return { status: 0, stdout: '', stderr: 'Relay registered: r-1\n' };
}

const cliExec: Exec = (command, args) => {
  if (command !== 'commandmate') return { status: null, stdout: '' };
  const port = cliPort();
  if (args[0] === 'reply') {
    const wt = worktreeOn(port, args[1]);
    if (!wt) return { status: 2, stdout: '' };
    const target = select(wt, flag(args, '--instance') as string);
    resolved();
    if ('ambiguous' in target) return { status: 2, stdout: '' };
    return {
      status: 0,
      stdout: JSON.stringify({ worktreeId: wt.id, instanceId: target.instanceId, cliToolId: target.cliToolId, reply: null }),
    };
  }
  if (args[0] === 'ls') {
    const rows = Object.values(servers[port]?.worktrees ?? {}).map((wt) => ({
      id: wt.id,
      path: wt.path,
      agentInstances: wt.roster.map((r) => ({ id: r.id, cliTool: r.cliTool, alias: r.alias })),
      sessionStatusByInstance: Object.fromEntries(wt.roster.map((r) => [r.id, READY])),
    }));
    return { status: 0, stdout: JSON.stringify(rows) };
  }
  if (args[0] === 'send') {
    const result = cliSend(args);
    return { status: result.status, stdout: result.stdout };
  }
  return { status: null, stdout: '' };
};

/** pm-send's own API reads (its endpoint). */
const api: TargetApi = {
  worktree: async (id) => {
    const wt = worktreeOn(pmPort, id);
    return wt ? { id: wt.id, path: wt.path } : { error: 'HTTP 404' };
  },
  resolveTarget: async (worktreeId, selector) => {
    const wt = worktreeOn(pmPort, worktreeId);
    if (!wt) return { error: 'HTTP 404' };
    const target = select(wt, selector);
    resolved();
    if ('ambiguous' in target) return { error: 'HTTP 409 ambiguous' };
    return target;
  },
};

const reserveDeps = () => ({
  exec: cliExec,
  now: () => new Date('2026-11-20T00:00:00Z'),
  pid: 700,
  isAlive: () => false,
  reservationDir: path.join(root, 'reservation'),
  stdout: () => {},
  stderr: (line: string) => err.push(line),
});

function deps(): Partial<PmSendDeps> {
  const all = {
    exec: cliExec,
    // the 08f798f72 form of the worktree read (its endpoint is pm-send's)
    resolveWorktree: async (id: string) => worktreeOn(pmPort, id)?.id ?? { error: 'HTTP 404' },
    endpoint: () => ({ url: `http://127.0.0.1:${pmPort}`, env: { CM_PORT: pmPort, CM_BIND: '127.0.0.1', CM_HTTPS_CERT: '', CM_HTTPS_KEY: '' } }),
    api: () => api,
    pinEnv: (env: Record<string, string>) => {
      pinned = { ...env };
    },
    spawn: (_command: string, args: readonly string[]) => {
      const result = cliSend(args);
      return { status: result.status, stderr: result.stderr };
    },
    stderr: (line: string) => err.push(line),
    reserve: reserveDeps(),
  };
  return all;
}

async function token(): Promise<string> {
  const lines: string[] = [];
  expect(await reserveMain(['reserve', '--label', '#4418'], { ...reserveDeps(), stdout: (l) => lines.push(l) })).toBe(0);
  return lines[0];
}

function mcbd(): Worktree {
  return {
    id: 'mycodebranchdesk',
    path: '/repo/mcbd',
    roster: [
      { id: 'claude', cliTool: 'claude' },
      { id: 'claude-2', cliTool: 'claude', alias: 'reviewer' },
      { id: 'claude-3', cliTool: 'claude', alias: 'leader' },
      { id: 'agy-1', cliTool: 'antigravity', alias: 'agy' },
    ],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pm-send-dest-4418-'));
  pmPort = '3011';
  cliConfigPort = '3011';
  cliHonorsPin = true;
  pinned = null;
  deliveries = [];
  err = [];
  afterFirstResolution = null;
  servers = {
    '3011': {
      port: '3011',
      worktrees: {
        mycodebranchdesk: mcbd(),
        'wt-x': { id: 'wt-x', path: '/repo/wt-x', roster: [{ id: 'codex', cliTool: 'codex' }] },
      },
    },
    '3000': {
      port: '3000',
      worktrees: {
        mycodebranchdesk: { ...mcbd(), path: '/other/mcbd' },
        'wt-x': { id: 'wt-x', path: '/other/wt-x', roster: [{ id: 'codex', cliTool: 'codex' }] },
      },
    },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every server's roster of mycodebranchdesk, changed the same way. */
function editRoster(edit: (roster: Row[]) => Row[]): void {
  for (const server of Object.values(servers)) {
    const wt = server.worktrees.mycodebranchdesk;
    wt.roster = edit(wt.roster);
  }
}

describe('#4418 I3\': pm-send sends to what it checked, or not at all', () => {
  it('positive control: a plain target is sent to once, on pm-send\'s server, with the ids it checked', async () => {
    expect(await main(['mycodebranchdesk', '--instance', 'reviewer', '--note', 'n', 'レビューして'], deps())).toBe(0);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ port: '3011', worktreeId: 'mycodebranchdesk', instanceId: 'claude-2', cliToolId: 'claude', message: 'レビューして' });
    expect(flag(deliveries[0].argv, '--instance')).toBe('claude-2');
  });

  it('positive control: claude-3 under the reservation is sent to once', async () => {
    const t = await token();
    expect(await main(['mycodebranchdesk', '--instance', 'leader', '--token', t, '--note', 'n', 'ブリーフ'], deps())).toBe(0);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ port: '3011', instanceId: 'claude-3', message: 'ブリーフ' });
  });

  it('(d) the row is removed and its id becomes another instance\'s alias: nothing is sent (exit 2)', async () => {
    afterFirstResolution = () =>
      editRoster((roster) =>
        roster.filter((r) => r.id !== 'claude-2').map((r) => (r.id === 'claude-3' ? { ...r, alias: 'claude-2' } : r))
      );
    expect(await main(['mycodebranchdesk', '--instance', 'reviewer', '--note', 'n', 'レビューして'], deps())).toBe(2);
    expect(deliveries).toEqual([]);
  });

  it('(e) pm-send\'s server and the CLI\'s are not the same (the CLI reads its own config): nothing is sent (exit 2)', async () => {
    cliConfigPort = '3000';
    cliHonorsPin = false;
    expect(await main(['wt-x', '--instance', 'codex', '--note', 'n', 'レビューして'], deps())).toBe(2);
    expect(deliveries).toEqual([]);
  });

  it('(e) positive control: a CLI whose own config differs but that takes the pinned endpoint sends once, to pm-send\'s server', async () => {
    cliConfigPort = '3000';
    expect(await main(['wt-x', '--instance', 'codex', '--note', 'n', 'レビューして'], deps())).toBe(0);
    expect(deliveries.map((d) => d.port)).toEqual(['3011']);
    expect(pinned).toMatchObject({ CM_PORT: '3011' });
  });

  it('(f) the alias is moved onto an antigravity row: nothing is sent (exit 2), agy is never addressed', async () => {
    afterFirstResolution = () =>
      editRoster((roster) =>
        roster.filter((r) => r.id !== 'claude-2').map((r) => (r.id === 'agy-1' ? { ...r, alias: 'claude-2' } : r))
      );
    expect(await main(['mycodebranchdesk', '--instance', 'reviewer', '--note', 'n', 'レビューして'], deps())).toBe(2);
    expect(deliveries).toEqual([]);
  });

  it('(d) on the claude-3 path: claude-3 is checked, then claude-3\'s row goes and its id is an alias of another — nothing is sent', async () => {
    const t = await token();
    afterFirstResolution = () =>
      editRoster((roster) =>
        roster.filter((r) => r.id !== 'claude-3').map((r) => (r.id === 'claude-2' ? { ...r, alias: 'claude-3' } : r))
      );
    expect(await main(['mycodebranchdesk', '--instance', 'leader', '--token', t, '--note', 'n', 'ブリーフ'], deps())).toBe(2);
    expect(deliveries).toEqual([]);
  });
});

describe('#4418: a message that starts with "-" is the message', () => {
  it('after --, "-h" is sent as the message (no help, no exit 0 without a send)', async () => {
    expect(await main(['wt-x', '--instance', 'codex', '--note', 'n', '--', '-h'], deps())).toBe(0);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].message).toBe('-h');
    expect(deliveries[0].argv.slice(-2)).toEqual(['--', '-h']);
  });

  it('a bullet-list message ("- 1 件目") goes after -- in the send', async () => {
    expect(await main(['wt-x', '--instance', 'codex', '--note', 'n', '- 1 件目\n- 2 件目'], deps())).toBe(0);
    expect(deliveries.map((d) => d.message)).toEqual(['- 1 件目\n- 2 件目']);
    expect(deliveries[0].argv.slice(-2)).toEqual(['--', '- 1 件目\n- 2 件目']);
  });

  it('claude-3 (claude3-reserve passes the message positionally): a "-" message is exit 2, nothing sent', async () => {
    const t = await token();
    expect(await main(['mycodebranchdesk', '--instance', 'claude-3', '--token', t, '--note', 'n', '--', '- ブリーフ'], deps())).toBe(2);
    expect(deliveries).toEqual([]);
  });
});
