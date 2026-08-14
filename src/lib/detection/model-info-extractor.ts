/**
 * Model / reasoning-effort extraction from the terminal frame (Issue #1784).
 *
 * Phase 1 (#1783) reads the model off the agents' own structured hook events.
 * That channel has one hole and one gap:
 *
 *  - **No effort, anywhere.** Not one hook payload of any tool carries a
 *    reasoning-effort field (verified across every fixture under
 *    `tests/fixtures/hooks/`). The only place the number exists at all is on
 *    screen, in the TUI's own chrome.
 *  - **No model after a restart, for Claude.** Claude publishes its model on
 *    `SessionStart` and on nothing else, so a server that restarts mid-session
 *    never hears it again for that session. The banner is still in scrollback.
 *
 * This module is the screen-scraped half. It is deliberately a *separate* set of
 * patterns from `cli-patterns.ts`: two of the patterns it would otherwise have
 * been tempting to extend are load-bearing for behaviour that has nothing to do
 * with display —
 *
 *  - `CODEX_STATUS_BAR_PATTERN` is the footer boundary the Codex running/idle
 *    decision is windowed on (#1150). Widening it to capture groups risks the
 *    dot.
 *  - `CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN` is the guard that stops Auto-Yes from
 *    Enter-confirming the `/model` picker and rewriting the user's **global
 *    default model** (#1495).
 *
 * So: read-only reuse of `CODEX_STATUS_BAR_PATTERN` to *locate* the footer (one
 * definition of "which line is the status bar", shared with the detector), new
 * patterns to read values out of it, and not one byte changed in either file.
 *
 * ## Where the values come from (all measured on real TUIs, 2026-08-15)
 *
 * | tool        | line                                                             |
 * |-------------|------------------------------------------------------------------|
 * | codex       | footer:  `gpt-5.6-sol xhigh · ~/share/work/…`                     |
 * | claude      | banner:  `▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max` |
 * | antigravity | footer:  `? for shortcuts …               Gemini 3.7 Flash · hig` |
 * | antigravity | banner:  `    ▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (High)`              |
 *
 * Everything is matched **after** `stripAnsi`. The real captures are shot
 * through with SGR sequences *inside* the value — the Codex footer arrives as
 * `\x1b[38;2;…mgpt-5.6-sol xhigh\x1b[2m\x1b[39m · …` — so a pattern applied to
 * the raw bytes matches nothing at all. `tests/fixtures/model-info-captures.ts`
 * keeps one ANSI-bearing capture precisely so a regression here fails a test
 * rather than a user's screen.
 *
 * ## Not a new capture
 *
 * Nothing here issues a `capture-pane`. {@link extractModelInfo} is a pure
 * function of text the status-detection poll already fetched
 * (`worktree-status-helper.ts`), so the added load is zero.
 *
 * @see Issue #1784, Phase 2 of the model/effort visibility series
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { stripAnsi } from './ansi';
import { CODEX_STATUS_BAR_PATTERN } from './cli-patterns';

/**
 * The reasoning-effort vocabulary these tools actually print.
 *
 * `minimal` and `xhigh` are the ends Codex exposes; Claude prints `xhigh` too.
 * Anything outside this list is treated as "not an effort token", which is what
 * keeps a stray word at the end of a status bar from being published as one.
 */
export const REASONING_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

/** What one capture could be read to say. Either half may be unknown. */
export interface ModelInfo {
  /** The model id/label on screen, or null when the frame does not show one. */
  model: string | null;
  /** The reasoning effort on screen, or null. Always a {@link ReasoningEffort}. */
  effort: string | null;
}

/**
 * Longest string accepted as a model name.
 *
 * A bound, not a format check: the point is that a runaway match (a wrapped
 * conversation line that happened to satisfy the shape) is rejected rather than
 * pushed into the UI and the API. Real ids are far shorter — the longest
 * observed is `Opus 5 (1M context)` at 19.
 */
const MAX_MODEL_NAME_LENGTH = 64;

/** An unknown answer. Freshly built each time — callers may keep the object. */
function unknown(): ModelInfo {
  return { model: null, effort: null };
}

/**
 * Bare model *token* shape — Codex, whose footer prints the raw id.
 *
 * No spaces: the Codex footer's model is one token (`gpt-5.6-sol`, `o4-mini`).
 */
const MODEL_TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/**
 * Model *label* shape — Claude and Antigravity, which print a display name.
 *
 * Spaces, dots and parentheses are in (`Opus 5 (1M context)`, `Gemini 3.7
 * Flash`); anything else — box glyphs, `?`, `·`, `>` — is out, which is what
 * rejects a status-bar hint that was mistaken for the model.
 */
const MODEL_LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 .()[\]_:@/-]*$/;

function isPlausibleModelToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_MODEL_NAME_LENGTH && MODEL_TOKEN_SHAPE.test(value);
}

function isPlausibleModelLabel(value: string): boolean {
  return value.length > 0 && value.length <= MAX_MODEL_NAME_LENGTH && MODEL_LABEL_SHAPE.test(value);
}

/**
 * Resolve a word to a {@link ReasoningEffort}, or null.
 *
 * `allowTruncated` exists for exactly one measured defect: **agy 1.1.13 renders
 * its right-aligned status bar one column short**, so `high` reaches the pane as
 * `hig` at every width tested (200 and 120 both produce a 199-/119-column line
 * whose last glyph is missing). Accepting a one-character-short prefix recovers
 * it. The prefix must resolve to exactly one level, so nothing ambiguous is ever
 * promoted — `hig`→`high`, `lo`→`low`, `mediu`→`medium`, `xhig`→`xhigh`, and a
 * single letter resolves to nothing.
 *
 * Off for Codex and Claude: neither truncates, and loosening a matcher that does
 * not need it only buys false positives.
 */
export function resolveEffortToken(
  token: string,
  options: { allowTruncated?: boolean } = {}
): string | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === '') return null;
  if ((REASONING_EFFORT_LEVELS as readonly string[]).includes(normalized)) return normalized;
  if (!options.allowTruncated || normalized.length < 2) return null;
  const candidates = REASONING_EFFORT_LEVELS.filter(
    (level) => level.length === normalized.length + 1 && level.startsWith(normalized)
  );
  return candidates.length === 1 ? candidates[0] : null;
}

// =============================================================================
// Codex
// =============================================================================

/**
 * Reads `<model>[ <effort>]` off the head of a Codex status bar (Issue #1784).
 *
 * Applied to the segment *before* the first "·", which is what makes one pattern
 * cover all three footer formats the CLI has shipped:
 *
 *   v0.147 / v0.141: `gpt-5.6-sol xhigh · ~/share/work/…`      → head `gpt-5.6-sol xhigh `
 *   legacy w/ quota: `gpt-5.4 high · 21% left · ~/…`           → head `gpt-5.4 high `
 *   legacy o4-mini:  `  o4-mini            50% left · /path`   → head `  o4-mini            50% left `
 *
 * The last one is why the effort group is optional *and* why it is anchored to a
 * keyword rather than "the second token": that format's second token is `50%`,
 * and a positional read would publish "50%" as the reasoning effort.
 *
 * No /g flag (stateless `exec`). No nested quantifiers — `[^\s·]+` and the
 * optional `\s+<keyword>` are adjacent, never nested (ReDoS-safe, same rule
 * `cli-patterns.ts` documents).
 */
export const CODEX_FOOTER_MODEL_PATTERN =
  /^\s*([^\s·]+)(?:\s+(minimal|low|medium|high|xhigh)\b)?/i;

function readCodexFooter(line: string): ModelInfo | null {
  // Same "is this the status bar" question the detector asks, answered by the
  // same pattern (#1150). Imported read-only: this module must never be the
  // reason that boundary moves.
  if (!CODEX_STATUS_BAR_PATTERN.test(line)) return null;
  const separator = line.indexOf('·');
  if (separator < 0) return null;
  const match = CODEX_FOOTER_MODEL_PATTERN.exec(line.slice(0, separator));
  if (!match) return null;
  const model = match[1];
  if (!isPlausibleModelToken(model)) return null;
  const effort = match[2] ? resolveEffortToken(match[2]) : null;
  // `CODEX_STATUS_BAR_PATTERN` is a *boundary* test — "a token, a middle dot, a
  // trailing path" — and the detector can afford that because it only ever asks
  // it inside a window it already knows the footer is in. Reading values needs
  // one more bit of evidence, because a sentence Codex printed about a file
  // ("Updated · /src/foo.ts") satisfies the boundary shape, and a value read
  // here LATCHES for the rest of the session. Every Codex model id carries a
  // version number, so a digit in the token or a recognised effort keyword
  // beside it is what separates chrome from prose.
  if (effort === null && !/\d/.test(model)) return null;
  return { model, effort };
}

// =============================================================================
// Claude
// =============================================================================

/**
 * Reads `<model> with <effort> effort` off the Claude startup banner (#1784).
 *
 * Measured on claude 2.1.232:
 *   `▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max`
 *
 * Three deliberate choices:
 *
 *  - **The block/box glyph is required.** `U+2500–U+259F` covers both the ASCII
 *    art of the plain banner (`▝▜█████▛▘`) and the frame of the boxed welcome
 *    variant (`│   Opus 4.8 (1M context) with xhigh effort · Claude Max │`,
 *    `tests/fixtures/claude-model-overlay.ts`). Without it, a *reply* containing
 *    the words "…with high effort…" would be scraped as a model — Claude's own
 *    prose shares the pane with its chrome.
 *  - **The plan suffix is not matched.** `· Claude Max` is one plan of several
 *    and is not part of the model; the match ends at `effort`.
 *  - **`(1M context)` is inside the model, not stripped.** It is what
 *    distinguishes the 1M variant, and #1783 already displays the hook-reported
 *    id verbatim.
 *
 * No /g. No nested quantifiers: the lazy `[^\u2500-\u259F]*?` sits between two
 * literal-anchored parts, and the greedy prefix class is disjoint from `\S`.
 */
export const CLAUDE_STARTUP_BANNER_PATTERN =
  /^\s*[\u2500-\u259F][\s\u2500-\u259F]*(\S[^\u2500-\u259F]*?)\s+with\s+(minimal|low|medium|high|xhigh)\s+effort\b/i;

function readClaudeBanner(line: string): ModelInfo | null {
  const match = CLAUDE_STARTUP_BANNER_PATTERN.exec(line);
  if (!match) return null;
  const model = match[1].trim();
  if (!isPlausibleModelLabel(model)) return null;
  return { model, effort: resolveEffortToken(match[2]) };
}

// =============================================================================
// Antigravity
// =============================================================================

/**
 * The two left-hand hints agy prints on its status bar (#1784).
 *
 * `? for shortcuts` when idle and `esc to cancel` while generating — both
 * measured on agy 1.1.13, and both already documented in
 * `src/lib/cli-tools/antigravity.ts`. Requiring one of them is what stops a
 * wrapped answer line that happens to end in `· high` from being read as chrome.
 */
export const ANTIGRAVITY_STATUS_BAR_HINT_PATTERN =
  /^\s*(?:\?\s+for\s+shortcuts|esc\s+to\s+cancel)\b/i;

/**
 * Reads `<model> (<Effort>)` off the agy startup banner (#1784).
 *
 * Measured: `    ▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (High)`. Same block-glyph anchor
 * as the Claude banner, for the same reason. The sibling banner lines are
 * rejected by the effort keyword — the account line `dev@example.com (Google AI
 * Pro)` sitting directly above it has the shape but not the vocabulary.
 *
 * Used only as the fallback: the status bar survives scrollback eviction and the
 * banner does not.
 */
export const ANTIGRAVITY_BANNER_MODEL_PATTERN =
  /^\s*[\u2500-\u259F][\s\u2500-\u259F]*(\S[^\u2500-\u259F]*?)\s+\((minimal|low|medium|high|xhigh)\)\s*$/i;

function readAntigravityStatusBar(line: string): ModelInfo | null {
  if (!ANTIGRAVITY_STATUS_BAR_HINT_PATTERN.test(line)) return null;
  const separator = line.lastIndexOf('·');
  if (separator < 0) return null;
  // agy drops the final column of this line (see `resolveEffortToken`), so the
  // trailing token is read with truncation tolerance. If it does not resolve,
  // the whole line is abandoned rather than half-read: a bar with no effort
  // suffix would otherwise hand back a model name with its last letter shaved
  // off.
  const effort = resolveEffortToken(line.slice(separator + 1), { allowTruncated: true });
  if (!effort) return null;
  // The bar is `<hint>` … right-aligned `<model>`, so the model is the last
  // run of text separated from the hint by the alignment padding.
  const chunks = line.slice(0, separator).trimEnd().split(/\s{2,}/);
  const model = (chunks[chunks.length - 1] ?? '').trim();
  return { model: isPlausibleModelLabel(model) ? model : null, effort };
}

function readAntigravityBanner(line: string): ModelInfo | null {
  const match = ANTIGRAVITY_BANNER_MODEL_PATTERN.exec(line);
  if (!match) return null;
  const model = match[1].trim();
  if (!isPlausibleModelLabel(model)) return null;
  return { model, effort: resolveEffortToken(match[2]) };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Scan a capture from the bottom up, returning the first line that reads.
 *
 * Bottom-up is the whole rule: the status bar is the last line of the frame, and
 * for Claude "the last banner wins" is how a mid-session `/model` switch — which
 * prints a fresh banner — overtakes the one from session start.
 *
 * ANSI is stripped per line rather than over the whole blob so a malformed OSC
 * sequence can never swallow a newline and merge two lines into one.
 */
function scanFromEnd(
  captureText: string,
  read: (line: string) => ModelInfo | null
): ModelInfo | null {
  const lines = captureText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const result = read(stripAnsi(lines[i]));
    if (result) return result;
  }
  return null;
}

/**
 * What this capture says the session's model and reasoning effort are (#1784).
 *
 * Pure and side-effect free. Never throws, and answers `{ model: null, effort:
 * null }` for every tool it has no rule for (gemini / copilot / vibe-local /
 * opencode — out of scope for this Issue) and for every frame that does not show
 * the chrome it looks for.
 *
 * **Answering null is a correct outcome, not a failure.** tmux keeps a
 * 2000-line `history-limit`; a Claude session that has been talking for hours
 * has long since scrolled its banner away, and the honest answer then is "the
 * screen does not say" — the alternative, a stale or guessed value, is the one
 * thing this must not do. The caller latches the last non-null sighting.
 *
 * @param cliToolId - Which TUI the text came from; the rules are per-tool
 * @param captureText - `capture-pane` output, ANSI-bearing or not
 */
export function extractModelInfo(cliToolId: CLIToolType, captureText: string): ModelInfo {
  if (!captureText) return unknown();

  switch (cliToolId) {
    case 'codex':
      return scanFromEnd(captureText, readCodexFooter) ?? unknown();
    case 'claude':
      return scanFromEnd(captureText, readClaudeBanner) ?? unknown();
    case 'antigravity':
      return (
        scanFromEnd(captureText, readAntigravityStatusBar) ??
        scanFromEnd(captureText, readAntigravityBanner) ??
        unknown()
      );
    default:
      return unknown();
  }
}

/**
 * The effort an Antigravity model id carries in its own name (#1784).
 *
 * agy's ids embed the level — `gemini-3.7-flash-high`, `gemini-3.5-flash-low` —
 * and that id arrives on **every** agy hook payload (`modelName`), which makes
 * it a strictly better source than the screen for this one tool: no scrollback
 * dependency, no truncation, no polling delay.
 *
 * Ids that carry no suffix (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`)
 * answer null and fall through to the scraped bar.
 *
 * **Measured against the Issue text**: #1784 lists `gpt-oss-120b-medium` as an
 * id "without a suffix" while also specifying `-low|-medium|-high$` as the rule
 * — the two contradict each other, because that id ends in `-medium`. The stated
 * rule is applied as written (it reads `medium`), which is also the reading that
 * matches what the level means for that model. Nothing is lost either way: the
 * *model* shown in the UI is the hook-reported id verbatim, so the id is never
 * rewritten by this function.
 *
 * `minimal` / `xhigh` are deliberately not in the suffix vocabulary: no agy id
 * has been observed with them, and a model genuinely named `…-minimal` would be
 * misread.
 */
export const ANTIGRAVITY_MODEL_ID_EFFORT_PATTERN = /-(low|medium|high)$/i;

export function deriveEffortFromModelId(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const match = ANTIGRAVITY_MODEL_ID_EFFORT_PATTERN.exec(modelId);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Fold the hook-reported model together with the scraped frame (#1784).
 *
 * The precedence, and why:
 *
 *  - **model — hooks win.** A hook payload is the agent naming itself; the
 *    screen is a render of that, abbreviated for display (agy prints `Gemini 3.7
 *    Flash` for `gemini-3.7-flash-high`). When they disagree the exact one is
 *    right. Capture only fills the hole: Claude after a server restart, and any
 *    session that predates this process.
 *  - **effort — the screen wins for codex/claude**, because it is the *only*
 *    source: no hook payload of any tool carries an effort field.
 *  - **effort — the id wins for antigravity**, because agy encodes the level in
 *    the id it reports on every event, and that beats a bar that is only on
 *    screen while the session lives.
 *
 * The derivation reads the *merged* model rather than the hook value alone:
 * effort-in-the-id is a property of the id being published, and when no hook has
 * spoken the merged value is the scraped display name, which carries no suffix
 * and falls through to the scraped effort anyway. Same answer, one input.
 *
 * @param cliToolId - Which tool; only `antigravity` derives effort from the id
 * @param hooksModel - {@link import('@/lib/session/agent-event-state').getLastKnownAgentModel}
 * @param captured - {@link extractModelInfo}'s answer, latched by the caller
 */
export function mergeModelInfo(
  cliToolId: CLIToolType,
  hooksModel: string | null | undefined,
  captured: ModelInfo | null | undefined
): ModelInfo {
  const model = (hooksModel || null) ?? captured?.model ?? null;
  const capturedEffort = captured?.effort ?? null;
  const effort =
    cliToolId === 'antigravity' ? (deriveEffortFromModelId(model) ?? capturedEffort) : capturedEffort;
  return { model, effort };
}
