/**
 * PM's side of the Claude 3 reservation (Issue #4243). Entry point is
 * `claude3-reserve.ts`; the rules live in `src/lib/agent-health/claude3-reservation.ts`
 * and the design in docs/design/claude3-dispatch-exclusion-4243.md.
 *
 *   reserve --label <s> [--hours 1-24]            → prints the token
 *   reserve --self --label <s> [--hours 1-24]     (from inside claude-3 only: holder leader, no state check)
 *   send --token <t> <message>                    → commandmate send mycodebranchdesk <message> --instance claude-3
 *   renew --token <t> [--hours 1-24]
 *   release --token <t>
 *   release --force --from <t>                    (a person)
 *   finish --token <t>                            (the dispatch run's last step: finished mark, then release)
 *   takeover --from <t> --reason restart|dispatch-finished [--label <s>] [--hours 1-24]
 *   status [--json]                               (reads only)
 *
 * Exit: 0 done, 2 bad arguments / configuration / I/O, 3 held by someone else /
 * token mismatch / sending, 4 Claude 3 is busy. `send` returns commandmate's exit.
 * The destination is the dispatch constants; there is no option to move the
 * reservation's directory or the destination.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  acquireReservation,
  DEFAULT_RESERVATION_HOURS,
  defaultReservationDir,
  describeHolder,
  dispatchRunFinishedMark,
  finishDispatchRun,
  forceReleaseReservation,
  isOverdue,
  isSending,
  defaultIsAlive,
  readReservation,
  RESERVATION_TARGET,
  releaseReservation,
  renewReservation,
  sendUnderReservation,
  takeoverReservation,
  targetMatches,
  type ReservationEnv,
  type ReservationResult,
  type TakeoverReason,
} from '@/lib/agent-health/claude3-reservation';
import { judgeAgentState, sendArgv } from '@/lib/agent-health/dispatch';
import { defaultSpawnExec, spawnExecFromSync, type SpawnExec } from './spawn-exec';

export interface ExecResult {
  status: number | null;
  stdout: string;
}
export type Exec = (command: string, args: readonly string[]) => ExecResult;

export interface ReserveDeps {
  exec: Exec;
  spawnExec?: SpawnExec;
  now: () => Date;
  pid: number;
  isAlive: (pid: number) => boolean;
  /** Production: `defaultReservationDir()`. A test that injects `exec` without this gets a throwaway directory. */
  reservationDir?: string;
  beforePublish?: ReservationEnv['beforePublish'];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const RESERVE_USAGE = [
  'Usage: npx tsx scripts/agent-health/claude3-reserve.ts <command>',
  '',
  '  reserve --label <s> [--hours 1-24]   reserve claude-3 for PM; prints the token (review after 8h by default)',
  '  reserve --self --label <s> [--hours 1-24]  claude-3 reserves itself (only from inside claude-3; skips the busy check)',
  '  send --token <t> <message>           send to claude-3 under the reservation',
  '  renew --token <t> [--hours 1-24]     move the review time',
  '  release --token <t>                  give claude-3 back',
  '  release --force --from <t>           a person releases the reservation they looked at',
  '  finish --token <t>                   the dispatch run\'s last step: leave the finished mark, then release',
  '  takeover --from <t> --reason restart|dispatch-finished [--label <s>] [--hours 1-24]',
  '  status [--json]                      show the reservation (reads only)',
  '',
  'Exit: 0 done, 2 bad arguments / configuration / I/O, 3 held by someone else / token mismatch / sending,',
  '      4 claude-3 is busy. send returns the exit of commandmate send.',
].join('\n');

const defaultExec: Exec = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 300_000,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

function defaultDeps(): ReserveDeps {
  return {
    exec: defaultExec,
    now: () => new Date(),
    pid: process.pid,
    isAlive: defaultIsAlive,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`[claude3-reserve] ${line}\n`),
  };
}

type Command =
  | { kind: 'reserve'; label: string; hours: number; self: boolean }
  | { kind: 'send'; token: string; message: string }
  | { kind: 'renew'; token: string; hours: number }
  | { kind: 'release'; token: string }
  | { kind: 'finish'; token: string }
  | { kind: 'force-release'; from: string }
  | { kind: 'takeover'; from: string; reason: TakeoverReason; label: string | null; hours: number }
  | { kind: 'status'; json: boolean };

export type ReserveParse = { ok: true; command: Command } | { ok: false; error: string; help?: boolean };

export function parseReserveArgs(argv: readonly string[]): ReserveParse {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '-h' || sub === '--help') return { ok: false, error: RESERVE_USAGE, help: sub !== undefined };
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  const VALUED = ['--label', '--hours', '--token', '--from', '--reason'];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-h' || arg === '--help') return { ok: false, error: RESERVE_USAGE, help: true };
    if (VALUED.includes(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      values[arg] = value;
    } else if (arg === '--force' || arg === '--json' || arg === '--self') {
      flags.add(arg);
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `unknown argument: ${arg}\n\n${RESERVE_USAGE}` };
    } else {
      positional.push(arg);
    }
  }
  const allowed = (names: string[], flagNames: string[] = [], positionals = 0): string | null => {
    for (const name of Object.keys(values)) if (!names.includes(name)) return `${sub} does not take ${name}`;
    for (const flag of flags) if (!flagNames.includes(flag)) return `${sub} does not take ${flag}`;
    if (positional.length !== positionals) return `${sub} takes ${positionals} positional argument(s)`;
    return null;
  };
  const hours = (): number | string => {
    const raw = values['--hours'];
    if (raw === undefined) return DEFAULT_RESERVATION_HOURS;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 24 ? n : '--hours must be an integer from 1 to 24';
  };
  const need = (name: string): string | null => (values[name] ? null : `${sub} needs ${name}`);
  const failWith = (error: string | null): ReserveParse | null => (error ? { ok: false, error } : null);

  switch (sub) {
    case 'reserve': {
      const bad = failWith(allowed(['--label', '--hours'], ['--self']) ?? need('--label'));
      if (bad) return bad;
      const h = hours();
      if (typeof h === 'string') return { ok: false, error: h };
      return { ok: true, command: { kind: 'reserve', label: values['--label'], hours: h, self: flags.has('--self') } };
    }
    case 'send': {
      const bad = failWith(allowed(['--token'], [], 1) ?? need('--token'));
      if (bad) return bad;
      if (positional[0].length === 0) return { ok: false, error: 'send needs a message' };
      return { ok: true, command: { kind: 'send', token: values['--token'], message: positional[0] } };
    }
    case 'renew': {
      const bad = failWith(allowed(['--token', '--hours']) ?? need('--token'));
      if (bad) return bad;
      const h = hours();
      if (typeof h === 'string') return { ok: false, error: h };
      return { ok: true, command: { kind: 'renew', token: values['--token'], hours: h } };
    }
    case 'release': {
      if (flags.has('--force')) {
        const bad = failWith(allowed(['--from'], ['--force']) ?? need('--from'));
        if (bad) return bad;
        return { ok: true, command: { kind: 'force-release', from: values['--from'] } };
      }
      const bad = failWith(allowed(['--token']) ?? need('--token'));
      if (bad) return bad;
      return { ok: true, command: { kind: 'release', token: values['--token'] } };
    }
    case 'finish': {
      const bad = failWith(allowed(['--token']) ?? need('--token'));
      if (bad) return bad;
      return { ok: true, command: { kind: 'finish', token: values['--token'] } };
    }
    case 'takeover': {
      const bad = failWith(allowed(['--from', '--reason', '--label', '--hours']) ?? need('--from') ?? need('--reason'));
      if (bad) return bad;
      const reason = values['--reason'];
      if (reason !== 'restart' && reason !== 'dispatch-finished') return { ok: false, error: '--reason must be restart or dispatch-finished' };
      const h = hours();
      if (typeof h === 'string') return { ok: false, error: h };
      return { ok: true, command: { kind: 'takeover', from: values['--from'], reason, label: values['--label'] ?? null, hours: h } };
    }
    case 'status': {
      const bad = failWith(allowed([], ['--json']));
      if (bad) return bad;
      return { ok: true, command: { kind: 'status', json: flags.has('--json') } };
    }
    default:
      return { ok: false, error: `unknown command: ${sub}\n\n${RESERVE_USAGE}` };
  }
}

export async function main(argv: readonly string[], overrides: Partial<ReserveDeps> = {}): Promise<number> {
  const deps: ReserveDeps = { ...defaultDeps(), ...overrides };
  const parsed = parseReserveArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      deps.stdout(parsed.error);
      return 0;
    }
    deps.stderr(parsed.error);
    return 2;
  }
  const injected = overrides.exec !== undefined;
  let throwaway: string | null = null;
  let dir = overrides.reservationDir;
  if (!dir) {
    if (injected) {
      throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-claude3-reservation-'));
      dir = throwaway;
    } else {
      dir = defaultReservationDir();
    }
  }
  const env: ReservationEnv = {
    dir,
    now: deps.now,
    pid: deps.pid,
    isAlive: deps.isAlive,
    ...(deps.beforePublish ? { beforePublish: deps.beforePublish } : {}),
  };
  const spawnExec = overrides.spawnExec ?? (injected ? spawnExecFromSync(deps.exec) : defaultSpawnExec);
  try {
    return await run(parsed.command, env, deps, spawnExec);
  } finally {
    if (throwaway) fs.rmSync(throwaway, { recursive: true, force: true });
  }
}

/** 0 ready / not-running, 4 busy, 2 unknown. */
function claude3Free(deps: ReserveDeps): number {
  const result = deps.exec('commandmate', ['ls', '--json']);
  let parsed: unknown;
  try {
    parsed = result.status === 0 ? JSON.parse(result.stdout) : undefined;
  } catch {
    parsed = undefined;
  }
  const state = judgeAgentState(parsed);
  if (state.kind === 'busy') {
    deps.stderr(`claude-3 が ${state.detail}`);
    return 4;
  }
  if (state.kind === 'unknown') {
    deps.stderr(`claude-3 の状態を確かめられない: ${state.detail}`);
    return 2;
  }
  return 0;
}

/** Issue #4288: is the caller claude-3 itself (`commandmate whoami --json`)? Not authentication: it stops a PM's slip. */
function callerIsClaude3(deps: ReserveDeps): boolean {
  const result = deps.exec('commandmate', ['whoami', '--json']);
  if (result.status !== 0) return false;
  try {
    const who = JSON.parse(result.stdout) as { worktreeId?: unknown; instanceId?: unknown };
    return who.worktreeId === RESERVATION_TARGET.worktreeId && who.instanceId === RESERVATION_TARGET.instanceId;
  } catch {
    return false;
  }
}

function report(deps: ReserveDeps, result: ReservationResult, done: string): number {
  if (!result.ok) {
    deps.stderr(result.message);
    return result.code;
  }
  deps.stderr(done);
  return 0;
}

async function run(command: Command, env: ReservationEnv, deps: ReserveDeps, spawnExec: SpawnExec): Promise<number> {
  const now = deps.now();
  switch (command.kind) {
    case 'status': {
      const read = readReservation(env.dir);
      if (!read.ok) {
        deps.stderr(read.message);
        return 2;
      }
      const current = read.current;
      const view = {
        dir: env.dir,
        targetMatches: targetMatches(current.target),
        overdue: isOverdue(current, now),
        sending: isSending(current, now, deps.isAlive),
        current,
      };
      if (command.json) {
        deps.stdout(JSON.stringify(view));
      } else {
        deps.stdout(`dir=${env.dir}`);
        deps.stdout(`${describeHolder(current, now)}${view.sending ? '（送信中）' : ''}`);
        if (current.state === 'held') deps.stdout(`token=${current.token ?? '-'} heldSince=${current.heldSince ?? '-'} generation=${current.generation}`);
        if (!view.targetMatches) deps.stdout('送り先が設定と違う（設定不一致）');
      }
      return view.targetMatches ? 0 : 2;
    }
    case 'reserve': {
      const read = readReservation(env.dir);
      if (!read.ok) {
        deps.stderr(read.message);
        return 2;
      }
      if (!targetMatches(read.current.target)) {
        deps.stderr('予約の送り先が設定と違う（設定不一致）');
        return 2;
      }
      if (read.current.state === 'held') {
        deps.stderr(describeHolder(read.current, now));
        return 3;
      }
      if (command.self) {
        // claude-3 is busy by definition while it runs this command: the state check is skipped.
        if (!callerIsClaude3(deps)) {
          deps.stderr('--self は claude-3（mycodebranchdesk の claude-3）の中からだけ使える');
          return 2;
        }
      } else {
        const free = claude3Free(deps);
        if (free !== 0) return free;
      }
      const result = acquireReservation(env, {
        holder: command.self ? 'leader' : 'pm',
        label: command.label,
        hours: command.hours,
      });
      if (!result.ok) {
        deps.stderr(result.message);
        return result.code;
      }
      deps.stderr(`予約した（${result.generation.reviewAfter} まで。外すのは release --token）: ${env.dir}`);
      deps.stdout(result.generation.token as string);
      return 0;
    }
    case 'send': {
      const sent = await sendUnderReservation(env, command.token, (onChild) =>
        spawnExec('commandmate', sendArgv(command.message, false), onChild),
        'pm'
      );
      if (!sent.sent) {
        deps.stderr(`送らなかった: ${sent.message}`);
        return sent.code;
      }
      if (sent.stdout) for (const line of sent.stdout.replace(/\n$/, '').split('\n')) deps.stdout(line);
      return sent.status ?? 2;
    }
    case 'renew':
      return report(deps, renewReservation(env, command.token, command.hours), '期限を延ばした');
    case 'release':
      return report(deps, releaseReservation(env, command.token), '予約を外した');
    case 'finish':
      return report(deps, finishDispatchRun(env, command.token), '完了の印を残し、予約を外した');
    case 'force-release':
      return report(deps, forceReleaseReservation(env, command.from), '予約を強制的に外した');
    case 'takeover': {
      if (command.reason === 'dispatch-finished') {
        const free = claude3Free(deps);
        if (free !== 0) return free;
      }
      const result = takeoverReservation(env, {
        fromToken: command.from,
        reason: command.reason,
        ...(command.label ? { label: command.label } : {}),
        hours: command.hours,
        finished: (current) => dispatchRunFinishedMark(env.dir, current),
      });
      if (!result.ok) {
        deps.stderr(result.message);
        return result.code;
      }
      deps.stderr(`引き継いだ（前の token: ${command.from}）`);
      deps.stdout(result.generation.token as string);
      return 0;
    }
  }
}
