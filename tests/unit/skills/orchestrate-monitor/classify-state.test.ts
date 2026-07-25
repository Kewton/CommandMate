import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/classify-state.sh',
);
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function classify(fixture: string): string {
  return execFileSync('bash', [SCRIPT, '--json', path.join(FIXTURES, fixture)], {
    encoding: 'utf8',
  }).trim();
}

describe('classify-state on real capture --json shapes', () => {
  it('NOT_RUNNING when the session is not running', () => {
    expect(classify('not-running.json')).toBe('NOT_RUNNING');
  });

  it('GENERATING on the token-counter anchor (↓ 1.4k tokens)', () => {
    expect(classify('generating-token-anchor.json')).toBe('GENERATING');
  });

  it('GENERATING on a background-agent wait even when isGenerating is false', () => {
    // Faithful to the recipe: the text anchor — not the isGenerating field —
    // is the reliable "still busy" signal.
    expect(classify('generating-bg-agent.json')).toBe('GENERATING');
  });

  it('IDLE on the completion summary (must not match `Brewed for 8m 55s`)', () => {
    // Anchor trap: `[0-9]+m [0-9]+s` would match the summary line and pin a
    // finished session as generating forever; `↓ [0-9]` avoids it. The `↑`
    // token line must not be read as the `↓` anchor either.
    expect(classify('idle-brewed-summary.json')).toBe('IDLE');
  });

  it('PROMPT on a yes/no approval prompt (isPromptWaiting=true)', () => {
    expect(classify('prompt-yes-no.json')).toBe('PROMPT');
  });

  it('PROMPT on AskUserQuestion even when isPromptWaiting=false', () => {
    // `❯ 1. Submit answers` is not flagged as isPromptWaiting by the product,
    // so a text-marker check is required or the blocked question reads as idle.
    expect(classify('prompt-submit-answers.json')).toBe('PROMPT');
  });

  it('RATE_LIMIT on a usage-limit banner', () => {
    expect(classify('rate-limit.json')).toBe('RATE_LIMIT');
  });
});

// Issue #1522. Every fixture below is a raw `capture --json` payload with its
// ANSI intact (see fixture-fidelity.test.ts). Each one is IDLE or RATE_LIMIT
// under the pre-#1522 implementation — verified by classifying them with
// `git show HEAD~:...` — which is why this whole skill mis-supervised every
// worker it was used on while its unit tests stayed green.
describe('classify-state on live ANSI captures (Issue #1522)', () => {
  it('GENERATING when ANSI splits the token counter (↓<reset> 14.9k tokens)', () => {
    // Defect 1: the live TUI emits the arrow, a colour reset, then the count, so
    // `↓ [0-9]` grepped over the raw JSON never matched and every generating
    // worker was reported IDLE / NOT_STARTED.
    expect(classify('live-generating-token.json')).toBe('GENERATING');
  });

  it('GENERATING before the first token, on the `esc to interrupt` footer', () => {
    // Defect 2: `✳ Cascading… (19s)` has no counter. The footer hint is shown
    // only while a turn runs (idle shows `? for shortcuts`), so it detects a
    // worker that thinks for minutes before emitting anything. The fixture's
    // status fields are the idle-looking ones the product reports for a frame
    // that stopped changing, so it cannot pass by reading isGenerating.
    expect(classify('live-generating-pre-token.json')).toBe('GENERATING');
  });

  it('GENERATING during the CLI’s own 5xx backoff, never RATE_LIMIT', () => {
    // Defect 3: `529 Overloaded · Retrying in 4s · attempt 7/10` is a *live*
    // session. Intervening queues the keystroke instead of resuming — the
    // fixture still carries the real `❯ a` / `Press up to edit queued messages`
    // artefact from the production incident.
    expect(classify('live-retrying-529.json')).toBe('GENERATING');
  });

  it('IDLE once the retries are exhausted, despite `attempt 10/10` on screen', () => {
    // Defect 4: the stale retry line must not read as alive, or the resend path
    // in monitor.sh can never fire. The footer flipping to `? for shortcuts` is
    // what separates the two.
    expect(classify('live-api-error-exhausted.json')).toBe('IDLE');
  });

  it('GENERATING when the task text in scrollback mentions rate limits', () => {
    // Defect 5, as it actually happened: `content` is the delta since
    // lastCapturedLine, so the loop's first poll returned the whole buffer
    // including the task text — which contained the identifier
    // `ml_has_rate_limit`. The old bare `rate.?limit` anchor matched it and the
    // loop sent `a` to two healthy workers. Same pane as the fixture above; only
    // the scrollback differs.
    expect(classify('live-generating-task-text-scrollback.json')).toBe('GENERATING');
  });

  it('GENERATING when the pane itself shows rate-limiter source', () => {
    // Defect 5, ordering half: a real usage limit stops the turn, so banner-ish
    // text on a still-generating frame is something the worker is reading. This
    // fails if RATE_LIMIT is ever moved back ahead of GENERATING.
    expect(classify('live-generating-rate-limit-source.json')).toBe('GENERATING');
  });

  it('IDLE — not RATE_LIMIT — when an idle pane shows rate-limiter source', () => {
    // Defect 5, anchor half: no GENERATING branch can rescue an idle frame, so
    // this fails unless the anchor is limited to product banner wording. The
    // pane carries `rate-limit`, `RATE_LIMIT`, `rateLimit` and
    // `ml_has_rate_limit`, but no banner text.
    expect(classify('live-idle-rate-limit-source.json')).toBe('IDLE');
  });

  it('IDLE on a genuinely idle live pane (`? for shortcuts` footer)', () => {
    expect(classify('live-idle.json')).toBe('IDLE');
  });
});
