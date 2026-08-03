/**
 * capture Command - Get current terminal output
 * Issue #518: [DR1-08] Factory pattern
 * Issue #1623: `--pane` reads the raw tmux pane as a transcript (案B)
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { CaptureOptions } from '../types';
import type { CurrentOutputResponse, WorktreeDetailResponse } from '../types/api-responses';
import { ApiClient, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveInstanceCliTool } from './instances';
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

/** Response of POST /api/worktrees/[id]/capture. */
interface PaneCaptureResponse {
  output: string;
}

/**
 * Format capture output as JSON (excluding fullOutput for size).
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
 * POST /capture demands an explicit `cliToolId`, while GET /current-output falls
 * back to the worktree's own default server-side. Mirroring that fallback here
 * (`worktree.cliToolId || 'claude'`, matching the route) keeps bare
 * `capture <id> --pane` pointed at the same session the rest of the CLI uses.
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
  if (instance) {
    const resolved = await resolveInstanceCliTool(client, worktreeId, instance, agent);
    if (resolved) return resolved;
  }
  if (agent) return agent;

  const worktree = await client.get<WorktreeDetailResponse>(`/api/worktrees/${worktreeId}`);
  return worktree.cliToolId || 'claude';
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

        if (options.pane) {
          await capturePane(worktreeId, options);
          return;
        }

        const client = new ApiClient({ token: options.token });

        // Issue #1629: /current-output takes the CLI tool at face value and
        // otherwise falls back to the worktree default, so `--instance codex`
        // alone captured the wrong (claude-named) session. Resolve the tool the
        // instance is registered under before asking.
        const agent = options.instance
          ? await resolveInstanceCliTool(client, worktreeId, options.instance, options.agent)
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
