/**
 * Synthetic Codex frame matching the 1000-row TUI layout (Issue #1172).
 *
 * Like the Claude fixture, Codex anchors its approval prompt near the top of the
 * pinned 1000-row pane and a status/usage footer near the bottom, leaving a
 * large layout-only blank gap between them.
 */
export function buildCodex1000RowApprovalFrame(): string {
  const lines = Array<string>(1000).fill('');
  lines[40] = 'Allow command to run?';
  lines[41] = '  $ rm -rf build';
  lines[43] = '❯ 1. Yes';
  lines[44] = "  2. Yes, and don't ask again for this command";
  lines[45] = '  3. No, and tell Codex what to do differently';
  lines[992] = 'token usage: 12,345 / 200,000';
  lines[993] = 'esc to interrupt';
  return lines.join('\n');
}
