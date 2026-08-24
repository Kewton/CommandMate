/**
 * `describeComposer()` / `captureSpec()` are declarations each tool owns, and
 * they say exactly what the tables they replaced said (Issue #1933, §6.3 /
 * §10.12).
 *
 * The values are the whole point of this file. This Issue is a refactor: the
 * knowledge moved out of `submit-verified-sender.ts`'s three module-level
 * tables and out of `session/worktree-status-helper.ts`'s `cliToolId === …`
 * ladder, and nothing about any tool's behaviour was meant to change with it.
 * Each expectation below is therefore written against the constant or the call
 * site the value came from, not against the new table — a table asserted
 * against itself would pass however wrong it was.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';
import { resolveComposerSpec, DEFAULT_COMPOSER_SPEC } from '@/lib/cli-tools/composer-spec';
import { resolveCaptureSpec, GEMINI_PANE_HEIGHT } from '@/lib/cli-tools/capture-spec';
import { OPENCODE_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { STATUS_DETECTION_CAPTURE_LINES } from '@/config/status-capture-config';
import { GEMINI_PANE_HEIGHT as GEMINI_PANE_HEIGHT_REEXPORT } from '@/lib/cli-tools/gemini';

function tool(id: CLIToolType) {
  return CLIToolManager.getInstance().getTool(id);
}

describe('describeComposer (Issue #1933 §6.3)', () => {
  it('is answered by every tool, and by default from the shared table', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(tool(id).describeComposer()).toEqual(resolveComposerSpec(id));
    }
  });

  /**
   * `INPUT_LINE_MARKER_TOOLS` used to be "every supported TUI except opencode",
   * listed rather than written as a negation so adding a tool is a decision
   * someone makes with its frames in front of them. That property is preserved
   * as: exactly one tool is read structurally, and it is opencode.
   */
  it('reads opencode structurally and everything else off a marked input line', () => {
    const byReader = Object.fromEntries(
      CLI_TOOL_IDS.map((id) => [id, resolveComposerSpec(id).reader])
    );

    expect(byReader).toEqual({
      claude: 'input-line-marker',
      codex: 'input-line-marker',
      gemini: 'input-line-marker',
      'vibe-local': 'input-line-marker',
      copilot: 'input-line-marker',
      antigravity: 'input-line-marker',
      opencode: 'opencode-box',
    });
  });

  it('never leaves a tool `unreadable`, which is the state #1906 found', () => {
    // An unreadable composer classifies every send as `submitted` without
    // evidence — the defect, not a default.
    for (const id of CLI_TOOL_IDS) {
      expect(resolveComposerSpec(id).reader).not.toBe('unreadable');
    }
  });

  it('reads back twelve rows for the marker tools and the whole frame for opencode', () => {
    for (const id of CLI_TOOL_IDS) {
      const expected = id === 'opencode' ? OPENCODE_PANE_HEIGHT : 12;
      expect(resolveComposerSpec(id).verifyCaptureLines).toBe(expected);
    }
  });

  /**
   * #1880 (claude) and #1890 (codex) are the only two input boxes that have
   * been captured at the production geometry. Blind `C-e`+`C-u` into a box
   * nobody has measured replaces a residual-text problem with a data-loss one.
   */
  it('empties the composer before typing only for the two measured tools', () => {
    const clearing = CLI_TOOL_IDS.filter((id) => resolveComposerSpec(id).clearBeforeSend);
    expect(clearing.sort()).toEqual(['claude', 'codex']);
  });

  it('submits with one Enter everywhere except vibe-local, whose IME needs two', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(resolveComposerSpec(id).submitEnterCount).toBe(id === 'vibe-local' ? 2 : 1);
    }
  });

  it('takes claude as the BaseCLITool default', () => {
    expect(resolveComposerSpec('claude')).toEqual(DEFAULT_COMPOSER_SPEC);
  });
});

describe('captureSpec (Issue #1933 §10.12)', () => {
  it('is answered by every tool, and by default from the shared table', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(tool(id).captureSpec()).toEqual(resolveCaptureSpec(id));
    }
  });

  /**
   * The exact ladder `worktree-status-helper.getStatusCaptureLines()` carried
   * before this Issue, restated against the constants it read.
   */
  it('asks for each tool the same number of rows the status helper used to', () => {
    expect(resolveCaptureSpec('opencode').statusLines).toBe(OPENCODE_PANE_HEIGHT);
    expect(resolveCaptureSpec('gemini').statusLines).toBe(GEMINI_PANE_HEIGHT);
    for (const id of CLI_TOOL_IDS) {
      if (id === 'opencode' || id === 'gemini') continue;
      expect(resolveCaptureSpec(id).statusLines).toBe(STATUS_DETECTION_CAPTURE_LINES);
    }
  });

  it('reports the alternate screen from the one existing predicate', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(resolveCaptureSpec(id).usesAlternateScreen).toBe(usesAlternateScreen(id));
    }
  });

  it('keeps GEMINI_PANE_HEIGHT importable from the tool module it moved out of', () => {
    expect(GEMINI_PANE_HEIGHT_REEXPORT).toBe(GEMINI_PANE_HEIGHT);
    expect(GEMINI_PANE_HEIGHT).toBe(200);
  });
});
