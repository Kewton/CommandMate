/**
 * Issue #4418: PM's one way to send (scripts/orchestrate/pm-send-main.ts) and
 * `claude3-reserve.ts send`. commandmate never runs: `exec` / `spawn` are
 * stubs that record their calls; the reservation lives under os.tmpdir() and
 * is removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RELAY_ROUNDS_REFUSED_NOTICE,
  isRelayRoundsRefusal,
  main,
  parsePmSendArgs,
  type PmSendDeps,
  type SpawnResult,
  type TargetApi,
} from '../../../../scripts/orchestrate/pm-send-main';
import { main as reserveMain, type Exec } from '../../../../scripts/agent-health/claude3-reserve-main';
import { pmRelayFlags, pmSendArgv, sendArgv } from '@/lib/agent-health/dispatch';
import { MAX_RELAY_HOPS, MAX_RELAY_ROUNDS, decideRelayCreation, isRelayRefusal } from '@/lib/relay/relay-policy';

let root: string;
let execCalls: Array<[string, string[]]>;
let spawnCalls: Array<[string, string[]]>;
let worktreeCalls: string[];
/** pm-send's own instance resolutions on its endpoint: [worktree id, selector]. */
let resolveCalls: Array<[string, string]>;
/** Former worktree ids and what the server makes of them (`GET /api/worktrees/:id` → `id`). */
let formerIds: Record<string, string>;
let reserveCalls: Array<[string, string[]]>;
let err: string[];
/** What `commandmate reply mycodebranchdesk --instance <sel> --json` resolves each selector to. */
let roster: Record<string, string>;

const READY = { isRunning: true, isProcessing: false, isWaitingForResponse: false };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pm-send-4418-'));
  execCalls = [];
  spawnCalls = [];
  worktreeCalls = [];
  resolveCalls = [];
  formerIds = { 'mcbd-old': 'mycodebranchdesk', 'wt-x-old': 'wt-x' };
  reserveCalls = [];
  err = [];
  roster = { codex: 'codex', 'claude-2': 'claude-2', 'claude-3': 'claude-3', leader: 'claude-3', reviewer: 'claude-2' };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const toolOf = (instanceId: string) => (instanceId === 'codex' ? 'codex' : 'claude');
const PATHS: Record<string, string> = { mycodebranchdesk: '/repo/mcbd', 'wt-x': '/repo/wt-x' };

/** The CLI's own check of the target (`reply --json`, `ls --json`), on the same fake server. */
const exec: Exec = (command, args) => {
  execCalls.push([command, [...args]]);
  if (command === 'commandmate' && args[0] === 'reply') {
    const id = roster[args[3]];
    return id
      ? { status: 0, stdout: JSON.stringify({ worktreeId: args[1], instanceId: id, cliToolId: toolOf(id), reply: null }) }
      : { status: 2, stdout: '' };
  }
  if (command === 'commandmate' && args[0] === 'ls') {
    return { status: 0, stdout: JSON.stringify(Object.entries(PATHS).map(([id, p]) => ({ id, path: p }))) };
  }
  return { status: null, stdout: '' };
};

/** pm-send's own reads (`GET /api/worktrees/:id`, `…/resolve-target`) on the same fake server. */
const api: TargetApi = {
  worktree: async (id) => {
    worktreeCalls.push(id);
    if (id === 'gone') return { error: 'HTTP 404' };
    const current = formerIds[id] ?? id;
    return { id: current, path: PATHS[current] ?? `/repo/${current}` };
  },
  resolveTarget: async (worktreeId, selector) => {
    resolveCalls.push([worktreeId, selector]);
    const id = roster[selector];
    return id ? { instanceId: id, cliToolId: toolOf(id) } : { error: 'HTTP 404' };
  },
};

const endpoint = () => ({ url: 'http://127.0.0.1:3011', env: { CM_PORT: '3011' } });

/** The reservation side's commandmate (ls for reserve, send for the send). */
const reserveExec: Exec = (command, args) => {
  reserveCalls.push([command, [...args]]);
  if (command === 'commandmate' && args[0] === 'ls') {
    return {
      status: 0,
      stdout: JSON.stringify([
        {
          id: 'mycodebranchdesk',
          agentInstances: [{ id: 'claude-3', cliTool: 'claude' }],
          sessionStatusByInstance: { 'claude-3': READY },
        },
      ]),
    };
  }
  if (command === 'commandmate' && args[0] === 'send') return { status: 0, stdout: '' };
  return { status: null, stdout: '' };
};

const reserveDeps = () => ({
  exec: reserveExec,
  now: () => new Date('2026-11-15T00:00:00Z'),
  pid: 700,
  isAlive: () => false,
  reservationDir: path.join(root, 'reservation'),
  stdout: () => {},
  stderr: (line: string) => err.push(line),
});

function run(argv: string[], status = 0): Promise<number> {
  const deps: Partial<PmSendDeps> = {
    exec,
    endpoint,
    api: () => api,
    pinEnv: () => {},
    spawn: (command, args) => {
      spawnCalls.push([command, [...args]]);
      return { status };
    },
    stderr: (line) => err.push(line),
    reserve: reserveDeps(),
  };
  return main(argv, deps);
}

const reserveSends = () => reserveCalls.filter(([, a]) => a[0] === 'send').map(([, a]) => a);
const nothingRan = () => {
  expect(worktreeCalls).toEqual([]);
  expect(resolveCalls).toEqual([]);
  expect(execCalls).toEqual([]);
  expect(spawnCalls).toEqual([]);
  expect(reserveCalls).toEqual([]);
};

describe('pm-send: --note is required (exit 2, commandmate never starts)', () => {
  it('no --note: exit 2 and no commandmate', async () => {
    expect(await run(['wt-x', '--instance', 'codex', 'レビューして'])).toBe(2);
    nothingRan();
    expect(err.join('\n')).toMatch(/--note/);
  });

  it('an empty or blank --note: exit 2 and no commandmate', async () => {
    expect(await run(['wt-x', '--instance', 'codex', '--note', '', 'レビューして'])).toBe(2);
    expect(await run(['wt-x', '--instance', 'codex', '--note', '   ', 'レビューして'])).toBe(2);
    nothingRan();
  });

  it('a --note with no value (the next flag) is refused the same way', async () => {
    expect(await run(['wt-x', '--note', '--instance', 'codex', 'レビューして'])).toBe(2);
    nothingRan();
  });

  it('no --note to claude-3 either: exit 2 before the instance is resolved or the reservation is read', async () => {
    expect(await run(['mycodebranchdesk', '--instance', 'claude-3', '--token', 't', 'ブリーフ'])).toBe(2);
    nothingRan();
  });

  it('there is no flag that drops the relay', async () => {
    expect(await run(['wt-x', '--instance', 'codex', '--note', 'n', '--no-reply-to', 'x'])).toBe(2);
    expect(await run(['wt-x', '--instance', 'codex', '--note', 'n', '--reply-to', 'wt-y', 'x'])).toBe(2);
    nothingRan();
  });
});

describe('pm-send: what is sent (positive control)', () => {
  it('always adds --reply-to self --note <note>', async () => {
    expect(await run(['wt-x', '--instance', 'codex', '--note', '設計レビューの DONE:', 'レビューして'])).toBe(0);
    expect(spawnCalls).toEqual([
      ['commandmate', ['send', 'wt-x', '--instance', 'codex', '--reply-to', 'self', '--note', '設計レビューの DONE:', '--', 'レビューして']],
    ]);
    // I3': every target is resolved and, right before the send, checked by the CLI too.
    expect(resolveCalls).toEqual([['wt-x', 'codex'], ['wt-x', 'codex']]);
    expect(execCalls.map(([, a]) => a[0])).toEqual(['ls', 'reply']);
  });

  it('returns commandmate send\'s exit as it is', async () => {
    expect(await run(['wt-x', '--instance', 'codex', '--note', 'n', 'x'], 50)).toBe(50);
    expect(await run(['wt-x', '--instance', 'codex', '--note', 'n', 'x'], 124)).toBe(124);
  });

  it('a non-claude-3 instance of mycodebranchdesk is resolved, then sent plainly with the relay', async () => {
    expect(await run(['mycodebranchdesk', '--instance', 'claude-2', '--note', 'UAT の DONE:', 'UAT して'])).toBe(0);
    expect(execCalls.map(([, a]) => a[0])).toEqual(['ls', 'reply']);
    expect(spawnCalls[0][1]).toEqual([
      'send', 'mycodebranchdesk', '--instance', 'claude-2', '--reply-to', 'self', '--note', 'UAT の DONE:', '--', 'UAT して',
    ]);
  });

  it('an instance that cannot be resolved on mycodebranchdesk: exit 2, nothing sent', async () => {
    expect(await run(['mycodebranchdesk', '--instance', 'nobody', '--note', 'n', 'x'])).toBe(2);
    expect(spawnCalls).toEqual([]);
    expect(reserveCalls).toEqual([]);
  });

  it('--token to anything but claude-3: exit 2, nothing sent', async () => {
    expect(await run(['wt-x', '--instance', 'codex', '--note', 'n', '--token', 't', 'x'])).toBe(2);
    expect(spawnCalls).toEqual([]);
  });
});

describe('pm-send: claude-3 keeps the reservation rule (team.md §4)', () => {
  it('claude-3 without --token: exit 2, nothing sent', async () => {
    expect(await run(['mycodebranchdesk', '--instance', 'claude-3', '--note', 'n', 'ブリーフ'])).toBe(2);
    expect(spawnCalls).toEqual([]);
    expect(reserveSends()).toEqual([]);
  });

  it('an alias of claude-3 is claude-3 (resolved, so --token is still required)', async () => {
    expect(await run(['mycodebranchdesk', '--instance', 'leader', '--note', 'n', 'ブリーフ'])).toBe(2);
    expect(spawnCalls).toEqual([]);
  });

  it('a wrong token: the reservation refuses (exit 3) and nothing is sent', async () => {
    expect(await run(['mycodebranchdesk', '--instance', 'claude-3', '--token', 'pm-guess', '--note', 'n', 'ブリーフ'])).toBe(3);
    expect(spawnCalls).toEqual([]);
    expect(reserveSends()).toEqual([]);
  });

  it('with PM\'s token it goes through claude3-reserve send, with the relay', async () => {
    expect(await reserveMain(['reserve', '--label', '#4418'], { ...reserveDeps(), stdout: (l) => err.push(`TOKEN ${l}`) })).toBe(0);
    const token = (err.find((l) => l.startsWith('TOKEN ')) ?? '').slice(6);
    expect(token).toMatch(/^pm-/);
    reserveCalls = [];
    expect(await run(['mycodebranchdesk', '--instance', 'claude-3', '--token', token, '--note', 'リーダーの DONE:', 'ブリーフ'])).toBe(0);
    expect(spawnCalls).toEqual([]);
    expect(reserveSends()).toEqual([
      ['send', 'mycodebranchdesk', 'ブリーフ', '--instance', 'claude-3', '--reply-to', 'self', '--note', 'リーダーの DONE:'],
    ]);
  });
});

describe('pm-send: the rule and the send use the same resolved target (Codex P2-1 / P2-2)', () => {
  it('a former id of mycodebranchdesk is mycodebranchdesk: claude-3 still needs --token', async () => {
    expect(await run(['mcbd-old', '--instance', 'claude-3', '--note', 'n', 'ブリーフ'])).toBe(2);
    expect(await run(['mcbd-old', '--instance', 'leader', '--note', 'n', 'ブリーフ'])).toBe(2);
    expect(spawnCalls).toEqual([]);
    expect(reserveSends()).toEqual([]);
    // The instance was resolved against the current id, not the former one.
    expect(resolveCalls.map(([wt]) => wt)).toEqual(['mycodebranchdesk', 'mycodebranchdesk']);
  });

  it('positive control: a former id with PM\'s token goes through the reservation', async () => {
    let token = '';
    expect(await reserveMain(['reserve', '--label', '#4418'], { ...reserveDeps(), stdout: (l) => { token = l; } })).toBe(0);
    reserveCalls = [];
    expect(await run(['mcbd-old', '--instance', 'claude-3', '--token', token, '--note', 'n', 'ブリーフ'])).toBe(0);
    expect(spawnCalls).toEqual([]);
    expect(reserveSends()).toEqual([
      ['send', 'mycodebranchdesk', 'ブリーフ', '--instance', 'claude-3', '--reply-to', 'self', '--note', 'n'],
    ]);
  });

  it('the send names the resolved worktree and instance, not what PM typed', async () => {
    expect(await run(['mcbd-old', '--instance', 'reviewer', '--note', 'n', 'UAT して'])).toBe(0);
    expect(spawnCalls).toEqual([
      ['commandmate', ['send', 'mycodebranchdesk', '--instance', 'claude-2', '--reply-to', 'self', '--note', 'n', '--', 'UAT して']],
    ]);
    // An alias that changes after the check cannot redirect the send: the argv carries no alias.
    roster.reviewer = 'claude-3';
    expect(spawnCalls[0][1]).not.toContain('reviewer');
    expect(await run(['wt-x-old', '--instance', 'codex', '--note', 'n', 'x'])).toBe(0);
    expect(spawnCalls[1][1].slice(0, 2)).toEqual(['send', 'wt-x']);
  });

  it('a worktree id the server cannot resolve: exit 2, nothing resolved or sent (fail-closed)', async () => {
    expect(await run(['gone', '--instance', 'claude-3', '--token', 't', '--note', 'n', 'x'])).toBe(2);
    expect(await run(['gone', '--instance', 'codex', '--note', 'n', 'x'])).toBe(2);
    expect(execCalls).toEqual([]);
    expect(spawnCalls).toEqual([]);
    expect(reserveCalls).toEqual([]);
  });
});

describe('claude3-reserve send: --note is required (Issue #4418)', () => {
  async function reserveToken(): Promise<string> {
    let token = '';
    expect(await reserveMain(['reserve', '--label', '#4418'], { ...reserveDeps(), stdout: (l) => { token = l; } })).toBe(0);
    reserveCalls = [];
    return token;
  }

  it('no --note, or a blank one: exit 2 and commandmate send never runs, even with the right token', async () => {
    const token = await reserveToken();
    expect(await reserveMain(['send', '--token', token, 'ブリーフ'], reserveDeps())).toBe(2);
    expect(await reserveMain(['send', '--token', token, '--note', '', 'ブリーフ'], reserveDeps())).toBe(2);
    expect(await reserveMain(['send', '--token', token, '--note', ' ', 'ブリーフ'], reserveDeps())).toBe(2);
    expect(reserveCalls).toEqual([]);
  });

  it('with --note: the argv carries --reply-to self --note (positive control)', async () => {
    const token = await reserveToken();
    expect(await reserveMain(['send', '--token', token, '--note', 'DONE:', 'ブリーフ'], reserveDeps())).toBe(0);
    expect(reserveSends()).toEqual([
      ['send', 'mycodebranchdesk', 'ブリーフ', '--instance', 'claude-3', '--reply-to', 'self', '--note', 'DONE:'],
    ]);
  });
});

describe('the daily dispatch\'s argv does not change (negative control)', () => {
  it('sendArgv carries no relay; pmSendArgv is sendArgv plus the relay flags', () => {
    expect(sendArgv('/clear', false)).toEqual(['send', 'mycodebranchdesk', '/clear', '--instance', 'claude-3']);
    expect(sendArgv('msg', true)).toEqual(['send', 'mycodebranchdesk', 'msg', '--instance', 'claude-3', '--auto-yes', '--duration', '8h']);
    expect(sendArgv('msg', true)).not.toContain('--reply-to');
    expect(pmSendArgv('msg', 'n')).toEqual([...sendArgv('msg', false), ...pmRelayFlags('n')]);
    expect(pmRelayFlags('n')).toEqual(['--reply-to', 'self', '--note', 'n']);
  });

  it('dispatch-main builds its sends from sendArgv, not from the PM argv', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts/agent-health/dispatch-main.ts'), 'utf8');
    expect(src).toMatch(/sendArgv\(message, withAutoYes\)/);
    expect(src).not.toMatch(/pmSendArgv|pmRelayFlags|--reply-to/);
  });
});

describe('parsePmSendArgs', () => {
  it('needs a worktree id and a message', () => {
    expect(parsePmSendArgs(['--instance', 'codex', '--note', 'n', 'x']).ok).toBe(false);
    expect(parsePmSendArgs(['wt', '--note', 'n', 'x']).ok).toBe(false);
    expect(parsePmSendArgs(['wt', '--instance', 'codex', '--note', 'n', 'x'])).toEqual({
      ok: true,
      command: { worktreeId: 'wt', instance: 'codex', note: 'n', token: null, message: 'x' },
    });
  });
});

/**
 * #4418 after #4420: asking again after an answer is no longer a chain, but PM that
 * received MAX_RELAY_ROUNDS replies within the window is refused RELAY_HOPS_EXCEEDED.
 * pm-send returns that exit as it is, never sends plainly instead, and says to wait
 * or hand it back (I5: L1 holds).
 */
describe('pm-send after the relay pace ceiling (#4418 after #4420)', () => {
  const PM_END = { worktreeId: 'wt-pm', instanceId: 'claude' };
  const TARGET_END = { worktreeId: 'wt-x', instanceId: 'codex' };
  /** The CLI's line for a relay refusal (`registerRelay`: `Error: <message>`), with the policy's own message. */
  const refusalLine = (replyRounds: number, parentHops: number | null = null, allowRelayChain = false) => {
    const verdict = decideRelayCreation({ from: PM_END, to: TARGET_END, parentHops, allowRelayChain, openBetween: 0, replyRounds });
    if (!isRelayRefusal(verdict)) throw new Error('expected a refusal');
    return { code: verdict.code, stderr: `Error: ${verdict.message}\n` };
  };

  function runWith(answer: SpawnResult, extra: Partial<PmSendDeps> = {}, argv = ['wt-x', '--instance', 'codex', '--note', 'n', '次の依頼']) {
    return main(argv, {
      exec,
      endpoint,
      api: () => api,
      pinEnv: () => {},
      spawn: (command, args) => {
        spawnCalls.push([command, [...args]]);
        return answer;
      },
      stderr: (line) => err.push(line),
      reserve: reserveDeps(),
      ...extra,
    });
  }

  it('the policy\'s pace refusal is what isRelayRoundsRefusal reads; the depth refusal and the others are not', () => {
    const rounds = refusalLine(MAX_RELAY_ROUNDS);
    expect(rounds.code).toBe('RELAY_HOPS_EXCEEDED');
    expect(isRelayRoundsRefusal(rounds.stderr)).toBe(true);
    const depth = refusalLine(0, MAX_RELAY_HOPS, true);
    expect(depth.code).toBe('RELAY_HOPS_EXCEEDED');
    expect(isRelayRoundsRefusal(depth.stderr)).toBe(false);
    expect(isRelayRoundsRefusal(refusalLine(0, 1, false).stderr)).toBe(false); // RELAY_CHAIN_BLOCKED
    expect(isRelayRoundsRefusal(undefined)).toBe(false);
    expect(isRelayRoundsRefusal('')).toBe(false);
  });

  it('refused on the pace: the exit as it is, one send only (with the relay), and the line says wait or hand it back', async () => {
    expect(await runWith({ status: 2, stderr: refusalLine(MAX_RELAY_ROUNDS).stderr })).toBe(2);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0][1]).toEqual(expect.arrayContaining(['--reply-to', 'self', '--note', 'n']));
    expect(err).toContain(RELAY_ROUNDS_REFUSED_NOTICE);
    expect(RELAY_ROUNDS_REFUSED_NOTICE).toMatch(/RELAY_HOPS_EXCEEDED/);
    expect(RELAY_ROUNDS_REFUSED_NOTICE).toMatch(/待/);
    expect(RELAY_ROUNDS_REFUSED_NOTICE).toMatch(/人に返す/);
    expect(RELAY_ROUNDS_REFUSED_NOTICE).toMatch(/素の send には落とさない/);
  });

  it('negative control: another failure, or a send that went through, adds no line and keeps the exit', async () => {
    expect(await runWith({ status: 2, stderr: refusalLine(0, 1, false).stderr })).toBe(2);
    expect(await runWith({ status: 1, stderr: 'Error: something else\n' })).toBe(1);
    expect(await runWith({ status: 0, stderr: 'Relay registered: r-1\n' })).toBe(0);
    expect(await runWith({ status: 0 })).toBe(0);
    expect(spawnCalls).toHaveLength(4);
    expect(err).not.toContain(RELAY_ROUNDS_REFUSED_NOTICE);
  });

  it('(Codex P3-1) the line is added only for exit 2 with the whole refusal line, not for a fragment or another exit', async () => {
    const line = refusalLine(MAX_RELAY_ROUNDS).stderr.trim();
    const fragment = line.replace(/^Error: /, '');
    expect(await runWith({ status: 1, stderr: `${line}\n` })).toBe(1);
    expect(await runWith({ status: 2, stderr: `Error: upstream said: ${fragment}\n` })).toBe(2);
    expect(await runWith({ status: 2, stderr: `Warning: ${fragment}\nError: something else\n` })).toBe(2);
    expect(err).not.toContain(RELAY_ROUNDS_REFUSED_NOTICE);
    // positive control: the same line, alone on its line, with exit 2 (other lines around it are fine)
    expect(await runWith({ status: 2, stderr: `Relay ...\n${line}\n` })).toBe(2);
    expect(err.filter((l) => l === RELAY_ROUNDS_REFUSED_NOTICE)).toHaveLength(1);
    expect(isRelayRoundsRefusal(`${line}\n`)).toBe(true);
    expect(isRelayRoundsRefusal(`Error: upstream said: ${fragment}`)).toBe(false);
  });

  it('claude-3 under the reservation: the same refusal gives the same line, and nothing more is sent', async () => {
    expect(await reserveMain(['reserve', '--label', '#4418'], { ...reserveDeps(), stdout: (l) => err.push(`TOKEN ${l}`) })).toBe(0);
    const token = (err.find((l) => l.startsWith('TOKEN ')) ?? '').slice(6);
    const reserveSpawned: string[][] = [];
    const code = await runWith(
      { status: 0 },
      {
        reserveSpawn: async (_command, args) => {
          reserveSpawned.push([...args]);
          return { status: 2, stdout: '', stderr: refusalLine(MAX_RELAY_ROUNDS).stderr };
        },
      },
      ['mycodebranchdesk', '--instance', 'claude-3', '--token', token, '--note', 'リーダーの DONE:', 'ブリーフ']
    );
    expect(code).toBe(2);
    expect(spawnCalls).toEqual([]);
    expect(reserveSpawned).toEqual([
      ['send', 'mycodebranchdesk', 'ブリーフ', '--instance', 'claude-3', '--reply-to', 'self', '--note', 'リーダーの DONE:'],
    ]);
    expect(err).toContain(RELAY_ROUNDS_REFUSED_NOTICE);
  });
});
