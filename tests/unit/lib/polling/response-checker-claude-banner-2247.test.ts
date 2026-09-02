/**
 * Issue #2247 — the Claude startup-banner guard must not eat ordinary replies.
 *
 * `extractResponse` has carried a "skip the Claude Code startup screen" branch
 * since 787f7401 (2026-03-29). It fired on any extraction shorter than 2000
 * characters that contained one of four anchors, and two of those anchors are
 * things a REPLY says just as readily as a banner:
 *
 *  - `hasVersionInfo` was `/Claude Code|claude\/|v\d+\.\d+/`. The bare
 *    `v\d+\.\d+` matches every version string a reply mentions;
 *  - `hasBannerArt` included `│`, which is the glyph Claude Code draws markdown
 *    TABLES with.
 *
 * Measured on 2026-09-02 (`mycodebranchdesk`, `claude-2`): a finished reply
 * reading "GitHub Release v0.30.0 を公開しました …" (148 chars) was reported
 * `isComplete: false` on every 2-second poll for eleven minutes, and the branch
 * logged nothing, so `response-poller` was silent for the whole window. The turn
 * was never saved.
 *
 * The fix is the shape #1897 gave copilot: the banner anchors are only evidence
 * on a pane that has not had a single turn yet. Claude echoes every prompt into
 * the transcript as `❯ <text>`; the startup screen has none.
 *
 * The frames are `tests/fixtures/claude-live-2247` — one live Claude Code
 * v2.1.258 session at 200x1000, raw ANSI, captured turn by turn. See its
 * README.md for the provenance and the pre-fix measurements.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Built inside vi.hoisted() rather than from tests/helpers/logger-mock:
// `@/lib/logger` is pulled in transitively by `cli-patterns` while the hoisted
// vi.mock factory runs, so a plain `const` above the factory is still in the
// temporal dead zone by then (same reason as the #1695 suite next door).
const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

// ---------------------------------------------------------------------------
// Module boundary mocks — the same seams the #2047 suite cuts, trimmed to what
// `extractResponse` touches. Nothing here is under test.
// ---------------------------------------------------------------------------

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  createMessage: vi.fn(),
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  getWorktreeById: vi.fn(() => ({ id: 'wt-1', name: 'wt-1' })),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: vi.fn(async () => {}),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));

import { extractResponse } from '@/lib/polling/response-checker';
import { cleanClaudeResponse } from '@/lib/response-cleaner';
import { stripAnsi, findClaudeChromeStart } from '@/lib/detection/cli-patterns';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/claude-live-2247');

const TURN_FRAMES = [
  'turn-github-release',
  'turn-version-v12',
  'turn-table',
  'turn-tip',
] as const;

const ALL_FRAMES = ['boot-banner', ...TURN_FRAMES] as const;

const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');

/** What the poller would write to `chat_messages.content` for this frame. */
const savedReply = (name: string): string | null => {
  const result = extractResponse(frame(name), 0, 'claude', 1000);
  if (!result?.isComplete) return null;
  return cleanClaudeResponse(result.response);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Issue #2247: the fixtures stay raw and at production geometry', () => {
  it.each(ALL_FRAMES)('%s is a 1000-row capture with its escapes intact', (name) => {
    const raw = frame(name);
    expect(raw).toContain('\x1b[');
    expect(raw.split('\n').length).toBeGreaterThan(1000);
  });

  it('keeps the dim ghost suggestion that makes boot-banner a fair negative', () => {
    // The composer row of the startup screen. `ESC[2m` is the ONLY thing that
    // separates it from a transcript echo (#1879), so a fixture normalised to
    // plain text would silently turn this suite into a rubber stamp.
    const composerRow = frame('boot-banner').split('\n')[997];
    expect(composerRow).toContain('\x1b[2m');
    expect(stripAnsi(composerRow)).toMatch(/^[>❯]\s+\S/);
  });
});

describe('Issue #2247: a finished turn is finished, whatever it quotes', () => {
  it('saves the reply from the frame that lost a turn in production', () => {
    const saved = savedReply('turn-github-release');

    expect(saved).not.toBeNull();
    // The body opens with the reply. `⏺` is Claude's own reply bullet, which
    // `cleanClaudeResponse` keeps on purpose (it is how the UI tells an agent
    // message from a tool row); the first thing after it is the answer.
    expect(saved!.split('\n')[0]).toBe(
      '⏺ GitHub Release v0.30.0 を公開しました / 変更点は CHANGELOG を参照してください / 以上です',
    );
    // Length is the point of the defect, not a detail: this is well inside the
    // 2000-character window the banner branch applies to, which is why the
    // previous turn (2374 chars, same version string) survived and this one
    // did not.
    expect(saved!.length).toBeLessThan(2000);
  });

  it('saves a reply whose only banner anchor is a bare version string', () => {
    // `hasVersionInfo`'s old `v\d+\.\d+` alternative, in its shortest form.
    const saved = savedReply('turn-version-v12');

    expect(saved).not.toBeNull();
    expect(saved).toContain('v1.2');
    expect(saved).toContain('タグを打ちました');
  });

  it('saves a reply that is nothing but a markdown table', () => {
    // `hasBannerArt`'s old `│`. Claude Code renders tables with box drawing, so
    // the anchor fired on the reply's own content.
    const saved = savedReply('turn-table');

    expect(saved).not.toBeNull();
    expect(saved).toContain('│');
    expect(saved).toContain('本番');
    expect(saved).toContain('停止');
  });

  it('saves a reply that quotes the startup tips', () => {
    // `hasStartupTips` — `Tip:` and `for shortcuts` at once.
    const saved = savedReply('turn-tip');

    expect(saved).not.toBeNull();
    expect(saved).toContain('Tip: Use /help for shortcuts');
    expect(saved).toContain('これは仕様です');
  });

  it('pins which anchor each frame actually trips, so the fix stays honest', () => {
    // Measured on these frames. If a future edit makes one of these anchors stop
    // matching, the four tests above would still pass while testing nothing —
    // they would be asserting that a branch which no longer fires does not fire.
    const anchorsOf = (name: string) => {
      const region = stripAnsi(extractResponse(frame(name), 0, 'claude', 1000)!.response);
      return {
        art: /[╭╮╰╯│]/.test(region),
        version: /Claude Code|claude\//.test(region) || /v\d+\.\d+/.test(region),
        tips: /Tip:|for shortcuts|\?\s*for help/.test(region),
        short: region.length < 2000,
      };
    };

    expect(anchorsOf('turn-github-release')).toEqual({ art: false, version: true, tips: false, short: true });
    expect(anchorsOf('turn-version-v12')).toEqual({ art: false, version: true, tips: false, short: true });
    expect(anchorsOf('turn-table')).toEqual({ art: true, version: false, tips: false, short: true });
    expect(anchorsOf('turn-tip')).toEqual({ art: false, version: false, tips: true, short: true });
  });
});

/**
 * The one state where the two anchor regexes are still load-bearing, and so the
 * only place their narrowing can be tested.
 *
 * On a pane that HAS an echo the turn guard settles it before the anchors are
 * read. The anchors still decide the case #1289 measured and guarded: a pane
 * whose echoed prompt has scrolled off the top. #1289's own fixture is a
 * 990-row reply, which clears the 2000-character window; a SHORT reply after a
 * long tool run reaches the same state and does not.
 *
 * These frames are assembled, not captured — the live session cannot be made to
 * scroll its echo off in four turns — so they carry only the structure
 * `findClaudeChromeStart` reads, transcribed from the #1289 suite.
 */
const SEPARATOR = '─'.repeat(40);
const STATUS_BAR =
  '  ⏸ manual mode on · ? for shortcuts · ← for agents                       focus';

/** A 1000-row pane holding `reply` and nothing above it but blank scrollback. */
const paneWithEchoScrolledOff = (reply: string[]): string => {
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR];
  const head: string[] = new Array(1000 - reply.length - tail.length).fill('');
  return [...head, ...reply, ...tail].join('\n');
};

describe('Issue #2247: the anchors themselves are banner-specific now', () => {
  it('saves a short reply that mentions a version when the echo has scrolled off', () => {
    // `hasVersionInfo` used to be `/Claude Code|claude\/|v\d+\.\d+/`. With no echo
    // to guard on, that bare alternative is the whole decision.
    const result = extractResponse(
      paneWithEchoScrolledOff(['⏺ Release v1.2 is out']),
      0,
      'claude',
      1000,
    );

    expect(result?.isComplete).toBe(true);
    expect(cleanClaudeResponse(result!.response)).toContain('Release v1.2 is out');
  });

  it('saves a short table when the echo has scrolled off', () => {
    // `hasBannerArt` used to be `/[╭╮╰╯│]/`, and `│` is table drawing.
    const result = extractResponse(
      paneWithEchoScrolledOff([
        '⏺ ┌──────┬──────┐',
        '  │ 環境 │ 状態 │',
        '  └──────┴──────┘',
      ]),
      0,
      'claude',
      1000,
    );

    expect(result?.isComplete).toBe(true);
    expect(cleanClaudeResponse(result!.response)).toContain('│ 環境 │ 状態 │');
  });

  it('still refuses the banner itself when the pane has no echo at all', () => {
    // The other direction, on the same assembled shape: the banner's own version
    // row is `Claude Code v<n>.<n>`, and that must keep matching.
    const result = extractResponse(
      paneWithEchoScrolledOff([
        ' ▐▛███▜▌   Claude Code v2.1.258',
        '▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max',
      ]),
      0,
      'claude',
      1000,
    );

    expect(result?.isComplete).toBe(false);
  });
});

describe('Issue #2247: the startup screen is still not a reply', () => {
  it('reports the banner-only pane incomplete', () => {
    const result = extractResponse(frame('boot-banner'), 0, 'claude', 1000);

    expect(result).not.toBeNull();
    expect(result!.isComplete).toBe(false);
    expect(result!.response).toBe('');
  });

  it('does not count the footer ghost as the pane having had a turn', () => {
    // The load-bearing detail of the fix. `boot-banner.txt` HAS a row matching
    // `/^[>❯]\s+\S/` once the ANSI is gone — the composer's dim suggestion — and
    // it sits below the chrome boundary. An echo scan over the whole pane would
    // therefore call this pane "already had a turn" and save the banner, which
    // is what the test above would catch, but only this one says why.
    const lines = frame('boot-banner').split('\n');
    const chromeStart = findClaudeChromeStart(lines);

    const ghostRows = lines
      .map((line, i) => ({ i, clean: stripAnsi(line) }))
      .filter(({ clean }) => /^[>❯]\s+\S/.test(clean));

    expect(ghostRows.length).toBeGreaterThan(0);
    for (const { i } of ghostRows) {
      expect(i, 'a transcript echo appeared on the startup screen').toBeGreaterThanOrEqual(chromeStart);
    }
  });

  it('logs once when it suppresses the banner, instead of stopping in silence', () => {
    extractResponse(frame('boot-banner'), 0, 'claude', 1000);

    const bannerLogs = mockLogger.info.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('startup banner'),
    );
    expect(bannerLogs).toHaveLength(1);
    expect(bannerLogs[0][1]).toMatchObject({ hasVersionInfo: true });
  });

  it('stays silent on the turns it now lets through', () => {
    for (const name of TURN_FRAMES) {
      mockLogger.info.mockClear();
      extractResponse(frame(name), 0, 'claude', 1000);
      expect(
        mockLogger.info.mock.calls.filter(
          ([message]) => typeof message === 'string' && message.includes('startup banner'),
        ),
        `${name} still went through the banner branch`,
      ).toHaveLength(0);
    }
  });
});
