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
 * Never throws. A daemon that cannot serve the ledger is a reason to fall back
 * to the pane, not a reason to lose a turn that already completed.
 *
 * @param client - API client
 * @param worktreeId - Worktree ID
 * @param instanceId - Resolved instance ID
 * @param since - ISO timestamp taken immediately before the send
 */
async function readLatestReply(
  client: ApiClient,
  worktreeId: string,
  instanceId: string | undefined,
  since: number,
): Promise<string | null> {
  const query = new URLSearchParams({ limit: String(REPLY_LOOKBACK_MESSAGES) });
  if (instanceId) query.set('instance', instanceId);

  let messages: PromptMessageResponse[];
  try {
    // PromptMessageResponse is the CLI's mirror of a serialized chat row; the
    // `messageType: 'prompt'` filter is the caller's, not the type's, so it is
    // the right shape for reading normal rows too.
    messages = await client.get<PromptMessageResponse[]>(
      `/api/worktrees/${worktreeId}/messages?${query.toString()}`,
    );
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) return null;

  const replies = messages.filter(
    (m) =>
      m.role === 'assistant'
      && m.messageType !== 'prompt'
      && typeof m.content === 'string'
      && m.content.trim() !== ''
      && Date.parse(m.timestamp) >= since,
  );
  if (replies.length === 0) return null;
  return replies[replies.length - 1].content.trim();
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
        const target = options.instance
          ? await resolveInstanceTarget(client, worktreeId, options.instance, options.agent)
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
        let reply = await readLatestReply(client, worktreeId, instanceId, askedAt);
        if (reply === null && agent) {
          source = 'pane';
          reply = await readPaneTail(client, worktreeId, agent, instanceId);
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
