/**
 * The steps split out of `extractResponse`, including the per-tool
 * startup-screen defenses (Issue #3374 split from response-checker.ts).
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  findClaudeChromeStart,
  isCodexTurnActive,
  stripAnsi,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_SKIP_PATTERNS,
  findCommandCodeChromeStart,
  findCopilotChromeStart,
  readCopilotStatusBar,
  COPILOT_BOOT_BANNER_ANCHORS,
  COPILOT_USER_ECHO_PATTERN,
  COPILOT_TRANSCRIPT_CONTINUATION_PATTERN,
  findOpenCodeChromeStart,
  findCodexChromeStart,
  findCodexUserEchoIndex,
} from '@/lib/detection/cli-patterns';
import { createLogger } from '@/lib/logger';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';

const logger = createLogger('response-poller');

import { resolveExtractionStartIndex, isOpenCodeComplete, resolveOpenCodeTurnRegion } from '../response-extractor';
import { isStartupScreenWithoutUserEcho } from './startup-screen';
import { GEMINI_LOADING_INDICATORS } from './response-poller-constants';
import { incompleteResult, type ExtractionResult } from './response-checker-extraction-result';

/**
 * How many rows from the bottom of a copilot capture may hold its status bar.
 *
 * `readCopilotStatusBar` stops at the first non-blank row from the end, and the
 * capture handed to it here has already had its trailing blanks trimmed, so one
 * row is enough in practice. The slack exists so the reader keeps working if that
 * trim ever changes, without mapping a thousand rows through `stripAnsi` on every
 * poll tick. (Issue #1897)
 */
const COPILOT_STATUS_BAR_SCAN_ROWS = 8;

// ============================================================================
// extractResponse (internal)
// ============================================================================

/**
 * Where the tool's pinned footer starts in the capture — the row the transcript
 * stops at — or -1 when the tool pins none or its landmark is not on the frame.
 *
 * Split out of {@link extractResponse} (Issue #3213). The comment above
 * `openCodeCleanLines` there introduces the first three readers and says why
 * they stay separate functions; the one in the body here continues it.
 *
 * @param cliToolId - CLI tool identifier
 * @param lines - The trimmed tmux buffer lines array
 * @param openCodeCleanLines - `lines` with ANSI stripped for opencode, null for every other tool
 * @returns Index of the first chrome row, or -1
 */
export function findChromeStart(
  cliToolId: CLIToolType,
  lines: string[],
  openCodeCleanLines: string[] | null
): number {
  // Issue #2250: Command Code is the fourth. Its landmark is its own — the
  // `❯ Ask your question...` composer fenced by two full-pane rules, with the
  // permission-mode row underneath — and it is load-bearing rather than tidy:
  // that placeholder is drawn with the same `❯ <text>` shape as a transcript
  // echo, so without the boundary `findRecentUserPromptIndex` anchors the turn
  // on the FOOTER and every reply extracts as empty (#1289's defect, verbatim).
  //
  // Issue #2400: codex is the fifth, and the one that had been missing. It pins
  // the same two rows — `› Ask Codex to do anything` and the `model · cwd`
  // status bar — and without a boundary the saturated-window anchor (#1670)
  // walked into them: the newest `›` in the pane was the COMPOSER, so extraction
  // started on the status bar and every reply on a saturated pane was saved as
  // that one row. `findCodexChromeStart` reads the composer by its SGR
  // attributes (#2310) rather than by its placeholder wording, which is what the
  // previous guard did and why it stopped working at codex 0.15x.
  return cliToolId === 'claude'
    ? findClaudeChromeStart(lines)
    : cliToolId === 'copilot'
      ? findCopilotChromeStart(lines)
      : cliToolId === 'command-code'
        ? findCommandCodeChromeStart(lines)
        : cliToolId === 'codex'
          ? findCodexChromeStart(lines)
          : openCodeCleanLines
            ? findOpenCodeChromeStart(openCodeCleanLines)
            : -1;
}

/**
 * Index of the newest echoed user prompt in the transcript, or -1 when there is
 * none in the window.
 *
 * The body of the `findRecentUserPromptIndex` closure in {@link extractResponse},
 * split out as it was (Issue #3213). The closure is still there: it binds the
 * frame and keeps the default window, because `resolveExtractionStartIndex` and
 * `buildPromptExtractionResult` take the search as a one-argument callback.
 *
 * @param cliToolId - CLI tool identifier
 * @param lines - The trimmed tmux buffer lines array
 * @param openCodeCleanLines - `lines` with ANSI stripped for opencode, null for every other tool
 * @param chromeStart - What `findChromeStart` returned for this frame
 * @param contentEnd - Where the transcript stops: `chromeStart`, or the line count when that is -1
 * @param windowSize - How many rows up from `contentEnd` to search
 * @returns Index into `lines`, or -1
 */
export function findRecentUserPromptIndexInFrame(
  cliToolId: CLIToolType,
  lines: string[],
  openCodeCleanLines: string[] | null,
  chromeStart: number,
  contentEnd: number,
  windowSize: number
): number {
  let userPromptPattern: RegExp;
  if (cliToolId === 'codex') {
    // Issue #2400: codex's three uses of `›` are separated by their SGR
    // attributes, not by their text (#2310). This branch used to exclude the
    // composer with a negative lookahead over its placeholder strings
    // (`Implement`, `Find and fix`, `Type`, `Summarize`) — codex 0.1x wording,
    // none of which 0.15x draws. `Ask Codex to do anything` passed the guard,
    // became the newest "echo", and on a saturated pane (#1670) — the only
    // path where this anchor decides where extraction STARTS — every reply was
    // saved as the single status-bar row below it.
    //
    // Two independent things now keep the composer out, and the reader needs
    // both because neither covers the other's frames: `contentEnd` cuts the
    // composer off structurally when `findCodexChromeStart` located it, and
    // when it did not, `findCodexUserEchoIndex` steps over the bottom-most
    // `›` row instead. The second is what still answers on an ANSI-stripped
    // capture, where none of #2310's attributes survive to be read.
    return findCodexUserEchoIndex(lines, contentEnd, windowSize, chromeStart >= 0);
  } else if (openCodeCleanLines) {
    // Issue #1911: anchor on the newest ECHOED USER PROMPT, not on the
    // second-to-last `▣ Build` row. The old anchor belonged to the PREVIOUS
    // turn, so the echoed prompt of the current one was always extracted as
    // part of the reply — and on the first turn of a session, where there is
    // no second marker, it fell through to line 0 and the whole pane (banner
    // included) became the answer. `windowSize` is ignored: the alternate
    // screen has no scrollback, so the whole pane IS the window, and every
    // caller already passes `totalLines` or more for this tool.
    return resolveOpenCodeTurnRegion(openCodeCleanLines).echoEnd;
  } else if (cliToolId === 'copilot') {
    // Issue #1897: copilot 1.0.80 draws the transcript one column in, so the
    // bare `^[>❯]` form below never matched the echoed prompt -- every copilot
    // extraction fell back to line 0, i.e. to the launch banner. The composer,
    // which IS at column 0, lives below `contentEnd` and so cannot be picked up
    // as an echo here.
    //
    // The scan then walks past the echo's own wrapped rows and returns the LAST
    // of them, so that callers' `+ 1` lands on the reply rather than on the
    // second half of the operator's question.
    //
    // Same defect as #1911's opencode branch above and the same shape of fix,
    // but NOT the same code: opencode's echo is a `┃  <text>` gutter row and
    // copilot's is ` ❯ <text>` at the pane's one-column indent, so the anchor
    // and the continuation rule are both tool-specific measurements.
    for (let i = contentEnd - 1; i >= Math.max(0, contentEnd - windowSize); i--) {
      if (!COPILOT_USER_ECHO_PATTERN.test(stripAnsi(lines[i]))) continue;
      let echoEnd = i;
      while (
        echoEnd + 1 < contentEnd &&
        COPILOT_TRANSCRIPT_CONTINUATION_PATTERN.test(stripAnsi(lines[echoEnd + 1]))
      ) {
        echoEnd++;
      }
      return echoEnd;
    }
    return -1;
  } else {
    userPromptPattern = /^[>❯]\s+\S/;
  }

  // Issue #1289: for Claude the search stops above the footer. The text the
  // user just typed sits in the footer's input box and matches the same "❯ …"
  // shape as the transcript echo; anchoring on it would treat the footer as
  // the newest turn and extract the status bar as its reply.
  for (let i = contentEnd - 1; i >= Math.max(0, contentEnd - windowSize); i--) {
    const cleanLine = stripAnsi(lines[i]);
    if (userPromptPattern.test(cleanLine)) {
      return i;
    }
  }

  return -1;
}

// Startup-screen defenses, split out of extractResponse one function per tool
// (Issue #3213). Each is called on a frame the completion rules have already
// accepted, with the `response` extracted from it, and answers only for its own
// tool: the incomplete result to return when the frame is that tool's startup
// screen rather than a reply, `null` when the response stands. They are declared
// in the order extractResponse calls them — the comments inside say "above" and
// "below" about each other and about the checks that ran before the call.
//
// Issue #3293 added the last two, codex and vibe-local. Theirs is the one result
// here that is not incomplete: an empty COMPLETE one, for the reason given at
// `readStartupScreenPastCursor`.

/**
 * Claude: the startup banner, and an echoed prompt with no reply under it yet.
 *
 * @param cliToolId - CLI tool identifier
 * @param response - The response extracted from the frame
 * @param totalLines - Total line count in the buffer
 * @param skipPatterns - The tool's skip patterns from `getCliToolPatterns`
 * @param findRecentUserPromptIndex - Callback to locate the most recent user prompt
 * @returns The incomplete result to return, or null when the response stands
 */
function suppressClaudeStartupScreen(
  cliToolId: CLIToolType,
  response: string,
  totalLines: number,
  skipPatterns: RegExp[],
  findRecentUserPromptIndex: (windowSize: number) => number
): ExtractionResult | null {
  // CRITICAL FIX: Detect and skip Claude Code startup banner/screen
  if (cliToolId === 'claude') {
    const cleanResponse = stripAnsi(response);

    // Issue #2247: `│` is what Claude Code draws markdown TABLES with -- the
    // live frame in `tests/fixtures/claude-live-2247/turn-table.txt` is a
    // two-row table and nothing else -- so it identified a reply, not a banner.
    // The banner's own frame glyphs are the rounded corners and the block
    // shading; those stay.
    const hasBannerArt = /[╭╮╰╯]/.test(cleanResponse) || /░{3,}/.test(cleanResponse) || /▓{3,}/.test(cleanResponse);
    // Issue #2247: the bare `v\d+\.\d+` alternative matched any version string a
    // reply happens to mention. The frame that lost a turn on 2026-09-02 was
    // "GitHub Release v0.30.0 を公開しました" (148 chars, well under the 2000
    // below). What the banner actually prints is the tool's own name and
    // version on one row -- `Claude Code v2.1.258` -- so that is what is
    // matched now, plus the `claude/` form older banners used.
    const hasVersionInfo = /Claude Code v\d+\.\d+|claude\//.test(cleanResponse);
    const hasStartupTips = /Tip:|for shortcuts|\?\s*for help/.test(cleanResponse);
    const hasProjectInit = /^\s*\/Users\/.*$/m.test(cleanResponse) && cleanResponse.split('\n').length < 30;

    // Issue #2247: the anchors above are only evidence of a banner on a pane
    // that has not had a single turn yet -- the same shape as the #1897 copilot
    // fix below. Claude echoes every prompt into the transcript as `❯ <text>`,
    // and the startup screen has none, so an echo anywhere in the transcript
    // rules the banner out no matter what the reply quotes.
    //
    // The search is `findRecentUserPromptIndex`, deliberately: it is the same
    // `/^[>❯]\s+\S/` this file already anchors extraction on, and it stops at
    // `contentEnd`. That bound is load-bearing rather than incidental -- the
    // footer's composer draws a DIM ghost suggestion (`❯ Try "write a test for
    // <filepath>"`, see `boot-banner.txt`) whose stripped bytes are identical
    // to a real echo (#1879), so a scan over the whole pane would read the
    // startup screen as "already had a turn" and put the banner back in
    // History.
    const hasTurnEcho = findRecentUserPromptIndex(totalLines) >= 0;

    const userPromptMatch = cleanResponse.match(/^[>❯]\s+(\S.*)$/m);

    if (userPromptMatch) {
      const userPromptIndex = cleanResponse.indexOf(userPromptMatch[0]);
      const contentAfterPrompt = cleanResponse.substring(userPromptIndex + userPromptMatch[0].length).trim();

      const contentLines = contentAfterPrompt.split('\n').filter(line => {
        const trimmed = line.trim();
        return trimmed &&
               !skipPatterns.some(p => p.test(trimmed)) &&
               !/^─+$/.test(trimmed);
      });

      if (contentLines.length === 0) {
        return incompleteResult(totalLines);
      }
    } else if (
      !hasTurnEcho &&
      (hasBannerArt || hasVersionInfo || hasStartupTips || hasProjectInit) &&
      response.length < 2000
    ) {
      // Issue #2247: this branch used to swallow the turn in silence -- the
      // poller kept ticking every 2s and `response-poller` logged nothing at
      // all, so the only way to tell a lost turn from an idle session was to
      // re-run `extractResponse` on a saved pane by hand. It is reached only
      // before the first echo lands, so it cannot become a per-tick flood.
      logger.info('Claude startup banner suppressed, response not saved', {
        responseLength: response.length,
        hasBannerArt,
        hasVersionInfo,
        hasStartupTips,
        hasProjectInit,
      });
      return incompleteResult(totalLines);
    }
  }

  return null;
}

/**
 * Copilot: the launch screen.
 *
 * @param cliToolId - CLI tool identifier
 * @param response - The response extracted from the frame
 * @param totalLines - Total line count in the buffer
 * @returns The incomplete result to return, or null when the response stands
 */
function suppressCopilotLaunchScreen(
  cliToolId: CLIToolType,
  response: string,
  totalLines: number
): ExtractionResult | null {
  // Issue #1897: copilot's launch screen is a complete, idle frame -- composer
  // drawn, key hints on the status bar -- so every check above accepts it and
  // History used to open with the banner ("Current Sessions Issues Pull
  // requests Gists / No copilot-instructions.md found… / Tip: /app") saved as
  // the agent's first reply, before the operator had said anything.
  //
  // What actually distinguishes it is that no turn has happened: copilot echoes
  // every prompt into the transcript as ` ❯ <text>`, and the launch screen has
  // none. The banner anchors are only consulted once that echo is missing, so a
  // reply that quotes any of this wording is unaffected.
  if (cliToolId === 'copilot') {
    const cleanResponse = stripAnsi(response);
    const hasUserEcho = cleanResponse
      .split('\n')
      .some(line => COPILOT_USER_ECHO_PATTERN.test(line));
    if (!hasUserEcho && COPILOT_BOOT_BANNER_ANCHORS.some(anchor => anchor.test(cleanResponse))) {
      return incompleteResult(totalLines);
    }
  }

  return null;
}

/**
 * Command Code: the launch screen.
 *
 * @param cliToolId - CLI tool identifier
 * @param response - The response extracted from the frame
 * @param totalLines - Total line count in the buffer
 * @param findRecentUserPromptIndex - Callback to locate the most recent user prompt
 * @returns The incomplete result to return, or null when the response stands
 */
function suppressCommandCodeLaunchScreen(
  cliToolId: CLIToolType,
  response: string,
  totalLines: number,
  findRecentUserPromptIndex: (windowSize: number) => number
): ExtractionResult | null {
  // Issue #2250: Command Code's launch screen is a complete, idle frame --
  // block-art logo, three `#` banner rows, composer drawn between its two
  // rules -- so every check above accepts it, and History would open with
  // `# Command Code v1.40.1 / # models: … / # <cwd>` saved as the agent's
  // first reply before the operator has said anything.
  //
  // The rule is ONE condition and it is a positive one: Command Code echoes
  // every prompt into the transcript as `❯ <text>`, and the launch screen has
  // none. That is the shape #1897 and #2247 both converged on; the anchor
  // heuristics claude carries above (`hasBannerArt` / `hasVersionInfo` /
  // `hasStartupTips`) are deliberately NOT reproduced here, because they are
  // what #2247 had to take back -- a bare version string in a reply is a
  // normal reply, and Command Code prints its own version on every launch.
  //
  // `findRecentUserPromptIndex` is the same `/^[>❯]\s+\S/` scan the extraction
  // anchors on, and it stops at `contentEnd`, so the composer's own dim
  // `❯ Ask your question...` placeholder cannot be mistaken for an echo
  // (#1879's trap).
  if (cliToolId === 'command-code' && findRecentUserPromptIndex(totalLines) < 0) {
    logger.info('Command Code launch screen suppressed, response not saved', {
      responseLength: response.length,
    });
    return incompleteResult(totalLines);
  }

  return null;
}

/**
 * Gemini: the banner, the auth/loading states, and a frame too short to be a reply.
 *
 * @param cliToolId - CLI tool identifier
 * @param response - The response extracted from the frame
 * @param totalLines - Total line count in the buffer
 * @returns The incomplete result to return, or null when the response stands
 */
function suppressGeminiStartupScreen(
  cliToolId: CLIToolType,
  response: string,
  totalLines: number
): ExtractionResult | null {
  // Gemini-specific check
  if (cliToolId === 'gemini') {
    const bannerCharCount = (response.match(/[░█]/g) || []).length;
    const totalChars = response.length;
    if (bannerCharCount > totalChars * 0.3) {
      return incompleteResult(totalLines);
    }

    if (GEMINI_LOADING_INDICATORS.some(indicator => response.includes(indicator))) {
      return incompleteResult(totalLines);
    }

    if (!response.includes('\u2726') && response.length < 10) {
      return incompleteResult(totalLines);
    }
  }

  return null;
}

/**
 * OpenCode: the banner.
 *
 * @param cliToolId - CLI tool identifier
 * @param response - The response extracted from the frame
 * @param totalLines - Total line count in the buffer
 * @param cleanOutputToCheck - The ANSI-stripped text the completion rules were tested against
 * @returns The incomplete result to return, or null when the response stands
 */
function suppressOpenCodeBanner(
  cliToolId: CLIToolType,
  response: string,
  totalLines: number,
  cleanOutputToCheck: string
): ExtractionResult | null {
  // OpenCode banner defense
  if (cliToolId === 'opencode') {
    const cleanResponse = stripAnsi(response);
    if (cleanResponse.length < 50 || !OPENCODE_RESPONSE_COMPLETE.test(cleanOutputToCheck)) {
      const contentLines = cleanResponse.split('\n').filter(line => {
        const trimmed = line.trim();
        return trimmed && !OPENCODE_SKIP_PATTERNS.some(p => p.test(trimmed));
      });
      if (contentLines.length === 0) {
        return incompleteResult(totalLines);
      }
    }
  }

  return null;
}

/**
 * The result for a startup screen of a tool that reads its reply from the
 * cursor: nothing to save, and the cursor moved past the screen (Issue #3293).
 *
 * The defenses above return an incomplete result and leave the cursor where it
 * was. Where extraction is anchored on the echoed prompt (copilot,
 * command-code, opencode) that costs nothing: once a turn exists, the banner
 * above its echo is never read. codex and vibe-local start at
 * `lastCapturedLine`. A cursor left at 0 would put the banner back on the first
 * turn — vibe-local's first reply would be saved with the whole startup screen
 * above it.
 *
 * So the screen is reported as read: a COMPLETE result with an empty response
 * and the `lineCount` the banner save had. `checkForResponse` writes that
 * cursor and saves nothing ("Validate response content is not empty"), which
 * leaves every later tick with exactly the cursor it had before this Issue.
 *
 * Asked of the whole pane, by the reader the pre-send flush uses for the same
 * question ({@link isStartupScreenWithoutUserEcho}), and not of a clipped
 * capture: the echo of a turn longer than the window has scrolled out (#1670).
 *
 * @param tool - The tool the calling defense answers for
 * @param ctx - What this call has read off the capture
 * @param response - The response extracted from the frame
 * @param endIndex - The line count `collectCompletedResponse` reported for it
 * @returns The empty complete result to return, or null when the response stands
 */
function readStartupScreenPastCursor(
  tool: 'codex' | 'vibe-local',
  ctx: ExtractionContext,
  response: string,
  endIndex: number
): ExtractionResult | null {
  const { cliToolId, lines, lastCapturedLine, bufferReset, captureWindowSaturated } = ctx;

  // An empty response is already what this would return.
  if (cliToolId !== tool || !response || captureWindowSaturated) {
    return null;
  }
  if (!isStartupScreenWithoutUserEcho(cliToolId, lines)) {
    return null;
  }

  // Only when `checkForResponse` goes on to write the cursor, which is once per
  // startup screen. vibe-local's cursor ends on the last row, so every later
  // tick of the idle pane takes the buffer-reset branch, re-extracts the banner
  // and arrives here again.
  if (bufferReset || endIndex > lastCapturedLine) {
    logger.info(`${tool} startup screen suppressed, response not saved`, {
      responseLength: response.length,
      lineCount: endIndex,
    });
  }

  return {
    response: '',
    isComplete: true,
    lineCount: endIndex,
    bufferReset,
    captureWindowSaturated,
  };
}

/**
 * Codex: the startup screen.
 *
 * @param ctx - What this call has read off the capture
 * @param response - The response extracted from the frame
 * @param endIndex - The line count `collectCompletedResponse` reported for it
 * @returns The empty complete result to return, or null when the response stands
 */
function suppressCodexStartupScreen(
  ctx: ExtractionContext,
  response: string,
  endIndex: number
): ExtractionResult | null {
  // Issue #3293: codex's startup screen is a complete, idle frame — composer
  // drawn, no status line above it — so `hasPrompt && !isThinking` accepts it,
  // and the rows from the cursor down were saved as the agent's first reply.
  // On 0.160.0 that is `>_ OpenAI Codex (v0.160.0)`, the cwd, a tagline and the
  // block-art logo (20 rows in `tests/fixtures/startup-screen-3293/`); on 0.15x
  // the `Tip:` and usage notices under the banner box, whose own rows the skip
  // patterns happen to drop.
  //
  // It took one poll of that screen. The frame the folder-trust dialog leaves
  // behind when it is answered is this screen, and answering it with `respond`
  // starts the poller.
  //
  // The dialog itself never reaches this point: it has no composer, and it was
  // returned as a prompt by the early check in extractResponse.
  //
  // A turn longer than the pane does reach it, and has to pass. 0.160.0 keeps
  // no scrollback, so the echo of such a turn has left the pane off the top and
  // "composer, no echo above it" holds for a finished reply. The reader asks
  // for the banner row as well, which that pane has lost with the echo.
  //
  // Issue #3335: on 0.160.0 the cursor this leaves (the composer row, 996) is
  // also where it stays — the pane does not grow, so the replies of the
  // session are drawn above it and the screen read takes none of them. That
  // is by design: they reach History from codex's transcript. See the codex
  // branch of `resolveExtractionStartIndex`.
  return readStartupScreenPastCursor('codex', ctx, response, endIndex);
}

/**
 * Vibe Local: the startup screen.
 *
 * @param ctx - What this call has read off the capture
 * @param response - The response extracted from the frame
 * @param endIndex - The line count `collectCompletedResponse` reported for it
 * @returns The empty complete result to return, or null when the response stands
 */
function suppressVibeLocalStartupScreen(
  ctx: ExtractionContext,
  response: string,
  endIndex: number
): ExtractionResult | null {
  // Issue #3293: vibe-local's startup screen ends in an empty `ctx:N% ❯` prompt
  // row with nothing working, so it is accepted the same way. Its skip patterns
  // name some banner rows (`Model  …`, `CWD  …`) and miss the rest — the
  // launcher's `Model: …` / `Ollama: …` box, the logo, the hint rows — so most
  // of the screen was saved (20 rows of the 1.3.3 capture in the same fixtures).
  return readStartupScreenPastCursor('vibe-local', ctx, response, endIndex);
}

// The rest of extractResponse, split out one function per step (Issue #3213):
// the completion rules, the completion branch they open, and the partial
// reading a frame falls through to. They are declared in the order
// extractResponse reaches them, and each is called at the position its lines
// had. The comments inside were written in place: "above" and "below" in them
// are positions in extractResponse. The startup-screen defenses above are
// called from `extractCompletedResponse` now, in the order they were.

/**
 * What one `extractResponse` call has read off its capture, as handed to the
 * steps split out of it (Issue #3213).
 *
 * One object rather than positional arguments, for the reason
 * `ResponseCheckContext` below gives: five of these are numbers and three are
 * patterns, and a call site could transpose either without a type error. Each
 * step destructures the names it uses, so the moved lines read exactly as they
 * did inside `extractResponse`. Nothing in it is written after it is built.
 */
export interface ExtractionContext {
  cliToolId: CLIToolType;
  /** The trimmed tmux buffer lines array. */
  lines: string[];
  totalLines: number;
  /** `lines` with ANSI stripped for opencode, null for every other tool. */
  openCodeCleanLines: string[] | null;
  /** What `findChromeStart` returned for this frame. */
  chromeStart: number;
  /** Where the transcript stops: `chromeStart`, or the line count when that is -1. */
  contentEnd: number;
  lastCapturedLine: number;
  bufferReset: boolean;
  captureWindowSaturated: boolean;
  /** How many rows from the bottom the completion rules look at. */
  checkLineCount: number;
  /** The ANSI-stripped text the completion rules are tested against. */
  cleanOutputToCheck: string;
  promptPattern: RegExp;
  separatorPattern: RegExp;
  thinkingPattern: RegExp;
  skipPatterns: RegExp[];
  findRecentUserPromptIndex: (windowSize: number) => number;
}

/**
 * Does this frame show a finished turn, by its tool's own completion rule?
 *
 * The readings and the four per-tool rules that decided the completion branch
 * of {@link extractResponse}, split out as they were (Issue #3213). The return
 * is the condition that `if` tested.
 *
 * @param ctx - What this call has read off the capture
 * @returns True when the turn on the frame is finished
 */
export function isTurnComplete(ctx: ExtractionContext): boolean {
  const {
    cliToolId, lines, totalLines, checkLineCount, cleanOutputToCheck,
    promptPattern, separatorPattern, thinkingPattern,
  } = ctx;

  const hasPrompt = promptPattern.test(cleanOutputToCheck);
  const hasSeparator = separatorPattern.test(cleanOutputToCheck);
  // Issue #1671: Codex's activity markers are past-tense transcript records that
  // never leave the scrollback, so testing them against this fixed tail window
  // reports "still thinking" for a finished turn whenever its final message was
  // short enough to keep the last "• Ran <cmd>" row inside the window. Codex gets
  // a liveness check that keys off the status line it repaints above the composer
  // instead; every other tool keeps the tail-window match.
  const isThinking = cliToolId === 'codex'
    ? isCodexTurnActive(lines, checkLineCount)
    : thinkingPattern.test(cleanOutputToCheck);

  // Issue #1897: copilot's `hasPrompt` is worthless as a completion signal and
  // its `isThinking` is worthless as a liveness one. The `❯` composer is drawn
  // between its two rules throughout a turn (measured on every frame of #1885's
  // running fixtures), and `COPILOT_THINKING_PATTERN` matches nothing copilot
  // 1.0.80 draws (0 of 44 live generating frames). So `hasPrompt && !isThinking`
  // was true on the very first poll of a running turn -- the extractor declared
  // the turn finished, saved the status bar as the reply, and `checkForResponse`
  // stopped polling, which is why the real answer never reached History.
  //
  // 1.0.80 paints the turn's state on the bottom row of the pane and nowhere
  // else, so that ROW -- never a tail window, which copilot's own reply text can
  // forge (`status-vocabulary-in-response.txt`) -- is the evidence. `idle` is a
  // positive observation that the turn is over (design policy §4 D1 decision 1
  // item 2); `working` and `null` (a dialog box has taken the bar away) both mean
  // "not finished", and the dialog case is already served by the prompt path
  // above.
  const copilotStatusBar = cliToolId === 'copilot'
    ? readCopilotStatusBar(lines.slice(Math.max(0, totalLines - COPILOT_STATUS_BAR_SCAN_ROWS)).map(stripAnsi))
    : null;

  // Prompt-based completion logic
  const isPromptBasedComplete = cliToolId === 'copilot'
    ? copilotStatusBar === 'idle'
    : (cliToolId === 'codex' || cliToolId === 'gemini' || cliToolId === 'vibe-local' || cliToolId === 'antigravity') && hasPrompt && !isThinking;
  const isClaudeComplete = cliToolId === 'claude' && hasPrompt && hasSeparator && !isThinking;
  // Issue #2250: claude's shape, because Command Code's layout is claude's — the
  // composer sits between two full-pane rules and is drawn only when the agent
  // will accept input. Deliberately NOT keyed on `✻ Worked for`: that row is the
  // live turn's, not the transcript's (it is present in `turn-version.txt` and
  // gone from `dialog-create-file.txt`, the same pane one prompt later) and
  // `WorkedDurationNote` omits it entirely for a turn under 1000 ms.
  const isCommandCodeComplete =
    cliToolId === 'command-code' && hasPrompt && hasSeparator && !isThinking;
  const isOpenCodeDone = cliToolId === 'opencode' && isOpenCodeComplete(cleanOutputToCheck);

  return isPromptBasedComplete || isClaudeComplete || isCommandCodeComplete || isOpenCodeDone;
}

/**
 * Collect the rows of a finished turn's reply, and where the cursor stops.
 *
 * The first half of the completion branch of {@link extractResponse}, split out
 * as it was (Issue #3213). The loop writes `endIndex` when it stops early, so
 * it is returned beside the response instead of being written through.
 *
 * @param ctx - What this call has read off the capture
 * @returns The trimmed response, and the line count to report for it
 */
function collectCompletedResponse(ctx: ExtractionContext): { response: string; endIndex: number } {
  const {
    cliToolId, lines, totalLines, chromeStart, contentEnd, lastCapturedLine,
    bufferReset, captureWindowSaturated, skipPatterns, findRecentUserPromptIndex,
  } = ctx;

  const responseLines: string[] = [];

  const startIndex = resolveExtractionStartIndex(
    lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
    captureWindowSaturated
  );

  // `contentEnd` bounds the content only; `endIndex` keeps reporting the full
  // buffer so lineCount bookkeeping in session_states is unchanged (#1289).
  //
  // Issue #2400: codex is the exception, and it is the pre-existing behaviour
  // rather than a new rule. Before this Issue the loop below stopped on the
  // composer's `›` and wrote that row's index into `endIndex`; now the composer
  // is outside `contentEnd`, so the break can no longer fire on it and
  // `endIndex` would silently advance ~3 rows further. Those rows matter for
  // codex specifically: it renders INLINE, and it repaints the composer band in
  // place — the next turn's transcript is printed over exactly the rows the
  // composer occupied in this capture. A cursor parked past them would skip
  // real content on the following poll. So the cursor stops where the content
  // stops, which is what it did before.
  let endIndex = cliToolId === 'codex' ? contentEnd : totalLines;

  for (let i = startIndex; i < contentEnd; i++) {
    const line = lines[i];
    const cleanLine = stripAnsi(line);

    if (cliToolId === 'codex' && /^›\s+/.test(cleanLine)) {
      endIndex = i;
      break;
    }

    if (cliToolId === 'gemini' && /^(%|\$|.*@.*[%$#])\s*$/.test(cleanLine)) {
      endIndex = i;
      break;
    }

    // Antigravity (agy): the bare ">" input box line marks the end of the
    // response (the status bar and shortcuts footer follow below it). (Issue #988)
    if (cliToolId === 'antigravity' && /^>\s*$/.test(cleanLine)) {
      endIndex = i;
      break;
    }

    // Issue #1911: both rows this stops on (`Ask anything...` in the composer,
    // `tab agents  ctrl+p commands` under its border) live in the chrome, which
    // `contentEnd` now excludes structurally. Kept only as the fallback for a
    // frame whose chrome could not be located, because there it is still the
    // one boundary available — and #1883 measured that a REPLY can contain
    // `Ask anything...`, so cutting the turn on it is a last resort, not the
    // primary rule.
    if (cliToolId === 'opencode' && chromeStart < 0) {
      if (OPENCODE_PROMPT_PATTERN.test(cleanLine) || OPENCODE_PROMPT_AFTER_RESPONSE.test(cleanLine)) {
        endIndex = i;
        break;
      }
    }

    const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
    if (shouldSkip) {
      continue;
    }

    responseLines.push(line);
  }

  const response = responseLines.join('\n').trim();

  return { response, endIndex };
}

/**
 * Build the result for a frame the completion rules accepted.
 *
 * The body of the completion branch of {@link extractResponse}, split out as it
 * was (Issue #3213). Every return is `extractResponse`'s own result: incomplete
 * when the reply's tail still shows a thinking indicator or the frame is a
 * startup screen, complete otherwise. (A codex or vibe-local startup screen is
 * the exception — complete, with an empty response; Issue #3293.)
 *
 * @param ctx - What this call has read off the capture
 * @returns What `extractResponse` returns for this frame
 */
export function extractCompletedResponse(ctx: ExtractionContext): ExtractionResult {
  const {
    cliToolId, totalLines, openCodeCleanLines, bufferReset, captureWindowSaturated,
    cleanOutputToCheck, thinkingPattern, skipPatterns, findRecentUserPromptIndex,
  } = ctx;

  const { response, endIndex } = collectCompletedResponse(ctx);

  // DR-004: Check only the tail of the response for thinking indicators.
  //
  // Issue #1897: not for copilot. This is the same tail-window match the #1671
  // codex fix removed from the liveness test, and on copilot it is both
  // redundant and harmful: the status bar above has already made a positive
  // `idle` observation about THIS frame, while the window here sees transcript
  // that never scrolls away. `COPILOT_THINKING_PATTERN`'s braille alternative
  // matches any spinner glyph a reply happens to quote, and the turn would then
  // be reported unfinished for the rest of the session.
  const responseTailLines = response.split('\n').slice(-THINKING_TAIL_LINE_COUNT).join('\n');
  if (cliToolId !== 'copilot' && thinkingPattern.test(responseTailLines)) {
    return incompleteResult(totalLines);
  }

  // Startup-screen defenses, one per tool and in this order. Each answers only
  // for its own tool; `null` means the response stands.
  const startupScreen =
    suppressClaudeStartupScreen(cliToolId, response, totalLines, skipPatterns, findRecentUserPromptIndex) ??
    suppressCopilotLaunchScreen(cliToolId, response, totalLines) ??
    suppressCommandCodeLaunchScreen(cliToolId, response, totalLines, findRecentUserPromptIndex) ??
    suppressGeminiStartupScreen(cliToolId, response, totalLines) ??
    suppressOpenCodeBanner(cliToolId, response, totalLines, cleanOutputToCheck) ??
    suppressCodexStartupScreen(ctx, response, endIndex) ??
    suppressVibeLocalStartupScreen(ctx, response, endIndex);
  if (startupScreen) {
    return startupScreen;
  }

  return {
    response,
    isComplete: true,
    lineCount: endIndex,
    bufferReset,
    captureWindowSaturated,
    // Issue #1911: opencode only. `echoEnd < 0` means the turn is longer than
    // the alternate-screen pane and its head has already scrolled away, so
    // `response` starts mid-answer. Nothing else in this frame can recover it.
    turnHeadTruncated: openCodeCleanLines
      ? resolveOpenCodeTurnRegion(openCodeCleanLines).headTruncated
      : undefined,
  };
}

/**
 * Build the result for a frame whose turn is still running: what has streamed
 * so far, or an empty incomplete result when nothing has.
 *
 * The tail of {@link extractResponse}, split out as it was (Issue #3213). Both
 * returns are `extractResponse`'s own result.
 *
 * @param ctx - What this call has read off the capture
 * @returns What `extractResponse` returns for this frame
 */
export function extractPartialResponse(ctx: ExtractionContext): ExtractionResult {
  const {
    lines, totalLines, contentEnd, lastCapturedLine, bufferReset,
    captureWindowSaturated, skipPatterns, findRecentUserPromptIndex,
  } = ctx;

  // Partial response in progress
  const responseLines: string[] = [];
  const endIndex = totalLines;
  // Issue #1670: a saturated window makes lastCapturedLine meaningless here too —
  // starting the partial slice at it would stream an arbitrary tail fragment
  // instead of the turn so far. Re-anchor on the echoed user prompt.
  const partialBufferReset = bufferReset || captureWindowSaturated || lastCapturedLine >= endIndex - 5;
  const recentPromptIndex = partialBufferReset ? findRecentUserPromptIndex(80) : -1;
  const startIndex = partialBufferReset
    ? (recentPromptIndex >= 0 ? recentPromptIndex + 1 : Math.max(0, endIndex - 80))
    : Math.max(0, lastCapturedLine);

  // Partial (still-streaming) content is bounded by the footer too (#1289).
  for (let i = startIndex; i < Math.min(endIndex, contentEnd); i++) {
    const line = lines[i];
    const cleanLine = stripAnsi(line);

    const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
    if (shouldSkip) {
      continue;
    }

    responseLines.push(line);
  }

  const partialResponse = responseLines.join('\n').trim();
  if (partialResponse) {
    return {
      response: partialResponse,
      isComplete: false,
      lineCount: endIndex,
    };
  }

  // Response not yet complete
  return incompleteResult(totalLines);
}
