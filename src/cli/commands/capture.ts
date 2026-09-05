/**
 * capture Command - Get current terminal output
 * Issue #518: [DR1-08] Factory pattern
 * Issue #1623: `--pane` reads the raw tmux pane as a transcript (案B)
 * Issue #1685: `--prompts` lists the resolved-prompt audit trail
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { CaptureOptions } from '../types';
import type { CurrentOutputResponse, PromptMessageResponse, WorktreeDetailResponse } from '../types/api-responses';
import { MAX_MESSAGES_LIMIT } from '../../config/history-display-config';
import { ApiClient, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId, DEFAULT_CLI_TOOL_ID } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveInstanceCliTool } from './instances';
import { resolveSessionTarget, describeSessionTargetConflict } from '../utils/session-target';
import { printMaybePaged } from '../utils/pager';
import { squeezeTranscript } from '../../lib/tmux/transcript-squeeze';

/**
 * Rows of pane history the `--pane` viewer asks for.
 *
 * Deliberately NOT configurable and deliberately equal to the capture route's
 * own default: Issue #1623 has to leave the detection pipeline's view of the
 * pane untouched, and the cheapest way to guarantee that is for the viewer to
 * make exactly the request everything else already makes. `--tail` narrows the
 * RESULT instead (see {@link CaptureOptions.tail}).
 */
const PANE_CAPTURE_LINES = 1000;

/**
 * Default redraw interval of `--pane --follow`, in milliseconds (Issue #2317).
 *
 * Two seconds, matching the response poller's own cadence: a faster redraw
 * cannot show anything the server has not captured yet, and would only add tmux
 * round-trips to a session someone is already watching.
 */
const DEFAULT_FOLLOW_INTERVAL_MS = 2000;

/** Floor and ceiling for `--interval`. */
const MIN_FOLLOW_INTERVAL_MS = 250;
const MAX_FOLLOW_INTERVAL_MS = 60_000;

/**
 * `promptData.type` the server writes for a frame the detection layer could not
 * classify (Issue #1708). Mirrors UNCLASSIFIED_PROMPT_TYPE in
 * src/types/models.ts; duplicated rather than imported because the CLI bundle
 * keeps its own copy of the API shapes (see api-responses.ts).
 */
const UNCLASSIFIED_FRAME_TYPE = 'unclassified';

/** Response of POST /api/worktrees/[id]/capture. */
interface PaneCaptureResponse {
  output: string;
}

/**
 * Format capture output as JSON (excluding fullOutput for size).
 *
 * Everything the server sends except `fullOutput` passes through verbatim, which
 * is why Issue #1785's `model` / `reasoningEffort` appear in `--json` without a
 * line of code here — and why `content` / `realtimeSnippet` / `sessionStatus` /
 * `sessionStatusReason`, which the orchestrate-monitor recipe parses, cannot be
 * disturbed by a field being added upstream.
 */
function formatJson(data: CurrentOutputResponse): string {
  const { fullOutput: _fullOutput, ...rest } = data;
  return JSON.stringify(rest, null, 2);
}

/**
 * Parse and validate `--tail N`.
 *
 * @param raw - Raw option value, if the user passed one
 * @returns The parsed count, or undefined when the option was absent
 */
function parseTail(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error('Error: --tail must be a positive integer.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return value;
}

/**
 * Resolve which CLI tool's session the pane should be read from.
 *
 * POST /capture demands an explicit `cliToolId`, so unlike GET /current-output
 * this path cannot leave the choice to the server. Issue #1925 moved the choice
 * itself to the server anyway — `resolveSessionTarget` asks
 * `/resolve-target`, which applies the same precedence every other route now
 * uses, so bare `capture <id> --pane` reads the session the rest of the CLI
 * addresses instead of a locally-guessed one.
 *
 * Reading is not a side effect, so a `--agent` that contradicts the roster
 * warns and reads the roster's agent rather than failing: `capture` is the
 * inner call of unbounded monitor loops, and a non-zero exit there is a poll
 * skipped forever rather than an error anyone sees (DR3-015).
 *
 * The tail of this function only runs against a server too old to resolve, the
 * one case where the CLI still has to name a default itself.
 *
 * @param client - API client
 * @param worktreeId - Worktree ID
 * @param agent - Value of `--agent`, already validated
 * @param instance - Value of `--instance`, already validated
 * @returns CLI tool ID to capture
 */
async function resolvePaneCliTool(
  client: ApiClient,
  worktreeId: string,
  agent: string | undefined,
  instance: string | undefined
): Promise<string> {
  const target = await resolveSessionTarget(client, worktreeId, {
    instanceId: instance,
    requestedCliTool: agent,
  });
  if (target.conflict) {
    console.error(
      `Warning: ${describeSessionTargetConflict(target.conflict)} `
      + `Reading ${target.conflict.rosterCliTool}.`
    );
  }
  if (target.cliToolId) return target.cliToolId;

  const worktree = await client.get<WorktreeDetailResponse>(`/api/worktrees/${worktreeId}`);
  return worktree.cliToolId || DEFAULT_CLI_TOOL_ID;
}

/** Default number of prompts `--prompts` lists (Issue #1685). */
const DEFAULT_PROMPTS_LIMIT = 20;

/**
 * Parse and validate `--limit N` for the `--prompts` listing.
 *
 * @param raw - Raw option value, if the user passed one
 * @returns The parsed count (defaults to {@link DEFAULT_PROMPTS_LIMIT})
 */
function parsePromptsLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PROMPTS_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_MESSAGES_LIMIT) {
    console.error(`Error: --limit must be an integer between 1 and ${MAX_MESSAGES_LIMIT}.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return value;
}

/**
 * Render one prompt option for the text listing. Handles both the
 * multiple-choice object shape ({number, label, isDefault}) and plain strings
 * (yes_no options).
 */
function formatPromptOption(option: unknown): string {
  if (option !== null && typeof option === 'object') {
    const { number: num, label, isDefault } = option as { number?: number; label?: string; isDefault?: boolean };
    const body = `${num !== undefined ? `${num}) ` : ''}${label ?? ''}`.trim();
    return isDefault ? `${body} (default)` : body;
  }
  return String(option);
}

/**
 * `--prompts` path (Issue #1685): list the resolved-prompt audit trail.
 *
 * Reads prompt messages from chat history instead of the live pane, so the
 * question / options / answer / answeredBy of a prompt Auto-Yes already
 * resolved remain retrievable after the fact — the case where `wait` never
 * exited 10 and `capture --json`'s promptData is already null.
 */
async function capturePrompts(worktreeId: string, options: CaptureOptions): Promise<void> {
  const client = new ApiClient({ token: options.token });
  const limit = parsePromptsLimit(options.limit);

  const query = new URLSearchParams({ messageType: 'prompt', limit: String(limit) });
  if (options.agent) query.set('cliTool', options.agent);
  if (options.instance) query.set('instance', options.instance);

  const messages = await client.get<PromptMessageResponse[]>(
    `/api/worktrees/${worktreeId}/messages?${query.toString()}`
  );

  // Defensive: the endpoint already filters, but promptData-less rows would
  // render as empty entries.
  const prompts = messages.filter((m) => m.messageType === 'prompt' && m.promptData);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          worktreeId,
          count: prompts.length,
          prompts: prompts.map((m) => ({
            id: m.id,
            timestamp: m.timestamp,
            cliToolId: m.cliToolId ?? null,
            instanceId: m.instanceId ?? null,
            type: m.promptData!.type,
            question: m.promptData!.question,
            options: m.promptData!.options ?? null,
            status: m.promptData!.status ?? null,
            answer: m.promptData!.answer ?? null,
            answeredAt: m.promptData!.answeredAt ?? null,
            answeredBy: m.promptData!.answeredBy ?? null,
            // Issue #1699: what the contract's denyPatterns were judged against.
            // Null on rows recorded before the field existed.
            approvalTarget: m.promptData!.approvalTarget ?? null,
            // Issue #1725: which structured signal reported an unclassified row,
            // or null when the row is a plain detection failure (#1708).
            source: typeof m.promptData!.source === 'string' ? m.promptData!.source : null,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  if (prompts.length === 0) {
    console.log('No prompt history.');
    return;
  }

  const blocks = prompts.map((m) => {
    const p = m.promptData!;
    const answered = p.status === 'answered';
    // Issue #1708: a row recording that detection FAILED must not read as a
    // prompt that was seen and is merely unanswered — that reading is what would
    // send an operator looking for an answer path that never existed.
    const unclassified = p.type === UNCLASSIFIED_FRAME_TYPE;
    // Issue #1725: the same row type now has two origins, and they mean
    // opposite things about coverage. `detection-failed` is "nothing saw this";
    // `hook-<source>` is "the agent told us, and the scraper still did not see
    // it" — the second is the measurement the hooks Epic exists to produce.
    const structuredSource = typeof p.source === 'string' ? p.source : null;
    const state = unclassified
      ? structuredSource
        ? `unclassified:hook-${structuredSource}`
        : 'unclassified:detection-failed'
      : answered
        ? `answered:${p.answeredBy ?? 'unknown'}`
        : 'pending';
    const header = `${m.timestamp}  ${m.cliToolId ?? '-'}/${m.instanceId ?? '-'}  [${state}]`;
    const lines = [header, `  Q: ${p.question}`];
    if (Array.isArray(p.options) && p.options.length > 0) {
      lines.push(`  options: ${p.options.map(formatPromptOption).join('  ')}`);
    }
    if (answered) {
      lines.push(`  A: ${p.answer ?? '-'}${p.answeredAt ? `  (${p.answeredAt})` : ''}`);
    }
    return lines.join('\n');
  });

  console.log(blocks.join('\n'));
}

/**
 * `--pane` path: read the raw tmux pane and render it as a readable transcript.
 *
 * The squeeze happens CLIENT-side on purpose. The server keeps returning the
 * unmodified frame, so nothing that consumes `/capture` — detection, Auto-Yes,
 * the response saver — sees a different payload because this command exists.
 */
async function capturePane(worktreeId: string, options: CaptureOptions): Promise<void> {
  const client = new ApiClient({ token: options.token });
  const tail = parseTail(options.tail);
  const cliToolId = await resolvePaneCliTool(client, worktreeId, options.agent, options.instance);

  const data = await client.post<PaneCaptureResponse>(`/api/worktrees/${worktreeId}/capture`, {
    cliToolId,
    lines: PANE_CAPTURE_LINES,
    ...(options.instance ? { instanceId: options.instance } : {}),
  });

  const raw = data.output ?? '';
  const squeezed = squeezeTranscript(raw, { tail });
  const text = options.raw ? raw : squeezed.text;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          cliToolId,
          instanceId: options.instance ?? null,
          output: text,
          lines: options.raw ? squeezed.rawLines : squeezed.lines,
          rawLines: squeezed.rawLines,
          squeezed: !options.raw,
          tailed: !options.raw && squeezed.tailed,
        },
        null,
        2
      )
    );
    return;
  }

  printMaybePaged(text);
}

/**
 * Parse and validate `--interval <ms>`.
 *
 * @param raw - Raw option value, if the user passed one
 * @returns The interval in milliseconds
 */
function parseFollowInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_FOLLOW_INTERVAL_MS;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < MIN_FOLLOW_INTERVAL_MS ||
    value > MAX_FOLLOW_INTERVAL_MS
  ) {
    console.error(
      `Error: --interval must be an integer between ${MIN_FOLLOW_INTERVAL_MS} and ${MAX_FOLLOW_INTERVAL_MS} (milliseconds).`
    );
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return value;
}

/**
 * `--pane --follow`: redraw the squeezed transcript on an interval (Issue #2317).
 *
 * ## Why this exists next to `prefix + g`
 *
 * The popup #1623 added is a SNAPSHOT and needs a key press to refresh, and it
 * does not work at all under `tmux attach -r` (a read-only client is delivered
 * no keys but the detach one). This is the reading path that needs neither a
 * tmux client nor a key table: it works from any terminal, over ssh, and while
 * somebody else is attached.
 *
 * ## What it does NOT do
 *
 * It never writes. Every iteration makes exactly the request `--pane` already
 * makes — same route, same {@link PANE_CAPTURE_LINES} — so the detection
 * pipeline sees no different payload because a human is watching, and the
 * session's geometry is untouched (Issue #2317 受入条件 Phase C 2).
 *
 * Ctrl-C is the exit, and it needs no handler: SIGINT's default action ends the
 * process, and the alternate screen is left with the cursor restored by the
 * `finally` below.
 */
async function capturePaneFollow(worktreeId: string, options: CaptureOptions): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error(
      'Error: --follow needs a terminal (it redraws the screen). '
      + 'Without one, loop over `commandmate capture <id> --pane --tail N` instead.'
    );
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const client = new ApiClient({ token: options.token });
  const tail = parseTail(options.tail);
  const intervalMs = parseFollowInterval(options.interval);
  const cliToolId = await resolvePaneCliTool(client, worktreeId, options.agent, options.instance);

  // Hide the cursor while redrawing, and put it back whatever ends the loop.
  process.stdout.write('\u001b[?25l');
  const restoreCursor = (): void => {
    process.stdout.write('\u001b[?25h');
  };
  process.on('exit', restoreCursor);

  try {
    for (;;) {
      const data = await client.post<PaneCaptureResponse>(
        `/api/worktrees/${worktreeId}/capture`,
        {
          cliToolId,
          lines: PANE_CAPTURE_LINES,
          ...(options.instance ? { instanceId: options.instance } : {}),
        }
      );
      const squeezed = squeezeTranscript(data.output ?? '', { tail });
      // The visible rows, minus one for the footer. Slicing HERE rather than
      // asking the server for fewer lines is the same choice `--tail` makes: the
      // squeeze has to run over the whole frame or the blank padding is what
      // gets kept.
      const rows = Math.max(1, (process.stdout.rows || 40) - 1);
      const body = squeezed.text.split('\n').slice(-rows).join('\n');
      process.stdout.write(`\u001b[H\u001b[2J${body}\n`);
      process.stdout.write(
        `\u001b[7m[CommandMate] ${worktreeId} / ${cliToolId} — Ctrl-C to stop\u001b[0m`
      );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    restoreCursor();
  }
}

export function createCaptureCommand(): Command {
  const cmd = new Command('capture');
  cmd
    .description('Capture current terminal output from a worktree')
    .argument('<worktree-id>', 'Worktree ID')
    .option('--json', 'JSON output (excludes fullOutput)')
    // Issue #1623: reading mode. Works without attaching and without tmux 3.2+,
    // which is why it is the fallback the popup binding degrades to.
    .option('--pane', 'Read the raw tmux pane as a transcript, with blank layout rows squeezed')
    .option('--tail <n>', 'With --pane: keep only the last N lines OF THE SQUEEZED transcript')
    .option('--raw', 'With --pane: skip the squeeze and print the pane verbatim')
    // Issue #2317: the reading path that needs no tmux client and no key table.
    .option('--follow', 'With --pane: redraw on an interval instead of printing once (Ctrl-C to stop)')
    .option('--interval <ms>', `With --pane --follow: redraw interval in milliseconds (default ${DEFAULT_FOLLOW_INTERVAL_MS})`)
    // Issue #1685: audit trail of resolved prompts (question/options/answer/answeredBy)
    .option('--prompts', 'List recent prompts from chat history (including ones Auto-Yes already resolved)')
    .option('--limit <n>', `With --prompts: number of most recent prompts to list (default ${DEFAULT_PROMPTS_LIMIT})`)
    .option('--instance <id>', INSTANCE_OPTION_DESCRIPTION)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: CaptureOptions) => {
      try {
        // [SEC4-04] Validate worktree ID
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (options.agent && !isCliToolId(options.agent)) {
          console.error('Error: Invalid agent.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #868: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #1623: --tail / --raw only mean anything for the pane viewer.
        // Silently ignoring them would look like the flag had no effect.
        if (!options.pane && (options.tail !== undefined || options.raw)) {
          console.error('Error: --tail and --raw require --pane.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #2317: same rule as --tail/--raw. A --follow that silently did
        // nothing outside --pane would look like the flag was accepted.
        if (!options.pane && (options.follow || options.interval !== undefined)) {
          console.error('Error: --follow and --interval require --pane.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.interval !== undefined && !options.follow) {
          console.error('Error: --interval requires --follow.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        // The follow loop redraws the screen; --json and --raw are both "give me
        // the bytes", and neither has a meaning that survives being overwritten
        // every two seconds.
        if (options.follow && (options.json || options.raw)) {
          console.error('Error: --follow cannot be combined with --json or --raw.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #1685: --prompts reads history, --pane reads the live pane —
        // asking for both at once has no meaningful answer.
        if (options.prompts && options.pane) {
          console.error('Error: --prompts cannot be combined with --pane.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (!options.prompts && options.limit !== undefined) {
          console.error('Error: --limit requires --prompts.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (options.prompts) {
          await capturePrompts(worktreeId, options);
          return;
        }

        if (options.pane) {
          if (options.follow) {
            await capturePaneFollow(worktreeId, options);
            return;
          }
          await capturePane(worktreeId, options);
          return;
        }

        const client = new ApiClient({ token: options.token });

        // Issue #1629: /current-output takes the CLI tool at face value and
        // otherwise falls back to the worktree default, so `--instance codex`
        // alone captured the wrong (claude-named) session. Resolve the tool the
        // instance is registered under before asking. Issue #1925: 'read-only',
        // because capture looks rather than acts — see resolvePaneCliTool.
        const agent = options.instance
          ? await resolveInstanceCliTool(client, worktreeId, options.instance, options.agent, 'read-only')
          : options.agent;

        // Build path with optional cliTool/instance query parameters
        const query = new URLSearchParams();
        if (agent) {
          query.set('cliTool', agent);
        }
        if (options.instance) {
          query.set('instance', options.instance);
        }
        const qs = query.toString();
        const path = `/api/worktrees/${worktreeId}/current-output${qs ? `?${qs}` : ''}`;

        const data = await client.get<CurrentOutputResponse>(path);

        if (options.json) {
          console.log(formatJson(data));
        } else {
          // Default: plain text output (content field)
          console.log(data.content);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
