/**
 * Build a compact copy of a TUI frame for detection only.
 *
 * Alternate-screen CLIs may anchor interactive content near the top of a large
 * pane and a status/task panel at the bottom. Raw tail windows therefore lose
 * the prompt even though it is still visible. This helper never changes the
 * display output; it only removes layout-only blank rows and, for Claude's
 * known prompt footers, excludes overlays rendered below the active prompt.
 */

// A real footer starts its row: in every capture measured for Issue 2776 only
// whitespace precedes it (plus one SGR colour sequence in a raw capture), while
// every measured quote of it has visible text first (`「`, `- Approval footer: `,
// `navigate · `). A quote above the live prompt otherwise cut the frame at the
// quote (Issue 2774: 963 of 1002 rows). The row end is NOT anchored: real
// footers go on with more key hints (` · Esc to cancel`, ` · ctrl+e to explain`).
// Position and discard-size limits were measured and rejected — see
// docs/design/tui-frame-footer-scan-2776.md.
const CLAUDE_PROMPT_FOOTER_PATTERN =
  /^(?:\s|\x1b\[[0-9;]*m)*Esc\s+to\s+cancel\s*[·•]\s*Tab\s+to\s+amend/i;
const CLAUDE_PICKER_FOOTER_PATTERN = /^(?:\s|\x1b\[[0-9;]*m)*Enter\s+to\s+select\b.*\bnavigate\b/i;

// A prompt/thinking/input anchor below a footer means that footer belongs to an
// older frame. Task-panel rows intentionally do not match these patterns.
// `›` (U+203A) is codex's composer glyph. Without it, a line anywhere in the
// transcript that merely QUOTES a picker footer truncates the frame at that
// line and the live composer below it is discarded — the agent then reads as
// `running` / `default` forever (Issue 2774). The other six tools draw
// `>` or `❯`, so this class is what they are already covered by.
const CLAUDE_LOWER_INTERACTIVE_ANCHOR =
  /^\s*[>❯›]\s*(?:\d{1,2}[.)])?|esc\s+to\s+interrupt|[✻✽✶✢✳⦿◉●⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.+…/i;

/** Whether `line` is one of Claude's prompt/picker footer rows (not a quote of one). */
export function isClaudeFooter(line: string): boolean {
  return CLAUDE_PROMPT_FOOTER_PATTERN.test(line) || CLAUDE_PICKER_FOOTER_PATTERN.test(line);
}

function compactBlankRows(lines: string[]): string[] {
  const compacted: string[] = [];
  let previousWasBlank = false;

  for (const line of lines) {
    const isBlank = line.trim() === '';
    if (isBlank && previousWasBlank) continue;
    compacted.push(line);
    previousWasBlank = isBlank;
  }

  while (compacted.length > 0 && compacted[compacted.length - 1].trim() === '') {
    compacted.pop();
  }
  return compacted;
}

/**
 * Normalize a captured frame for prompt/status detection.
 * The operation is idempotent and preserves all non-empty line ordering.
 */
export function normalizeTuiFrameForDetection(output: string): string {
  if (output === '') return '';

  const lines = output.split('\n');
  let footerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isClaudeFooter(lines[i])) {
      footerIndex = i;
      break;
    }
  }

  let detectionLines = lines;
  if (footerIndex >= 0) {
    const hasNewerInteractiveAnchor = lines
      .slice(footerIndex + 1)
      .some(line => CLAUDE_LOWER_INTERACTIVE_ANCHOR.test(line));

    if (hasNewerInteractiveAnchor) {
      // The footer belongs to scrollback/an older frame. Analyze only the
      // newer active region so its options cannot be resurrected.
      detectionLines = lines.slice(footerIndex + 1);
    } else {
      detectionLines = lines.slice(0, footerIndex + 1);
    }
  }

  return compactBlankRows(detectionLines).join('\n');
}
