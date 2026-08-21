/**
 * Reading a `tool_input` that did not arrive as an object (Issue #1902).
 *
 * Every permission parser in `sources/` requires `tool_input` to be a plain
 * object, and copilot 1.0.80's `Edit` breaks that: its `PreToolUse` sends the
 * whole apply-patch envelope as a **bare string**.
 *
 * ```json
 * {"hook_event_name":"PreToolUse","tool_name":"Edit",
 *  "tool_input":"*** Begin Patch\n*** Add File: note4.txt\n+yo\n*** End Patch\n"}
 * ```
 *
 * The object check answered null for that payload, null became
 * `unknown-payload`, and `unknown-payload` is a no-decision — so **every file
 * edit copilot made fell through to a dialog**, no matter what Auto-Yes or the
 * contract said, and the screen-scraping poller answered it two to four seconds
 * later. `Read` and `Bash` were unaffected because their `tool_input` is an
 * object, which is why the symptom looked like "Auto-Yes works, except for
 * edits".
 *
 * ## What normalising must not become
 *
 * A silent rewrite. The adjudicated shape is no longer the shape the agent
 * sent, and an operator reading `capture --json` has to be able to see that —
 * hence {@link ToolInputNormalization}, which is carried on the payload,
 * recorded per session by `./tool-input-normalization-state`, and published in
 * `structuredEvents.toolInputNormalization`. The reason code is the point: it
 * says *"the tool_input was a string, so it was read as a patch"* rather than
 * leaving a `{ patch }` object that nothing explains.
 *
 * ## Where the deny patterns are applied — and why not to the body
 *
 * To the envelope's **action header lines** (`*** Add File: note4.txt`,
 * `*** Update File: …`, `*** Delete File: …`, `*** Move to: …`), never to the
 * hunk bodies.
 *
 * That is not a new rule; it is the one `PRIMARY_TOOL_INPUT_KEYS` already
 * states. `Write.content` and `Edit.new_string` are deliberately excluded from
 * the matching surface there, because a deny pattern is a statement about the
 * *action* and matching it against a file body suppresses an edit for quoting
 * the very string the contract is trying to keep out of the shell. A patch body
 * is exactly those two fields fused into one string. Matching it would make
 * copilot's `Edit` strictly stricter than Claude's `Edit` and `Write` for the
 * same action, so a contract that runs unattended on Claude would deadlock on
 * copilot the first time an agent wrote a shell script — and the escalation
 * would be a dialog nobody is watching.
 *
 * The header lines carry the verb *and* the path, so both kinds of contract
 * still work: `Delete File` blocks deletions, `\.env` blocks a path.
 *
 * Under-matching is the one thing worth guarding, since it ends in an
 * unattended approval rather than a dialog. So the summary is only used when it
 * is trustworthy: **no header line found, or more than
 * {@link MAX_PATCH_ACTION_LINES} of them, falls back to the whole envelope** —
 * over-matching, which costs a dialog, the same direction
 * `collectToolInputMatchTexts` already falls in for an unknown tool.
 *
 * @module lib/hooks/tool-input-normalization
 */

/** Key a string `tool_input` recognised as an apply-patch envelope is stored under. */
export const PATCH_TOOL_INPUT_KEY = 'patch';

/** Key any other string `tool_input` is stored under. */
export const TEXT_TOOL_INPUT_KEY = 'text';

/**
 * Why the adjudicated `tool_input` is not the one the agent sent.
 *
 * kebab-case to match the reason codes already on this wire
 * (`AutoYesSuppressionReason`, `StructuredPromptSource`).
 */
export type ToolInputNormalizationReason =
  /** A string opening with `*** Begin Patch`, read as an apply-patch envelope. */
  | 'string-tool-input-as-patch'
  /** A string that is not an envelope; carried verbatim, interpreted as nothing. */
  | 'string-tool-input-as-text';

/** What was done to the payload, in a form `capture --json` can publish. */
export interface ToolInputNormalization {
  reason: ToolInputNormalizationReason;
  /** Key the raw value was put under in the normalised object. */
  key: typeof PATCH_TOOL_INPUT_KEY | typeof TEXT_TOOL_INPUT_KEY;
  /**
   * `typeof` the value the agent actually sent.
   *
   * `'string'` is the only value produced today and the only one measured. It
   * is a field rather than a constant so that a later shape — copilot sending
   * an array, say — is reported as what it was instead of being folded into
   * the string case.
   */
  receivedType: string;
}

/** A `tool_input` an adjudicator can read, plus how it got that way. */
export interface NormalizedToolInput {
  toolInput: Record<string, unknown>;
  /** Null when the agent sent an object and nothing was done to it. */
  normalization: ToolInputNormalization | null;
}

/** The opening line of an apply-patch envelope. */
export const PATCH_ENVELOPE_OPENING = '*** Begin Patch';

/** Column-0 prefix of an envelope's structural lines. */
const PATCH_ACTION_PREFIX = '*** ';

/** Structural lines that name no action, so nothing is judged against them. */
const PATCH_ENVELOPE_MARKERS = new Set(['Begin Patch', 'End Patch']);

/**
 * How much of the string is examined for the opening marker.
 *
 * Bounded so a multi-megabyte patch does not get copied by `trimStart()` just
 * to look at its first sixteen characters.
 */
const PATCH_OPENING_SCAN_LENGTH = 64;

/**
 * Most action lines a patch may have before its summary stops being trusted.
 *
 * A patch touching more files than this is not summarised at all — see the
 * module comment on why the fallback goes to over-matching.
 */
export const MAX_PATCH_ACTION_LINES = 64;

/** Whether a string opens an apply-patch envelope. */
export function isPatchEnvelope(raw: string): boolean {
  return raw.slice(0, PATCH_OPENING_SCAN_LENGTH).trimStart().startsWith(PATCH_ENVELOPE_OPENING);
}

/**
 * The strings a deny pattern is matched against for a patch (Issue #1902).
 *
 * The envelope's action headers, verbatim and including the `*** ` prefix, so a
 * contract can name either the verb or the path. Falls back to the whole
 * envelope when there is no header to summarise or too many to trust; see the
 * module comment.
 *
 * @param patch - The raw envelope, exactly as the agent sent it
 * @returns Texts to match, never empty for a non-empty patch
 */
export function collectPatchMatchTexts(patch: string): string[] {
  const actions: string[] = [];

  for (const rawLine of patch.split('\n')) {
    // Content lines inside a hunk are prefixed (` `, `+`, `-`), so a `*** ` at
    // column 0 is structural. A CRLF payload leaves the `\r` on the line.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith(PATCH_ACTION_PREFIX)) continue;

    const action = line.slice(PATCH_ACTION_PREFIX.length).trim();
    if (action === '' || PATCH_ENVELOPE_MARKERS.has(action)) continue;

    actions.push(`${PATCH_ACTION_PREFIX}${action}`);
    if (actions.length > MAX_PATCH_ACTION_LINES) return [patch];
  }

  return actions.length > 0 ? actions : [patch];
}

/**
 * Read a `tool_input` field, normalising a string into an object.
 *
 * Only copilot calls this today, because copilot is the only tool measured
 * sending a string (#1902). It lives here rather than in `sources/copilot/`
 * because the shape is not copilot-specific — the apply-patch envelope is a
 * format several tools speak — and a second copy is a second place for the
 * deny-pattern surface to be decided differently.
 *
 * @param value - `body.tool_input`, whatever it turned out to be
 * @returns The readable input, or null when there is nothing to adjudicate —
 *   which every caller must turn into a no-decision, i.e. a dialog
 */
export function readPermissionToolInput(value: unknown): NormalizedToolInput | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { toolInput: value as Record<string, unknown>, normalization: null };
  }

  if (typeof value === 'string') {
    // An empty string is the string case's version of an absent `tool_input`:
    // nothing for the deny patterns to be judged against, so the request is
    // unadjudicatable rather than harmless.
    if (value === '') return null;

    const isPatch = isPatchEnvelope(value);
    const key = isPatch ? PATCH_TOOL_INPUT_KEY : TEXT_TOOL_INPUT_KEY;
    return {
      toolInput: { [key]: value },
      normalization: {
        reason: isPatch ? 'string-tool-input-as-patch' : 'string-tool-input-as-text',
        key,
        receivedType: 'string',
      },
    };
  }

  return null;
}
