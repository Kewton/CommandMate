/** @vitest-environment node */

/**
 * Issue #2095: the sidebar finding has to leave the detector.
 *
 * Matching a frame in `lib/detection/opencode-pane-obstruction` is not the
 * deliverable. An operator triaging "this worktree has been running for an hour"
 * reads `capture --json`, and the history row written after the 60 s dwell is
 * where a UI user meets the same fact — so these run the real detection module
 * through `buildCurrentOutput` against the frames Issue #2046 captured from a
 * live opencode 1.18.22 (`tests/fixtures/opencode-live-2046/README.md`).
 *
 * The two frames are the same session one `ctrl+x b` apart. Everything that
 * differs between the assertions below differs because of that keystroke.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
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

import { createMessage } from '@/lib/db';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { resetUnclassifiedFrameTracking } from '@/lib/detection/unclassified-frame-tracker';
import { OPENCODE_SIDEBAR_RECOVERY_CHORD } from '@/lib/detection/opencode-pane-obstruction';

const FIXTURES = path.resolve(__dirname, '../../fixtures/opencode-live-2046/w80');
const frame = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

const capture = (cliToolId: CLIToolType = 'opencode') =>
  buildCurrentOutput({} as Database.Database, 'wt-2095', cliToolId);

beforeEach(() => {
  vi.clearAllMocks();
  isRunning.mockResolvedValue(true);
  resetUnclassifiedFrameTracking();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('capture payload exposes the sidebar (Issue #2095)', () => {
  it('publishes the obstruction on the frame `ctrl+x b` produced', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('sidebar-on'));

    const payload = await capture();

    expect(payload.paneObstruction).not.toBeNull();
    expect(payload.paneObstruction?.id).toBe('opencode_sidebar');
    expect(payload.paneObstruction?.at).toBeGreaterThan(0);
    // The excerpt is the second column's own text on the first box row inside
    // the 100 rows the payload publishes — which on this fixture is the
    // sidebar's FOOTER, not its title. Over the whole capture the same detector
    // answers `OK2046` (the session title, asserted in
    // `detection-opencode-pane-obstruction-2095.test.ts`). Both are the sidebar;
    // `id` is what says so, and nothing may branch on this text.
    expect(payload.paneObstruction?.matchedText).toBe('/private/tmp/claude-501/-Users-');
    expect(payload.realtimeSnippet).toContain(payload.paneObstruction?.matchedText ?? '');
  });

  it('publishes null — explicitly, as a key — on the same session one keystroke earlier', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('sidebar-off'));

    const payload = await capture();

    expect(payload.paneObstruction).toBeNull();
    // A missing key would read as "this server is too old to know", which is a
    // different statement from "this server looked and found nothing".
    const serialized = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect('paneObstruction' in serialized).toBe(true);
  });

  it('publishes null on a session that is not running', async () => {
    isRunning.mockResolvedValue(false);

    const payload = await capture();

    expect(payload.isRunning).toBe(false);
    expect(payload.paneObstruction).toBeNull();
  });

  it('reports it next to the very `running` / `unknown_frame` that stalls the wait', async () => {
    // The whole point: this is a payload whose verdict says "still working" for
    // a turn that finished. Both facts have to be on the same object, because a
    // caller that has one without the other is exactly where #2095 started.
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('sidebar-on'));

    const payload = await capture();

    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe('unknown_frame');
    expect(payload.isUnclassifiedActive).toBe(true);
    expect(payload.paneObstruction?.id).toBe('opencode_sidebar');
  });

  it('leaves `sidebar-off`’s verdicts exactly where #2046 measured them', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('sidebar-off'));

    const payload = await capture();

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('opencode_response_complete');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

describe('no other tool is examined (Issue #2095)', () => {
  it('publishes null for claude on the identical bytes that raise it for opencode', async () => {
    // The acceptance condition "no other tool's detection changes", stated where
    // it can actually fail. The gate is the tool id, not the frame — so the
    // strongest test is the SAME frame under a different tool.
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('sidebar-on'));

    const asOpencode = await capture('opencode');
    const asClaude = await capture('claude');

    expect(asOpencode.paneObstruction?.id).toBe('opencode_sidebar');
    expect(asClaude.paneObstruction).toBeNull();
  });
});

describe('the history row names the cause and the key (Issue #2095)', () => {
  /** Hold the same unclassified frame past the 60 s dwell #1708 set. */
  async function dwellPastRecordThreshold(fixture: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
    vi.mocked(captureSessionOutput).mockResolvedValue(frame(fixture));

    await capture(); // opens the run
    vi.setSystemTime(new Date('2026-08-27T00:01:01Z'));
    await capture(); // 61 s later: past UNCLASSIFIED_RECORD_DWELL_MS
  }

  it('appends the sidebar and `ctrl+x b` to the "could not parse it" row', async () => {
    await dwellPastRecordThreshold('sidebar-on');

    const written = vi.mocked(createMessage).mock.calls.map((c) => String(c[1].content));
    const row = written.find((c) => c.includes('Unclassified interactive frame'));

    expect(row).toBeDefined();
    // #1708's wording is untouched — a caller matching on it keeps matching.
    expect(row).toContain('The detection layer could not parse it');
    // …and #2095's answer to "why" is appended to it.
    expect(row).toContain('paneObstruction=opencode_sidebar');
    expect(row).toContain("opencode's sidebar is sharing rows with the transcript");
    expect(row).toContain(OPENCODE_SIDEBAR_RECOVERY_CHORD);
    expect(OPENCODE_SIDEBAR_RECOVERY_CHORD).toBe('ctrl+x b');
  });

  it('writes the #1708 row unchanged when the frame carries no obstruction', async () => {
    // The control that keeps the append honest: an unclassified frame with no
    // second column must produce the row exactly as it was before this Issue.
    await dwellPastRecordThreshold('home-leader-b-fallthrough');

    const written = vi.mocked(createMessage).mock.calls.map((c) => String(c[1].content));
    const row = written.find((c) => c.includes('Unclassified interactive frame'));

    expect(row).toBeDefined();
    expect(row).not.toContain('paneObstruction');
    expect(row).not.toContain(OPENCODE_SIDEBAR_RECOVERY_CHORD);
    expect(row?.endsWith('--pane`.')).toBe(true);
  });
});
