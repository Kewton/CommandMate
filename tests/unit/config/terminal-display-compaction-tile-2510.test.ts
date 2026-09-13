/**
 * The `/sessions` tile's terminal layout policy (Issue #2510).
 *
 * `config/terminal-display-compaction` is the one home for how a terminal pane
 * lays a frame out (#2049, #2047). #2510 adds the tile to it, and with it the
 * fact that broke the module's old claim: a PC column is NOT necessarily wider
 * than the pane it shows.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  SESSION_TILE_TERMINAL_LAYOUT,
  getTerminalDisplayCompaction,
  measureTerminalFrameColumns,
} from '@/config/terminal-display-compaction';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { TUI_PANE_WIDTH } from '@/config/tmux-pane-config';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');

describe('Issue #2510: SESSION_TILE_TERMINAL_LAYOUT', () => {
  it('keeps the frame columns and sets them compact', () => {
    expect(SESSION_TILE_TERMINAL_LAYOUT).toEqual({ wrapMode: 'frame', density: 'compact' });
  });

  it('is the arithmetic the Issue is about: a half-width tile holds fewer columns than the pane', () => {
    // 804px: a tile's terminal scroll region measured at 1920x1080 in a real
    // browser. Even at the compact 7.2px per column that is well under
    // TUI_PANE_WIDTH — which is why `frame` is needed at all, and why the
    // density alone could not replace it.
    const tileWidthPx = 804;
    const compactColumnPx = 7.2;
    expect(Math.floor(tileWidthPx / compactColumnPx)).toBeLessThan(TUI_PANE_WIDTH);
  });

  it('did not move the phone policy for any tool', () => {
    // The tile uses `frame` for every tool; the phone still does so for
    // opencode only (#2047). The two must stay separate decisions.
    for (const tool of CLI_TOOL_IDS as readonly CLIToolType[]) {
      expect(getTerminalDisplayCompaction(tool).mobileWrapMode, tool).toBe(
        tool === 'opencode' ? 'frame' : 'viewport',
      );
    }
  });
});

describe('Issue #2510: measuring a claude frame', () => {
  it('does not count an OSC 8 hyperlink as columns', () => {
    // BEL- and ST-terminated forms, both of which a capture can carry. What is
    // visible is the label `claude.ai` and nothing else.
    const bel = '\x1b]8;;https://claude.ai/code/session_x\x07claude.ai\x1b]8;;\x07';
    const st = '\x1b]8;id=1;https://claude.ai/code/session_x\x1b\\claude.ai\x1b]8;;\x1b\\';
    expect(measureTerminalFrameColumns(bel)).toBe('claude.ai'.length);
    expect(measureTerminalFrameColumns(st)).toBe('claude.ai'.length);
  });

  it.each([
    'tests/fixtures/claude-live-2247/boot-banner.txt',
    'tests/fixtures/claude-live-2486/tabs-q1.txt',
  ])('measures the live 200-column capture %s at the pane width, not wider', (fixture) => {
    // Both carry OSC 8 links in claude's header and measured 270 / 228 when only
    // SGR was stripped — the difference is empty sideways scroll in a tile.
    expect(measureTerminalFrameColumns(read(fixture))).toBe(TUI_PANE_WIDTH);
  });
});

describe('Issue #2510: the docblock no longer says PC columns are always wide enough', () => {
  const source = read('src/config/terminal-display-compaction.ts');

  it('drops the claim that re-wrapping never happens on PC', () => {
    expect(source).not.toContain('already wider than any pane');
    expect(source).not.toContain('re-wrapping never happens there');
  });

  it('states the case where the assumption breaks', () => {
    expect(source).toContain('A PC column is not necessarily wider than the pane (Issue #2510)');
  });
});

describe('Issue #2510: the tile reads the policy rather than restating it', () => {
  const source = read('src/components/sessions/SessionTile.tsx');

  it('resolves compaction through the config module, like both worktree-screen surfaces', () => {
    expect(source).toContain("from '@/config/terminal-display-compaction'");
    expect(source).toContain('getTerminalDisplayCompaction(cliToolId)');
    expect(source).toContain('compactTuiLayoutPadding={compactTuiLayoutPadding}');
    expect(source).toContain('preservePaintedPanelRows={preservePaintedPanelRows}');
  });

  it('takes its wrap mode and density from the tile constant', () => {
    expect(source).toContain('wrapMode={SESSION_TILE_TERMINAL_LAYOUT.wrapMode}');
    expect(source).toContain('density={SESSION_TILE_TERMINAL_LAYOUT.density}');
  });

  it('left the worktree screen split pane on its pre-#2510 layout', () => {
    // The Issue's hard constraint: `/worktrees/<id>` must not change.
    const split = read('src/components/worktree/TerminalSplitPaneContent.tsx');
    expect(split).not.toContain('wrapMode=');
    expect(split).not.toContain('density=');
    expect(split).toContain('useHistoryPaneState()');
  });
});
