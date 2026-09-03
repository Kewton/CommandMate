/**
 * Response cleaning functions for CLI tools.
 * Removes tool-specific artifacts (shell prompts, banners, TUI decorations)
 * from captured tmux output before saving to the database.
 *
 * Issue #479: Extracted from response-poller.ts for single-responsibility separation
 */

import {
  stripAnsi,
  findClaudeChromeStart,
  PASTED_TEXT_PATTERN,
  OPENCODE_SKIP_PATTERNS,
  OPENCODE_RESPONSE_COMPLETE,
  COPILOT_SKIP_PATTERNS,
  COPILOT_TRANSCRIPT_CONTINUATION_PATTERN,
  COPILOT_TOOL_VERBS,
  COPILOT_BOX_ROW_PATTERN,
  findCopilotChromeStart,
} from './detection/cli-patterns';
import { normalizeOpenCodeLine, normalizeCopilotLine } from './tui-accumulator';
import {
  COPILOT_MAX_MESSAGE_LENGTH,
  COPILOT_TRUNCATION_MARKER,
} from '@/config/copilot-constants';

/**
 * Clean up Claude response by removing shell setup commands, environment exports, ANSI codes, and banner
 * Also extracts only the LATEST response to avoid including conversation history
 *
 * @param response - Raw Claude response
 * @returns Cleaned response (only the latest response)
 */
export function cleanClaudeResponse(response: string): string {
  // First, strip ANSI escape codes
  const cleanedResponse = stripAnsi(response);

  // Find the LAST user prompt (> followed by content) and extract only the response after it
  // This ensures we only get the latest response, not the entire conversation history
  const allLines = cleanedResponse.split('\n');

  // Issue #1289: drop Claude Code's bottom-pinned footer before anything else.
  // Its rotating hint row would otherwise change the saved content — and so its
  // hash — on every poll tick, and the text sitting in its input box matches the
  // same "❯ …" shape as the transcript echo searched for below.
  const chromeStart = findClaudeChromeStart(allLines);
  const lines = chromeStart >= 0 ? allLines.slice(0, chromeStart) : allLines;

  // Find the last user prompt line index
  let lastUserPromptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    // User prompt line: > followed by actual content (not empty >)
    if (/^❯\s+\S/.test(lines[i])) {
      lastUserPromptIndex = i;
      break;
    }
  }

  // Extract lines after the last user prompt
  const startIndex = lastUserPromptIndex >= 0 ? lastUserPromptIndex + 1 : 0;
  const responseLines = lines.slice(startIndex);

  // Patterns to remove (Claude-specific setup commands and UI elements)
  // IMPORTANT: These patterns should NOT match legitimate Claude response content
  // Lines starting with black circle (Claude output marker) are typically valid content
  const skipPatterns = [
    /CLAUDE_HOOKS_/,  // Any CLAUDE_HOOKS reference
    /\/bin\/claude/,  // Claude binary path (any variant)
    /^claude\s*$/,  // Just "claude" on a line
    /@.*\s+%\s*$/,  // Shell prompt (any user@host followed by % at end of line)
    /^[^⏺]*curl.*POST/,  // Curl POST commands (not starting with black circle)
    /^[^⏺]*Content-Type/,  // HTTP headers (not in Claude output)
    /^[^⏺]*export\s+CLAUDE_/,  // Claude environment exports only
    /^\s*$/,  // Empty lines
    // Claude Code banner patterns (only match pure banner elements)
    /^[╭╮╰╯│─\s]+$/,  // Box drawing characters only (with spaces)
    /^[│╭╮╰╯].*[│╭╮╰╯]$/,  // Lines with box drawing on both sides (banner rows)
    /Claude Code v[\d.]+/,  // Version info
    /^Tips for getting started/,  // Tips header (at line start)
    /^Welcome back/,  // Welcome message (at line start)
    /Run \/init to create/,  // Init instruction
    /^Recent activity/,  // Activity header (at line start)
    /^No recent activity/,  // No activity message (at line start)
    /▐▛███▜▌|▝▜█████▛▘|▘▘ ▝▝/,  // ASCII art logo
    /^\s*Opus \d+\.\d+\s*·\s*Claude Max/,  // Model info in banner format
    /\.com's Organization/,  // Organization info
    /\?\s*for shortcuts\s*$/,  // Shortcuts hint at end of line
    /^─{10,}$/,  // Separator lines
    /^❯\s*$/,  // Empty prompt lines
    PASTED_TEXT_PATTERN,  // [Pasted text #N +XX lines] (Issue #212)
  ];

  // Filter out UI elements and keep only the response content
  const cleanedLines: string[] = [];
  for (const line of responseLines) {
    const shouldSkip = skipPatterns.some(pattern => pattern.test(line));
    if (!shouldSkip && line.trim()) {
      cleanedLines.push(line);
    }
  }

  // Return cleaned content
  return cleanedLines.join('\n').trim();
}

/**
 * Clean up Gemini response by removing shell prompts and error messages
 *
 * @param response - Raw Gemini response
 * @returns Cleaned response
 */
export function cleanGeminiResponse(response: string): string {
  // Strip ANSI escape codes first (Gemini uses 24-bit color codes like \x1b[38;2;r;g;bm)
  const strippedResponse = stripAnsi(response);
  // Split response into lines
  const lines = strippedResponse.split('\n');
  const cleanedLines: string[] = [];

  // Patterns to remove
  const skipPatterns = [
    /^maenokota@.*%/,  // Shell prompt
    /^zsh:/,           // Shell error messages
    /^feature-issue-\d+/,  // Worktree indicator
    /^\s*$/,           // Empty lines at start
  ];

  // Find the star marker (actual Gemini response start)
  let foundMarker = false;
  const afterMarker: string[] = [];

  for (const line of lines) {
    if (line.includes('\u2726')) {
      foundMarker = true;
      // Extract content after star marker
      const markerIndex = line.indexOf('\u2726');
      const afterMarkerContent = line.substring(markerIndex + 1).trim();
      if (afterMarkerContent) {
        afterMarker.push(afterMarkerContent);
      }
      continue;
    }

    if (foundMarker) {
      // Skip shell prompts and errors after star marker
      if (skipPatterns.some(pattern => pattern.test(line))) {
        continue;
      }
      afterMarker.push(line);
    }
  }

  // If we found content after star, use only that
  if (afterMarker.length > 0) {
    return afterMarker.join('\n').trim();
  }

  // Otherwise, filter the original response
  for (const line of lines) {
    if (skipPatterns.some(pattern => pattern.test(line))) {
      continue;
    }
    cleanedLines.push(line);
  }

  return cleanedLines.join('\n').trim();
}

/**
 * Copilot tool-action pattern: ● followed by one of copilot's TOOL NAMES.
 *
 * Issue #571: Distinguish tool actions from actual response content starting with ●
 *
 * Issue #1897: the list used to hold ~110 ordinary English verbs (Check, Add,
 * Update, Show, Find, Set, Test, Save, Watch, Verify, Build, Start, …). On
 * copilot 1.0.80 `●` is the marker for the AGENT'S MESSAGE -- tool calls are
 * drawn as `$ <Tool> …` (see {@link COPILOT_TOOL_INVOCATION_PATTERN}) -- so every
 * one of those verbs matched prose and nothing else. `● Check the config file`
 * was deleted as a tool call, and because the match also opened a
 * skip-until-next-marker block it took the rest of the reply with it.
 *
 * What remains is the set of names copilot actually labels tool rows with, which
 * is why the ≤1.0.79 rows this was written for (`● Read package.json`,
 * `● Get current directory structure (shell)`) are still filtered. A match is now
 * a SINGLE-LINE skip: the follow-on command and output rows are recognised on
 * their own by {@link COPILOT_FOLD_MARKER_PATTERN} and
 * {@link COPILOT_COMMAND_OUTPUT_PATTERN}, so nothing needs a block that can run
 * away over a whole message.
 *
 * Issue #2269: the verb list moved to {@link COPILOT_TOOL_VERBS}, which
 * `COPILOT_TOOL_ROW_PATTERN` reads as well. 1.0.82 marks most tool rows with a
 * file-type badge rather than `●` and that pattern owns those; `●` is still the
 * marker for a tool row whose file type has no badge (`● Read d.txt 1 line
 * read`, measured) and for the ask-user row (`● Asked user …`), so both markers
 * have to answer to one vocabulary.
 */
const COPILOT_TOOL_ACTION_PATTERN = new RegExp(`^●\\s+(?:${COPILOT_TOOL_VERBS})[\\s:]`);

/**
 * copilot 1.0.80's tool invocation row (Issue #1897).
 *
 * Measured on the live frames in
 * `tests/unit/lib/detection/fixtures/copilot-live-1885/`: a tool call is a `$`
 * marker row naming the tool, with the fold marker and the elapsed time
 * right-aligned onto the same row, and the command it ran on the indented rows
 * below:
 *
 *     $ Shell Wait 25 seconds then print status 2 lines…            1m 27s
 *       sleep 25; echo finished
 *
 * The capitalised tool name is required so a `$ npm install` line inside a reply's
 * code block is not read as copilot's own chrome. This is the one construct that
 * still opens a skip block, and that block now ends at the next marker row or the
 * next blank row rather than running to the end of the message.
 */
const COPILOT_TOOL_INVOCATION_PATTERN = /^\$\s+[A-Z][A-Za-z]*(?:\s|$)/;

/**
 * Pattern for "N lines..." fold markers in Copilot TUI output.
 * These indicate collapsed command output.
 */
const COPILOT_FOLD_MARKER_PATTERN = /^\d+\s+lines\.\.\.$/;

/**
 * Pattern for Copilot thinking indicator characters (◐◑◒◓).
 */
const COPILOT_THINKING_INDICATOR_PATTERN = /^[◐◑◒◓]/;

/**
 * Pattern for shell command output lines in Copilot TUI.
 * Matches common command prefixes that appear in tool call output.
 *
 * Issue #1897: the heads that are also ordinary English words at the start of a
 * sentence were removed -- `find`, `go`, `make`, `cat`, `ls`, `cd`, `echo`,
 * `node`, `python`, `ruby`. "find the file in src/", "go to the settings page",
 * "make sure you run npm test" and "cat the file to check" were all being deleted
 * from saved replies as if they were shell transcript. The heads that remain are
 * tool names no English sentence opens with, so the rule keeps its purpose (the
 * `git --no-pager …` and `npm run …` rows copilot echoes under a tool call) at no
 * cost to prose.
 */
const COPILOT_COMMAND_OUTPUT_PATTERN = /^(?:git\s+--no-pager|git\s+(?:log|diff|show|status|branch|remote|fetch|pull|push|merge|rebase|checkout|reset|stash|tag|config|clone|init|add|commit|rm|mv|bisect|grep|ls-files|rev-parse|describe|shortlog|blame|reflog|cherry-pick|revert|submodule|worktree)\b|npm\s+|npx\s+|yarn\s+|pnpm\s+|cargo\s+|pip\s+|rustc\s+|cmake\s+|docker\s+|kubectl\s+|aws\s+|gcloud\s+|az\s+|terraform\s+|ansible\s+|curl\s+|wget\s+|ssh\s+|scp\s+|rsync\s+|grep\s+|sed\s+|awk\s+|mkdir\s+|rm\s+|cp\s+|mv\s+|chmod\s+|chown\s+)/;

/**
 * Clean Copilot response by removing TUI artifacts, extracting only the latest
 * response, and normalizing content.
 *
 * Issue #565: Full implementation using normalizeCopilotLine (DRY with tui-accumulator)
 * and COPILOT_SKIP_PATTERNS for filtering.
 *
 * Issue #571: Added "latest response only" extraction logic:
 * 1. Find the last ❯ prompt line — content after it is the latest response
 * 2. Filter ● tool-action lines (shell, Read, Get, etc.) while preserving ● response content
 * 3. Filter ◐◑◒◓ thinking indicators
 * 4. Filter "N lines..." fold markers
 * 5. Filter shell command output lines
 *
 * @param response - Raw Copilot response
 * @returns Cleaned response (only the latest response)
 */
export function cleanCopilotResponse(response: string): string {
  const strippedResponse = stripAnsi(response);
  const allLines = strippedResponse.split('\n');

  // Issue #1897: cut copilot's bottom-pinned chrome (cwd row, rules, composer,
  // status bar) before anything else, positionally — the status bar's wording is
  // something copilot will happily print as body text, so only its position tells
  // the two apart. Returns -1, and so changes nothing, for input that is not a
  // whole captured frame: the accumulated content this normally receives, and the
  // synthetic strings the unit tests pass.
  const chromeStart = findCopilotChromeStart(allLines);
  const lines = chromeStart >= 0 ? allLines.slice(0, chromeStart) : allLines;

  // Step 1: Find the last ❯ prompt line with user input (not empty prompt)
  // This marks the boundary — everything after is the latest response
  let lastUserPromptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const normalized = normalizeCopilotLine(lines[i]);
    if (!normalized) continue;
    // Match ❯ followed by actual content (user input)
    if (/^❯\s+\S/.test(normalized)) {
      lastUserPromptIndex = i;
      break;
    }
  }

  // Extract lines after the last user prompt.
  //
  // Issue #1897: a prompt too long for one row wraps onto indented continuation
  // rows, and starting at `+ 1` opened the saved reply with the tail of the
  // operator's own question. Walk past them. (Indentation only survives on a raw
  // frame; the accumulator has its own copy of this rule for the normalised path.)
  let startIndex = lastUserPromptIndex >= 0 ? lastUserPromptIndex + 1 : 0;
  if (lastUserPromptIndex >= 0) {
    while (
      startIndex < lines.length &&
      COPILOT_TRANSCRIPT_CONTINUATION_PATTERN.test(lines[startIndex])
    ) {
      startIndex++;
    }
  }
  const responseLines = lines.slice(startIndex);

  const cleanedLines: string[] = [];

  // Track block-level skip state for multi-line constructs
  let inThinkingBlock = false;
  let inToolOutputBlock = false;

  for (const line of responseLines) {
    // Issue #2269: tested BEFORE normalisation, for the reason #1897 records at
    // COPILOT_BOX_ROW_PATTERN and then only acted on in the accumulator:
    // `normalizeCopilotLine` deletes every U+2500..U+257F glyph, so by the time
    // COPILOT_SKIP_PATTERNS runs below, every glyph-anchored rule in it is dead
    // in THIS function. That is what let two rows of copilot's launch screen
    // through -- `  ╰─╯╰─╯  Copilot v1.0.82 uses AI.` cleans to a bare version
    // string (1.0.82 split the one-line disclaimer the exact-match rule was
    // written for), and `   └ Enable all permissions …` cleans to prose -- on
    // every call that receives a raw frame rather than accumulated content.
    //
    // Deliberately not resetting the block flags: the reasoning block's own rows
    // are `│ <chain of thought>`, so a box row is the middle of a block far more
    // often than the end of one. That is the behaviour the dead `/^[│└]/` rule
    // below was written with, and this is the live version of it.
    if (COPILOT_BOX_ROW_PATTERN.test(line)) continue;

    // Normalize using the same function as TUI accumulator (DRY)
    const normalized = normalizeCopilotLine(line);
    if (!normalized) {
      // Issue #1897: a blank row closes whatever block is open. copilot separates
      // every transcript block with one, and skipping this reset is what allowed a
      // single misclassified marker row to swallow the entire rest of the reply.
      inThinkingBlock = false;
      inToolOutputBlock = false;
      continue;
    }

    // Skip lines matching any Copilot skip pattern (existing patterns)
    const shouldSkip = COPILOT_SKIP_PATTERNS.some(pattern => pattern.test(normalized));
    if (shouldSkip) continue;

    // Issue #1897: copilot 1.0.80's tool call. Its command / output rows follow
    // until the next marker row or blank row.
    if (COPILOT_TOOL_INVOCATION_PATTERN.test(normalized)) {
      inToolOutputBlock = true;
      inThinkingBlock = false;
      continue;
    }

    // Issue #571: Skip ● tool-action lines (but preserve ● response content).
    // Issue #1897: a single-line skip — see COPILOT_TOOL_ACTION_PATTERN.
    if (COPILOT_TOOL_ACTION_PATTERN.test(normalized)) continue;

    // Issue #571: Skip ◐◑◒◓ thinking indicator lines and their continuation lines
    if (COPILOT_THINKING_INDICATOR_PATTERN.test(normalized)) {
      inThinkingBlock = true;
      inToolOutputBlock = false;
      continue;
    }

    // Issue #571: Skip "N lines..." fold markers
    if (COPILOT_FOLD_MARKER_PATTERN.test(normalized)) continue;

    // Issue #571: Skip shell command output lines
    if (COPILOT_COMMAND_OUTPUT_PATTERN.test(normalized)) continue;

    // Skip empty ❯ prompt lines and ❯ with content (previous prompts that leaked through)
    if (/^❯\s*/.test(normalized)) {
      inThinkingBlock = false;
      inToolOutputBlock = false;
      continue;
    }

    // Issue #571: Skip │ and └ prefixed lines (command output block content)
    if (/^[│└]/.test(normalized)) {
      continue;
    }

    // Detect new content block: ● starts a new response block, reset skip states
    if (/^●/.test(normalized)) {
      inThinkingBlock = false;
      inToolOutputBlock = false;
      // This is a ● line that didn't match COPILOT_TOOL_ACTION_PATTERN,
      // so it's actual response content — keep it, but remove the ● prefix
      cleanedLines.push(normalized.replace(/^●\s*/, ''));
      continue;
    }

    // If we're in a thinking or tool output block, skip continuation lines until a
    // new block marker (●, ❯, $) or a blank row is found.
    // Note: TUI accumulator normalizes lines (trim), so indentation is lost.
    if (inThinkingBlock || inToolOutputBlock) {
      continue;
    }

    cleanedLines.push(normalized);
  }

  return cleanedLines.join('\n').trim();
}

/**
 * Clean OpenCode TUI response by removing decoration characters and status lines,
 * and trimming to only the latest response.
 * [D2-009] Removes box-drawing characters, Build summary, loading indicators,
 * prompt patterns, and processing indicators.
 *
 * Cleaning pipeline:
 * 1. Split response into lines
 * 2. Trim to latest response: find Build markers (square Build . model . time)
 *    and discard all content before the second-to-last marker.
 *    OpenCode TUI accumulates conversation history; each Q&A exchange ends
 *    with a Build marker. Without this trimming, savePendingAssistantResponse
 *    and Layer 2 accumulator would include previous Q&As in the response.
 * 3. Skip empty lines
 * 4. Skip lines matching any OPENCODE_SKIP_PATTERNS (TUI artifacts)
 * 5. Skip Build summary line (OPENCODE_RESPONSE_COMPLETE, the completion indicator)
 * 6. Join remaining lines
 *
 * @param response - Raw OpenCode response (may contain TUI decoration)
 * @returns Cleaned response with TUI artifacts removed
 *
 * @internal Exported for unit testing (response-poller-opencode.test.ts)
 */
export function cleanOpenCodeResponse(response: string): string {
  const lines = response.split('\n');

  // Step 2: Trim to latest response by finding Build markers.
  // Each Q&A exchange ends with "square Build . model . time".
  // If 2+ markers exist, only include content after the second-to-last marker.
  const buildIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cleanLine = normalizeOpenCodeLine(lines[i]);
    if (cleanLine && OPENCODE_RESPONSE_COMPLETE.test(cleanLine)) {
      buildIndices.push(i);
    }
  }
  let startLine = 0;
  if (buildIndices.length >= 2) {
    startLine = buildIndices[buildIndices.length - 2] + 1;
  }

  const cleanedLines: string[] = [];

  for (let i = startLine; i < lines.length; i++) {
    // Strip ANSI escape codes and TUI border characters before pattern matching.
    // Without this, embedded ANSI codes and heavy borders can break regex matches.
    const cleanLine = normalizeOpenCodeLine(lines[i]);
    if (!cleanLine) continue;

    // Skip lines matching any OpenCode skip pattern
    const shouldSkip = OPENCODE_SKIP_PATTERNS.some(pattern => pattern.test(cleanLine));
    if (shouldSkip) continue;

    // Skip the Build summary line (completion indicator)
    if (OPENCODE_RESPONSE_COMPLETE.test(cleanLine)) continue;

    cleanedLines.push(cleanLine);
  }

  return cleanedLines.join('\n').trim();
}

/**
 * Truncate a message to fit within a maximum character length.
 * Issue #571: Prevents excessively large messages from being saved to the database.
 *
 * **Tail-preserving**: When truncation is needed, the head (oldest content) is removed
 * and a marker is prepended. The tail (most recent content) is preserved because
 * the latest response content is typically the most relevant for chat history. [DR1-07]
 *
 * Includes a surrogate pair guard [SEC4-06]: if the cut point falls between
 * a high surrogate (U+D800-U+DBFF) and its low surrogate (U+DC00-U+DFFF),
 * the cut is adjusted forward by one character to avoid creating broken pairs.
 *
 * @param content - Message content to potentially truncate
 * @param maxLength - Maximum allowed character length (default: COPILOT_MAX_MESSAGE_LENGTH)
 * @param marker - Truncation marker text (default: COPILOT_TRUNCATION_MARKER)
 * @returns Original content if within limit, or marker + tail portion if truncated
 */
export function truncateMessage(
  content: string,
  maxLength: number = COPILOT_MAX_MESSAGE_LENGTH,
  marker: string = COPILOT_TRUNCATION_MARKER,
): string {
  if (!content || content.length <= maxLength) {
    return content;
  }

  // Calculate how many characters of the tail to preserve.
  // Format: marker + '\n' + tail
  const markerWithNewline = marker + '\n';
  const tailLength = maxLength - markerWithNewline.length;

  if (tailLength <= 0) {
    // Edge case: marker alone exceeds maxLength; return marker truncated to maxLength
    return marker.slice(0, maxLength);
  }

  // Determine cut point (index into content from which to take the tail)
  let cutIndex = content.length - tailLength;

  // Surrogate pair guard: if cutIndex lands on a low surrogate (second half of a pair),
  // advance by 1 to avoid splitting the pair
  if (cutIndex > 0 && cutIndex < content.length) {
    const code = content.charCodeAt(cutIndex);
    if (code >= 0xDC00 && code <= 0xDFFF) {
      // This is a low surrogate; skip past it to keep the pair intact in the discarded head
      cutIndex += 1;
    }
  }

  const tail = content.slice(cutIndex);
  return markerWithNewline + tail;
}
