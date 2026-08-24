/**
 * Reading Claude Code's `PermissionRequest` payload (Issue #1724).
 *
 * The shape here is taken from a real session, not from the documentation:
 * `tests/fixtures/hooks/claude/permission-request.json` and
 * `permission-request-ask-user-question.json`, captured by the Issue #1721
 * spike. Two documented fields do not exist in practice (D2 of
 * `docs/design/agent-hooks-live-verification.md`):
 *
 *  - **`tool_use_id` is absent.** Nothing here may key off it. Correlation with
 *    `PreToolUse` is `prompt_id` + `tool_name` + `tool_input`.
 *  - **`permission_requirements` is absent**; `permission_suggestions`
 *    (`addRules` candidates) appears instead. It is carried through for the
 *    audit trail and is never a decision input — it is Claude's *suggestion*,
 *    which is exactly the thing the adjudicator is supposed to judge.
 *
 * Parsing is strict on purpose. Anything this module cannot vouch for becomes
 * `null`, and the caller turns `null` into a no-decision — the fail-safe side,
 * because the alternative to a dialog is executing a command.
 *
 * @module lib/hooks/permission-request-payload
 */

import {
  collectPatchMatchTexts,
  type ToolInputNormalization,
} from './tool-input-normalization';

/** `hook_event_name` this receiver accepts. Anything else is not ours to judge. */
export const PERMISSION_REQUEST_EVENT_NAME = 'PermissionRequest';

/**
 * The tool whose permission request is never adjudicated (Issue #1726 owns it).
 *
 * `AskUserQuestion` raises a `PermissionRequest` like any other tool, but the
 * spike measured that **returning `allow` still shows the picker** (§5.6). So an
 * allow here buys nothing and an allow is not an answer to a question — the two
 * reasons point the same way.
 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** Bound on `tool_name`; it is a Claude-side identifier, logged and stored. */
export const MAX_TOOL_NAME_LENGTH = 128;

/** A `PermissionRequest` payload this server is willing to adjudicate. */
export interface PermissionRequestPayload {
  /** e.g. `Bash`, `Edit`, `AskUserQuestion`. */
  toolName: string;
  /** The tool's arguments, verbatim. The *only* thing deny patterns may see. */
  toolInput: Record<string, unknown>;
  /** Correlation key with `PreToolUse` (D2); absent on payloads that omit it. */
  promptId: string | null;
  /** Agent session id. Never an identity key — `/clear` changes it (#1721). */
  sessionId: string | null;
  /** `default` / `acceptEdits` / … as reported by the agent. */
  permissionMode: string | null;
  /** `addRules` candidates Claude offered. Recorded, never a decision input. */
  permissionSuggestions: unknown[] | null;
  /**
   * Non-null when {@link toolInput} is not the shape the agent sent
   * (Issue #1902).
   *
   * Optional and null for every parser but copilot's, which is the only one
   * measured receiving a string `tool_input` — copilot 1.0.80's `Edit` sends
   * the whole apply-patch envelope as one. See
   * `lib/hooks/tool-input-normalization` for what the rewrite is and why the
   * deny patterns are applied to the patch's action headers rather than to its
   * body.
   *
   * Carried on the payload rather than inferred from the object's shape, so
   * that {@link collectToolInputMatchTexts} is told what it is looking at
   * instead of sniffing for a `patch` key a real tool could one day send.
   */
  toolInputNormalization?: ToolInputNormalization | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a `PermissionRequest` body.
 *
 * @param body - Whatever was posted to the receiver
 * @returns The payload, or null when it is not a `PermissionRequest` this
 *   server recognises — which the caller must treat as "no decision".
 */
export function parsePermissionRequestPayload(body: unknown): PermissionRequestPayload | null {
  if (!isPlainObject(body)) return null;
  if (body.hook_event_name !== PERMISSION_REQUEST_EVENT_NAME) return null;

  const toolName = readString(body, 'tool_name');
  if (!toolName || toolName.length > MAX_TOOL_NAME_LENGTH) return null;

  // An absent or non-object `tool_input` means there is nothing to judge the
  // deny patterns against, so the request cannot be adjudicated safely.
  if (!isPlainObject(body.tool_input)) return null;

  return {
    toolName,
    toolInput: body.tool_input,
    promptId: readString(body, 'prompt_id'),
    sessionId: readString(body, 'session_id'),
    permissionMode: readString(body, 'permission_mode'),
    permissionSuggestions: Array.isArray(body.permission_suggestions)
      ? body.permission_suggestions
      : null,
  };
}

/**
 * The arguments of each tool that carry what is actually being asked for.
 *
 * "Primary arguments" per the Issue: `Bash` is judged on its command line, a
 * file tool on its path. Bulk payloads (`Write.content`, `Edit.new_string`) are
 * deliberately excluded — a deny pattern is a statement about the *action*, and
 * matching it against a file body would suppress an edit for quoting the very
 * string the contract is trying to keep out of the shell.
 *
 * `Bash.description` is included: it is model-authored prose about the same
 * command, so including it can only ever suppress more, never less.
 */
const PRIMARY_TOOL_INPUT_KEYS: Record<string, readonly string[]> = {
  Bash: ['command', 'description'],
  BashOutput: ['bash_id'],
  KillShell: ['shell_id'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query'],
  SlashCommand: ['command'],
  Task: ['description', 'subagent_type', 'prompt'],
};

/**
 * Every string a deny pattern is matched against for one request.
 *
 * **This is the whole of the matching surface, and it comes from a single
 * request's `tool_input`.** Issue #1699 is the reason that sentence is worth
 * writing down: the screen-based path used to match deny patterns against
 * `instructionText`, a scrollback window, so an `rm -rf` a human had approved
 * several turns earlier stayed on the pane and went on matching — suppressing
 * every later approval, including edits with nothing to do with it, until the
 * line scrolled off. A worker sat silent for an hour. Nothing on the pane, and
 * nothing from any earlier request, can reach this function.
 *
 * Unknown tools fall back to the serialised input rather than to nothing:
 * over-matching costs a dialog, under-matching costs the protection a contract
 * asked for. The same fallback covers a known tool whose primary arguments are
 * missing or non-string, so a Claude-side shape change cannot silently empty
 * the surface.
 *
 * @param toolName - `tool_name` from the payload
 * @param toolInput - `tool_input` from the payload
 * @param normalization - Set when `toolInput` was rewritten from something that
 *   was not an object (Issue #1902); null or omitted for a payload the agent
 *   sent as an object, which is every tool but copilot's `Edit`
 * @returns Texts to match, never empty for a non-empty input
 */
export function collectToolInputMatchTexts(
  toolName: string,
  toolInput: Record<string, unknown>,
  normalization?: ToolInputNormalization | null
): string[] {
  if (normalization) {
    const raw = toolInput[normalization.key];
    if (typeof raw === 'string' && raw !== '') {
      // The tool-name table cannot help here: the agent sent no named
      // arguments at all, so the surface comes from the string itself.
      return normalization.reason === 'string-tool-input-as-patch'
        ? collectPatchMatchTexts(raw)
        : [raw];
    }
    // The record and the input disagree — something rewrote one without the
    // other. Fall through to the whole-input fallback rather than trusting
    // either: over-matching costs a dialog, under-matching costs the protection.
  }

  const keys = PRIMARY_TOOL_INPUT_KEYS[toolName];
  if (keys) {
    const texts = keys
      .map(key => toolInput[key])
      .filter((value): value is string => typeof value === 'string' && value !== '');
    if (texts.length > 0) return texts;
  }

  try {
    return [JSON.stringify(toolInput) ?? ''];
  } catch {
    // Circular or otherwise unserialisable input: judged on its keys alone, so
    // the caller still gets a non-empty surface instead of a silent allow.
    return [Object.keys(toolInput).join(' ')];
  }
}
