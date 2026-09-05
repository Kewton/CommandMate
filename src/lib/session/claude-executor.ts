/**
 * CLI Command Executor (non-interactive mode)
 * Issue #294: Executes CLI tool commands for scheduled executions
 * Issue #379: Added OpenCode support (opencode run)
 *
 * Supported tools: claude, codex, gemini, vibe-local, opencode, copilot, antigravity, command-code
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
import {
  COPILOT_PERMISSIONS,
  COMMAND_CODE_PERMISSIONS,
  type CopilotPermission,
  type CommandCodePermission,
} from '@/config/schedule-config';
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
    // Issue #2253: Command Code ships four bins (`cmd` / `cmdc` / `command-code`
    // / `commandcode`) and Epic #2249 決定 1 picked the unambiguous spelling, so
    // the tool id is not the executable here either. Written as a literal to
    // match the two cases above rather than importing
    // `COMMAND_CODE_COMMAND` from `@/lib/cli-tools/command-code`, which would
    // pull the tmux transport into the scheduler's dependency graph; the unit
    // test imports both and asserts they are the same string, so the copy
    // cannot drift.
    case 'command-code':
      return 'commandcode';
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
 * - command-code: -p <message> --output-format json [--yolo | --permission-mode <permission>]
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
    case 'command-code': {
      // Issue #2253 (Epic #2249 Phase D): `commandcode -p <message>` runs one
      // prompt non-interactively. `--output-format json` is unconditional for
      // the same reason opencode's `--format json` is: the text format writes a
      // rendered answer with no frame around it, while the json format ends in a
      // single `{"type":"result",…}` line carrying `finalText` and `subtype`,
      // which is what {@link extractCommandCodeResult} reads.
      //
      // ## `--yolo` and `--permission-mode` are different axes, and exclusive here
      //
      // `commandcode --help` lists them separately, and the shipped option
      // declaration in `command-code@1.40.1/dist/cli.mjs` is
      // `.addOption(new Be('--permission-mode <mode>', …).choices(['default',
      // 'standard','plan','auto-accept','dont-ask']))` with `--yolo` as a plain
      // boolean alias of `--dangerously-skip-permissions`. So `--yolo` is not a
      // *value* of the mode flag, and sending both would ask the CLI to run
      // under a mode and to bypass modes at once. A scheduled run has nobody to
      // answer a permission dialog, so the default is `--yolo` and an explicit
      // permission replaces it rather than joining it.
      //
      // The whitelist check follows copilot's shape (SEC4-001) rather than
      // codex's `??`: a permission the dropdown could not have produced falls
      // back to the unattended default instead of reaching the CLI, where an
      // unknown `--permission-mode` value is a `.choices()` rejection and the
      // run would fail before the prompt was ever sent.
      //
      // `--yolo` does not override `.commandcode/settings.json`
      // `permissions.deny`; a denied tool call still ends the run with exit 4,
      // which {@link describeCommandCodeExit} names in the failure reason.
      const args = ['-p', message, '--output-format', 'json'];
      if (COMMAND_CODE_PERMISSIONS.includes(permission as CommandCodePermission)) {
        args.push('--permission-mode', permission as string);
      } else {
        args.push('--yolo');
      }
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

// =============================================================================
// command-code `--output-format json` extraction (Issue #2253)
// =============================================================================

/**
 * `PRINT_EXIT_CODE`, read off `command-code@1.40.1/dist/cli.mjs`.
 *
 * The bundle declares it as one object —
 * `{SUCCESS:0, ERROR:1, AUTH_ERROR:3, PERMISSION_DENIED:4, RATE_LIMITED:5,
 * CONNECTION_ERROR:6, SERVER_ERROR:7, MAX_TURNS_REACHED:8, NO_RESPONSE:9,
 * INSUFFICIENT_CREDITS:10, INTERRUPTED:130}` — and `classifyPrintModeError`
 * next to it is what picks between them. Issue #2253 lists six of the eleven;
 * all eleven are recorded here because the point of the map is to turn a bare
 * number in an execution log into a sentence, and a code that falls through
 * produces exactly the log line the map exists to replace.
 *
 * 0 is deliberately absent: success is not a failure reason, and a lookup that
 * answers for it would let a caller render "Reason: success" on a run that
 * worked.
 */
export const COMMAND_CODE_EXIT_REASONS: Readonly<Record<number, string>> = {
  1: 'error',
  3: 'authentication failed',
  4: 'permission denied',
  5: 'rate limited',
  6: 'connection error',
  7: 'server error',
  8: 'max turns reached',
  9: 'no response',
  10: 'insufficient credits',
  130: 'interrupted',
};

/** The `{"type":"result",…}` line that closes a `--output-format json` run. */
export interface CommandCodeResult {
  /**
   * `success` | `error` | `max_turns` on the measured CLI, but typed as a
   * string: this value is read off a third-party process, and narrowing it to a
   * union here would mean either dropping an unrecognised subtype (silently
   * turning a failure into "no result line") or asserting a shape the process
   * never promised.
   */
  subtype: string;
  /** The assistant's answer. Empty on `max_turns` and on `error`. */
  finalText: string;
  /** The `error` field the CLI adds on `subtype: "error"` (its stderr line). */
  error?: string;
}

/**
 * The result line of `commandcode -p … --output-format json`, or null.
 *
 * ## The measured stream
 *
 * One JSON object per line. Every line but the last is `{"type":"event",…}`;
 * the last is the result. Measured on command-code 1.40.1 (fixtures under
 * `tests/fixtures/command-code/headless/`):
 *
 * ```text
 * {"type":"event","event":{"type":"run_start","sessionId":"…"}}
 * {"type":"event","event":{"type":"text_delta","delta":"OK"}}
 * {"type":"event","event":{"type":"run_end","result":{"finalText":"OK",…}}}
 * {"type":"result","subtype":"success","sessionId":"…","stopReason":"end_turn",
 *  "usage":{…},"durationMs":1957,"finalText":"OK"}
 * ```
 *
 * ## Why the last result line rather than `run_end`
 *
 * `run_end` carries a `result.finalText` too, and on a successful run they
 * agree. But `buildPrintResultLine` in the bundle emits the result line on the
 * failure path as well, where no `run_end` was ever produced: an empty query
 * answers with exactly one line,
 * `{"type":"result","subtype":"error",…,"finalText":"","error":"Error: No query
 * provided. …"}`, and nothing else. Reading `run_end` would see nothing there.
 *
 * ## Why it never throws and never invents a result
 *
 * Null means "this stdout carried no result line", which the caller renders as
 * raw output rather than as an empty answer — the state a run that dies before
 * `runPrintMode` is actually in (`--model <unknown>` exits 1 with **empty
 * stdout** and the message only on stderr). Unparseable lines are skipped for
 * the reason the opencode reader skips them: a stray `console.log` from a mod
 * lands on the same stdout as the stream.
 *
 * @param stdout - Raw stdout from `commandcode -p … --output-format json`
 * @returns The decoded result line, or null when stdout carried none
 */
export function extractCommandCodeResult(stdout: string): CommandCodeResult | null {
  let found: CommandCodeResult | null = null;

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
    if (record.type !== 'result') continue;
    if (typeof record.subtype !== 'string') continue;

    found = {
      subtype: record.subtype,
      finalText: typeof record.finalText === 'string' ? record.finalText : '',
      ...(typeof record.error === 'string' ? { error: record.error } : {}),
    };
  }

  return found;
}

/**
 * One line naming why a Command Code run failed, or null when it did not.
 *
 * Both halves are load-bearing, because the CLI can disagree with itself. A run
 * whose answer is blank exits `NO_RESPONSE` (9) while `buildPrintResultLine`
 * still stamps `subtype: "success"` — the subtype is derived from `stopReason`
 * and the exit code from `classifyPrintOutcome`, and only the pair says what
 * happened. So a non-zero exit is a failure whatever the subtype says, and a
 * subtype other than `success` is a failure whatever the exit code says.
 *
 * @param exitCode - Process exit code (null when killed by a signal)
 * @param result - Decoded result line, when stdout carried one
 * @returns A `Reason: …` sentence, or null when the run succeeded
 */
export function describeCommandCodeFailure(
  exitCode: number | null,
  result: CommandCodeResult | null
): string | null {
  const failedByCode = exitCode !== null && exitCode !== 0;
  const failedBySubtype = result !== null && result.subtype !== 'success';
  if (!failedByCode && !failedBySubtype) return null;

  const parts: string[] = [];
  if (exitCode !== null && exitCode !== 0) {
    const reason = COMMAND_CODE_EXIT_REASONS[exitCode];
    parts.push(reason ? `exit ${exitCode} (${reason})` : `exit ${exitCode}`);
  }
  if (result) {
    parts.push(`subtype=${result.subtype}`);
    if (result.error) parts.push(result.error);
  }
  return `Reason: command-code ${parts.join(' / ')}`;
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

          // Issue #2253: command-code writes its whole NDJSON stream *and* a
          // final result line before exiting non-zero — a max-turns run ends at
          // exit 8 with a complete `{"type":"result","subtype":"max_turns",…}`
          // line — so the answer and the CLI's own reason are on stdout even
          // here. Decoding them turns a log that said "Error: Command failed"
          // over a 4KB event dump into the reason plus the text.
          const commandCodeResult = cliToolId === 'command-code'
            ? extractCommandCodeResult(stdout || '')
            : null;
          const exitCodeNumber = typeof errCode === 'number' ? errCode : null;

          const errorSummary = [
            `Error: ${error.message}`,
            `Code: ${errCode ?? 'unknown'}`,
            `Signal: ${error.signal ?? 'none'}`,
            isMaxBuffer ? 'Reason: stdout exceeded execFile maxBuffer (output_limit)' : null,
            cliToolId === 'command-code'
              ? describeCommandCodeFailure(exitCodeNumber, commandCodeResult)
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join('\n');

          // `?? stdout` on purpose, matching the success path: a run that died
          // before it could write a result line (an unknown `--model` exits 1
          // with empty stdout and the message on stderr) reports what it did
          // write rather than an empty body.
          const decodedStdout = commandCodeResult
            ? commandCodeResult.finalText
            : (stdout || '');

          const rawOutput = stripAnsi(
            [
              errorSummary,
              decodedStdout ? `\n--- stdout ---\n${decodedStdout}` : '',
              stderr ? `\n--- stderr ---\n${stderr}` : '',
            ].join('\n')
          );
          const output = truncateOutput(rawOutput);

          resolve({
            output,
            exitCode: exitCodeNumber,
            status: isTimeout ? 'timeout' : 'failed',
            error: error.message,
          });
          return;
        }

        // Issue #2044: opencode speaks NDJSON now (`--format json`), so the
        // stored output is the assistant's answer rather than the event log.
        // `?? stdout` on purpose: an unrecognised stream is reported verbatim,
        // never swallowed.
        //
        // Issue #2253: command-code is the same deal one flag over
        // (`--output-format json`), except that its stream also carries the
        // CLI's own verdict. `classifyPrintOutcome` in the bundle can exit 0
        // only on `subtype: "success"`, so this branch is the success case in
        // practice — but the subtype is read rather than assumed, because
        // "the process exited 0" and "the agent answered" are two facts and
        // this layer is the only one that can still see the second.
        if (cliToolId === 'command-code') {
          const result = extractCommandCodeResult(stdout || '');
          const failure = describeCommandCodeFailure(0, result);
          const body = result ? result.finalText : (stdout || '');
          resolve({
            output: truncateOutput(stripAnsi(failure ? `${failure}\n${body}` : body)),
            exitCode: 0,
            status: failure ? 'failed' : 'completed',
            ...(failure ? { error: failure } : {}),
          });
          return;
        }

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
