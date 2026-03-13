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
} from './detection/cli-patterns';
import { normalizeOpenCodeLine } from './tui-accumulator';

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
