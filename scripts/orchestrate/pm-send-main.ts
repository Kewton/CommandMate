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
 * `claude3-reserve.ts send`, which adds the same relay.
 *
 * One server, one target (I3'): the endpoint is resolved once (the CLI's own
 * `loadClientEnv` → `resolveServerEndpoint`) and pinned for every child
 * `commandmate` (CM_PORT / CM_BIND / CM_HTTPS_CERT / CM_HTTPS_KEY exported, so a
 * CLI that reads another .env still dials this one). On it, the worktree is made
 * current (`GET /api/worktrees/:id`: a former id of mycodebranchdesk is
 * mycodebranchdesk) and the selector resolved (`GET …/resolve-target`: an alias
 * of claude-3 is claude-3) — for every target, so the claude-3 rule does not
 * depend on how either is named. Right before the send the resolved ids are
 * checked again, by pm-send on the endpoint and by the CLI itself
 * (`commandmate reply … --json`, `commandmate ls --json`): the same worktree row
 * (id and path) and the id resolving to itself with the same tool. Anything else
 * — a row gone and its id now another instance's alias, a CLI on another
 * server, a read that fails — sends nothing (exit 2). The message goes after
 * `--`, so one that starts with "-" is the message, not an option.
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
import { loadClientEnv, resolveServerEndpoint } from '@/cli/utils/server-url';
import { isUatIsolationEnabled } from '@/config/uat-isolation';
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

/** The one server pm-send and its children talk to (I3'). */
export interface Endpoint {
  url: string;
  /** Exported to every child `commandmate`, so it dials `url` whatever .env it would read. */
  env: Record<string, string>;
}

/** A resolved target, as the server states it. */
export interface ResolvedWorktree {
  id: string;
  path: string;
}
export interface ResolvedInstance {
  instanceId: string;
  cliToolId: string;
}

/** pm-send's own reads, on the pinned endpoint. */
export interface TargetApi {
  /** `GET /api/worktrees/:id`: a former id answers with the current worktree. */
  worktree: (worktreeId: string) => Promise<ResolvedWorktree | { error: string }>;
  /** `GET /api/worktrees/:id/resolve-target?instance=`: a row's id first, then a tool id, then an alias. */
  resolveTarget: (worktreeId: string, selector: string) => Promise<ResolvedInstance | { error: string }>;
}

export interface PmSendDeps {
  /** A captured `commandmate` run (the CLI's own check of the target). */
  exec: Exec;
  /** The endpoint to pin, or why it cannot be named. */
  endpoint: () => Endpoint | { error: string };
  /** pm-send's reads on that endpoint. */
  api: (endpoint: Endpoint) => TargetApi;
  /** Pin the endpoint for every child that follows (production: into process.env). */
  pinEnv: (env: Record<string, string>) => void;
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
  'Usage: npx tsx scripts/orchestrate/pm-send.ts <worktree-id> --instance <id> --note "<what you wait for>" [--token <t>] [--] "<message>"',
  '',
  '  A message that starts with "-" goes after --. It is sent after -- too (claude-3: not possible, exit 2).',
  '  The target is resolved and checked on one server (the endpoint is pinned for commandmate);',
  '  if it cannot be confirmed to be the same row right before the send, nothing is sent (exit 2).',
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
  if (typeof stderr !== 'string') return false;
  return stderr.split(/\r?\n/).some((line) => RELAY_ROUNDS_REFUSAL_LINE.test(line));
}

/** The whole line `registerRelay` prints for the pace refusal (relay-policy's message after `Error: `). */
const RELAY_ROUNDS_REFUSAL_LINE =
  /^Error: This session received \d+ replies to its relays in the last \d+ minutes; the limit is \d+\. Wait before opening another \(the count clears as replies age out\)\.$/;

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
    // Everything after `--` is positional: a message may start with "-".
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
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

/** argv of the plain send (any target but claude-3). The message after `--`, so "-h" is a message. */
export function pmSendCommandArgv(command: Pick<PmSendCommand, 'worktreeId' | 'instance' | 'note' | 'message'>): string[] {
  return ['send', command.worktreeId, '--instance', command.instance, ...pmRelayFlags(command.note), '--', command.message];
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

/** The CLI's own endpoint resolution, once; its keys are what every child is pinned to. */
const defaultEndpoint: PmSendDeps['endpoint'] = () => {
  try {
    if (isUatIsolationEnabled() && !process.env.CM_PORT) return { error: 'CM_UAT_ISOLATION without CM_PORT' };
    const env = loadClientEnv();
    const endpoint = resolveServerEndpoint(env);
    return {
      url: endpoint.url,
      env: {
        CM_PORT: String(endpoint.port),
        CM_BIND: endpoint.bind,
        // An empty value is "not set" to the CLI and wins over its .env.
        CM_HTTPS_CERT: env.CM_HTTPS_CERT ?? '',
        CM_HTTPS_KEY: env.CM_HTTPS_KEY ?? '',
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const errorOf = (error: unknown): { error: string } => ({ error: error instanceof Error ? error.message : String(error) });

const defaultApi: PmSendDeps['api'] = (endpoint) => {
  const client = new ApiClient({ baseUrl: endpoint.url });
  return {
    worktree: async (worktreeId) => {
      try {
        const worktree = await client.get<{ id?: unknown; path?: unknown }>(`/api/worktrees/${encodeURIComponent(worktreeId)}`);
        if (typeof worktree.id === 'string' && worktree.id !== '' && typeof worktree.path === 'string') {
          return { id: worktree.id, path: worktree.path };
        }
        return { error: 'no id or path in the answer' };
      } catch (error) {
        return errorOf(error);
      }
    },
    resolveTarget: async (worktreeId, selector) => {
      try {
        const answer = await client.get<{ instanceId?: unknown; cliToolId?: unknown; conflict?: unknown }>(
          `/api/worktrees/${encodeURIComponent(worktreeId)}/resolve-target?instance=${encodeURIComponent(selector)}`
        );
        if (answer.conflict) return { error: 'the roster and the instance disagree (conflict)' };
        if (typeof answer.instanceId === 'string' && answer.instanceId !== '' && typeof answer.cliToolId === 'string') {
          return { instanceId: answer.instanceId, cliToolId: answer.cliToolId };
        }
        return { error: 'no instance in the answer' };
      } catch (error) {
        return errorOf(error);
      }
    },
  };
};

const defaultPinEnv: PmSendDeps['pinEnv'] = (env) => {
  Object.assign(process.env, env);
};

function defaultDeps(): PmSendDeps {
  return {
    exec: defaultExec,
    endpoint: defaultEndpoint,
    api: defaultApi,
    pinEnv: defaultPinEnv,
    spawn: defaultSpawn,
    stderr: (line) => process.stderr.write(`[pm-send] ${line}\n`),
  };
}

/** The CLI's own answer for a target (`reply --json` resolves `--instance` the way `send` does). */
function cliResolves(deps: PmSendDeps, worktreeId: string, instanceId: string): ResolvedInstance & { worktreeId: string } | { error: string } {
  const result = deps.exec('commandmate', ['reply', worktreeId, '--instance', instanceId, '--since', REPLY_SINCE_NEVER, '--json']);
  if (result.status !== 0) return { error: `commandmate reply exit ${String(result.status)}` };
  try {
    const answer = JSON.parse(result.stdout) as { worktreeId?: unknown; instanceId?: unknown; cliToolId?: unknown };
    if (typeof answer.worktreeId === 'string' && typeof answer.instanceId === 'string' && typeof answer.cliToolId === 'string') {
      return { worktreeId: answer.worktreeId, instanceId: answer.instanceId, cliToolId: answer.cliToolId };
    }
  } catch {
    // fall through
  }
  return { error: `no instance in the answer: ${result.stdout.trim()}` };
}

/** The worktree row the CLI's server has under this id (`ls --json`). */
function cliWorktreeRow(deps: PmSendDeps, worktreeId: string): ResolvedWorktree | { error: string } {
  const result = deps.exec('commandmate', ['ls', '--json']);
  if (result.status !== 0) return { error: `commandmate ls exit ${String(result.status)}` };
  try {
    const rows = JSON.parse(result.stdout) as unknown;
    if (Array.isArray(rows)) {
      const row = rows.find((r: { id?: unknown }) => r && r.id === worktreeId) as { id: string; path?: unknown } | undefined;
      if (!row) return { error: `no worktree ${worktreeId}` };
      if (typeof row.path === 'string') return { id: row.id, path: row.path };
    }
  } catch {
    // fall through
  }
  return { error: 'no worktree path in the answer' };
}

/**
 * Right before the send (I3'): the checked worktree and instance are still the same rows, on
 * pm-send's endpoint and as the CLI that sends sees them. Null when they are; else why not.
 */
async function confirmTarget(
  deps: PmSendDeps,
  api: TargetApi,
  worktree: ResolvedWorktree,
  instance: ResolvedInstance
): Promise<string | null> {
  const same = (a: ResolvedInstance, b: ResolvedInstance): boolean => a.instanceId === b.instanceId && a.cliToolId === b.cliToolId;
  const again = await api.worktree(worktree.id);
  if ('error' in again) return `worktree ${worktree.id} を読み直せない（${again.error}）`;
  if (again.id !== worktree.id || again.path !== worktree.path) return `worktree ${worktree.id} が判定した行と違う（${again.id} ${again.path}）`;
  const resolvedAgain = await api.resolveTarget(worktree.id, instance.instanceId);
  if ('error' in resolvedAgain) return `${instance.instanceId} を読み直せない（${resolvedAgain.error}）`;
  if (!same(resolvedAgain, instance)) return `${instance.instanceId} が判定した行と違う（今は ${resolvedAgain.instanceId} / ${resolvedAgain.cliToolId}）`;
  const row = cliWorktreeRow(deps, worktree.id);
  if ('error' in row) return `commandmate から worktree ${worktree.id} を確かめられない（${row.error}）`;
  if (row.path !== worktree.path) return `commandmate の接続先の worktree ${worktree.id} が別の行（${row.path}。判定は ${worktree.path}）`;
  const cli = cliResolves(deps, worktree.id, instance.instanceId);
  if ('error' in cli) return `commandmate から ${instance.instanceId} を確かめられない（${cli.error}）`;
  if (cli.worktreeId !== worktree.id || !same(cli, instance)) {
    return `commandmate では ${instance.instanceId} が別の宛先（${cli.worktreeId} / ${cli.instanceId} / ${cli.cliToolId}）`;
  }
  return null;
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

  // One server for everything below (I3'): pinned before any child runs.
  const endpoint = deps.endpoint();
  if ('error' in endpoint) {
    deps.stderr(`接続先を決められなかった（${endpoint.error}）。何も送っていない`);
    return 2;
  }
  deps.pinEnv(endpoint.env);
  const api = deps.api(endpoint);

  // The current worktree id: a former id of mycodebranchdesk must meet the same rule (Codex P2-1).
  const worktree = await api.worktree(command.worktreeId);
  if ('error' in worktree) {
    deps.stderr(`worktree ${command.worktreeId} を解決できなかった（${worktree.error}）。何も送っていない`);
    return 2;
  }
  // The instance id behind the selector (an alias of claude-3 is claude-3); the send names this id (Codex P2-2).
  const instance = await api.resolveTarget(worktree.id, command.instance);
  if ('error' in instance) {
    deps.stderr(`--instance ${command.instance} を解決できなかった（${instance.error}）。何も送っていない`);
    return 2;
  }
  const worktreeId = worktree.id;
  const toClaude3 = worktreeId === DISPATCH_WORKTREE_ID && instance.instanceId === DISPATCH_INSTANCE_ID;

  if (toClaude3 && !command.token) {
    deps.stderr('claude-3 へは予約の token が要る（claude3-reserve.ts reserve → --token。docs/orchestrate/team.md §4）。何も送っていない');
    return 2;
  }
  if (!toClaude3 && command.token) {
    deps.stderr('--token は claude-3 宛てにだけ使う。何も送っていない');
    return 2;
  }
  if (toClaude3 && command.message.startsWith('-')) {
    deps.stderr('claude-3 宛ての本文は "-" で始められない（claude3-reserve の送信は本文を位置引数で渡す）。先頭を変えて送り直す。何も送っていない');
    return 2;
  }

  const unconfirmed = await confirmTarget(deps, api, worktree, instance);
  if (unconfirmed !== null) {
    deps.stderr(`${unconfirmed}。判定した宛先と送る宛先が同じと確かめられないので、何も送っていない`);
    return 2;
  }

  if (toClaude3 && command.token) {
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
  const result = await deps.spawn('commandmate', pmSendCommandArgv({ ...command, worktreeId, instance: instance.instanceId }));
  return afterSend(deps, result.status ?? 2, result.stderr);
}

/** The send's exit as it is; after the pace refusal, the line that says what to do instead (never a plain send). */
function afterSend(deps: PmSendDeps, status: number, stderr: string | undefined): number {
  if (status === 2 && isRelayRoundsRefusal(stderr)) deps.stderr(RELAY_ROUNDS_REFUSED_NOTICE);
  return status;
}
