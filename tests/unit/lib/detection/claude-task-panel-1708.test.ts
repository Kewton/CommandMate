/** @vitest-environment node */

/**
 * Issue #1708: Claude's task panel silently swallowed the prompt underneath it.
 *
 * Every fixture here is a verbatim `tmux capture-pane -p -S -1200` of a live
 * Claude Code 2.1.223 session on a 200x1000 alternate-screen pane — the geometry
 * src/lib/tmux/tmux.ts pins for real worktree sessions, and the reason the bug
 * only ever showed up in production: at 120x40 the panel and the dialog cannot
 * both be on screen, so a small pane never reproduces it.
 *
 * What was broken. The panel is bottom-anchored, so a prompt dialog renders near
 * the top and the panel ~880 blank rows below it. `compactBlankRows` collapses
 * that gap, which drops the panel straight into Pass 2's 50-line reverse-scan
 * window. #704/#807 already handle the case where a footer sits between them and
 * can be trimmed at — but the AskUserQuestion CONFIRMATION step ("Ready to submit
 * your answers?") renders neither the "Esc to cancel · Tab to amend" footer nor
 * the "Enter to select … navigate" one, so nothing trimmed and the panel was the
 * first thing the reverse scan met.
 *
 * Two of its rows matched NORMAL_OPTION_PATTERN *independently* — measured by
 * ablating one line at a time out of askuserquestion-submit-taskpanel.txt:
 *
 *   drop "7 tasks (2 done, 1 in progress, 4 open)"  -> still isPrompt=false
 *   drop "… +2 completed"                           -> still isPrompt=false
 *   drop both                                       -> isPrompt=true, 2 options
 *
 * so fixing either one alone leaves the frame undetected. That is why the guard
 * skips the panel as a BLOCK rather than by wording. (Issue #1708's own text
 * named only the header and predicted the single-line drops would pass; the
 * capture says otherwise, and the capture wins.)
 *
 * Downstream, an undetected frame means `isPromptWaiting: false` — which is the
 * only blocked-on-a-human signal the current-output payload carries — so Auto-Yes,
 * `wait --on-prompt agent` and the contract's autoYes policy all stayed silent
 * while the worker sat stopped until its 900s timeout.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { findClaudeTaskPanelLines } from '@/lib/detection/prompt-detect-multiple-choice';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/claude-live-1708/', import.meta.url));

function frame(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}.txt`, 'utf8');
}

/** The pipeline status-detector runs before handing a frame to detectPrompt. */
function detect(raw: string) {
  return detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions('claude'));
}

function labels(raw: string): string[] {
  const promptData = detect(raw).promptData;
  if (promptData?.type !== 'multiple_choice') return [];
  return promptData.options.map(o => o.label);
}

describe('Issue #1708: a task panel below the prompt must not hide it', () => {
  it('detects the AskUserQuestion confirmation that the panel used to swallow', () => {
    const raw = frame('askuserquestion-submit-taskpanel');

    // The frame really does carry both poison lines and neither trim footer —
    // if Claude ever changes that, this test would pass for the wrong reason.
    expect(raw).toContain('7 tasks (2 done, 1 in progress, 4 open)');
    expect(raw).toContain('… +2 completed');
    expect(raw).not.toMatch(/Esc\s+to\s+cancel\s*[·•]\s*Tab\s+to\s+amend/i);
    expect(raw).not.toMatch(/Enter\s+to\s+select\b.*\bnavigate\b/i);

    const result = detect(raw);
    expect(result.isPrompt).toBe(true);
    expect(result.promptData?.type).toBe('multiple_choice');
    expect(labels(raw)).toEqual(['Submit answers', 'Cancel']);
  });

  it('publishes that frame as blocked-on-a-human, not as ready for input', () => {
    // The exact triple Issue #1708 reported from the live server:
    // sessionStatus=ready / reason=input_prompt / isPromptWaiting=false.
    const status = detectSessionStatus(frame('askuserquestion-submit-taskpanel'), 'claude');
    expect(status.hasActivePrompt).toBe(true);
    expect(status.status).toBe('waiting');
    expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
  });

  it('collects no phantom option when the task count equals options + 1', () => {
    // Issue #1708 calls this out as the nastiest variant: with "3 tasks" and two
    // real options the numbers DO line up consecutively, so detection succeeds
    // while smuggling the panel header in as option 3 — and Auto-Yes would then
    // be able to answer a choice the user never saw.
    const raw = frame('askuserquestion-submit-taskpanel').replace('7 tasks (2 done', '3 tasks (2 done');
    expect(labels(raw)).toEqual(['Submit answers', 'Cancel']);
  });

  it('keeps the permission dialog detected when a panel sits below its footer', () => {
    // Same panel, but this frame HAS the "Esc to cancel · Tab to amend" footer,
    // so #704's effectiveEnd trim already excluded the panel. Guards the fix
    // against regressing the path that was working.
    const raw = frame('bash-approval-taskpanel');
    const result = detect(raw);
    expect(result.isPrompt).toBe(true);
    expect(labels(raw)).toEqual([
      'Yes',
      'Yes, and always allow access to tmp/ from this project',
      'No',
    ]);
  });

  it('still reports an idle session with a task panel as ready, not as a prompt', () => {
    // The other direction: skipping panel rows lets the reverse scan travel
    // further up the frame, so an idle session must not start false-positiving.
    // The composer barrier (#287) is what stops it, and it must keep stopping it.
    const raw = frame('idle-taskpanel');
    expect(raw).toContain('7 tasks (2 done, 1 in progress, 4 open)');

    expect(detect(raw).isPrompt).toBe(false);
    const status = detectSessionStatus(raw, 'claude');
    expect(status.hasActivePrompt).toBe(false);
    expect(status.status).toBe('ready');
    expect(status.reason).toBe(STATUS_REASON.INPUT_PROMPT);
  });
});

describe('Issue #1708: findClaudeTaskPanelLines block extent', () => {
  it('claims the header, its rows and the collapsed summary — and stops there', () => {
    const lines = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '',
      '  7 tasks (2 done, 1 in progress, 4 open)',
      '  ◼ Phase 3',
      '  ◻ Phase 4',
      '   … +2 completed',
      '❯ composer text',
    ];
    expect([...findClaudeTaskPanelLines(lines, 0, lines.length)].sort((a, b) => a - b)).toEqual([
      4, 5, 6, 7,
    ]);
  });

  it('does not claim a numbered option that merely mentions tasks', () => {
    const lines = ['  2. Run 3 tasks (2 done) in parallel', '  7 tasks (0 done, 0 in progress, 7 open)'];
    expect([...findClaudeTaskPanelLines(lines, 0, lines.length)]).toEqual([1]);
  });

  it('honours the [start, end) bounds so a trimmed effectiveEnd is respected', () => {
    const lines = ['  7 tasks (1 done, 0 in progress, 0 open)', '  ◼ Phase 1'];
    expect([...findClaudeTaskPanelLines(lines, 0, 1)]).toEqual([0]);
    expect([...findClaudeTaskPanelLines(lines, 1, 2)]).toEqual([]);
  });
});

describe('Issue #1708: the collapsed summary line accepts "completed"', () => {
  it('treats "… +N completed" as metadata like "… +N pending" (Issue #704)', () => {
    // Without a panel header above it the block skip never engages, so this is
    // solely the SUMMARY_LINE_PATTERN half of the fix.
    const build = (summary: string) =>
      ['Do you want to proceed?', '❯ 1. Yes', '  2. No', `   ${summary}`].join('\n');

    expect(labels(build('… +1 pending'))).toEqual(['Yes', 'No']);
    expect(labels(build('… +2 completed'))).toEqual(['Yes', 'No']);
  });
});
