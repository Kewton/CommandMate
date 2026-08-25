/**
 * CMATE CLI Tool Column Parser (Pure Module)
 * Issue #588: Shared parse/validation for CLI Tool column in CMATE.md
 *
 * This module has NO fs/path/Node.js dependencies and can be safely imported
 * from both server-side (cmate-parser.ts) and client-side (cmate-validator.ts).
 *
 * Exports:
 * - parseCliToolColumn(): tokenize raw CLI Tool column string
 * - validateCopilotModelName(): validate model name (reject approach)
 * - validateAntigravityModelName(): validate Antigravity --model value (Issue #989)
 * - validateOpencodeRunName(): validate --agent / --variant values (Issue #2044)
 * - validateOpencodeTitle(): validate --title value (Issue #2044)
 * - parseAndValidateCliToolColumn(): combined pipeline entry point
 * - resolveScheduleCommandOptions(): CMATE.md row -> executor options (Issue #2044)
 * - TOOLS_WITH_MODEL_SUPPORT: Set of tools supporting --model in CMATE.md
 * - TOOLS_WITH_RUN_OPTIONS: Set of tools whose column accepts a flag list
 */

import { MODEL_NAME_PATTERN, MAX_MODEL_NAME_LENGTH } from '@/config/copilot-constants';
import { ANTIGRAVITY_MODEL_NAME_PATTERN, MAX_ANTIGRAVITY_MODEL_NAME_LENGTH } from '@/config/antigravity-constants';
import {
  OPENCODE_RUN_NAME_PATTERN,
  MAX_OPENCODE_RUN_NAME_LENGTH,
  MAX_OPENCODE_TITLE_LENGTH,
} from '@/config/opencode-constants';
import type { OpencodeRunOptions, ScheduleEntry } from '@/types/cmate';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of parsing a CLI Tool column value.
 *
 * Issue #2044: the option fields moved to {@link OpencodeRunOptions} so that the
 * parse result, the `ScheduleEntry` it becomes and the `ExecuteCommandOptions`
 * the executor consumes are one shape rather than three that agree by habit.
 */
export interface ParsedCliToolColumn extends OpencodeRunOptions {
  /** Resolved CLI tool ID (e.g., 'claude', 'copilot') */
  cliToolId: string;
  /** Syntax error reason (DR1-002: integrated into parse result) */
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * CLI Tools that support --model <name> syntax in CMATE.md CLI Tool column (DR2-005).
 * This Set controls which tools accept the --model option in the CMATE.md schedule table.
 * vibe-local model is managed via DB (worktree.vibe_local_model), not CMATE.md.
 * To add CMATE.md --model support for a new tool, add it here (DR1-006).
 *
 * ## `opencode` (Issue #1914)
 *
 * `claude-executor.ts` has carried an `opencode run -m <model>` branch since
 * Issue #379, and it had never once executed: the only caller that supplies a
 * model for a schedule is `job-executor.resolveModelOption()`, which answered
 * `undefined` for every tool but copilot and vibe-local, and the other reachable
 * caller (`daily-summary-generator`) is gated by `SUMMARY_ALLOWED_TOOLS`, which
 * has no opencode either. Adding the id here is one half of making that branch
 * reachable; `resolveModelOption()` reads this Set for the other half, so the
 * two cannot drift apart again.
 *
 * The value is passed through **verbatim** as `provider/model`, which is the
 * format `opencode run --help` documents for `-m, --model` (measured on
 * opencode 1.18.21). It is not prefixed with `ollama/` — see
 * `buildCliArgs()` for why that prefix went away.
 */
export const TOOLS_WITH_MODEL_SUPPORT = new Set(['copilot', 'opencode']);

/**
 * CLI Tools whose CMATE.md column is a **flag list** rather than one fixed shape
 * (Issue #2044).
 *
 * Every other tool in {@link TOOLS_WITH_MODEL_SUPPORT} accepts exactly
 * `<tool> --model <name>` and nothing else, and that stayed true here on
 * purpose: widening copilot's grammar is a behaviour change nobody asked for,
 * and the narrow rule is what makes `copilot --modle x` an error instead of a
 * silently ignored token.
 *
 * `opencode` is the exception because `opencode run` has four more options
 * CommandMate can drive (`--agent`, `--variant`, `-c`, `--title`), and a
 * schedule that wants `--agent plan --variant high` cannot say so in three
 * tokens. Membership here is what {@link parseCliToolColumn} branches on.
 */
export const TOOLS_WITH_RUN_OPTIONS = new Set(['opencode']);

/**
 * The opencode column grammar, as one line, for error messages.
 *
 * Kept next to the parser rather than inlined so the message a user sees and
 * the flags the loop accepts are edited together.
 */
export const OPENCODE_COLUMN_SYNTAX =
  'opencode [--model <provider/model>] [--agent <name>] [--variant <name>] [--continue] [--title <text>]';

// =============================================================================
// Parse Functions
// =============================================================================

/**
 * Split a CLI Tool column value into argv-like tokens (Issue #2044).
 *
 * Whitespace-separated, except that `"…"` and `'…'` keep their contents
 * together. Quoting exists for exactly one option — `--title`, whose value is
 * prose ("nightly review") rather than an identifier. Without it the only
 * titles expressible in a Markdown cell would be single words, which is the
 * kind of limitation that gets discovered after someone has written the row.
 *
 * The quote characters are removed, so `--title "nightly review"` yields the
 * token `nightly review`. An unterminated quote is an error rather than an
 * implicit close: silently accepting `--title "nightly` would write a schedule
 * whose title is not the one that was typed.
 *
 * @param raw - Trimmed CLI Tool column value
 * @returns The tokens, or an error describing the quoting fault
 */
export function tokenizeCliToolColumn(raw: string): { tokens: string[]; error?: string } {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const char of raw) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) {
    return { tokens: [], error: 'CLI Tool column has an unterminated quote' };
  }
  if (started) tokens.push(current);
  return { tokens };
}

/**
 * Parse the opencode flag list that follows the tool id (Issue #2044).
 *
 * Reads `[--model|-m <v>] [--agent <v>] [--variant <v>] [--continue|-c]
 * [--title <v>]` in any order. Three things are refused rather than tolerated,
 * each because tolerating it would produce a schedule that runs differently
 * from what the row says:
 *
 * - **an unknown flag** — `--agnet plan` would otherwise run the default agent;
 * - **a repeated flag** — the CLI would take one of the two values and there is
 *   no reading of the row that says which;
 * - **a missing value** — `--agent --title x` would make `--title` the agent
 *   name, and a value starting with `-` is the DR4-001 injection shape anyway.
 *
 * @param cliToolId - Always `opencode` today; echoed into error messages
 * @param tokens - Tokens after the tool id
 * @returns The parsed options, or an error
 */
function parseOpencodeRunFlags(cliToolId: string, tokens: string[]): ParsedCliToolColumn {
  const parsed: ParsedCliToolColumn = { cliToolId };
  const seen = new Set<string>();

  const takeValue = (flag: string, index: number): string | null => {
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('-')) return null;
    return value;
  };

  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i];

    if (seen.has(flag)) {
      return { cliToolId, error: `${cliToolId} option "${flag}" is repeated` };
    }

    switch (flag) {
      case '--model':
      case '-m': {
        const value = takeValue(flag, i);
        if (value === null) return { cliToolId, error: `${cliToolId} option "${flag}" needs a value` };
        seen.add('--model');
        seen.add('-m');
        parsed.model = value;
        i++;
        break;
      }
      case '--agent': {
        const value = takeValue(flag, i);
        if (value === null) return { cliToolId, error: `${cliToolId} option "${flag}" needs a value` };
        seen.add(flag);
        parsed.agent = value;
        i++;
        break;
      }
      case '--variant': {
        const value = takeValue(flag, i);
        if (value === null) return { cliToolId, error: `${cliToolId} option "${flag}" needs a value` };
        seen.add(flag);
        parsed.variant = value;
        i++;
        break;
      }
      case '--title': {
        const value = takeValue(flag, i);
        if (value === null) return { cliToolId, error: `${cliToolId} option "${flag}" needs a value` };
        seen.add(flag);
        parsed.title = value;
        i++;
        break;
      }
      case '--continue':
      case '-c': {
        seen.add('--continue');
        seen.add('-c');
        parsed.continueSession = true;
        break;
      }
      default:
        return { cliToolId, error: `${cliToolId} only supports: ${OPENCODE_COLUMN_SYNTAX}` };
    }
  }

  return parsed;
}

/**
 * Parse a raw CLI Tool column string into cliToolId and optional run options.
 * Syntax errors are reported via the error field (DR1-002).
 *
 * Examples:
 * - "copilot --model gpt-5.4-mini" -> { cliToolId: "copilot", model: "gpt-5.4-mini" }
 * - "claude" -> { cliToolId: "claude", model: undefined }
 * - "" / "  " -> { cliToolId: "claude", model: undefined } (default)
 * - "claude --model x" -> { cliToolId: "claude", error: "..." }
 * - "opencode --agent plan --variant high"
 *     -> { cliToolId: "opencode", agent: "plan", variant: "high" }   (Issue #2044)
 *
 * Security (DR4-002): Error messages use fixed text + allowed syntax hints,
 * not raw input values, to prevent log injection / UI toast pollution. The one
 * value echoed back is the offending **flag**, which had to match one of the
 * literals above or is reported as the generic syntax hint.
 *
 * @param raw - Raw CLI Tool column value from CMATE.md table
 * @returns Parsed result with optional error
 */
export function parseCliToolColumn(raw: string): ParsedCliToolColumn {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { cliToolId: 'claude', model: undefined };
  }

  const { tokens, error: tokenizeError } = tokenizeCliToolColumn(trimmed);
  if (tokenizeError) {
    // The tool id is unknown when quoting failed; report the column's default so
    // the caller still has a usable cliToolId to name in its own message.
    return { cliToolId: trimmed.split(/\s+/)[0], error: tokenizeError };
  }
  const cliToolId = tokens[0];

  if (tokens.length === 1) {
    return { cliToolId, model: undefined };
  }

  // Tools without --model support must not have additional tokens (DR1-006)
  if (!TOOLS_WITH_MODEL_SUPPORT.has(cliToolId)) {
    return { cliToolId, error: `CLI Tool "${cliToolId}" does not support additional options` };
  }

  // Issue #2044: opencode's column is a flag list; every other tool keeps the
  // exactly-three-tokens rule it has had since #588.
  if (TOOLS_WITH_RUN_OPTIONS.has(cliToolId)) {
    return parseOpencodeRunFlags(cliToolId, tokens.slice(1));
  }

  // Only accept: <tool> --model <name> (exactly 3 tokens)
  if (tokens.length === 3 && tokens[1] === '--model') {
    return { cliToolId, model: tokens[2] };
  }

  // Invalid additional tokens
  return { cliToolId, error: `${cliToolId} only supports: ${cliToolId} --model <modelName>` };
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate a Copilot model name using the reject approach (no sanitization).
 * Shared between send API, CLI send, parser, and validator (DR1-003).
 *
 * Issue #1914: this is also what validates an **opencode** `provider/model`
 * value, and the pattern already fits — `MODEL_NAME_PATTERN` allows `/` and `:`
 * and requires a leading alphanumeric, so `ollama/qwen3:8b` and
 * `anthropic/claude-sonnet-4-5` pass while a leading `-` (the CLI-option
 * injection case DR4-001 is about) does not. The name is kept because the export
 * is reached from the send API and `commandmate send`, which are outside this
 * Issue's scope; what is deliberately **not** added is a `provider/model` shape
 * requirement. Two probes against opencode 1.18.21 in an isolated `HOME` — one
 * with `-m totallynotaprovider/some-model`, one with `-m barewordmodel` — both
 * exited 1 with the same opaque `UnknownError`, so the CLI gives no signal that
 * would let this layer reject a bare name without guessing.
 *
 * @param modelName - Model name to validate
 * @returns Validation result with optional reason for rejection
 */
export function validateCopilotModelName(modelName: string): { valid: boolean; reason?: string } {
  // Control character rejection
  if (/[\x00-\x1f\x7f]/.test(modelName)) {
    return { valid: false, reason: 'Model name contains control characters' };
  }

  // Empty / whitespace-only rejection
  if (modelName.trim() === '') {
    return { valid: false, reason: 'Model name must not be empty' };
  }

  // Pattern validation (leading alphanumeric required, DR4-001)
  if (!MODEL_NAME_PATTERN.test(modelName)) {
    return { valid: false, reason: 'Model name contains invalid characters' };
  }

  // Length validation
  if (modelName.length > MAX_MODEL_NAME_LENGTH) {
    return { valid: false, reason: `Model name exceeds ${MAX_MODEL_NAME_LENGTH} characters` };
  }

  return { valid: true };
}

/**
 * Validate an Antigravity model name using the reject approach (no sanitization).
 * Issue #989: Antigravity's `--model` value is the display name from `agy models`
 * (e.g. "Gemini 3.1 Pro (High)"), which includes spaces and parentheses that
 * Copilot's MODEL_NAME_PATTERN disallows, hence a dedicated pattern.
 *
 * @param modelName - Model name to validate
 * @returns Validation result with optional reason for rejection
 */
export function validateAntigravityModelName(modelName: string): { valid: boolean; reason?: string } {
  // Control character rejection
  if (/[\x00-\x1f\x7f]/.test(modelName)) {
    return { valid: false, reason: 'Model name contains control characters' };
  }

  // Empty / whitespace-only rejection
  if (modelName.trim() === '') {
    return { valid: false, reason: 'Model name must not be empty' };
  }

  // Pattern validation (leading alphanumeric required, DR4-001)
  if (!ANTIGRAVITY_MODEL_NAME_PATTERN.test(modelName)) {
    return { valid: false, reason: 'Model name contains invalid characters' };
  }

  // Length validation
  if (modelName.length > MAX_ANTIGRAVITY_MODEL_NAME_LENGTH) {
    return { valid: false, reason: `Model name exceeds ${MAX_ANTIGRAVITY_MODEL_NAME_LENGTH} characters` };
  }

  return { valid: true };
}

/**
 * Validate an opencode `--agent` / `--variant` value (Issue #2044).
 *
 * Reject, never sanitize — the same stance as the two validators above, for the
 * same reason: this value becomes an argv element, and a "cleaned" agent name
 * runs a *different* agent than the row asked for, silently.
 *
 * What is deliberately **not** checked is membership in a list of known agents
 * or variants. opencode lets a project declare its own agents in
 * `opencode.json`, and the variant vocabulary is provider-specific
 * (`opencode run --help` on 1.18.22 calls it "provider-specific reasoning
 * effort, e.g., high, max, minimal" — an *example* list, not an enum). A
 * whitelist here would reject valid configurations this layer cannot see.
 *
 * @param value - The `--agent` or `--variant` value
 * @param label - Which option is being validated, for the message
 * @returns Validation result with optional reason for rejection
 */
export function validateOpencodeRunName(
  value: string,
  label: 'agent' | 'variant'
): { valid: boolean; reason?: string } {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { valid: false, reason: `opencode ${label} contains control characters` };
  }
  if (value.trim() === '') {
    return { valid: false, reason: `opencode ${label} must not be empty` };
  }
  if (!OPENCODE_RUN_NAME_PATTERN.test(value)) {
    return { valid: false, reason: `opencode ${label} contains invalid characters` };
  }
  if (value.length > MAX_OPENCODE_RUN_NAME_LENGTH) {
    return {
      valid: false,
      reason: `opencode ${label} exceeds ${MAX_OPENCODE_RUN_NAME_LENGTH} characters`,
    };
  }
  return { valid: true };
}

/**
 * Validate an opencode `--title` value (Issue #2044).
 *
 * Looser than {@link validateOpencodeRunName} because a title is prose: spaces
 * and non-ASCII are the point of the option. Three bounds remain:
 *
 * - **no control characters**, the log-injection rule every other value here
 *   follows;
 * - **no leading `-`**, so a title cannot be read by the CLI as another option
 *   (DR4-001);
 * - **no `|`**, because the value round-trips through a Markdown table cell.
 *   `cmate-writer.escapeTableCell()` would rewrite it to `｜` on write, so
 *   accepting it here would mean the title stored is not the title given.
 *
 * @param title - The `--title` value
 * @returns Validation result with optional reason for rejection
 */
export function validateOpencodeTitle(title: string): { valid: boolean; reason?: string } {
  if (/[\x00-\x1f\x7f]/.test(title)) {
    return { valid: false, reason: 'opencode title contains control characters' };
  }
  if (title.trim() === '') {
    return { valid: false, reason: 'opencode title must not be empty' };
  }
  if (title.startsWith('-')) {
    return { valid: false, reason: 'opencode title must not start with "-"' };
  }
  if (title.includes('|')) {
    return { valid: false, reason: 'opencode title must not contain "|"' };
  }
  if (title.length > MAX_OPENCODE_TITLE_LENGTH) {
    return { valid: false, reason: `opencode title exceeds ${MAX_OPENCODE_TITLE_LENGTH} characters` };
  }
  return { valid: true };
}

// =============================================================================
// Combined Pipeline
// =============================================================================

/**
 * Parse and validate a CLI Tool column value in a single call (DR1-005, DR1-007).
 * Both cmate-parser.ts and cmate-validator.ts use this entry point.
 *
 * Orchestration order:
 * 1. parseCliToolColumn() - tokenize and extract cliToolId + model
 * 2. validateCopilotModelName() - validate model name if present
 *
 * Note: isCliToolType() validation is left to the caller, as parser and
 * validator handle unknown tool IDs differently (skip vs. report error).
 *
 * @param raw - Raw CLI Tool column value
 * @returns result: parsed data, errors: validation error messages
 */
export function parseAndValidateCliToolColumn(
  raw: string
): { result: ParsedCliToolColumn; errors: string[] } {
  const errors: string[] = [];
  const parsed = parseCliToolColumn(raw);

  // Syntax error check
  if (parsed.error) {
    errors.push(parsed.error);
  }

  // Model name validation (only when model is present)
  if (parsed.model) {
    const modelResult = validateCopilotModelName(parsed.model);
    if (!modelResult.valid) {
      errors.push(modelResult.reason!);
    }
  }

  // Issue #2044: opencode's run options. Only reachable when the parser filled
  // them, which it does only for ids in TOOLS_WITH_RUN_OPTIONS.
  if (parsed.agent) {
    const agentResult = validateOpencodeRunName(parsed.agent, 'agent');
    if (!agentResult.valid) errors.push(agentResult.reason!);
  }
  if (parsed.variant) {
    const variantResult = validateOpencodeRunName(parsed.variant, 'variant');
    if (!variantResult.valid) errors.push(variantResult.reason!);
  }
  if (parsed.title) {
    const titleResult = validateOpencodeTitle(parsed.title);
    if (!titleResult.valid) errors.push(titleResult.reason!);
  }

  return { result: parsed, errors };
}

// =============================================================================
// Schedule -> Executor Options (Issue #2044)
// =============================================================================

/**
 * Turn a parsed CMATE.md row into the options `executeClaudeCommand()` takes.
 *
 * This is the successor to `job-executor.resolveModelOption()`, which can only
 * express `{ model }` and therefore drops `--agent` / `--variant` / `-c` /
 * `--title` on the floor. It reads {@link TOOLS_WITH_MODEL_SUPPORT} for the
 * model, exactly as its predecessor does, so the two agree about which tools
 * take a model; the run options are additionally gated on
 * {@link TOOLS_WITH_RUN_OPTIONS} so a future tool cannot inherit opencode's
 * flags by accident.
 *
 * **Not yet wired at the schedule call site.** `src/lib/job-executor.ts` is
 * outside Issue #2044's declared scope, so `executeSchedule()` still calls
 * `resolveModelOption()` and a scheduled `opencode --agent plan` currently runs
 * with the model only. Replacing that one call with this function is the whole
 * of the remaining change; every layer on both sides of it — parser, validator,
 * writer, `buildCliArgs()` — is complete and covered by
 * `tests/unit/lib/cmate-opencode-run-options-2044.test.ts`.
 *
 * `vibe-local` is deliberately absent: its model lives in the worktree row
 * rather than in CMATE.md, so it stays `resolveModelOption()`'s business until
 * that function delegates here.
 *
 * @param entry - Parsed schedule entry from CMATE.md
 * @returns Options to pass to `executeClaudeCommand`, or undefined when the row
 *   asks for nothing beyond the tool's defaults
 */
export function resolveScheduleCommandOptions(
  entry: Pick<ScheduleEntry, 'cliToolId' | 'model' | 'agent' | 'variant' | 'continueSession' | 'title'>
): OpencodeRunOptions | undefined {
  const options: OpencodeRunOptions = {};

  if (entry.model && TOOLS_WITH_MODEL_SUPPORT.has(entry.cliToolId)) {
    options.model = entry.model;
  }

  if (TOOLS_WITH_RUN_OPTIONS.has(entry.cliToolId)) {
    if (entry.agent) options.agent = entry.agent;
    if (entry.variant) options.variant = entry.variant;
    if (entry.continueSession) options.continueSession = true;
    if (entry.title) options.title = entry.title;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}
