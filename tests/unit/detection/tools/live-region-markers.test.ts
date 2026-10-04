/**
 * The live-region markers, pinned to the fixtures they were measured on
 * (Issue #3183, `docs/design/3183-live-region-extraction.md` §7).
 *
 * Each row is one line of the design doc's table: a fixture, the anchor the
 * tool's declaration must find on it, and the PHYSICAL line (1-based, as the
 * doc cites it) the region must start at. `normalizeFrame` compacts blank runs,
 * so the start is checked by content: the first non-blank row at or after
 * `startRow` must be the cited line. When a tool's TUI changes and this table
 * goes red, the doc and the declaration are what get updated — together.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { LIVE_REGION_SPECS } from '@/lib/detection/tools/live-region-specs';
import { TOOL_STATUS_DETECTORS } from '@/lib/detection/tools/registry';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { LiveRegionAnchor } from '@/lib/detection/tools/types';

const ROOT = path.resolve(__dirname, '../../../..');

interface MarkerRow {
  tool: CLIToolType;
  fixture: string;
  anchor: LiveRegionAnchor;
  /** Physical line the region starts at (first non-blank row); omitted for `'none'`. */
  line?: number;
  /** For `'composer'`: is it the bottom of the pane? */
  atBottom?: boolean;
}

const F = 'tests/fixtures';
const U = 'tests/unit/lib/detection/fixtures';

export const MARKERS: readonly MarkerRow[] = [
  // claude — the input box; the rule above the dialog's first option.
  { tool: 'claude', fixture: `${F}/tui-frame-footer-2776/claude-2.1.278-idle-quoted-footers.txt`, anchor: 'composer', line: 997, atBottom: true },
  { tool: 'claude', fixture: `${F}/claude-idle-numbered-list-2457/live-2997/claude-reply-numbered-list-21284.txt`, anchor: 'composer', line: 57, atBottom: true },
  { tool: 'claude', fixture: `${F}/tui-frame-footer-2776/claude-2.1.278-bash-approval.txt`, anchor: 'dialog', line: 12 },
  { tool: 'claude', fixture: `${U}/claude-live-1708/bash-approval-taskpanel.txt`, anchor: 'dialog', line: 97 },
  { tool: 'claude', fixture: `${F}/tui-frame-footer-2776/claude-2.1.278-askuserquestion-picker.txt`, anchor: 'dialog', line: 17 },
  { tool: 'claude', fixture: `${F}/tui-frame-footer-2776/claude-2.1.278-edit-approval.txt`, anchor: 'dialog', line: 46 },
  { tool: 'claude', fixture: `${F}/tui-frame-footer-2776/claude-2.1.278-approval-below-quoted-footers.txt`, anchor: 'dialog', line: 88 },
  { tool: 'claude', fixture: `${F}/claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt`, anchor: 'none' },
  // codex — the bottom-most genuine `›` row; "at the bottom" by its SGR.
  { tool: 'codex', fixture: `${F}/codex-dialogs-0157/quoted-approval-idle.txt`, anchor: 'composer', line: 997, atBottom: true },
  { tool: 'codex', fixture: `${F}/claude-idle-numbered-list-2457/live-2997/codex-reply-dialog-glyph-01571.txt`, anchor: 'composer', line: 57, atBottom: true },
  // A dialog replaces the composer, so the bottom-most `›` row is the user's
  // last turn above it: the region runs from there and is not the bottom.
  { tool: 'codex', fixture: `${F}/codex-dialogs-0157/approval.txt`, anchor: 'composer', line: 24, atBottom: false },
  // antigravity — the bare `>` row; the boundary above the `↑/↓ Navigate` footer.
  { tool: 'antigravity', fixture: `${F}/antigravity-live-2364/idle-after-deny.txt`, anchor: 'composer', line: 42, atBottom: true },
  { tool: 'antigravity', fixture: `${F}/antigravity-live-2364/dialog-bash-oneline.txt`, anchor: 'dialog', line: 29 },
  { tool: 'antigravity', fixture: `${F}/antigravity-live-2364/picker-switch-model.txt`, anchor: 'composer', line: 42, atBottom: false },
  // command-code — the input box; the rule above the dialog's first option.
  { tool: 'command-code', fixture: `${F}/tui-frame-footer-2776/command-code-1.58.0-idle-quoted-footers.txt`, anchor: 'composer', line: 29, atBottom: true },
  { tool: 'command-code', fixture: `${F}/command-code-live-2250/dialog-shell-command.txt`, anchor: 'dialog', line: 29 },
  // copilot — the bottom chrome (cwd row, fenced composer, status bar); the box.
  { tool: 'copilot', fixture: `${U}/copilot-live-1885/turn-complete.txt`, anchor: 'composer', line: 997, atBottom: true },
  { tool: 'copilot', fixture: `${U}/copilot-live-2269/turn-complete.txt`, anchor: 'composer', line: 996, atBottom: true },
  { tool: 'copilot', fixture: `${U}/copilot-live-1885/permission-dialog.txt`, anchor: 'dialog', line: 987 },
  // opencode — the gutter block above `╹▀▀` + the `ctrl+p` footer; the title row.
  { tool: 'opencode', fixture: `${F}/opencode-agent-health-3021/quoted-dialog-reply-done.txt`, anchor: 'composer', line: 192, atBottom: true },
  { tool: 'opencode', fixture: `${U}/opencode-live-1893/permission-bash.txt`, anchor: 'dialog', line: 192 },
  // opencode-v2 — the same composer; the permission / question title rows.
  { tool: 'opencode-v2', fixture: `${F}/opencode-v2-dialogs-2984/quoted-dialog-reply.txt`, anchor: 'composer', line: 194, atBottom: true },
  { tool: 'opencode-v2', fixture: `${F}/opencode-v2-dialogs-2984/permission.txt`, anchor: 'dialog', line: 186 },
  { tool: 'opencode-v2', fixture: `${F}/opencode-v2-dialogs-2984/question.txt`, anchor: 'dialog', line: 190 },
];

describe('[#3183] each tool declares its live region, once', () => {
  it('the seven measured tools have a declaration; the two unmeasured ones do not', () => {
    expect(Object.keys(LIVE_REGION_SPECS).sort()).toEqual(
      ['antigravity', 'claude', 'codex', 'command-code', 'copilot', 'opencode', 'opencode-v2'].sort(),
    );
  });

  it('every detector declares the same object normalizeFrame reads', () => {
    for (const detector of TOOL_STATUS_DETECTORS) {
      expect(detector.liveRegion, detector.tool).toBe(LIVE_REGION_SPECS[detector.tool]);
    }
  });

  it('a frame normalised without a tool carries the whole frame', () => {
    const frame = normalizeFrame(readFileSync(path.join(ROOT, MARKERS[0].fixture), 'utf8'));
    expect(frame.liveRegion).toMatchObject({ tool: null, anchor: 'none', startRow: 0, composerAtBottom: false });
    expect(frame.liveRegion.lines).toEqual(frame.contentLines);
  });

  it('every tool of the table is measured on at least one composer and one dialog frame', () => {
    for (const tool of Object.keys(LIVE_REGION_SPECS)) {
      expect(MARKERS.some(m => m.tool === tool && m.anchor === 'composer'), tool).toBe(true);
      expect(
        MARKERS.some(m => m.tool === tool && m.anchor !== 'composer') ||
          MARKERS.some(m => m.tool === tool && m.atBottom === false),
        tool,
      ).toBe(true);
    }
  });
});

describe('[#3183] the markers land where the design doc says (§7)', () => {
  it.each(MARKERS)('$tool $anchor L$line — $fixture', ({ tool, fixture, anchor, line, atBottom }) => {
    const raw = readFileSync(path.join(ROOT, fixture), 'utf8');
    const frame = normalizeFrame(raw, tool);
    const region = frame.liveRegion;

    expect(region.tool).toBe(tool);
    expect(region.anchor).toBe(anchor);
    expect(region.lines).toEqual(frame.contentLines.slice(region.startRow));
    if (anchor === 'none') {
      expect(region.startRow).toBe(0);
      return;
    }

    const firstRow = region.lines.find(row => row.trim() !== '') ?? '';
    const cited = stripAnsi(raw.split('\n')[line! - 1]);
    expect(firstRow.trim()).toBe(cited.trim());
    if (anchor === 'composer') expect(region.composerAtBottom).toBe(atBottom);
    else expect(region.composerAtBottom).toBe(false);
  });
});
