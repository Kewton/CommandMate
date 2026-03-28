/**
 * Response cleaning functions for CLI tools.
 * Removes tool-specific artifacts (shell prompts, banners, TUI decorations)
 * from captured tmux output before saving to the database.
 *
 * Issue #479: Extracted from response-poller.ts for single-responsibility separation
 */

import {
  stripAnsi,
  PASTED_TEXT_PATTERN,
  OPENCODE_SKIP_PATTERNS,
  OPENCODE_RESPONSE_COMPLETE,
  COPILOT_SKIP_PATTERNS,
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
  const lines = cleanedResponse.split('\n');

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
 * Copilot tool-action pattern: ● followed by English tool/action keywords.
 * These lines represent Copilot's internal tool calls (shell, file reads, etc.)
 * and should be filtered from saved responses.
 * Does NOT match ● followed by non-action text (e.g., Japanese response content).
 *
 * Issue #571: Distinguish tool actions from actual response content starting with ●
 */
const COPILOT_TOOL_ACTION_PATTERN = /^●\s+(?:Get |Read |Run |Search |Write |Delete |Edit |List |Create |Check |Fetch |Map |Explore |Execute |Find |Install |Update |Open |Close |Copy |Move |Rename |Set |Test |Build |Deploy |Start |Stop |Restart |Kill |Call |Send |Upload |Download |Compile |Analyze |Scan |Apply |Revert |Reset |Push |Pull |Clone |Merge |Commit |Checkout |Branch |Tag |Diff |Log |Show |Status |Init |Config |Add |Remove |Index |Query |Connect |Disconnect |Ping |Trace |Debug |Validate |Verify |Inspect |Monitor |Watch |Clean |Purge |Flush |Load |Save |Export |Import |Format |Lint |Parse |Generate |Transform |Convert |Migrate |Upgrade |Patch |Enable |Disable |Grant |Revoke |Approve |Deny |Lock |Unlock |Mount |Unmount |Attach |Detach |Register |Unregister |Subscribe |Unsubscribe |Publish |Unpublish |Encrypt |Decrypt |Sign |Hash |Encode |Decode |Compress |Decompress |Archive |Extract |Backup |Restore |Dump |Model changed to:)/;

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
 */
const COPILOT_COMMAND_OUTPUT_PATTERN = /^(?:git\s+--no-pager|git\s+(?:log|diff|show|status|branch|remote|fetch|pull|push|merge|rebase|checkout|reset|stash|tag|config|clone|init|add|commit|rm|mv|bisect|grep|ls-files|rev-parse|describe|shortlog|blame|reflog|cherry-pick|revert|submodule|worktree)\b|npm\s+|npx\s+|node\s+|yarn\s+|pnpm\s+|cargo\s+|pip\s+|python\s+|ruby\s+|go\s+|rustc\s+|make\s+|cmake\s+|docker\s+|kubectl\s+|aws\s+|gcloud\s+|az\s+|terraform\s+|ansible\s+|curl\s+|wget\s+|ssh\s+|scp\s+|rsync\s+|find\s+|grep\s+|sed\s+|awk\s+|cat\s+|ls\s+|cd\s+|mkdir\s+|rm\s+|cp\s+|mv\s+|chmod\s+|chown\s+|echo\s+)/;

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
  const lines = strippedResponse.split('\n');

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

  // Extract lines after the last user prompt
  const startIndex = lastUserPromptIndex >= 0 ? lastUserPromptIndex + 1 : 0;
  const responseLines = lines.slice(startIndex);

  const cleanedLines: string[] = [];

  // Track block-level skip state for multi-line constructs
  let inThinkingBlock = false;
  let inCommandOutputBlock = false;

  for (const line of responseLines) {
    // Normalize using the same function as TUI accumulator (DRY)
    const normalized = normalizeCopilotLine(line);
    if (!normalized) continue;

    // Skip lines matching any Copilot skip pattern (existing patterns)
    const shouldSkip = COPILOT_SKIP_PATTERNS.some(pattern => pattern.test(normalized));
    if (shouldSkip) continue;

    // Issue #571: Skip ● tool-action lines (but preserve ● response content)
    if (COPILOT_TOOL_ACTION_PATTERN.test(normalized)) {
      inCommandOutputBlock = true;
      inThinkingBlock = false;
      continue;
    }

    // Issue #571: Skip ◐◑◒◓ thinking indicator lines and their continuation lines
    if (COPILOT_THINKING_INDICATOR_PATTERN.test(normalized)) {
      inThinkingBlock = true;
      inCommandOutputBlock = false;
      continue;
    }

    // Issue #571: Skip "N lines..." fold markers
    if (COPILOT_FOLD_MARKER_PATTERN.test(normalized)) continue;

    // Issue #571: Skip shell command output lines
    if (COPILOT_COMMAND_OUTPUT_PATTERN.test(normalized)) continue;

    // Skip empty ❯ prompt lines and ❯ with content (previous prompts that leaked through)
    if (/^❯\s*/.test(normalized)) continue;

    // Issue #571: Skip │ and └ prefixed lines (command output block content)
    if (/^[│└]/.test(normalized)) {
      continue;
    }

    // Detect new content block: ● starts a new response block, reset skip states
    if (/^●/.test(normalized)) {
      inThinkingBlock = false;
      inCommandOutputBlock = false;
      // This is a ● line that didn't match COPILOT_TOOL_ACTION_PATTERN,
      // so it's actual response content — keep it, but remove the ● prefix
      cleanedLines.push(normalized.replace(/^●\s*/, ''));
      continue;
    }

    // If we're in a thinking or command output block, skip continuation lines
    // until a new block marker (● or ❯) is found.
    // Note: TUI accumulator normalizes lines (trim), so indentation is lost.
    if (inThinkingBlock || inCommandOutputBlock) {
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
