/**
 * Seven tools, one real dialog and one quotation of it each (Issue #3183).
 *
 * The status side of the acceptance criteria: a live dialog is `waiting`, and
 * the same wording quoted in the conversation with the input box under it is
 * `ready` with `hasActivePrompt: false`. The Auto-Yes side of the same 14
 * frames is `tests/unit/lib/polling/auto-yes-live-region-3183.test.ts`.
 *
 * The pairs are listed in `docs/design/3183-live-region-extraction.md` §4.2.
 * Three negatives are composed (antigravity / command-code / copilot have no
 * live capture of a quoted dialog); how is recorded in
 * `tests/fixtures/live-region-3183/README.md`.
 *
 * And §4.3's mutations, so the green is not vacuous: take the input box away
 * from a negative and it must stop reading as idle; put an input box under a
 * positive and it must stop reading as a dialog.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

export interface QuotedDialogPair {
  tool: CLIToolType;
  /** A real dialog. */
  positive: string;
  /** The dialog's wording in the conversation, the input box under it. */
  negative: string;
  /** `hasActivePrompt` the real dialog publishes (keys surfaces publish false). */
  positiveHasActivePrompt: boolean;
}

export const QUOTED_DIALOG_PAIRS: readonly QuotedDialogPair[] = [
  {
    tool: 'claude',
    positive: 'tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt',
    negative: 'tests/fixtures/claude-idle-numbered-list-2457/live-2997/claude-reply-numbered-list-21284.txt',
    positiveHasActivePrompt: true,
  },
  {
    tool: 'codex',
    positive: 'tests/fixtures/codex-dialogs-0157/approval.txt',
    negative: 'tests/fixtures/codex-dialogs-0157/quoted-approval-idle.txt',
    positiveHasActivePrompt: true,
  },
  {
    tool: 'antigravity',
    positive: 'tests/fixtures/antigravity-live-2364/dialog-bash-oneline.txt',
    negative: 'tests/fixtures/live-region-3183/quoted-dialog-idle-antigravity.txt',
    positiveHasActivePrompt: true,
  },
  {
    tool: 'command-code',
    positive: 'tests/fixtures/command-code-live-2250/dialog-shell-command.txt',
    negative: 'tests/fixtures/live-region-3183/quoted-dialog-idle-command-code.txt',
    positiveHasActivePrompt: true,
  },
  {
    tool: 'copilot',
    positive: 'tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt',
    negative: 'tests/fixtures/live-region-3183/quoted-dialog-idle-copilot.txt',
    positiveHasActivePrompt: true,
  },
  {
    tool: 'opencode',
    // The approval strip takes ←/→ + Enter (`keys`): `waiting`, but not a
    // prompt to type into — every opencode v1 dialog is (design doc §6 item 1).
    positive: 'tests/unit/lib/detection/fixtures/opencode-live-1893/permission-bash.txt',
    negative: 'tests/fixtures/opencode-agent-health-3021/quoted-dialog-reply-done.txt',
    positiveHasActivePrompt: false,
  },
  {
    tool: 'opencode-v2',
    // The question form: numbered, and drawn in place of the composer.
    positive: 'tests/fixtures/opencode-v2-dialogs-2984/question.txt',
    negative: 'tests/fixtures/opencode-v2-dialogs-2984/quoted-dialog-reply.txt',
    positiveHasActivePrompt: false,
  },
];

describe('[#3183] a real dialog is waiting; its quotation above the input box is ready', () => {
  it('covers the seven tools the Issue names', () => {
    expect(QUOTED_DIALOG_PAIRS.map(pair => pair.tool).sort()).toEqual(
      ['antigravity', 'claude', 'codex', 'command-code', 'copilot', 'opencode', 'opencode-v2'].sort(),
    );
  });

  describe.each(QUOTED_DIALOG_PAIRS)('$tool', ({ tool, positive, negative, positiveHasActivePrompt }) => {
    it('positive: the real dialog is waiting', () => {
      const result = detectSessionStatus(read(positive), tool);
      expect(result.status).toBe('waiting');
      expect(result.hasActivePrompt).toBe(positiveHasActivePrompt);
      expect(normalizeFrame(read(positive), tool).liveRegion.composerAtBottom).toBe(false);
    });

    it('negative: the quotation with the input box under it is ready, with no active prompt', () => {
      const result = detectSessionStatus(read(negative), tool);
      expect(result.status).toBe('ready');
      expect(result.hasActivePrompt).toBe(false);
      expect(result.promptDetection.isPrompt).toBe(false);
      const region = normalizeFrame(read(negative), tool).liveRegion;
      expect(region.anchor).toBe('composer');
      expect(region.composerAtBottom).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// §4.3 mutations
// ---------------------------------------------------------------------------

/**
 * Blank the input box block the live region found (keeping the row count), so
 * the quotation becomes the bottom of the pane. Rows are matched by text on the
 * raw capture, row for row — `normalizeFrame` maps them one to one up to blank
 * compaction, so the block is identified on the normalised rows and removed
 * from the raw ones by content.
 */
export function withoutComposer(raw: string, tool: CLIToolType): string {
  const frame = normalizeFrame(raw, tool);
  const region = frame.liveRegion;
  if (region.anchor !== 'composer') throw new Error(`${tool}: no composer to remove`);
  const block = frame.contentLines.slice(region.startRow).map(row => row.trim()).filter(Boolean);
  const rows = raw.split('\n');
  let last = rows.length - 1;
  // Walk the raw rows bottom-up and blank every row of the block.
  let pending = block.length;
  for (let i = last; i >= 0 && pending > 0; i--) {
    const text = stripAnsi(rows[i]).trim();
    if (text === '') continue;
    if (text === block[pending - 1]) {
      rows[i] = '';
      pending--;
      last = i;
    } else {
      throw new Error(`${tool}: raw row ${i} (${text}) is not the composer block's row ${block[pending - 1]}`);
    }
  }
  if (pending > 0) throw new Error(`${tool}: composer block not found in the raw capture`);
  return rows.join('\n');
}

/** Copy the negative's input box block under the positive's last row (keeping nothing else). */
export function withComposerFrom(positiveRaw: string, negativeRaw: string, tool: CLIToolType): string {
  const negative = normalizeFrame(negativeRaw, tool);
  if (negative.liveRegion.anchor !== 'composer') throw new Error(`${tool}: negative has no composer`);
  const block = negativeRaw.split('\n').filter(row => stripAnsi(row).trim() !== '');
  const blockRows = negative.contentLines.length - negative.liveRegion.startRow;
  return `${positiveRaw.replace(/\s+$/, '')}\n\n${block.slice(-blockRows).join('\n')}\n`;
}

/**
 * The tools whose quotation is told apart BY the live region alone.
 *
 * For claude / codex / command-code / copilot the generic parser also stops at
 * the input box's own glyph (`❯` / `›`, #287's barrier), so taking the box
 * away removes two defences at once and the frame's verdict then rests on
 * other rules; their mutation is the composer-under-the-dialog half below.
 * antigravity's `>` is not one of those glyphs — which is how #2851 reached
 * Auto-Yes — so for it the live region is the only defence, and removing the
 * box must turn the quotation into a dialog.
 */
const COMPOSER_ONLY_DEFENCE: readonly CLIToolType[] = ['antigravity'];

describe('[#3183] mutation: the input box is what makes the quotation a quotation', () => {
  it.each(COMPOSER_ONLY_DEFENCE)('%s: without the input box, the quoted dialog reads as waiting', tool => {
    const pair = QUOTED_DIALOG_PAIRS.find(p => p.tool === tool)!;
    const mutated = withoutComposer(read(pair.negative), tool);
    expect(normalizeFrame(mutated, tool).liveRegion.composerAtBottom).toBe(false);
    const result = detectSessionStatus(mutated, tool);
    expect(result.status).toBe('waiting');
    expect(result.hasActivePrompt).toBe(true);
  });

  it.each(['claude', 'codex', 'antigravity', 'command-code'] as const)(
    '%s: an input box drawn under the real dialog makes it a quotation (no longer an active prompt)',
    tool => {
      const pair = QUOTED_DIALOG_PAIRS.find(p => p.tool === tool)!;
      const mutated = withComposerFrom(read(pair.positive), read(pair.negative), tool);
      const region = normalizeFrame(mutated, tool).liveRegion;
      expect(region.anchor).toBe('composer');
      expect(region.composerAtBottom).toBe(true);
      const result = detectSessionStatus(mutated, tool);
      expect(result.hasActivePrompt).toBe(false);
      expect(result.status).not.toBe('waiting');
    },
  );
});
