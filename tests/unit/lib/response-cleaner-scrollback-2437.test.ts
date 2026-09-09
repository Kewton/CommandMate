/**
 * The cleaner the four scrollback tools never had (Issue #2437).
 *
 * Until this change `cleanCliResponse` returned codex, command-code, agy and
 * vibe-local captures **verbatim** — codex's branch said so out loud ("Codex
 * doesn't need special cleaning"). The pre-send flush
 * (`savePendingAssistantResponse`) therefore wrote codex's idle composer into
 * History as an assistant reply, 10 times on `commandagent-develop` from
 * 2026-09-07, each row a copy of the input box and the status bar under it.
 *
 * Fixture-driven against the frames those tools actually draw
 * (`tests/fixtures/codex-live-2310/`, `command-code-live-2250/`,
 * `antigravity-live-2364/`), because the defect is a disagreement between the
 * cleaner and the pane: a hand-written frame agrees with the cleaner by
 * construction. Every case asserts BOTH directions — the chrome is gone AND the
 * reply next to it survived — since a cleaner that returns `''` for everything
 * would pass half of this file.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { cleanScrollbackResponse } from '@/lib/response-cleaner';
import { cleanCliResponse } from '@/lib/assistant-response-saver';

const CODEX_FIXTURES = join(process.cwd(), 'tests/fixtures/codex-live-2310');
const COMMAND_CODE_FIXTURES = join(process.cwd(), 'tests/fixtures/command-code-live-2250');
const ANTIGRAVITY_FIXTURES = join(process.cwd(), 'tests/fixtures/antigravity-live-2364');

/** A capture as the pre-send flush sees it: everything from `fromLine` down. */
function tailFrom(path: string, fromLine: number): string {
  return readFileSync(path, 'utf8').split('\n').slice(fromLine).join('\n');
}

describe('[#2437] codex', () => {
  // Rows 57/59 of the fixture: `› Ask Codex to do anything` (bold glyph) and the
  // `gpt-6-astra default · /path` status bar. This slice is the exact shape of
  // the 10 bogus rows the issue was opened for.
  const IDLE_COMPOSER_TAIL = tailFrom(join(CODEX_FIXTURES, 'saturated-idle-tail.txt'), 55);
  // The same pane one turn earlier: the three-line reply, then that composer.
  const REPLY_THEN_COMPOSER = tailFrom(join(CODEX_FIXTURES, 'saturated-idle-tail.txt'), 50);

  it('saves nothing when the pane holds only the idle composer', () => {
    expect(cleanScrollbackResponse(IDLE_COMPOSER_TAIL, 'codex')).toBe('');
  });

  it('reaches the same verdict through cleanCliResponse', () => {
    // The branch itself, not just the function behind it: before #2437 this
    // hit `default: output.trim()` and returned the composer.
    expect(cleanCliResponse(IDLE_COMPOSER_TAIL, 'codex')).toBe('');
  });

  it('keeps the reply and drops the composer chrome below it', () => {
    const cleaned = cleanScrollbackResponse(REPLY_THEN_COMPOSER, 'codex');

    expect(cleaned).toContain('A worktree is a working directory for a Git repository.');
    expect(cleaned).toContain('Each worktree can check out a different branch.');
    expect(cleaned).toContain('Worktrees share repository history but keep files separate.');
    expect(cleaned).not.toContain('Ask Codex to do anything');
    expect(cleaned).not.toContain('gpt-6-astra default');
  });

  it('boots with no reply to keep, so the whole banner-and-composer frame cleans away', () => {
    // `idle-composer.txt` is a freshly launched codex: box-drawn banner, two
    // notices, composer, status bar. Sliced at the composer's blank row, there
    // is no transcript at all and the honest answer is an empty string.
    const bootTail = tailFrom(join(CODEX_FIXTURES, 'idle-composer.txt'), 11);
    expect(cleanScrollbackResponse(bootTail, 'codex')).toBe('');
  });

  it('reads the composer by its SGR attributes, not by its placeholder wording', () => {
    // #2310's rule is what makes this survive codex rewording the placeholder,
    // which is exactly how the previous guard (`Implement|Find and fix|Type`)
    // died at 0.15x. Same frame, different words in the box.
    const reworded = REPLY_THEN_COMPOSER.replace(
      'Ask Codex to do anything',
      'Tell Codex what you want built'
    );
    const cleaned = cleanScrollbackResponse(reworded, 'codex');

    expect(cleaned).toContain('A worktree is a working directory for a Git repository.');
    expect(cleaned).not.toContain('Tell Codex what you want built');
  });
});

describe('[#2437] command-code', () => {
  it('saves nothing when the pane holds only the composer block', () => {
    // `boot-idle.txt` rows 13-16: opening rule, `❯ Ask your question...`,
    // closing rule, `? for shortcuts · taste on`.
    const idleTail = tailFrom(join(COMMAND_CODE_FIXTURES, 'boot-idle.txt'), 12);
    expect(cleanScrollbackResponse(idleTail, 'command-code')).toBe('');
    expect(cleanCliResponse(idleTail, 'command-code')).toBe('');
  });

  it('keeps the reply and drops the composer block below it', () => {
    // `turn-version.txt` from just after the echoed prompt: the reasoning
    // summary, the `⠶` reply, the turn summary, then the composer block.
    const replyTail = tailFrom(join(COMMAND_CODE_FIXTURES, 'turn-version.txt'), 14);
    const cleaned = cleanScrollbackResponse(replyTail, 'command-code');

    expect(cleaned).toContain('released v1.40.1');
    expect(cleaned).not.toContain('Ask your question');
    expect(cleaned).not.toContain('? for shortcuts');
  });
});

describe('[#2437] antigravity', () => {
  it('saves nothing when the pane holds only the input box', () => {
    // `boot-idle.txt` rows 8-11: rule, bare `>`, rule, `? for shortcuts … model`.
    const idleTail = tailFrom(join(ANTIGRAVITY_FIXTURES, 'boot-idle.txt'), 8);
    expect(cleanScrollbackResponse(idleTail, 'antigravity')).toBe('');
    expect(cleanCliResponse(idleTail, 'antigravity')).toBe('');
  });

  it('keeps the turn body and drops the input box below it', () => {
    const replyTail = tailFrom(join(ANTIGRAVITY_FIXTURES, 'idle-after-deny.txt'), 31);
    const cleaned = cleanScrollbackResponse(replyTail, 'antigravity');

    expect(cleaned).toContain('Building the command line');
    expect(cleaned).toContain('User declined the tool call');
    expect(cleaned).not.toContain('? for shortcuts');
    expect(cleaned.split('\n')).not.toContain('>');
  });
});

describe('[#2437] vibe-local', () => {
  // No live corpus for vibe-local in this repository, so this is the shape its
  // skip patterns were written against rather than a measured frame — the
  // `ctx:N% ❯` composer and the `✦ Ready … ESC: stop` status bar.
  const FRAME = [
    'The answer is 42.',
    'It took two lines to say.',
    '',
    '··················································',
    'ctx:12% ❯',
    '✦ Ready    ESC: stop',
  ].join('\n');

  it('keeps the reply and drops the composer and status bar', () => {
    const cleaned = cleanScrollbackResponse(FRAME, 'vibe-local');

    expect(cleaned).toBe('The answer is 42.\nIt took two lines to say.');
    expect(cleanCliResponse(FRAME, 'vibe-local')).toBe(cleaned);
  });
});

describe('[#2437] ordinary replies are untouched', () => {
  // The regression the branch must not cause: a reply with no chrome around it
  // is saved exactly as before, for every tool the branch now covers.
  it.each(['codex', 'command-code', 'antigravity', 'vibe-local'] as const)(
    'passes plain prose through for %s',
    (cliToolId) => {
      expect(cleanCliResponse('Done. The build is green.', cliToolId)).toBe(
        'Done. The build is green.'
      );
    }
  );
});
