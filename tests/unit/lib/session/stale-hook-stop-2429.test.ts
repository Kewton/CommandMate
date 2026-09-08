/**
 * A structured `ready` does not outlive the prompt it was never told about
 * (Issue #2429).
 *
 * ## The defect, as it was measured
 *
 * `mergeStructuredStatus` prefers the agent's own account of what it is doing
 * to the screen scrape (#1723), and until this Issue the only thing that could
 * overturn it was a scraper `waiting` (#1708). That holds for every tool that
 * can say when a turn BEGINS: claude, codex, copilot, gemini and antigravity
 * all post a turn-opening event, so the previous turn's `ready / hook_stop` is
 * replaced before the first generating frame of the next turn is ever read.
 *
 * Command Code posts neither half. Its loader validates event names against a
 * closed list — `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` — so
 * `UserPromptSubmit` cannot fire even if it is configured, and a turn that calls
 * no tool produces no `PreToolUse` either. Measured on 2026-09-08 against a 19 s
 * turn on v1.49.0, `GET /current-output` answered `ready / hook_stop` from 4 s
 * to 18 s while the status row read `esc to interrupt`. `commandmate wait`
 * reads that field rather than the frame for "is at its composer", so the only
 * thing between a long turn and a completion reported before the reply existed
 * was #1975's 60 s unanswered-prompt hold — which a turn over 60 s outlives.
 *
 * ## What is pinned here
 *
 * The precedence table, and both directions of it. The `running` the scraper
 * wins is taken off a REAL Command Code capture rather than a hand-written
 * verdict (`turn-shell-running-1490.txt`, the frame whose status row carries
 * `esc to interrupt`), so a change that stopped `COMMAND_CODE_THINKING_PATTERN`
 * matching it would fail here and not merely somewhere in the detector suite.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectSessionStatus,
  isGeneratingStatus,
  STATUS_REASON,
} from '@/lib/detection/status-detector';
import { mergeStructuredStatus, type ScraperVerdict } from '@/lib/session/current-output-builder';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';
import type { StructuredSessionState } from '@/lib/session/agent-event-state';
import type { PublishedTurn } from '@/lib/session/provisional-turn';
import { HOOK_STATUS_REASON } from '@/lib/session/status-mapping';

const LIVE_FIXTURES = path.resolve(__dirname, '../../../fixtures/command-code-live-2250');

/** The scraper's verdict for a live capture, exactly as `buildPayload` builds it. */
function scraperVerdictOf(fixture: string): ScraperVerdict {
  const raw = readFileSync(path.join(LIVE_FIXTURES, fixture), 'utf-8');
  const result = detectSessionStatus(raw, 'command-code');
  return {
    status: result.status,
    reason: result.reason,
    thinking: isGeneratingStatus({ status: result.status, reason: result.reason }),
    evidence: result.evidence,
    isUnclassifiedActive: isUnclassifiedFrame(result.status, result.reason),
  };
}

const SENT_AT = 1_788_848_400_000;

/** The previous turn's close, `msBefore` ms before the newest prompt. */
function closedStopTurn(msBefore: number, openedAt: number | null = null): PublishedTurn {
  return {
    turnId: 'turn-1788848348327-5',
    openedAt,
    closedAt: SENT_AT - msBefore,
    closedBy: 'stop',
  };
}

const HOOK_READY: StructuredSessionState = {
  status: 'ready',
  reason: HOOK_STATUS_REASON.STOP,
  event: 'stop',
  at: SENT_AT - 60_000,
  detail: null,
};

describe('[#2429] the generating frame beats a Stop older than the newest prompt', () => {
  it('reads the live `esc to interrupt` capture as positively generating', () => {
    // The premise of the whole rule. If this ever stops holding, every
    // assertion below would pass vacuously.
    const scraper = scraperVerdictOf('turn-shell-running-1490.txt');
    expect(scraper.status).toBe('running');
    expect(scraper.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(scraper.thinking).toBe(true);
  });

  it('publishes the scraper `running` when the Stop predates the send', () => {
    const scraper = scraperVerdictOf('turn-shell-running-1490.txt');
    const merged = mergeStructuredStatus(scraper, HOOK_READY, null, closedStopTurn(60_000), SENT_AT);

    expect(merged.status).toBe('running');
    expect(merged.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(merged.structuredApplied).toBe(false);
  });

  it('applies with no `openedAt` at all — the Command Code shape', () => {
    // `hookClosedTurn` (#2011) additionally requires `closedAt > openedAt`, and
    // requiring that here would exclude exactly the case this Issue is about: a
    // tool-less Command Code turn has no opening event, so `recordAgentEvent`
    // publishes `openedAt: null`. Pinned in both spellings so a future edit
    // cannot quietly fold this rule into that one.
    const scraper = scraperVerdictOf('turn-shell-running-1490.txt');

    for (const openedAt of [null, SENT_AT - 120_000]) {
      const merged = mergeStructuredStatus(
        scraper,
        HOOK_READY,
        null,
        closedStopTurn(60_000, openedAt),
        SENT_AT,
      );
      expect(merged.structuredApplied).toBe(false);
      expect(merged.status).toBe('running');
    }
  });

  it('carries the scraper frame facts through untouched', () => {
    // Issue #2011's rule survives: what the merge knows about the TURN says
    // nothing about whether this FRAME could be read.
    const scraper = scraperVerdictOf('turn-shell-running-1490.txt');
    const merged = mergeStructuredStatus(scraper, HOOK_READY, null, closedStopTurn(60_000), SENT_AT);

    expect(merged.evidence).toBe(scraper.evidence);
    expect(merged.isUnclassifiedActive).toBe(scraper.isUnclassifiedActive);
    expect(merged.thinking).toBe(true);
  });
});

describe('[#2429] every other combination keeps the structured verdict', () => {
  const generating = () => scraperVerdictOf('turn-shell-running-1490.txt');

  it('keeps `ready` when the Stop POSTDATES the send (the fast-turn case)', () => {
    // The agent answered and said so; a spinner still painted on the frame is a
    // repaint that has not settled, not work in flight. This is the same
    // comparison `wait`'s `outstandingPrompt` makes, and it must answer the
    // same way.
    const turn: PublishedTurn = { ...closedStopTurn(0), closedAt: SENT_AT + 5_000 };
    const merged = mergeStructuredStatus(generating(), HOOK_READY, null, turn, SENT_AT);

    expect(merged.status).toBe('ready');
    expect(merged.reason).toBe(HOOK_STATUS_REASON.STOP);
    expect(merged.structuredApplied).toBe(true);
  });

  it('keeps `ready` when the ledger could not be read', () => {
    // An unreadable ledger is not evidence that nothing was sent — the position
    // `wait` takes on the same read — so null leaves the pre-#2429 precedence
    // exactly as it was.
    const merged = mergeStructuredStatus(
      generating(),
      HOOK_READY,
      null,
      closedStopTurn(60_000),
      null,
    );

    expect(merged.status).toBe('ready');
    expect(merged.structuredApplied).toBe(true);
  });

  it('keeps `ready` on a frame that is merely not changing', () => {
    // The one that would have re-opened #1975. A `no_recent_output` /
    // `unknown_frame` floor is also `running`, and neither is evidence of
    // anything — only `isGeneratingStatus` is, which is what `thinking` carries.
    const floor: ScraperVerdict = {
      status: 'running',
      reason: STATUS_REASON.NO_RECENT_OUTPUT,
      thinking: false,
      evidence: 'none',
      isUnclassifiedActive: true,
    };
    const merged = mergeStructuredStatus(floor, HOOK_READY, null, closedStopTurn(60_000), SENT_AT);

    expect(merged.status).toBe('ready');
    expect(merged.structuredApplied).toBe(true);
  });

  it('keeps a structured `running` — the claude / codex path is untouched', () => {
    // These tools open the turn with `user_prompt_submit`, so the structured
    // layer already says `running` and there is no stale `ready` to expire.
    const running: StructuredSessionState = {
      status: 'running',
      reason: HOOK_STATUS_REASON.PROMPT_SUBMIT,
      event: 'user_prompt_submit',
      at: SENT_AT,
      detail: null,
    };
    const merged = mergeStructuredStatus(
      generating(),
      running,
      null,
      { turnId: 't-1', openedAt: SENT_AT, closedAt: null, closedBy: null },
      SENT_AT,
    );

    expect(merged.status).toBe('running');
    expect(merged.reason).toBe(HOOK_STATUS_REASON.PROMPT_SUBMIT);
    expect(merged.structuredApplied).toBe(true);
  });

  it('leaves #1708 alone: a scraper `waiting` still wins outright', () => {
    const waiting: ScraperVerdict = {
      status: 'waiting',
      reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
      thinking: false,
      evidence: 'positive',
      isUnclassifiedActive: false,
    };
    const merged = mergeStructuredStatus(waiting, HOOK_READY, null, closedStopTurn(60_000), SENT_AT);

    expect(merged.status).toBe('waiting');
    expect(merged.structuredApplied).toBe(false);
  });

  it('does not expire a `ready` the agent did not close with a Stop', () => {
    // `closedBy` is the whole discriminator between the agent's own word and
    // this server's inference. A close the SCREEN inferred cannot be measured
    // against a send: it never claimed to be about one.
    const inferred: PublishedTurn = { ...closedStopTurn(60_000), closedBy: 'scraper_evidence' };
    const merged = mergeStructuredStatus(generating(), HOOK_READY, null, inferred, SENT_AT);

    expect(merged.status).toBe('ready');
    expect(merged.structuredApplied).toBe(true);
  });
});
