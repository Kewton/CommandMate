/**
 * ask Command - one round trip to another agent session (Issue #2376)
 *
 *   commandmate ask <worktree-id> "<message>" [--instance <id|alias>]
 *                   [--agent <tool>] [--timeout <seconds>] [--json]
 *
 * ## Why this exists next to send / wait / capture
 *
 * Delegation between two agent sessions was a HARNESS, not a command. Session A
 * had to `send`, then `wait`, then branch on four exit codes, then `capture` and
 * work out which part of the pane was the reply — and every one of those steps
 * is a place to get it wrong in a way that fails quietly. Dropping the `wait`
 * spins; reading the pane without one reads the previous turn; answering the
 * other session's prompt with `respond` picks whatever option happened to be
 * highlighted (#1681).
 *
 * `ask` is those three steps with the branch already taken. It is deliberately
 * NOT a new mechanism: the send is the same POST, the wait is `wait`'s own
 * {@link pollWorktree}, and the exit codes are `wait`'s exit codes. What it adds
 * is the last step nothing had — turning "the turn ended" into "here is what
 * they said" — and the two guarantees the brief in the GUI promises: `--auto-yes`
 * is not offered, and a prompt is reported rather than answered.
 *
 * ## Where the reply comes from
 *
 * The chat ledger first (`chat_messages`, what the transcript readers and the
 * structured-history gate write), because that is the agent's reply as text —
 * no box drawing, no composer, no spinner frames. A tool that has no transcript
 * reader falls back to the squeezed pane, and `--json` says which of the two
 * answered in `source` so a caller can tell a real reply from a screen scrape.
 */

import { Command } from 'commander';
import { ExitCode, WaitExitCode } from '../types';
import type { ChatMessage, PromptMessageResponse } from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import {
  isInstanceSelector,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
  resolveInstanceTarget,
} from './instances';
import { pollWorktree } from './wait';
import { readSqueezedPaneTail } from './capture';
import {
  ALLOW_RELAY_CHAIN_DESCRIPTION,
  REPLY_TO_OPTION_DESCRIPTION,
  cancelRelayQuietly,
  registerRelay,
  resolveEndpointForWorktree,
  resolveRelayEndpoint,
} from './relays';

/**
 * Code the send API returns when the session is blocked on a prompt.
 *
 * Mirrors `PROMPT_WAITING_CODE` in `send.ts`, which mirrors the server's own —
 * the CLI bundle keeps its own copies of API strings rather than importing the
 * server's tmux/detection graph for one of them.
 */
const PROMPT_WAITING_CODE = 'PROMPT_WAITING';

/** Default `--timeout`, in seconds. Matches the GUI's delegation brief. */
const DEFAULT_ASK_TIMEOUT_SECONDS = 1800;

/**
 * Chat rows read back after the turn.
 *
 * Bounded because only the tail matters and an unbounded read of a long-running
 * worktree's history is a large response for one line of answer. Generous
 * enough that a turn which wrote several assistant rows (a tool-use narration
 * followed by the summary) still has its last one inside the window.
 */
const REPLY_LOOKBACK_MESSAGES = 30;

/** Squeezed pane lines kept for the fallback reply. */
const PANE_FALLBACK_TAIL = 80;

/**
 * The `request_id` namespace every transcript reader mints for a turn.
 *
 * `codex-turn:<turn_id>`, `claude-turn:<uuid>`, `antigravity-turn:<id>`,
 * `command-code-turn:<id>` and opencode's `oc-turn:<msg id>` — mirrored here as
 * a shape rather than imported, for the reason {@link PROMPT_WAITING_CODE}
 * gives: the CLI bundle keeps its own copies of API strings instead of pulling
 * `src/types/agent-transcript.ts` and its dependents into `build:cli`. Matching
 * the shape rather than a list of five literals is also what stops the sixth
 * reader from silently landing outside the filter.
 *
 * A `:` cannot appear in any of the ids themselves, so this cannot match a row
 * that merely CONTAINS the text.
 */
const TURN_REQUEST_ID_PATTERN = /-turn:/;

/**
 * Request-id namespaces CommandMate writes about a session, not for it.
 *
 * `chat_messages` has no `system` role, so "the model changed" (Issue #2357)
 * and "reply from X" (Issue #2377) are both stored as ASSISTANT rows and told
 * apart by their request id. Neither is anything the other session said, and
 * delivering the relay notice back as an answer is the smallest possible loop —
 * `findWorkerReply` steps over the same rows for the same reason.
 */
const SYSTEM_ROW_REQUEST_ID_PREFIXES = ['relay-sys:', 'model-changed:'] as const;

/**
 * Tools whose reply CommandMate reads out of a transcript rather than a screen.
 *
 * For these five the ledger is authoritative and a row with no turn marker is
 * by definition not the answer, so `ask` may hold out for a marked one. For
 * every other tool (copilot / gemini / vibe-local) the scraper's row is the
 * only record there will ever be, and demanding a marker would throw away a
 * cleaned reply in favour of the raw pane.
 *
 * Mirrors the five readers that live under `src/lib/hooks/sources/`.
 */
const TRANSCRIPT_READER_TOOLS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'antigravity',
  'command-code',
  'opencode',
]);

/**
 * How long `ask` will hold out for the turn row after the turn ends.
 *
 * Issue #2386 measured the gap on codex 0.153.4 at 5.2 s: the scraper writes the
 * idle composer into the ledger in the millisecond BEFORE the send, and the
 * rollout reader writes the real answer five seconds after `wait` has already
 * said `basis=hook_stop`. Reading once at that instant is how the junk got
 * printed as the answer, three times out of three.
 *
 * Three times the measured gap, and spent only when the ledger has nothing
 * marked yet — a session that already answered returns on the first read. When
 * it does elapse the existing pane fallback takes over, so the cost of guessing
 * this too low is a screen scrape, never a lost turn.
 */
const REPLY_TURN_ROW_GRACE_MS = 15_000;

/** How often the grace above re-reads the ledger. */
const REPLY_TURN_ROW_POLL_MS = 1_000;

/**
 * ANSI escape sequences, as a pattern built from escapes rather than literals.
 *
 * `scripts/check-control-chars.mjs` fails the build on a raw C0 byte in `src/`
 * (Issue #1432), and a raw ESC here would be one.
 */
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g;

/** Remaining C0/C1 control bytes, once the sequences above are gone. */
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Sleep, for the grace window above. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A reply body fit to print, or `''` if nothing survived.
 *
 * Issue #2386 asked for this as a belt to the braces: the row the junk came
 * from held RAW ANSI, and a caller that pipes `ask` into a report or a commit
 * message should never have to strip escape codes out of an agent's sentence.
 * Applied to the pane fallback as well as to the ledger, because the pane is
 * the more likely of the two to carry them.
 *
 * @param raw - Reply text as it arrived
 */
function sanitizeReply(raw: string): string {
  return raw.replace(ANSI_ESCAPE_PATTERN, '').replace(CONTROL_CHAR_PATTERN, '').trim();
}

/** Whether a row's `request_id` says a transcript reader wrote it. */
function isTurnRow(requestId: string | undefined | null): boolean {
  return typeof requestId === 'string' && TURN_REQUEST_ID_PATTERN.test(requestId);
}

/** Whether a row is CommandMate's own furniture rather than the agent's words. */
function isSystemRow(requestId: string | undefined | null): boolean {
  return typeof requestId === 'string'
    && SYSTEM_ROW_REQUEST_ID_PREFIXES.some((prefix) => requestId.startsWith(prefix));
}

/** One assistant row that could be this turn's answer. */
interface ReplyCandidate {
  /** Sanitized body. Never empty — an empty one is not a candidate. */
  content: string;
  /** Whether a transcript reader wrote it (see {@link isTurnRow}). */
  fromTranscript: boolean;
}

/**
 * The rows that could be this turn's reply, oldest first.
 *
 * @param messages - Rows as the messages route serialized them
 * @param since - Epoch ms taken immediately before the send
 */
function replyCandidates(messages: PromptMessageResponse[], since: number): ReplyCandidate[] {
  const candidates: ReplyCandidate[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.messageType === 'prompt') continue;
    if (typeof m.content !== 'string') continue;
    if (!(Date.parse(m.timestamp) >= since)) continue;
    if (isSystemRow(m.requestId)) continue;
    const content = sanitizeReply(m.content);
    if (content === '') continue;
    candidates.push({ content, fromTranscript: isTurnRow(m.requestId) });
  }
  return candidates;
}

/**
 * The recent chat rows for this instance, or null if they cannot be read.
 *
 * @param client - API client
 * @param worktreeId - Worktree ID
 * @param instanceId - Resolved instance ID
 */
async function fetchRecentMessages(
  client: ApiClient,
  worktreeId: string,
  instanceId: string | undefined,
): Promise<PromptMessageResponse[] | null> {
  const query = new URLSearchParams({ limit: String(REPLY_LOOKBACK_MESSAGES) });
  if (instanceId) query.set('instance', instanceId);
  try {
    // PromptMessageResponse is the CLI's mirror of a serialized chat row; the
    // `messageType: 'prompt'` filter is the caller's, not the type's, so it is
    // the right shape for reading normal rows too.
    const messages = await client.get<PromptMessageResponse[]>(
      `/api/worktrees/${worktreeId}/messages?${query.toString()}`,
    );
    return Array.isArray(messages) ? messages : null;
  } catch {
    return null;
  }
}

/** Where the printed reply came from. Reported in `--json`. */
type ReplySource = 'history' | 'pane' | 'none';

/** Options for the ask command. */
interface AskOptions {
  instance?: string;
  agent?: string;
  timeout?: string;
  json?: boolean;
  token?: string;
  /** Issue #2377: register a relay and return, instead of waiting. */
  async?: boolean;
  /** Issue #2377: who the reply goes to. Defaults to `self` under `--async`. */
  replyTo?: string;
  /** Issue #2377: permit a relay opened while answering a relayed message. */
  allowRelayChain?: boolean;
}

/**
 * Parse and validate `--timeout <seconds>`.
 *
 * A bare `parseInt` is not used (unlike `wait`, which takes commander's) so a
 * value the shell mangled is an error rather than a NaN that disables the
 * deadline — an `ask` with no deadline is the unattended hang this command
 * exists to bound.
 *
 * @param raw - Raw option value, if the user passed one
 * @returns Timeout in seconds
 */
function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ASK_TIMEOUT_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error('Error: --timeout must be a positive integer number of seconds.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return value;
}

/**
 * The newest assistant message this instance wrote after `since`, or null.
 *
 * `since` is captured before the send, so a reply from the PREVIOUS turn cannot
 * be mistaken for this one — the failure a bare `capture` after a `wait` has
 * always had. Prompt rows are excluded: a prompt is reported through the exit
 * code and the JSON payload, and printing its question as if it were an answer
 * is what would teach a caller to answer it.
 *
 * ## Why a timestamp is not enough (Issue #2386)
 *
 * `since` fences off the previous turn; it does nothing about a row written
 * INSIDE this one that is not a reply. codex's screen scraper writes the idle
 * composer into the ledger as an assistant row one millisecond before the send
 * lands — measured 3/3 on codex 0.153.4 — so at the moment `wait` says
 * `basis=hook_stop` the newest row after `since` is a scrape of an empty input
 * box, in raw ANSI, and the rollout reader's real answer is still five seconds
 * away. `ask` printed the box.
 *
 * The separator is the row's own `request_id`, which is why #2386 put it on the
 * wire: a reply a transcript reader wrote is keyed `<tool>-turn:<id>`, a scrape
 * is keyed nothing at all. For a tool that HAS such a reader the marker is
 * therefore required, and this waits {@link REPLY_TURN_ROW_GRACE_MS} for one
 * rather than answering with whatever the screen happened to hold. For a tool
 * that has none — copilot / gemini / vibe-local — the scraper's row is the only
 * record there will ever be, so it is taken as it always was, with no wait.
 *
 * Never throws. A daemon that cannot serve the ledger is a reason to fall back
 * to the pane, not a reason to lose a turn that already completed.
 *
 * @param client - API client
 * @param worktreeId - Worktree ID
 * @param instanceId - Resolved instance ID
 * @param since - Epoch ms taken immediately before the send
 * @param cliToolId - Resolved CLI tool, when one is known
 */
async function readLatestReply(
  client: ApiClient,
  worktreeId: string,
  instanceId: string | undefined,
  since: number,
  cliToolId: string | undefined,
): Promise<string | null> {
  const requireTurnRow = cliToolId !== undefined && TRANSCRIPT_READER_TOOLS.has(cliToolId);
  const deadline = Date.now() + (requireTurnRow ? REPLY_TURN_ROW_GRACE_MS : 0);

  for (;;) {
    const messages = await fetchRecentMessages(client, worktreeId, instanceId);
    const candidates = replyCandidates(messages ?? [], since);

    // Newest first among the rows a reader wrote. A turn that emitted several
    // assistant rows (a narration then the summary) still ends on its summary.
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (candidates[i].fromTranscript) return candidates[i].content;
    }

    if (!requireTurnRow) {
      // Unchanged behaviour for a tool with no transcript: the newest row after
      // the send, marker or not.
      const newest = candidates[candidates.length - 1];
      return newest ? newest.content : null;
    }

    if (Date.now() >= deadline) return null;
    await sleep(REPLY_TURN_ROW_POLL_MS);
  }
}

/**
 * The squeezed tail of the pane, for a tool that keeps no transcript.
 *
 * copilot / gemini / vibe-local publish no chat rows, so the screen is the only
 * record of what they said. Through `capture`'s own reader — the same route,
 * the same squeeze, the same client-side placement — so nothing that consumes
 * `/capture` sees a different payload because this command exists.
 *
 * @param client - API client
 * @param worktreeId - Worktree ID
 * @param cliToolId - Resolved CLI tool
 * @param instanceId - Resolved instance ID
 */
async function readPaneTail(
  client: ApiClient,
  worktreeId: string,
  cliToolId: string,
  instanceId: string | undefined,
): Promise<string | null> {
  return readSqueezedPaneTail(client, worktreeId, cliToolId, instanceId, PANE_FALLBACK_TAIL);
}

export function createAskCommand(): Command {
  const cmd = new Command('ask');
  cmd
    .description(
      'Send a message to another agent session and print its reply '
      + '(send + wait + read, with wait\'s exit codes)'
    )
    .argument('<worktree-id>', 'Worktree ID')
    .argument('<message>', 'Message to send')
    .option('--instance <id>', `${INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option(
      '--timeout <seconds>',
      `Maximum time to wait for the reply (default ${DEFAULT_ASK_TIMEOUT_SECONDS})`
    )
    .option('--json', 'Print the reply as JSON with the target and the reply source')
    .option(
      '--async',
      'Do not wait: register a relay, print its id and exit 0. The reply is '
      + 'delivered into --reply-to\'s composer when the turn ends (defaults to this session)'
    )
    .option('--reply-to <target>', REPLY_TO_OPTION_DESCRIPTION)
    .option('--allow-relay-chain', ALLOW_RELAY_CHAIN_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', `
--async is the same delegation without the block (Issue #2377). Nothing waits,
stdout is the relay id, and when the other session finishes CommandMate puts
its answer into your composer prefixed with \`[from <alias> / <worktree>]\`. Use
\`commandmate relays\` to see what is outstanding and \`relays cancel <id>\` to
withdraw one. --reply-to / --allow-relay-chain are only meaningful with it.

Exit codes (wait's, unchanged; --async always exits 0 once the relay exists):
  0    the turn ended; stdout is the reply body
  10   the other session is waiting on a prompt. stdout carries the prompt JSON
       (same shape as \`wait --on-prompt agent\`). Report it; do NOT answer it
       with \`respond\` on the other session's behalf — the number that resolves
       a dialog is the dialog's own, and a wrong one picks the default (#1681).
  21   nothing was running to ask
  124  timed out. Look with \`capture <id> --instance <id> --pane --tail 60\`

There is deliberately no --auto-yes: turning another session's Auto-Yes on is
a decision about that session's guard rails, not part of asking it a question.
`)
    .action(async (worktreeId: string, message: string, options: AskOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (message.trim() === '') {
          console.error('Error: Message cannot be empty.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.agent && !isCliToolId(options.agent)) {
          console.error(`Error: Invalid agent. Must be one of: ${CLI_TOOL_IDS.join(', ')}`);
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.instance && !isInstanceSelector(options.instance)) {
          console.error(INSTANCE_SELECTOR_ERROR);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // `--reply-to` / `--allow-relay-chain` only mean something under
        // `--async`: without it `ask` returns the reply on stdout, and a second
        // copy arriving in somebody's composer is a surprise, not a feature.
        if (!options.async && (options.replyTo || options.allowRelayChain)) {
          console.error('Error: --reply-to and --allow-relay-chain require --async.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const timeout = parseTimeout(options.timeout);
        const client = new ApiClient({ token: options.token });

        // Resolved once, before the send, and reused for the wait and both
        // reads: the alias-to-id mapping and the roster's tool are the same
        // facts for all four requests, and asking twice is how two of them end
        // up addressing different sessions (Issue #1925).
        //
        // Issue #2479: `--agent` alone is resolved too, with the tool id as the
        // selector — a tool id names that tool's primary instance (#868) unless
        // the roster has a row by that id. `resolveInstanceTarget` hands back no
        // instance for an undefined selector (send / respond / capture rely on
        // that), and an instance-less `ask` sent to <tool> but waited on the
        // worktree default: exit 21 while the default was not running, and the
        // default's turn instead of <tool>'s while it was.
        const selector = options.instance ?? options.agent;
        const target = selector
          ? await resolveInstanceTarget(client, worktreeId, selector, options.agent)
          : null;
        const agent = target ? target.cliToolId : options.agent;
        const instanceId = target?.instanceId;

        // Taken BEFORE the send so a reply written by the previous turn cannot
        // be read as this one's. Milliseconds, compared against the row's own
        // timestamp rather than against a re-derived clock.
        const askedAt = Date.now();

        // Issue #2377: registered BEFORE the send, so a session that answers
        // immediately cannot finish its turn in the window between the message
        // and the ledger row. A refusal exits 2 having sent nothing.
        let relayId: string | undefined;
        if (options.async) {
          const replyEndpoint = await resolveRelayEndpoint(client, options.replyTo ?? 'self');
          const workerEndpoint = await resolveEndpointForWorktree(
            client,
            worktreeId,
            options.instance,
            options.agent
          );
          relayId = await registerRelay(client, {
            from: replyEndpoint,
            to: workerEndpoint,
            allowRelayChain: options.allowRelayChain,
          });
        }

        const sendBody: Record<string, unknown> = { content: message };
        if (agent) sendBody.cliToolId = agent;
        if (instanceId) sendBody.instanceId = instanceId;

        try {
          await client.post<ChatMessage>(`/api/worktrees/${worktreeId}/send`, sendBody);
        } catch (error) {
          // The other session is sitting on a dialog, so the message would have
          // been typed into the dialog's input line instead of reaching the
          // agent (Issue #1708). Reported as a config error with the server's
          // own sentence: the answer is to look at that session, never to
          // re-send.
          // A relay whose message never arrived can never be answered.
          if (relayId) await cancelRelayQuietly(client, relayId);
          if (error instanceof ApiError && error.apiCode === PROMPT_WAITING_CODE) {
            console.error(
              `Error: ${error.payload?.error
                ?? `${worktreeId} is waiting on a prompt; the message was not sent.`}`
            );
            process.exit(ExitCode.CONFIG_ERROR);
          }
          throw error;
        }

        // Issue #2377: the whole point of `--async`. Nothing is waited on, so
        // the caller's own turn ends here and the answer arrives later, in their
        // composer, as a `relay` row.
        if (relayId) {
          if (options.json) {
            console.log(JSON.stringify({
              worktreeId,
              instanceId: instanceId ?? null,
              cliToolId: agent ?? null,
              relayId,
              mode: 'async',
            }, null, 2));
          } else {
            console.log(relayId);
          }
          console.error(
            'Message sent. The reply will be delivered when the turn ends; '
            + 'watch it with `commandmate relays`.'
          );
          process.exit(ExitCode.SUCCESS);
          return;
        }

        console.error('Message sent. Waiting for the reply...');

        // `wait`'s own poller, with `wait`'s own defaults: --on-prompt is left
        // at `agent`, so a prompt ends this ask with exit 10 and the payload
        // rather than blocking until the timeout.
        const result = await pollWorktree(client, worktreeId, {
          timeout,
          instance: instanceId,
          token: options.token,
        });

        if (result.exitCode !== WaitExitCode.SUCCESS) {
          // Same stdout contract as `wait`: the prompt payload, and nothing
          // else, so a caller can parse it without stripping progress lines.
          if (result.output) {
            console.log(JSON.stringify(result.output));
          }
          process.exit(result.exitCode);
          return;
        }

        let source: ReplySource = 'history';
        let reply = await readLatestReply(client, worktreeId, instanceId, askedAt, agent);
        if (reply === null && agent) {
          source = 'pane';
          const pane = await readPaneTail(client, worktreeId, agent, instanceId);
          const cleaned = pane === null ? '' : sanitizeReply(pane);
          reply = cleaned === '' ? null : cleaned;
        }
        if (reply === null) {
          source = 'none';
        }

        if (options.json) {
          console.log(JSON.stringify({
            worktreeId,
            instanceId: instanceId ?? null,
            cliToolId: agent ?? null,
            source,
            reply,
          }, null, 2));
        } else if (reply === null) {
          // Not an error exit: the turn DID end, and saying so on stderr keeps
          // stdout empty rather than filling it with an apology a caller would
          // paste into a report as the agent's answer.
          console.error(
            'Warning: the turn completed but no reply could be read '
            + '(no transcript row and no readable pane).'
          );
        } else {
          console.log(reply);
        }
        process.exit(ExitCode.SUCCESS);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
