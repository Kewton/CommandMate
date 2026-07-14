/** Synthetic Claude frame matching the 1000-row layout from Issue #1167. */
export function buildClaude1000RowPermissionFrame(): string {
  const lines = Array<string>(1000).fill('');
  lines[44] = 'Do you want to make this edit to useVirtualKeyboard.ts?';
  lines[45] = '❯ 1. Yes';
  lines[46] = '  2. Yes, allow all edits during this session (shift+tab)';
  lines[47] = '  3. No';
  lines[49] = 'Esc to cancel · Tab to amend';
  lines[992] = '6 tasks (0 done, 1 in progress, 5 open)';
  lines[993] = '◼ Update implementation';
  lines[994] = '◻ Add regression tests';
  lines[995] = '◻ Run validation';
  lines[996] = '◻ Review output';
  lines[997] = '◻ Prepare report';
  lines[998] = '… +1 pending';
  return lines.join('\n');
}
