/**
 * PM's one way to send (Issue #4418; design docs/design/pm-send-relay-4418.md).
 * Entry point is `pm-send.ts`.
 *
 *   pm-send <worktree-id> --instance <id> --note "<待つもの>" "<本文>"
 *   pm-send mycodebranchdesk --instance claude-3 --token <t> --note "<待つもの>" "<本文>"
 *
 * Every send carries `--reply-to self --note <待つもの>`: the target's turn end
 * brings the answer to PM's composer whatever the target writes, and the note
 * waits in PM's mem until that relay closes. There is no flag that drops it.
 * No `--note` (or an empty one) exits 2 before anything runs — commandmate is
 * not started at all.
 *
 * claude-3 of `mycodebranchdesk` is sent to only under PM's reservation
 * (docs/orchestrate/team.md §4): such a send needs `--token` and goes through
 * `claude3-reserve.ts send`, which adds the same relay. The selector is
 * resolved first (an alias of claude-3 is claude-3), so the rule does not
 * depend on how the instance is named.
 *
 * Exit: 2 bad arguments / the instance could not be resolved; otherwise the
 * exit of `commandmate send` (or of `claude3-reserve.ts send`) as it is.
 */

import { spawnSync } from 'child_process';
import { DISPATCH_INSTANCE_ID, DISPATCH_WORKTREE_ID, pmRelayFlags } from '@/lib/agent-health/dispatch';
import { main as reserveMain, type Exec, type ReserveDeps } from '../agent-health/claude3-reserve-main';

/** A `commandmate` run whose output goes straight to this process's own (the relay id is on stderr). */
export type Spawn = (command: string, args: readonly string[]) => { status: number | null };

export interface PmSendDeps {
  /** A captured run (only the instance resolution uses it). */
  exec: Exec;
  /** The send itself. */
  spawn: Spawn;
  stderr: (line: string) => void;
  /** Passed to `claude3-reserve.ts send` for claude-3 (tests inject exec / reservationDir there). */
  reserve?: Partial<ReserveDeps>;
}

export const PM_SEND_USAGE = [
  'Usage: npx tsx scripts/orchestrate/pm-send.ts <worktree-id> --instance <id> --note "<what you wait for>" [--token <t>] "<message>"',
  '',
  '  Always sends with --reply-to self --note <s>: the answer comes back to your composer when the',
  '  target\'s turn ends. No --note (or an empty one): exit 2, nothing sent.',
  '  claude-3 of mycodebranchdesk needs --token (the claude-3 reservation, docs/orchestrate/team.md §4).',
  '',
  'Exit: 2 bad arguments / the instance could not be resolved; otherwise the exit of commandmate send.',
].join('\n');

/** A `--since` no reply can be at or after (scripts/orchestrate/resolve-instance.mjs). */
const REPLY_SINCE_NEVER = '9999-12-31T23:59:59Z';

export interface PmSendCommand {
  worktreeId: string;
  instance: string;
  note: string;
  token: string | null;
  message: string;
}

export type PmSendParse = { ok: true; command: PmSendCommand } | { ok: false; error: string; help?: boolean };

export function parsePmSendArgs(argv: readonly string[]): PmSendParse {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const VALUED = ['--instance', '--note', '--token'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { ok: false, error: PM_SEND_USAGE, help: true };
    if (VALUED.includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (arg in values) return { ok: false, error: `${arg} is given twice` };
      values[arg] = value;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `unknown argument: ${arg}\n\n${PM_SEND_USAGE}` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) return { ok: false, error: `takes <worktree-id> and "<message>"\n\n${PM_SEND_USAGE}` };
  const [worktreeId, message] = positional;
  const note = values['--note'];
  if (note === undefined || note.trim().length === 0) {
    return { ok: false, error: '--note "<what you wait for>" is required: every PM send opens a relay. Nothing was sent.' };
  }
  if (!values['--instance']) return { ok: false, error: '--instance <id> is required. Nothing was sent.' };
  if (worktreeId.length === 0 || message.length === 0) return { ok: false, error: 'the worktree id and the message must not be empty' };
  return {
    ok: true,
    command: { worktreeId, instance: values['--instance'], note, token: values['--token'] ?? null, message },
  };
}

/** argv of the plain send (any target but claude-3). */
export function pmSendCommandArgv(command: Pick<PmSendCommand, 'worktreeId' | 'instance' | 'note' | 'message'>): string[] {
  return ['send', command.worktreeId, command.message, '--instance', command.instance, ...pmRelayFlags(command.note)];
}

const defaultExec: Exec = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

const defaultSpawn: Spawn = (command, args) => {
  const result = spawnSync(command, [...args], { stdio: 'inherit' });
  return { status: result.error ? null : result.status };
};

function defaultDeps(): PmSendDeps {
  return {
    exec: defaultExec,
    spawn: defaultSpawn,
    stderr: (line) => process.stderr.write(`[pm-send] ${line}\n`),
  };
}

/** The instance id behind a selector of mycodebranchdesk, through the CLI's own resolution. */
function resolveInstance(deps: PmSendDeps, worktreeId: string, selector: string): string | { error: string } {
  const result = deps.exec('commandmate', ['reply', worktreeId, '--instance', selector, '--since', REPLY_SINCE_NEVER, '--json']);
  if (result.status !== 0) return { error: `commandmate reply exit ${String(result.status)}` };
  try {
    const answer = JSON.parse(result.stdout) as { instanceId?: unknown };
    if (typeof answer.instanceId === 'string' && answer.instanceId !== '') return answer.instanceId;
  } catch {
    // fall through
  }
  return { error: `no instance in the answer: ${result.stdout.trim()}` };
}

export async function main(argv: readonly string[], overrides: Partial<PmSendDeps> = {}): Promise<number> {
  const deps: PmSendDeps = { ...defaultDeps(), ...overrides };
  const parsed = parsePmSendArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      process.stdout.write(`${parsed.error}\n`);
      return 0;
    }
    deps.stderr(parsed.error);
    return 2;
  }
  const command = parsed.command;

  // claude-3 lives only on mycodebranchdesk (the reservation's target).
  let toClaude3 = false;
  if (command.worktreeId === DISPATCH_WORKTREE_ID) {
    const resolved = resolveInstance(deps, command.worktreeId, command.instance);
    if (typeof resolved !== 'string') {
      deps.stderr(`--instance ${command.instance} を解決できなかった（${resolved.error}）。何も送っていない`);
      return 2;
    }
    toClaude3 = resolved === DISPATCH_INSTANCE_ID;
  }

  if (toClaude3) {
    if (!command.token) {
      deps.stderr('claude-3 へは予約の token が要る（claude3-reserve.ts reserve → --token。docs/orchestrate/team.md §4）。何も送っていない');
      return 2;
    }
    return reserveMain(['send', '--token', command.token, '--note', command.note, command.message], {
      stderr: deps.stderr,
      ...deps.reserve,
    });
  }
  if (command.token) {
    deps.stderr('--token は claude-3 宛てにだけ使う。何も送っていない');
    return 2;
  }
  return deps.spawn('commandmate', pmSendCommandArgv(command)).status ?? 2;
}
