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
 * `claude3-reserve.ts send`, which adds the same relay. The worktree id is
 * made current first (a former id of mycodebranchdesk is mycodebranchdesk,
 * through the server's `GET /api/worktrees/:id`), and on mycodebranchdesk the
 * selector is resolved (an alias of claude-3 is claude-3), so the rule does not
 * depend on how either is named. The send goes to the RESOLVED pair — the one
 * the rule was checked against — never to the strings PM typed. Either
 * resolution failing sends nothing (exit 2).
 *
 * Asking again after an answer goes through (#4420: a reply to PM's own relay is
 * not a chain parent). What stops it is the pace ceiling: PM that received
 * MAX_RELAY_ROUNDS replies to its relays within RELAY_ROUNDS_WINDOW_MS is refused
 * `RELAY_HOPS_EXCEEDED`. pm-send then returns that exit as it is — it never sends
 * again without the relay — and says to wait or hand it back to the person
 * (docs/design/pm-send-relay-4418.md §「返事を受けた後の再依頼」).
 *
 * Exit: 2 bad arguments / the worktree or the instance could not be resolved; otherwise the
 * exit of `commandmate send` (or of `claude3-reserve.ts send`) as it is.
 */

import { spawn as spawnChild, spawnSync } from 'child_process';
import { ApiClient } from '@/cli/utils/api-client';
import { DISPATCH_INSTANCE_ID, DISPATCH_WORKTREE_ID, pmRelayFlags } from '@/lib/agent-health/dispatch';
import { MAX_RELAY_ROUNDS, RELAY_ROUNDS_WINDOW_MS } from '@/lib/relay/relay-policy';
import { main as reserveMain, type Exec, type ReserveDeps } from '../agent-health/claude3-reserve-main';
import { SPAWN_TIMEOUT_MS, type SpawnExec } from '../agent-health/spawn-exec';

/** What a send run answers: its exit, and what it wrote to stderr (also passed through as it came). */
export interface SpawnResult {
  status: number | null;
  stderr?: string;
}

/** A `commandmate` run whose stdout goes straight to this process's own; stderr is passed through and kept. */
export type Spawn = (command: string, args: readonly string[]) => SpawnResult | Promise<SpawnResult>;

/** The claude-3 send's run (stdout captured for `claude3-reserve`, stderr passed through and kept). */
export type ReserveSpawn = (
  command: string,
  args: readonly string[],
  onChild?: (pid: number) => void
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export interface PmSendDeps {
  /** A captured run (only the instance resolution uses it). */
  exec: Exec;
  /** The current id of a worktree id (a former id maps to its worktree's current one). */
  resolveWorktree: (worktreeId: string) => Promise<string | { error: string }>;
  /** The send itself. */
  spawn: Spawn;
  stderr: (line: string) => void;
  /** Passed to `claude3-reserve.ts send` for claude-3 (tests inject exec / reservationDir there). */
  reserve?: Partial<ReserveDeps>;
  /**
   * The claude-3 send's run, so its stderr can be read for the pace refusal. Default: a real
   * child — but only when `reserve` injects neither `exec` nor `spawnExec` (a test's stubs stay in charge).
   */
  reserveSpawn?: ReserveSpawn;
}

export const PM_SEND_USAGE = [
  'Usage: npx tsx scripts/orchestrate/pm-send.ts <worktree-id> --instance <id> --note "<what you wait for>" [--token <t>] "<message>"',
  '',
  '  Always sends with --reply-to self --note <s>: the answer comes back to your composer when the',
  '  target\'s turn ends. No --note (or an empty one): exit 2, nothing sent.',
  '  claude-3 of mycodebranchdesk needs --token (the claude-3 reservation, docs/orchestrate/team.md §4).',
  '',
  `  ${MAX_RELAY_ROUNDS} replies to your relays within ${RELAY_ROUNDS_WINDOW_MS / 60_000} minutes: the send is refused (RELAY_HOPS_EXCEEDED);`,
  '  its exit is returned and nothing is sent without the relay. Wait, or hand it back to the person.',
  '',
  'Exit: 2 bad arguments / the worktree or the instance could not be resolved; otherwise the exit of commandmate send.',
].join('\n');

/**
 * Whether a send's stderr is the relay's pace refusal (`RELAY_HOPS_EXCEEDED` with
 * `ceiling: 'rounds'`, src/lib/relay/relay-policy.ts). The CLI prints the refusal's
 * message, not its code (`registerRelay` in src/cli/commands/relays.ts), so the message is read.
 */
export function isRelayRoundsRefusal(stderr: string | undefined): boolean {
  return typeof stderr === 'string' && /replies to its relays in the last \d+ minutes; the limit is \d+/.test(stderr);
}

/** What pm-send adds after the pace refusal: nothing was sent, no plain send follows, wait or hand back. */
export const RELAY_ROUNDS_REFUSED_NOTICE =
  `relay の往復の上限で断られた（RELAY_HOPS_EXCEEDED: 直近 ${RELAY_ROUNDS_WINDOW_MS / 60_000} 分に受けた自分の relay の返事が ${MAX_RELAY_ROUNDS} 本以上）。`
  + '何も送っていない。relay の無い素の send には落とさない（exit はそのまま返す）。'
  + `返事が ${RELAY_ROUNDS_WINDOW_MS / 60_000} 分の窓から外れるまで待って送り直すか、人に返す（docs/design/pm-send-relay-4418.md）`;

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

/** The tail of stderr kept for {@link isRelayRoundsRefusal} (the refusal is one short line before exit). */
const STDERR_KEPT = 64 * 1024;

/** Runs a command; stderr is written through as it comes and its tail kept. Never rejects. */
function teeRun(
  command: string,
  args: readonly string[],
  reserve: boolean,
  onChild?: (pid: number) => void
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawnChild>;
    try {
      // The claude-3 send keeps what claude3-reserve's own runner does: no stdin, stdout captured, killed after SPAWN_TIMEOUT_MS.
      child = spawnChild(command, [...args], { stdio: reserve ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'pipe'] });
    } catch {
      resolve({ status: null, stdout, stderr });
      return;
    }
    const timer = reserve ? setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS) : undefined;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-STDERR_KEPT);
    });
    if (typeof child.pid === 'number') onChild?.(child.pid);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

const defaultSpawn: Spawn = async (command, args) => {
  const result = await teeRun(command, args, false);
  return { status: result.status, stderr: result.stderr };
};

const defaultReserveSpawn: ReserveSpawn = (command, args, onChild) => teeRun(command, args, true, onChild);

/** `GET /api/worktrees/:id` answers with the worktree, whose `id` is the current one (Issue #1621). */
const defaultResolveWorktree: PmSendDeps['resolveWorktree'] = async (worktreeId) => {
  try {
    const worktree = await new ApiClient().get<{ id?: unknown }>(`/api/worktrees/${encodeURIComponent(worktreeId)}`);
    if (typeof worktree.id === 'string' && worktree.id !== '') return worktree.id;
    return { error: 'no id in the answer' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

function defaultDeps(): PmSendDeps {
  return {
    exec: defaultExec,
    resolveWorktree: defaultResolveWorktree,
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

  // The current worktree id: a former id of mycodebranchdesk must meet the same rule (Codex P2-1).
  const worktreeId = await deps.resolveWorktree(command.worktreeId);
  if (typeof worktreeId !== 'string') {
    deps.stderr(`worktree ${command.worktreeId} を解決できなかった（${worktreeId.error}）。何も送っていない`);
    return 2;
  }

  // claude-3 lives only on mycodebranchdesk (the reservation's target).
  let instance = command.instance;
  let toClaude3 = false;
  if (worktreeId === DISPATCH_WORKTREE_ID) {
    const resolved = resolveInstance(deps, worktreeId, command.instance);
    if (typeof resolved !== 'string') {
      deps.stderr(`--instance ${command.instance} を解決できなかった（${resolved.error}）。何も送っていない`);
      return 2;
    }
    // The send names the instance the rule was checked against, not the alias (Codex P2-2).
    instance = resolved;
    toClaude3 = resolved === DISPATCH_INSTANCE_ID;
  }

  if (toClaude3) {
    if (!command.token) {
      deps.stderr('claude-3 へは予約の token が要る（claude3-reserve.ts reserve → --token。docs/orchestrate/team.md §4）。何も送っていない');
      return 2;
    }
    // The claude-3 send's stderr is read here: claude3-reserve's own runner drops it.
    const injected = deps.reserve?.exec !== undefined || deps.reserve?.spawnExec !== undefined;
    const reserveSpawn = overrides.reserveSpawn ?? (injected ? undefined : defaultReserveSpawn);
    let reserveStderr = '';
    const spawnExec: SpawnExec | undefined = reserveSpawn
      ? async (c, a, onChild) => {
          const result = await reserveSpawn(c, a, onChild);
          reserveStderr += result.stderr;
          return { status: result.status, stdout: result.stdout };
        }
      : undefined;
    const status = await reserveMain(['send', '--token', command.token, '--note', command.note, command.message], {
      stderr: deps.stderr,
      ...deps.reserve,
      ...(spawnExec ? { spawnExec } : {}),
    });
    return afterSend(deps, status, reserveStderr);
  }
  if (command.token) {
    deps.stderr('--token は claude-3 宛てにだけ使う。何も送っていない');
    return 2;
  }
  const result = await deps.spawn('commandmate', pmSendCommandArgv({ ...command, worktreeId, instance }));
  return afterSend(deps, result.status ?? 2, result.stderr);
}

/** The send's exit as it is; after the pace refusal, the line that says what to do instead (never a plain send). */
function afterSend(deps: PmSendDeps, status: number, stderr: string | undefined): number {
  if (status !== 0 && isRelayRoundsRefusal(stderr)) deps.stderr(RELAY_ROUNDS_REFUSED_NOTICE);
  return status;
}
