/**
 * Issue #1897 — copilot's reply must be what reaches History.
 *
 * Measured against the live copilot 1.0.80 frames captured for Issue #1885
 * (`tests/unit/lib/detection/fixtures/copilot-live-1885/`, 200x1000, raw ANSI).
 * Four separate defects put terminal furniture in the database and the actual
 * answer nowhere:
 *
 *  1. `extractResponse` decided copilot was finished from `hasPrompt && !isThinking`.
 *     The `❯` composer is drawn throughout a turn and `COPILOT_THINKING_PATTERN`
 *     matches nothing 1.0.80 draws, so the FIRST poll of a running turn was
 *     "complete" — the status bar got saved as the reply and, because
 *     `checkForResponse` stops polling for full-screen TUIs once it saves, the
 *     real answer was never looked for again.
 *  2. The launch banner is itself a complete, idle frame, so History opened with
 *     it as the agent's first message.
 *  3. The bottom-pinned chrome and the `⌄ Thought for …` / `│ …` reasoning block
 *     were transcript as far as the TUI accumulator was concerned.
 *  4. `cleanCopilotResponse` deleted ordinary prose — a `●` row starting with any
 *     of ~110 English verbs, plus everything after it up to the next marker, and
 *     any line opening with `find` / `go` / `make` / `cat` / `cd` / `ls` / `echo`.
 *
 * Both directions are pinned throughout: the artefacts that must still be
 * removed are asserted next to the prose that must now survive, because a
 * cleaner test that only checks "this is no longer deleted" passes just as well
 * when the cleaner deletes nothing at all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { extractResponse } from '@/lib/polling/response-checker';
import { cleanCopilotResponse } from '@/lib/response-cleaner';
import {
  initTuiAccumulator,
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
} from '@/lib/tui-accumulator';
import {
  findCopilotChromeStart,
  readCopilotStatusBar,
  stripAnsi,
  COPILOT_THINKING_PATTERN,
  COPILOT_SKIP_PATTERNS,
} from '@/lib/detection/cli-patterns';

const FIXTURE_DIR = join(
  process.cwd(),
  'tests/unit/lib/detection/fixtures/copilot-live-1885'
);

const readFrame = (name: string): string =>
  readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8');

/** The first paragraph of the reply in `turn-complete.txt`. */
const REPLY_OPENING =
  '1. The semicolon began as a response to changing habits of reading and publishing.';

/** A row of copilot's launch banner. */
const BANNER_ROW = 'No copilot-instructions.md found';

/** The idle status bar of copilot 1.0.80, as drawn on the bottom row. */
const IDLE_STATUS_BAR = '← open sidebar · / commands · ? help · tab next tab';

describe('Issue #1897: copilot frames still carry their chrome', () => {
  it('keeps the fixtures raw, so the positional rules stay under test', () => {
    // Same guard as the #1885 suite: these files are only meaningful at the
    // production pane geometry with their escape sequences intact.
    for (const name of ['boot-idle', 'turn-running-early', 'turn-complete']) {
      const raw = readFrame(name);
      expect(raw, name).toContain('\x1b[');
      expect(raw.split('\n').length, name).toBeGreaterThan(900);
    }
  });
});

describe('Issue #1897: findCopilotChromeStart', () => {
  it('cuts above the cwd row, the rules, the composer and the status bar', () => {
    for (const name of [
      'boot-idle',
      'turn-running-early',
      'turn-running-thinking',
      'turn-complete',
      'status-vocabulary-in-response',
    ]) {
      const lines = readFrame(name).split('\n');
      const start = findCopilotChromeStart(lines);
      expect(start, name).toBeGreaterThan(0);

      const chrome = stripAnsi(lines.slice(start).join('\n'));
      // Everything the trim removes is furniture...
      expect(chrome, name).toMatch(/^─{10,}$/m);
      // ...and nothing it keeps is.
      const content = stripAnsi(lines.slice(0, start).join('\n'));
      expect(content, name).not.toContain(IDLE_STATUS_BAR);
      expect(content, name).not.toContain('esc interrupt  ');
    }
  });

  it('declines a frame with no composer — a dialog owns the bottom of the pane', () => {
    // permission-dialog.txt draws its box over the chrome, so there is no bar and
    // no composer to anchor on. Reporting a boundary anyway would truncate the
    // dialog the prompt detector still has to read.
    expect(findCopilotChromeStart(readFrame('permission-dialog').split('\n'))).toBe(-1);
  });

  it('declines input that is not a captured frame', () => {
    expect(findCopilotChromeStart([])).toBe(-1);
    expect(findCopilotChromeStart(['Here is my answer.', 'It is 42.'])).toBe(-1);
    // Two rules around a reply are not a composer.
    expect(
      findCopilotChromeStart(['─────────────', 'the answer is 42', '─────────────', 'trailing'])
    ).toBe(-1);
  });
});

describe('Issue #1897: extractResponse turn boundaries', () => {
  it('does NOT report a running turn as complete', () => {
    for (const name of ['turn-running-early', 'turn-running-thinking']) {
      const result = extractResponse(readFrame(name), 0, 'copilot');
      expect(readCopilotStatusBar(stripAnsi(readFrame(name)).split('\n')), name).toBe('working');
      expect(result?.isComplete, name).toBe(false);
    }
  });

  it('does NOT save the launch banner as the first assistant message', () => {
    const frame = readFrame('boot-idle');
    // The launch screen really is idle — that is exactly why it used to pass.
    expect(readCopilotStatusBar(stripAnsi(frame).split('\n'))).toBe('idle');

    const result = extractResponse(frame, 0, 'copilot');
    expect(result?.isComplete).toBe(false);
    expect(result?.response ?? '').not.toContain(BANNER_ROW);
  });

  it('reports the finished turn as complete and returns the reply, not the chrome', () => {
    const result = extractResponse(readFrame('turn-complete'), 0, 'copilot');
    expect(result?.isComplete).toBe(true);

    const response = stripAnsi(result!.response);
    expect(response).toContain(REPLY_OPENING);
    // The operator's own prompt, the banner, the reasoning block and the status
    // bar are all absent.
    expect(response).not.toContain('Write a 400 word essay');
    expect(response).not.toContain(BANNER_ROW);
    expect(response).not.toContain('Thought for');
    expect(response).not.toContain(IDLE_STATUS_BAR);
  });

  it('leaves a permission dialog on the prompt path', () => {
    const result = extractResponse(readFrame('permission-dialog'), 0, 'copilot');
    expect(result?.isComplete).toBe(true);
    expect(result?.promptDetection?.isPrompt).toBe(true);
  });

  it('does not claim a completed turn while the /model picker is open', () => {
    // The picker replaces the status bar with its own footer, so there is no
    // positive idle evidence — Issue #1895's subject, unchanged here.
    expect(extractResponse(readFrame('model-picker'), 0, 'copilot')?.isComplete).toBe(false);
  });
});

describe('Issue #1897: the #1885 trap — status vocabulary inside a reply', () => {
  const frame = readFrame('status-vocabulary-in-response');

  it('treats the frame as finished (the bar says idle, the reply only quotes it)', () => {
    expect(readCopilotStatusBar(stripAnsi(frame).split('\n'))).toBe('idle');
    expect(extractResponse(frame, 0, 'copilot')?.isComplete).toBe(true);
  });

  it('saves the quoted vocabulary as the reply instead of deleting it', () => {
    const result = extractResponse(frame, 0, 'copilot');
    const cleaned = cleanCopilotResponse(result!.response);

    // This is the whole answer copilot was asked to produce. A cleaner that
    // deleted the status bar by wording rather than by position would return "".
    expect(cleaned).toBe(
      ['Working esc interrupt', 'Thinking…', 'open sidebar / commands ? help tab next tab'].join('\n')
    );
  });
});

describe('Issue #1897: the polling path that actually feeds History', () => {
  // checkForResponse() cleans getAccumulatedContent(), not extractResponse()'s
  // return value, so the accumulator is where copilot's chrome had to be cut.
  const POLL_SEQUENCE = [
    'boot-idle',
    'turn-running-early',
    'turn-running-thinking',
    'turn-complete',
  ];

  const accumulate = (key: string): string => {
    initTuiAccumulator(key);
    for (const name of POLL_SEQUENCE) {
      accumulateTuiContent(key, readFrame(name), 'copilot');
    }
    const content = getAccumulatedContent(key);
    clearTuiAccumulator(key);
    return content;
  };

  it('saves the reply and nothing else across a whole turn of polls', () => {
    const saved = cleanCopilotResponse(accumulate('wt:copilot:1897'));

    expect(saved).toContain(REPLY_OPENING);
    expect(saved.endsWith('complete thoughts may stand alone yet belong closely together.')).toBe(true);

    // The four things #1897 reported finding in History instead.
    expect(saved).not.toContain(BANNER_ROW);          // launch banner
    expect(saved).not.toContain('esc interrupt');      // working status bar
    expect(saved).not.toContain(IDLE_STATUS_BAR);      // idle status bar
    expect(saved).not.toContain('Thought for');        // reasoning header

    // The reasoning block's body, which normalizeCopilotLine() strips the `│`
    // gutter off before the skip patterns ever run.
    expect(saved).not.toContain('The user wants an essay on history');

    // And not the operator's own question, nor its wrapped tail.
    expect(saved).not.toContain('Write a 400 word essay');
  });

  it('drops the wrapped tail of the operator\'s own question', () => {
    // The prompt in status-vocabulary-in-response.txt is too long for one row.
    // Normalisation trims its continuation, so without the accumulator's own echo
    // rule the saved reply opened with the second half of the question.
    initTuiAccumulator('wt:copilot:1897c');
    accumulateTuiContent('wt:copilot:1897c', readFrame('status-vocabulary-in-response'), 'copilot');
    const saved = cleanCopilotResponse(getAccumulatedContent('wt:copilot:1897c'));
    clearTuiAccumulator('wt:copilot:1897c');

    expect(saved).toContain('Working esc interrupt');
    expect(saved).not.toContain('Do not use tools');
    expect(saved).not.toContain('Reply with exactly these three lines');
  });

  it('keeps the reply intact — the essay is not truncated to its first row', () => {
    const saved = cleanCopilotResponse(accumulate('wt:copilot:1897b'));
    // Four numbered paragraphs, each of which used to be at risk from the
    // `●`-plus-verb block skip.
    for (const marker of ['1. The semicolon', '2. The decisive invention', '3. During the seventeenth', '4. In the twentieth century']) {
      expect(saved).toContain(marker);
    }
  });
});

describe('Issue #1897: cleanCopilotResponse no longer deletes prose', () => {
  it('keeps a ● row that opens with an English verb, and the paragraph under it', () => {
    const input = [
      '❯ how do I fix this?',
      '● Check the config file before running the tests.',
      '',
      'The file is at src/config.ts.',
      'Run npm test to verify.',
    ].join('\n');

    expect(cleanCopilotResponse(input)).toBe(
      [
        'Check the config file before running the tests.',
        'The file is at src/config.ts.',
        'Run npm test to verify.',
      ].join('\n')
    );
  });

  it('keeps sentences that open with a shell-command word', () => {
    const input = [
      '❯ q',
      '● Here is what to do:',
      'find the file in src/lib and open it.',
      'go to the settings page.',
      'make sure npm test passes.',
      'cat the file to check its contents.',
      'echo the value to confirm.',
      'cd into the directory first.',
      'ls the directory to see what is there.',
      'node the graph is the parent.',
    ].join('\n');

    expect(cleanCopilotResponse(input)).toBe(
      [
        'Here is what to do:',
        'find the file in src/lib and open it.',
        'go to the settings page.',
        'make sure npm test passes.',
        'cat the file to check its contents.',
        'echo the value to confirm.',
        'cd into the directory first.',
        'ls the directory to see what is there.',
        'node the graph is the parent.',
      ].join('\n')
    );
  });

  it('does not let a filtered tool row swallow the sentence under it', () => {
    // The `●`-plus-verb match used to open a skip-until-next-marker block, so a
    // single misclassified row cost the whole remainder of the reply. The row is
    // still filtered; only its reach is gone.
    const input = ['❯ q', '● Read package.json', 'The version is 1.2.3.'].join('\n');
    expect(cleanCopilotResponse(input)).toBe('The version is 1.2.3.');
  });

  it('closes a tool-output block at the blank row that ends the block', () => {
    const input = [
      '❯ q',
      '● Here is the plan.',
      '$ Shell Run the tests 2 lines…   5s',
      '  npm test',
      '',
      'All 42 tests pass.',
    ].join('\n');

    // The tool row and its command are gone; the sentence after the blank row —
    // copilot's own block separator — is not.
    expect(cleanCopilotResponse(input)).toBe('Here is the plan.\nAll 42 tests pass.');
  });

  it('keeps a reply that ends on the word "Processing"', () => {
    // `Generating|Processing` were alternatives of COPILOT_THINKING_PATTERN, which
    // is both a skip pattern and (before this fix) the extractor's liveness test:
    // the line was deleted AND the turn was reported unfinished for as long as it
    // stayed on screen.
    expect(COPILOT_THINKING_PATTERN.test('Processing complete.')).toBe(false);
    expect(COPILOT_THINKING_PATTERN.test('Generating the report now.')).toBe(false);

    const input = ['❯ q', '● The build finished.', 'Processing complete.'].join('\n');
    expect(cleanCopilotResponse(input)).toBe('The build finished.\nProcessing complete.');
  });

  it('starts the reply after a wrapped prompt echo, not inside it', () => {
    const input = [
      ' ❯ Reply with exactly these three lines and nothing else. Line 1: the text',
      '   Working esc interrupt . Do not use tools.',
      '',
      ' ● pong',
    ].join('\n');

    expect(cleanCopilotResponse(input)).toBe('pong');
  });
});

describe('Issue #1897: cleanCopilotResponse still deletes the artefacts', () => {
  it('removes tool rows, fold markers, command echoes, spinners and reasoning', () => {
    const input = [
      '❯ q',
      '● Read package.json',
      '● Get current directory structure (shell)',
      '$ Shell Wait 25 seconds then print status 2 lines…   1m 27s',
      '  sleep 25; echo finished',
      'git --no-pager log --oneline',
      'npm run test:unit',
      '17 lines...',
      '◐ Analyzing the code...',
      '⌄ Thought for 41s',
      '│ private reasoning here',
      '⌄ Thinking…',
      '● The real answer.',
    ].join('\n');

    expect(cleanCopilotResponse(input)).toBe('The real answer.');
  });

  it('still filters braille spinners and the launch banner', () => {
    const input = [
      'GitHub Copilot v1.0.80',
      'Copilot uses AI, so always check for mistakes.',
      'Describe a task to get started.',
      '⠁⠂ Loading',
      '❯ q',
      '● Done.',
    ].join('\n');

    expect(cleanCopilotResponse(input)).toBe('Done.');
  });

  it('keeps the braille alternative of COPILOT_THINKING_PATTERN', () => {
    // tui-accumulator's spinner filtering rides on this via COPILOT_SKIP_PATTERNS.
    expect(COPILOT_THINKING_PATTERN.test('⠁⠂⠄ Loading...')).toBe(true);
    expect(COPILOT_SKIP_PATTERNS).toContain(COPILOT_THINKING_PATTERN);
  });
});
