/**
 * CLI Command Executor (non-interactive mode)
 * Issue #294: Executes CLI tool commands for scheduled executions
 * Issue #379: Added OpenCode support (opencode run)
 *
 * Supported tools: claude, codex, gemini, vibe-local, opencode, copilot, antigravity
 *
 * Security:
 * - Uses execFile (not exec) to prevent shell injection
 * - Sanitizes environment variables via env-sanitizer.ts
 * - Limits output size to prevent memory exhaustion
 * - Enforces execution timeout
 * - Validates cliToolId against ALLOWED_CLI_TOOLS whitelist [SEC-001]
 */

import { execFile } from 'child_process';
import { sanitizeEnvForChildProcess } from '@/lib/security/env-sanitizer';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { COPILOT_PERMISSIONS, type CopilotPermission } from '@/config/schedule-config';
import type { OpencodeRunOptions } from '@/types/cmate';

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum output buffer size for execFile (10MB).
 *
 * Issue #719: 暫定緩和（1MB → 10MB）。
 * execFile はバッファリング方式であり、CLI 出力が膨らむ運用ケースで
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` を頻発させていたため一時的に拡張。
 * 根本対策（spawn + rolling buffer 化）は別Issueで対応する。
 */
export const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

/** Maximum output size stored in DB (100KB) */
export const MAX_STORED_OUTPUT_SIZE = 100 * 1024;

/** Execution timeout in milliseconds (15 minutes) */
export const EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;

/** Maximum message length sent to claude -p */
export const MAX_MESSAGE_LENGTH = 10000;

/** Allowed CLI tool identifiers for scheduled execution [DR2-002] derived from CLI_TOOL_IDS */
export const ALLOWED_CLI_TOOLS: Set<string> = new Set(CLI_TOOL_IDS);

/**
 * Get the actual executable command for a CLI tool.
 * Most tools use the tool ID as the command name, but some (like copilot)
 * use a different base command (e.g., 'gh' for copilot).
 * [DR2-001][SEC4-008]
 *
 * @param cliToolId - CLI tool identifier
 * @returns Actual command to execute
 */
export function getCommandForTool(cliToolId: string): string {
  switch (cliToolId) {
    case 'copilot':
      return 'gh';
    // Issue #990 (Phase C): Antigravity's executable is `agy`, not the tool id.
    case 'antigravity':
      return 'agy';
    default:
      return cliToolId;
  }
}

// =============================================================================
// Types
// =============================================================================

/**
 * Options for executeClaudeCommand.
 *
 * Issue #2044: extends {@link OpencodeRunOptions} rather than redeclaring
 * `model`, so the CMATE.md parse result and the executor argument are the same
 * five fields by construction. Every one of them is optional, which is what
 * keeps `job-executor`'s vibe-local `{ model }` literal assignable.
 */
export interface ExecuteCommandOptions extends OpencodeRunOptions {
  /** Execution timeout in milliseconds (default: EXECUTION_TIMEOUT_MS) */
  timeoutMs?: number;
}

/** Result of executing a claude -p command */
export interface ExecutionResult {
  /** stdout output (stripped of ANSI codes, truncated to MAX_STORED_OUTPUT_SIZE) */
  output: string;
  /** Process exit code (null if killed by signal) */
  exitCode: number | null;
  /** Execution status */
  status: 'completed' | 'failed' | 'timeout';
  /** Error message if any */
  error?: string;
}

// =============================================================================
// Executor
// =============================================================================

/**
 * Truncate output to MAX_STORED_OUTPUT_SIZE bytes.
 * Appends a truncation notice if truncated.
 *
 * @param output - Raw output string
 * @returns Truncated output string
 */
export function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, 'utf-8') <= MAX_STORED_OUTPUT_SIZE) {
    return output;
  }

  // Truncate to MAX_STORED_OUTPUT_SIZE bytes
  const buffer = Buffer.from(output, 'utf-8');
  const truncated = buffer.subarray(0, MAX_STORED_OUTPUT_SIZE).toString('utf-8');
  return truncated + '\n\n--- Output truncated (exceeded 100KB limit) ---';
}

/**
 * Build CLI arguments for non-interactive execution based on CLI tool type.
 *
 * - claude: -p <message> --output-format text --permission-mode <permission>
 * - codex: exec <message> --sandbox <permission>
 * - gemini: -p <message>
 * - vibe-local: [-p <message> -y] or [--model <model> -p <message> -y]
 * - opencode: run --format json [-m <model>] [--agent <a>] [--variant <v>] [-c] [--title <t>] <message>
 * - antigravity: -p <message> --dangerously-skip-permissions
 * - others: -p <message> (fallback)
 *
 * @param message - Prompt message
 * @param cliToolId - CLI tool identifier
 * @param permission - Permission mode (claude: --permission-mode, codex: --sandbox)
 * @param options - Additional options (e.g., model for vibe-local)
 * @returns Array of CLI arguments
 */
export function buildCliArgs(message: string, cliToolId: string, permission?: string, options?: ExecuteCommandOptions): string[] {
  switch (cliToolId) {
    case 'codex':
      return ['exec', message, '--sandbox', permission ?? 'workspace-write'];
    case 'gemini':
      return ['-p', message];
    case 'vibe-local':
      if (options?.model) {
        return ['--model', options.model, '-p', message, '-y'];
      }
      return ['-p', message, '-y'];
    case 'opencode': {
      // [D2-007] When model is not specified, OpenCode uses opencode.json default model.
      //
      // Issue #1914: the model is passed through **verbatim**. It used to be
      // written as `ollama/${model}`, which had two problems and one excuse:
      //
      //  - `opencode run --help` documents `-m, --model` as taking a value "in
      //    the format of provider/model" (measured on 1.18.21), so the prefix
      //    made every non-Ollama provider unreachable and mangled any value that
      //    already named one into `ollama/anthropic/…`.
      //  - The prefix was a silent transform: nothing downstream could tell the
      //    difference between "the user asked for Ollama" and "the code assumed
      //    it".
      //
      // Issue #2044 adds `--format json` and the four run options the CMATE.md
      // column can now carry.
      //
      // ## Why `--format json` is unconditional
      //
      // `--format default` writes a *formatted* transcript — box drawing, the
      // tool calls, the model banner — and recovering the assistant's answer
      // from it means guessing which decorations to strip, in a layout that is
      // free to change between releases. `--format json` emits one JSON event
      // per line and the answer is a field (measured on 1.18.22; see
      // `docs/design/opencode-server-live-verification.md` §15). Making it a
      // per-caller flag would leave the guessing path alive for whoever forgot
      // to pass it, so there is only the one path and
      // {@link extractOpencodeFinalText} reads it.
      //
      // Order: options first, message last. `opencode run` declares `message`
      // as a variadic positional (`[message..]`), so a message that begins with
      // `-` is still the message and never eats a flag.
      const args = ['run', '--format', 'json'];
      if (options?.model) args.push('-m', options.model);
      if (options?.agent) args.push('--agent', options.agent);
      if (options?.variant) args.push('--variant', options.variant);
      if (options?.continueSession) args.push('-c');
      if (options?.title) args.push('--title', options.title);
      args.push(message);
      return args;
    }
    case 'antigravity':
      // Issue #990 (Phase C): `agy -p <message>` runs a single prompt non-interactively.
      // --dangerously-skip-permissions auto-approves tool use so the process does not
      // hang on a permission prompt (stdin is closed immediately by executeClaudeCommand).
      return ['-p', message, '--dangerously-skip-permissions'];
    case 'copilot': {
      // SEC4-001: COPILOT_PERMISSIONS whitelist validation for direct call path safety.
      // Unlike Codex's ?? (nullish coalescing), we use explicit whitelist check (DR2-003).
      // Falsy values (undefined, empty string) and invalid values all fallback to 'allow-all-tools'.
      const safePerm = COPILOT_PERMISSIONS.includes(permission as CopilotPermission)
        ? permission
        : 'allow-all-tools';
      const args = ['copilot'];
      if (options?.model) {
        args.push('--model', options.model);
      }
      args.push('-p', message, `--${safePerm}`);
      return args;
    }
    case 'claude':
    default:
      return ['-p', message, '--output-format', 'text', '--permission-mode', permission ?? 'acceptEdits'];
  }
}

// =============================================================================
// opencode `--format json` extraction (Issue #2044)
// =============================================================================

/**
 * The assistant's answer, pulled out of `opencode run --format json` stdout.
 *
 * ## The measured stream
 *
 * One JSON object per line, no `event:` framing, no wrapping array. Measured on
 * opencode 1.18.22 inside an isolated `HOME`
 * (`docs/design/opencode-server-live-verification.md` §15):
 *
 * ```text
 * {"type":"step_start","sessionID":"ses_…","part":{…,"type":"step-start"}}
 * {"type":"tool_use","sessionID":"ses_…","part":{…,"tool":"read"}}
 * {"type":"text","sessionID":"ses_…","part":{"messageID":"msg_…","type":"text","text":"…"}}
 * {"type":"step_finish","sessionID":"ses_…","part":{…,"tokens":{…},"cost":0.0038181}}
 * ```
 *
 * and, when the run fails (exit 1, **empty stderr**):
 *
 * ```text
 * {"type":"error","sessionID":"ses_…","error":{"name":"UnknownError","data":{…}}}
 * ```
 *
 * ## Why the last *message*, not the last *event*
 *
 * A run that calls a tool produces two assistant messages: the one that decided
 * to call the tool, and the one that answered afterwards. Each carries its own
 * `messageID`, and only the second is the answer. Taking the last `text` event
 * alone would be right today — the measured runs put one text part in the final
 * message — but a message may hold several text parts, and returning the last
 * fragment of an answer while dropping its beginning is a silent truncation that
 * would look exactly like a short reply. So: every `text` part whose
 * `messageID` matches the final one, in arrival order, joined by a blank line.
 * Parts with no `messageID` fall back to "the last one", which is the same
 * answer for a stream that never names its messages.
 *
 * ## Why it never throws and never returns ""
 *
 * A caller that gets `null` keeps the raw stdout, so a stream shape this
 * function does not recognise degrades to "unformatted output" rather than to
 * "the report is empty". Unparseable lines are skipped rather than failing the
 * whole extraction, because `--print-logs` and a plugin's stray `console.log`
 * both land on the same stdout.
 *
 * @param stdout - Raw stdout from `opencode run --format json`
 * @returns The assistant's final text, a one-line rendering of an `error`
 *   frame, or null when the stream carried neither
 */
export function extractOpencodeFinalText(stdout: string): string | null {
  const texts: { messageId: string | null; text: string }[] = [];
  let lastError: string | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof frame !== 'object' || frame === null) continue;

    const record = frame as Record<string, unknown>;
    const part = typeof record.part === 'object' && record.part !== null
      ? (record.part as Record<string, unknown>)
      : null;

    if (record.type === 'text' && part && typeof part.text === 'string') {
      texts.push({
        messageId: typeof part.messageID === 'string' ? part.messageID : null,
        text: part.text,
      });
      continue;
    }

    if (record.type === 'error') {
      lastError = renderOpencodeErrorFrame(record);
    }
  }

  if (texts.length > 0) {
    const finalMessageId = texts[texts.length - 1].messageId;
    const belonging = finalMessageId === null
      ? [texts[texts.length - 1]]
      : texts.filter((entry) => entry.messageId === finalMessageId);
    return belonging.map((entry) => entry.text).join('\n\n');
  }

  return lastError;
}

/**
 * One line describing an `{"type":"error"}` frame.
 *
 * The measured shape is `error: { name, data: { message, ref } }`; every field
 * is treated as optional because the only thing this layer knows for certain is
 * the `type`. Rendered rather than dropped so a failed opencode run says
 * something in the execution log instead of nothing.
 */
function renderOpencodeErrorFrame(record: Record<string, unknown>): string {
  const error = typeof record.error === 'object' && record.error !== null
    ? (record.error as Record<string, unknown>)
    : {};
  const name = typeof error.name === 'string' ? error.name : 'error';
  const data = typeof error.data === 'object' && error.data !== null
    ? (error.data as Record<string, unknown>)
    : {};
  const message = typeof data.message === 'string' ? data.message : '';
  return message ? `opencode error: ${name}: ${message}` : `opencode error: ${name}`;
}

/**
 * Execute a CLI command in a worktree directory.
 *
 * @param message - Prompt message to send
 * @param cwd - Working directory (worktree path from DB)
 * @param cliToolId - CLI tool to use (default: 'claude')
 * @param permission - Permission mode (claude: --permission-mode, codex: --sandbox)
 * @param options - Additional options (e.g., model for vibe-local)
 * @returns Execution result with output and status
 */
export async function executeClaudeCommand(
  message: string,
  cwd: string,
  cliToolId: string = 'claude',
  permission?: string,
  options?: ExecuteCommandOptions
): Promise<ExecutionResult> {
  // Validate cliToolId against whitelist [SEC-001]
  if (!ALLOWED_CLI_TOOLS.has(cliToolId)) {
    return {
      output: '',
      exitCode: null,
      status: 'failed',
      error: `Invalid CLI tool: ${cliToolId}`,
    };
  }

  // Validate message length
  const truncatedMessage = message.length > MAX_MESSAGE_LENGTH
    ? message.substring(0, MAX_MESSAGE_LENGTH)
    : message;

  const args = buildCliArgs(truncatedMessage, cliToolId, permission, options);

  return new Promise<ExecutionResult>((resolve) => {
    const command = getCommandForTool(cliToolId);
    const child = execFile(
      command,
      args,
      {
        cwd,
        env: sanitizeEnvForChildProcess(),
        maxBuffer: MAX_OUTPUT_SIZE,
        timeout: options?.timeoutMs ?? EXECUTION_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Issue #719: 診断情報（Error / Code / Signal / Reason）を必ず出力先頭に残し、
          // exitCode は数値の場合のみ保存（文字列コードは null とする）。
          const errCode = (error as NodeJS.ErrnoException).code;
          const isMaxBuffer = errCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          // maxBuffer 超過は時間切れではなく「出力過多」なので timeout 扱いにしない。
          const isTimeout = error.killed || errCode === 'ETIMEDOUT';

          const errorSummary = [
            `Error: ${error.message}`,
            `Code: ${errCode ?? 'unknown'}`,
            `Signal: ${error.signal ?? 'none'}`,
            isMaxBuffer ? 'Reason: stdout exceeded execFile maxBuffer (output_limit)' : null,
          ]
            .filter((line): line is string => line !== null)
            .join('\n');

          const rawOutput = stripAnsi(
            [
              errorSummary,
              stdout ? `\n--- stdout ---\n${stdout}` : '',
              stderr ? `\n--- stderr ---\n${stderr}` : '',
            ].join('\n')
          );
          const output = truncateOutput(rawOutput);

          resolve({
            output,
            exitCode: typeof errCode === 'number' ? errCode : null,
            status: isTimeout ? 'timeout' : 'failed',
            error: error.message,
          });
          return;
        }

        // Issue #2044: opencode speaks NDJSON now (`--format json`), so the
        // stored output is the assistant's answer rather than the event log.
        // `?? stdout` on purpose: an unrecognised stream is reported verbatim,
        // never swallowed.
        const decoded = cliToolId === 'opencode'
          ? extractOpencodeFinalText(stdout || '') ?? stdout ?? ''
          : stdout || '';
        const rawOutput = stripAnsi(decoded);
        const output = truncateOutput(rawOutput);

        resolve({
          output,
          exitCode: 0,
          status: 'completed',
        });
      }
    );

    // Close stdin immediately to prevent hanging on yes/no prompts
    child.stdin?.end();

    // Return the child process PID for tracking
    if (child.pid) {
      // Store PID in global active processes for cleanup on shutdown
      const activeProcesses = getActiveProcesses();
      activeProcesses.set(child.pid, child);

      child.on('exit', () => {
        activeProcesses.delete(child.pid!);
      });
    }
  });
}

// =============================================================================
// Process Tracking (globalThis for hot reload persistence)
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __scheduleActiveProcesses: Map<number, import('child_process').ChildProcess> | undefined;
}

/**
 * Get the global active processes map.
 * Uses globalThis for hot reload persistence.
 */
export function getActiveProcesses(): Map<number, import('child_process').ChildProcess> {
  if (!globalThis.__scheduleActiveProcesses) {
    globalThis.__scheduleActiveProcesses = new Map();
  }
  return globalThis.__scheduleActiveProcesses;
}
