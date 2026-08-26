/**
 * Issue #2049: one home for "which tools compact their terminal display".
 *
 * Before this Issue the policy was written out twice — once in
 * `TerminalSplitPaneContent` (PC) and once in `MobileTerminalTab` (mobile) — as
 * a hand-typed `cliToolId === 'claude' || cliToolId === 'codex'`. Adding
 * opencode to one and not the other would make the same session render
 * differently depending on the screen it is opened on, which is not a failure
 * any per-component test would catch. The last describe below reads both
 * sources and fails if either grows its own copy of the rule again.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getTerminalDisplayCompaction } from '@/config/terminal-display-compaction';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('Issue #2049: getTerminalDisplayCompaction', () => {
  it('compacts layout padding for claude, codex and opencode', () => {
    for (const tool of ['claude', 'codex', 'opencode'] as const) {
      expect(getTerminalDisplayCompaction(tool).compactTuiLayoutPadding, tool).toBe(true);
    }
  });

  it('preserves painted panel rows for opencode only', () => {
    for (const tool of CLI_TOOL_IDS) {
      expect(getTerminalDisplayCompaction(tool).preservePaintedPanelRows, tool).toBe(
        tool === 'opencode',
      );
    }
  });

  it('leaves every other tool uncompacted, copilot included', () => {
    const untouched = CLI_TOOL_IDS.filter(
      (t) => t !== 'claude' && t !== 'codex' && t !== 'opencode',
    );
    expect(untouched).toContain('copilot');
    for (const tool of untouched) {
      // `mobileWrapMode` joined the policy in Issue #2047; `viewport` is the
      // pre-#2047 behaviour, so this still says "nothing about these tools
      // changed" — which is what the assertion is for.
      expect(getTerminalDisplayCompaction(tool), tool).toEqual({
        compactTuiLayoutPadding: false,
        preservePaintedPanelRows: false,
        mobileWrapMode: 'viewport',
      });
    }
  });

  it('never asks to preserve panel rows without compacting', () => {
    // `preservePaintedPanelRows` only means anything while compaction is on;
    // a tool with the second flag and not the first would be a silent no-op.
    for (const tool of CLI_TOOL_IDS) {
      const c = getTerminalDisplayCompaction(tool);
      if (c.preservePaintedPanelRows) expect(c.compactTuiLayoutPadding, tool).toBe(true);
    }
  });

  it('answers for every declared CLI tool id', () => {
    for (const tool of CLI_TOOL_IDS as readonly CLIToolType[]) {
      expect(typeof getTerminalDisplayCompaction(tool).compactTuiLayoutPadding).toBe('boolean');
    }
  });
});

describe('Issue #2049: PC and mobile read the same policy', () => {
  const SOURCES = [
    'src/components/worktree/TerminalSplitPaneContent.tsx',
    'src/components/worktree/MobileTerminalTab.tsx',
  ];

  it.each(SOURCES)('%s resolves compaction through the config module', (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
    expect(source).toContain("from '@/config/terminal-display-compaction'");
    expect(source).toContain('getTerminalDisplayCompaction(cliToolId)');
  });

  it.each(SOURCES)('%s carries no hand-written tool list for compaction', (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
    // The exact shape that had drifted: a literal comparison assigned to the
    // compaction flag. `disableAutoFollow` legitimately still does this — it is
    // a different decision (alternate-screen auto-follow) and must not be folded
    // in — so the assertion is scoped to the compaction identifiers.
    const offending = source
      .split('\n')
      .filter(
        (line) =>
          /compactTuiLayoutPadding|preservePaintedPanelRows/.test(line) &&
          /cliToolId\s*===/.test(line),
      );
    expect(offending).toEqual([]);
  });

  it.each(SOURCES)('%s forwards both flags to TerminalDisplay', (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
    expect(source).toContain('compactTuiLayoutPadding={compactTuiLayoutPadding}');
    expect(source).toContain('preservePaintedPanelRows={preservePaintedPanelRows}');
  });
});
