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
import { ApiClient, isDeadlineExceeded, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import type { ChatMessage, PromptMessageResponse } from '../types/api-responses';
import {
  TRANSCRIPT_READER_TOOLS,
  fetchPromptRowsSince,
  fetchRecentMessages,
  hasForeignPromptInWindow,
  mayHaveDroppedRowsSince,
  ownPromptInstance,
  pickLatestReply,
  replyCandidates,
  sanitizeReply,
} from '../utils/reply-ledger';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import {
  isInstanceSelector,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
} from './instances';
import { resolveCommandTarget } from './command-target';
import { pollWorktree } from './wait';
import { readSqueezedPaneTail } from './capture';
import {
  ALLOW_RELAY_CHAIN_DESCRIPTION,
  REPLY_TO_OPTION_DESCRIPTION,
  type RegisteredRelay,
} from './relays';
import { postMessage, registerRelayForMessage } from './message-dispatch';

/** Default `--timeout`, in seconds. Matches the GUI's delegation brief. */
const DEFAULT_ASK_TIMEOUT_SECONDS = 1800;

/** Squeezed pane lines kept for the fallback reply. */
const PANE_FALLBACK_TAIL = 80;

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
 *
 * Issue #3983: also the bound of each read after the turn ended (the ledger,
 * the overlap pages, the pane). Those are outside `--timeout` — the turn has
 * already completed in time — so a read that does not answer within the grace
 * moves on to the next fallback rather than ending the ask with 124.
 */
const REPLY_TURN_ROW_GRACE_MS = 15_000;

/** How often the grace above re-reads the ledger. */
const REPLY_TURN_ROW_POLL_MS = 1_000;

/** Sleep, for the grace window above. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Where the printed reply came from. Reported in `--json`. */
type ReplySource = 'history' | 'pane' | 'none';

/**
 * Why this ask's turn may have answered somebody else as well (Issue #3955).
 *
 * - `turn-already-open`: the turn whose end `ask` waited on had opened before
 *   the message was sent — the message joined a turn another sender started
 *   (the later of two overlapping asks).
 * - `foreign-message`: another message reached the instance between the send
 *   and the end of the turn (the earlier of two overlapping asks).
 */
type OverlapReason = 'turn-already-open' | 'foreign-message';

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
): Promise<{ content: string | null; messages: PromptMessageResponse[] | null }> {
  const requireTurnRow = cliToolId !== undefined && TRANSCRIPT_READER_TOOLS.has(cliToolId);
  const deadline = Date.now() + (requireTurnRow ? REPLY_TURN_ROW_GRACE_MS : 0);
  // Issue #3983: every read is bounded by the grace, with or without a turn row
  // to wait for; one that runs out falls back to the pane like an empty ledger.
  const graceClient = client.withDeadline(Date.now() + REPLY_TURN_ROW_GRACE_MS);

  for (;;) {
    let messages: PromptMessageResponse[] | null;
    try {
      messages = await fetchRecentMessages(graceClient, worktreeId, instanceId);
    } catch (error) {
      if (!isDeadlineExceeded(error)) throw error;
      return { content: null, messages: null };
    }
    // The rules are `reply`'s too (Issue #3039). A tool with no transcript
    // takes the newest row after the send, marker or not, with no wait.
    const reply = pickLatestReply(replyCandidates(messages ?? [], since), requireTurnRow);
    // The rows go back with the answer so the overlap check (Issue #3955)
    // reads the same ledger the reply came from, with no request of its own.
    if (reply) return { content: reply.content, messages };
    if (!requireTurnRow || Date.now() >= deadline) return { content: null, messages };
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
  // Issue #3983: bounded like the ledger reads; a pane that does not answer is
  // "no readable pane" (readSqueezedPaneTail never throws).
  const graceClient = client.withDeadline(Date.now() + REPLY_TURN_ROW_GRACE_MS);
  return readSqueezedPaneTail(graceClient, worktreeId, cliToolId, instanceId, PANE_FALLBACK_TAIL);
}

/** Argument checks. A mocked `process.exit` returns, so nothing here stops early. */
function validateAskArgs(worktreeId: string, message: string, options: AskOptions): void {
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
}

/** `--async`: prints the relay id (or its JSON) and exits 0. */
function printAsyncAck(
  worktreeId: string,
  instanceId: string | undefined,
  agent: string | undefined,
  relayId: string,
  options: AskOptions,
): void {
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
}

/** A non-success wait: prints the payload and exits with wait's code. */
function reportWaitFailure(
  result: Awaited<ReturnType<typeof pollWorktree>>,
  worktreeId: string,
  instanceId: string | undefined,
  agent: string | undefined,
  options: AskOptions,
): void {
  // Same stdout contract as `wait`: the prompt payload, and nothing
  // else, so a caller can parse it without stripping progress lines.
  if (result.output) {
    console.log(JSON.stringify(result.output));
  }
  if (result.upstreamFault && options.json) {
    console.log(JSON.stringify({
      worktreeId,
      instanceId: instanceId ?? null,
      cliToolId: agent ?? null,
      upstreamFault: result.upstreamFault,
    }, null, 2));
  }
  process.exit(result.exitCode);
}

/** Reads the reply from the transcript, falling back to the pane. */
async function readAskReply(
  client: ApiClient,
  worktreeId: string,
  instanceId: string | undefined,
  askedAt: number,
  agent: string | undefined,
): Promise<{ source: ReplySource; reply: string | null; messages: PromptMessageResponse[] | null }> {
  let source: ReplySource = 'history';
  const latest = await readLatestReply(client, worktreeId, instanceId, askedAt, agent);
  let reply = latest.content;
  if (reply === null && agent) {
    source = 'pane';
    const pane = await readPaneTail(client, worktreeId, agent, instanceId);
    const cleaned = pane === null ? '' : sanitizeReply(pane);
    reply = cleaned === '' ? null : cleaned;
  }
  if (reply === null) {
    source = 'none';
  }
  return { source, reply, messages: latest.messages };
}

/**
 * Whether this ask's turn was shared with another message (Issue #3955).
 *
 * codex 0.164.0 folds a message typed while a turn is running into that turn
 * ("Messages to be submitted after next tool call") and answers both with one
 * reply, so two overlapping asks to one instance both exit 0 and one of them
 * prints the other's answer (UAT 2026-10-27: 3 runs out of 4). Which reply
 * belongs to which message is not on the wire, so this does not try to
 * attribute it; it says the reply may not be this ask's.
 *
 * Both sides of the overlap, from records `ask` already reads:
 *
 * - the later ask: the send API's `turnOpenAtSend` (Issue #3957) — whether a
 *   turn was open at the moment the body started going in, read on the server
 *   at that moment. When the key is there its value alone decides this side:
 *   it does not depend on the record a poll sees (the server publishes only
 *   the newest one, and a turn opening right after the send replaces it before
 *   the first poll), and `askedAt` is earlier than the input, so a turn that
 *   closed in between is not this message's. Without the key ("not known": a
 *   tool whose hooks report no turn start, an older server), a turn that
 *   opened before `askedAt` and had not closed by
 *   it — the turn `wait` adopted, or any turn record a poll saw (`wait` drops a
 *   closed turn that opened more than one poll interval before it started, so
 *   a turn that closed before this ask's first poll is only in the record).
 *   Only a tool whose hooks report turns publishes one, and a turn that had
 *   closed before the send does not count, so a plain ask never sees it;
 * - the earlier ask: a `user` row with other text on the same instance sits
 *   between this ask's own input and the end of the turn. The lower bound is
 *   the row the send API returned (`foreignSince`, the server's stamp of the
 *   input start), so a request that went in and was answered while this one
 *   waited for the input lock is not counted (Issue #3957); `askedAt` when the
 *   send did not say. The upper bound is the server's close time when it
 *   published one, else the moment the turn was seen to end, so a message sent
 *   after the `Stop` (to the next turn) is not counted. With no instance
 *   resolved for the send there is no "same instance", and this side is off.
 *
 * @returns The first reason that applies, or null
 */
function detectOverlap(input: {
  message: string;
  askedAt: number;
  until: number;
  turnStartedAt: number | null;
  turnClosedAt: number | null;
  openAtSend: boolean;
  /** The send API's reading at the input start (Issue #3957); undefined when not known. */
  turnOpenAtSend: boolean | undefined;
  /** Lower bound of the earlier-ask side: this ask's own row stamp, else `askedAt` (Issue #3957). */
  foreignSince: number;
  instanceId: string | null;
  messages: PromptMessageResponse[] | null;
}): OverlapReason | null {
  if (input.turnOpenAtSend !== undefined) {
    if (input.turnOpenAtSend) return 'turn-already-open';
  } else {
    const closedBeforeSend = input.turnClosedAt !== null && input.turnClosedAt < input.askedAt;
    if (input.turnStartedAt !== null && input.turnStartedAt < input.askedAt && !closedBeforeSend) {
      return 'turn-already-open';
    }
    if (input.openAtSend) return 'turn-already-open';
  }
  if (
    input.messages
    && input.instanceId !== null
    && hasForeignPromptInWindow(input.messages, input.message, input.foreignSince, input.until, input.instanceId)
  ) {
    return 'foreign-message';
  }
  return null;
}

/**
 * The stamp of the row the send API wrote for this ask, in epoch ms, or null
 * when the body carried none (an older server, a mocked send) (Issue #3957).
 */
function sentRowStamp(sent: ChatMessage | undefined): number | null {
  if (typeof sent?.timestamp !== 'string') return null;
  const at = Date.parse(sent.timestamp);
  return Number.isFinite(at) ? at : null;
}

/**
 * Where this ask's turn ended, for the overlap window (Issue #3955): the
 * server's close time when one is known and not before the send, else the
 * moment the turn was seen to end. A message stamped later went to the next
 * turn.
 */
function overlapWindowEnd(
  askedAt: number,
  turnEndedAt: number,
  closedAt: number | null,
): number {
  return closedAt !== null && closedAt >= askedAt ? Math.min(closedAt, turnEndedAt) : turnEndedAt;
}

/**
 * The ledger rows the overlap check reads, and the instance it is about
 * (Issue #3955).
 *
 * The reply read's rows, plus — when that read came back full of rows newer
 * than the send, so a `user` row may have been cut off — every `user` row since
 * the send, paged in its own requests. The reply read itself is left as it is.
 * The instance is the one the send was resolved to, else the one the ledger
 * shows this ask's own row on inside `[askedAt, until]`, else null — the same
 * window the overlap is looked for in, so the same text sent to another
 * instance after this turn ended cannot leave the instance undecided.
 */
async function readOverlapLedger(
  client: ApiClient,
  worktreeId: string,
  instanceId: string | undefined,
  message: string,
  askedAt: number,
  until: number,
  messages: PromptMessageResponse[] | null,
): Promise<{ messages: PromptMessageResponse[] | null; instanceId: string | null }> {
  let rows = messages;
  if (rows && mayHaveDroppedRowsSince(rows, askedAt)) {
    // Issue #3983: bounded by the reply grace; a page that does not answer in
    // it is read like one that failed — the rows already read stand.
    const graceClient = client.withDeadline(Date.now() + REPLY_TURN_ROW_GRACE_MS);
    const since = await fetchPromptRowsSince(graceClient, worktreeId, instanceId, askedAt).catch(
      (error: unknown) => {
        if (isDeadlineExceeded(error)) return null;
        throw error;
      },
    );
    if (since) rows = [...rows, ...since];
  }
  const target = instanceId ?? (rows ? ownPromptInstance(rows, message, askedAt, until) : null);
  return { messages: rows, instanceId: target };
}

/** The one stderr line for an overlap (Issue #3955). */
function formatOverlapWarning(reason: OverlapReason, target: string): string {
  const what = reason === 'turn-already-open'
    ? `${target} was already in a turn when this message was sent, so the reply may be that turn's`
    : `another message reached ${target} during this turn, so the reply may answer it`;
  return `overlapped: ${what} rather than this ask's (send one ask at a time per instance)`;
}

/** Prints the reply (or its JSON, or the no-reply warning). */
function printAskReply(
  worktreeId: string,
  instanceId: string | undefined,
  agent: string | undefined,
  source: ReplySource,
  reply: string | null,
  options: AskOptions,
  overlapped: boolean,
): void {
  if (options.json) {
    // `overlapped` only when it is true (Issue #3955): an ask that did not
    // overlap prints exactly the payload it always did.
    console.log(JSON.stringify({
      worktreeId,
      instanceId: instanceId ?? null,
      cliToolId: agent ?? null,
      source,
      reply,
      ...(overlapped ? { overlapped: true } : {}),
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
  11   the turn never ran: an upstream fault is on the screen. stderr and --json
       name it (id=...). id=context-limit: the conversation is over the model's
       limit; \`instances <id> kill <instance>\` and ask again in a fresh session
  21   nothing was running to ask
  124  timed out. Look with \`capture <id> --instance <id> --pane --tail 60\`.
       When the send itself returned past the deadline, the message WAS sent
       (stderr says so); do not send it again

Send one ask at a time to an instance (Issue #3955). A message sent while the
instance is mid-turn can be folded into that turn (codex does), and the two
asks then get one reply between them. When ask sees that, it still exits 0
with the reply but prints \`overlapped: ...\` on stderr and --json adds
"overlapped": true — the reply may answer the other message.
--async relays (and send --reply-to) take only a turn that ended after the
message went in, and note a proven overlap on the delivered reply's second line
(\`[CommandMate relay] ... (overlap=later)\`); see \`relays --id <relay-id>\`.

There is deliberately no --auto-yes: turning another session's Auto-Yes on is
a decision about that session's guard rails, not part of asking it a question.
`)
    .action(async (worktreeId: string, message: string, options: AskOptions) => {
      // Issue #3983: `--timeout` counts from here, the resolution and the send
      // included.
      const commandStartedAt = Date.now();
      try {
        validateAskArgs(worktreeId, message, options);

        const timeout = parseTimeout(options.timeout);
        const client = new ApiClient({ token: options.token });
        const deadlineAt = commandStartedAt + timeout * 1000;

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
        //
        // Issue #3983: bounded by `--timeout`; running out is exit 124, nothing sent.
        const commandTarget = await resolveCommandTarget(
          client.withDeadline(deadlineAt),
          worktreeId,
          selector,
          options.agent,
        );
        const { agent, instanceId } = commandTarget;

        // Taken BEFORE the send so a reply written by the previous turn cannot
        // be read as this one's. Milliseconds, compared against the row's own
        // timestamp rather than against a re-derived clock.
        const askedAt = Date.now();

        // Issue #2377: registered BEFORE the send, so a session that answers
        // immediately cannot finish its turn in the window between the message
        // and the ledger row. A refusal exits 2 having sent nothing.
        //
        // Issue #3983: the endpoint resolution is bounded by `--timeout` (exit
        // 124, nothing registered or sent); the relay POST is not cut, like `/send`.
        let relay: RegisteredRelay | undefined;
        if (options.async) {
          relay = await registerRelayForMessage(client, {
            worktreeId,
            replyTo: options.replyTo ?? 'self',
            instance: options.instance,
            agent: options.agent,
            allowRelayChain: options.allowRelayChain,
            resolveClient: client.withDeadline(deadlineAt),
          });
        }

        const sendBody: Record<string, unknown> = { content: message };
        if (agent) sendBody.cliToolId = agent;
        if (instanceId) sendBody.instanceId = instanceId;

        // The other session may be sitting on a dialog (Issue #1708): the
        // message would be typed into the dialog's input line instead of
        // reaching the agent. Reported as a config error with the server's
        // own sentence: the answer is to look at that session, never to
        // re-send.
        // Issue #3957: a bound relay's id rides on the send (see `postMessage`).
        const sent = await postMessage(client, worktreeId, sendBody, {
          relay,
          promptWaitingFallback: `${worktreeId} is waiting on a prompt; the message was not sent.`,
          target: commandTarget,
        });

        // Issue #2377: the whole point of `--async`. Nothing is waited on, so
        // the caller's own turn ends here and the answer arrives later, in their
        // composer, as a `relay` row.
        if (relay) {
          printAsyncAck(worktreeId, instanceId, agent, relay.id, options);
          return;
        }

        // Issue #3983: the send itself is not cut by `--timeout` — aborting it
        // would leave "was it sent?" unanswered — but its time counts. Past the
        // deadline once it returns, the ask ends here, saying the message went in.
        if (Date.now() >= deadlineAt) {
          console.error(
            `Timeout: ${worktreeId} exceeded ${timeout}s while the message was being sent. `
            + 'The message was sent; not waiting for the reply. '
            + `Look with \`capture ${worktreeId}${instanceId ? ` --instance ${instanceId}` : ''} --pane --tail 60\`.`
          );
          process.exit(WaitExitCode.TIMEOUT);
          return;
        }

        console.error('Message sent. Waiting for the reply...');

        // `wait`'s own poller, with `wait`'s own defaults: --on-prompt is left
        // at `agent`, so a prompt ends this ask with exit 10 and the payload
        // rather than blocking until the timeout.
        // Issue #3955: the turn `wait` settled on, for the overlap check.
        const turn: { startedAt: number | null; closedAt: number | null } = { startedAt: null, closedAt: null };
        // Every turn record a poll saw, adopted or not: whether one was open at
        // the send, and the close time of the newest.
        const record: { openAtSend: boolean; closedAt: number | null } = { openAtSend: false, closedAt: null };
        const result = await pollWorktree(client, worktreeId, {
          timeout,
          timeoutStartedAt: commandStartedAt,
          instance: instanceId,
          token: options.token,
          // Always on (Issue #3011): a turn that never ran must not read as a reply.
          failOnUpstreamFault: true,
          onTurnStart: (startedAt, closedAt) => {
            // The close time is kept from the first poll that saw this turn
            // closed; a later poll publishing a newer turn does not erase it.
            if (startedAt !== turn.startedAt) turn.closedAt = null;
            turn.startedAt = startedAt;
            if (closedAt !== null && turn.closedAt === null) turn.closedAt = closedAt;
          },
          onTurnRecord: (openedAt, closedAt) => {
            record.closedAt = closedAt;
            if (openedAt !== null && openedAt < askedAt && (closedAt === null || closedAt >= askedAt)) {
              record.openAtSend = true;
            }
          },
        });

        if (result.exitCode !== WaitExitCode.SUCCESS) {
          reportWaitFailure(result, worktreeId, instanceId, agent, options);
          return;
        }

        // Taken before the reply grace: a message sent after the turn ended
        // went to the next turn, and is not an overlap with this one.
        const turnEndedAt = Date.now();
        const { source, reply, messages } = await readAskReply(client, worktreeId, instanceId, askedAt, agent);

        // Reported, not acted on (Issue #3955): the exit code and the reply
        // stay as they are; the line says the reply may not be this ask's.
        const until = overlapWindowEnd(askedAt, turnEndedAt, turn.closedAt ?? record.closedAt);
        const ledger = await readOverlapLedger(client, worktreeId, instanceId, message, askedAt, until, messages);
        const overlap = detectOverlap({
          message,
          askedAt,
          until,
          turnStartedAt: turn.startedAt,
          turnClosedAt: turn.closedAt,
          openAtSend: record.openAtSend,
          // Issue #3957: the server's own reading at the input start, when it has one.
          turnOpenAtSend: typeof sent?.turnOpenAtSend === 'boolean' ? sent.turnOpenAtSend : undefined,
          foreignSince: sentRowStamp(sent) ?? askedAt,
          instanceId: ledger.instanceId,
          messages: ledger.messages,
        });
        if (overlap) {
          console.error(formatOverlapWarning(overlap, instanceId ?? ledger.instanceId ?? agent ?? worktreeId));
        }

        printAskReply(worktreeId, instanceId, agent, source, reply, options, overlap !== null);
        process.exit(ExitCode.SUCCESS);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
