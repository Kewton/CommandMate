/** @vitest-environment node */

/**
 * Issue #2768: the payload has to publish rows an operator can actually read.
 *
 * `realtimeSnippet` was `lines.slice(-100)` of a 200x1000 pane. An inline tool
 * (codex / antigravity / Command Code / gemini / vibe-local) paints from the TOP
 * of that canvas, so a young session's last 100 rows are 100 empty strings —
 * measured on a live Command Code pane whose content ended at row 173.
 *
 * Unit coverage of the window itself is in `realtime-snippet-2768.test.ts`.
 * These two run it through the real `buildCurrentOutput`, because the field the
 * readers branch on is the one on the payload: #1839's `upstreamFault` is judged
 * on exactly these rows (`current-output-builder.ts`), so on a top-anchored pane
 * the banner was not merely hard to see — it could not be detected at all.
 *
 * The scaffold (how `captureSessionOutput` is mocked) follows
 * `current-output-pane-obstruction-2095.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: () => ({ isRunning }) }) },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => null),
  buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
    `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => false),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { resetUnclassifiedFrameTracking } from '@/lib/detection/unclassified-frame-tracker';

/** The Plan-review screen the Issue measured, as it sits on a 200x1000 pane. */
const CONTENT = [
  '─'.repeat(200),
  '',
  'Plan review: sample · ~/.commandcode/plans/sample.md · v1',
  '   1   # sample',
  '',
  ' REVIEW ',
  'Approve ctrl+a   executes the plan',
  'Cancel esc',
  '',
  'type + enter to comment',
];

/** Verbatim from `wait-upstream-fault-1839.test.ts` — Claude 2.1.236 on a 529 storm. */
const UPSTREAM_FAULT_BANNER =
  '⏺ API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.';

/** `rows`, then blank rows up to the pane's 1000: content clings to the top. */
const topAnchoredFrame = (rows: readonly string[]): string =>
  [...rows, ...Array.from({ length: 1000 - rows.length }, () => '')].join('\n');

const capture = (cliToolId: CLIToolType = 'command-code') =>
  buildCurrentOutput({} as Database.Database, 'wt-2768', cliToolId);

beforeEach(() => {
  vi.clearAllMocks();
  isRunning.mockResolvedValue(true);
  resetUnclassifiedFrameTracking();
});

describe('top-anchored panes publish readable rows (Issue #2768)', () => {
  it('ends `realtimeSnippet` on the footer the pane actually shows', async () => {
    const frame = topAnchoredFrame(CONTENT);
    // The premise: the old window (`lines.slice(-100)`) was 100 empty strings.
    expect(frame.split('\n').slice(-100).join('').trim()).toBe('');
    vi.mocked(captureSessionOutput).mockResolvedValue(frame);

    const payload = await capture();

    expect((payload.realtimeSnippet ?? '').split('\n').at(-1)).toBe('type + enter to comment');
  });

  it('detects the upstream-fault banner #1839 judges on these very rows', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(
      topAnchoredFrame([...CONTENT, UPSTREAM_FAULT_BANNER]),
    );

    const payload = await capture();

    expect(payload.upstreamFault).not.toBeNull();
  });
});
