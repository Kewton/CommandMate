/** @vitest-environment node */

/**
 * Issues #1879 / #1890: what is really in the composer, read off a RAW pane capture.
 *
 * Every claude fixture under `fixtures/claude-live-1879/` is a live
 * `tmux capture-pane -p -e` of Claude Code v2.1.238 in a disposable 200x1000
 * session, and every codex fixture under `fixtures/codex-live-1890/` is the same
 * capture of codex-cli 0.148.0 (see each directory's README for provenance and
 * the measured `cursor_x` of each frame). They are raw on purpose: after
 * `stripAnsi`, both CLIs' dim placeholder text is byte-identical to text a human
 * typed, so a stripped fixture would let a broken extractor pass every assertion
 * in this file.
 *
 * The first test in the file is the guard for exactly that — it asserts the
 * fixtures still carry `ESC[2m`. If someone "normalises" the fixtures, the ghost
 * tests stop being tests and this one says so.
 *
 * The codex half carries a second, heavier obligation than the claude half. #1880
 * wired this module into the SEND path, so a frame misread as `content` is no
 * longer a cosmetic bar defect: the pre-send clear fires `C-e`+`C-u` at whatever
 * is on screen and then refuses to send. Every codex negative here — the three
 * placeholder rotations, the dialogs, the transcript echo of a sent message — is
 * a frame that must never reach that path.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  COMPOSER_TEXT_MAX_CHARS,
  extractComposerText,
  findClaudeInputBox,
  findCodexInputBox,
  SUPPORTED_COMPOSER_TOOLS,
} from '@/lib/detection/composer-text';
import { stripAnsi } from '@/lib/detection/ansi';
import { findClaudeChromeStart } from '@/lib/detection/cli-patterns';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const CLAUDE_DIR = path.join(FIXTURES, 'claude-live-1879');
const CODEX_DIR = path.join(FIXTURES, 'codex-live-1890');

function claudeFrame(name: string): string {
  return fs.readFileSync(path.join(CLAUDE_DIR, `${name}.txt`), 'utf-8');
}

function codexFrame(name: string): string {
  return fs.readFileSync(path.join(CODEX_DIR, `${name}.txt`), 'utf-8');
}

/** A frame from an earlier Issue's codex capture set, reused as a negative. */
function codexFrameFrom(dir: string, name: string): string {
  return fs.readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf-8');
}

/** SGR "faint" — the single attribute that separates a ghost from real input. */
const DIM = '[2m';

describe('composer fixtures are raw (Issue #1879)', () => {
  // Without this the ghost cases below would pass against an extractor that
  // ignores attributes entirely, because the ghost rows would look like content
  // rows. Assert the discriminator is physically present before relying on it.
  it.each(['composer-ghost-suggestion', 'composer-ghost-history-1878'])(
    '%s still carries the dim SGR sequence',
    (name) => {
      expect(claudeFrame(name)).toContain(DIM);
    },
  );

  it('the ghost rows are indistinguishable from real input once stripped', () => {
    // The premise of the whole module, asserted rather than assumed: this is why
    // extraction may not run on `stripAnsi` output. Spelled with escapes because
    // the gutter is NOT an ASCII space: Claude Code pads with U+00A0 (measured),
    // while the row transcribed into #1878 carries a plain one — the extractor
    // has to survive both, and a literal here would silently encode one of them.
    const GLYPH = '\u276F';
    const NBSP = '\u00A0';
    expect(stripAnsi(claudeFrame('composer-ghost-history-1878')))
      .toContain(`${GLYPH} echo PREFILLED/clear`);
    expect(stripAnsi(claudeFrame('composer-residual-plain')))
      .toContain(`${GLYPH}${NBSP}echo PREFILLED`);
  });
});

describe('extractComposerText — the four states (Issue #1879)', () => {
  it('reports real residual text typed at the prompt', () => {
    expect(extractComposerText(claudeFrame('composer-residual-plain'), 'claude')).toEqual({
      text: 'echo PREFILLED',
      state: 'content',
    });
  });

  it('reports a coloured (non-dim) slash command as real content', () => {
    // `ESC[38;5;153m` — the 256-colour introducer whose ARGUMENT is 153. A naive
    // parameter scan reads a `2` inside `38;2;…`/`38;5;2` forms and marks the
    // rest of the row dim; this frame is the regression guard for that.
    expect(extractComposerText(claudeFrame('composer-residual-slash'), 'claude')).toEqual({
      text: '/cost',
      state: 'content',
    });
  });

  it('joins the rows of a multi-line composer', () => {
    expect(extractComposerText(claudeFrame('composer-residual-multiline'), 'claude')).toEqual({
      text: 'RESIDLINE1\nRESIDLINE2',
      state: 'content',
    });
  });

  it('reports an empty composer as empty', () => {
    expect(extractComposerText(claudeFrame('composer-empty'), 'claude')).toEqual({
      text: '',
      state: 'empty',
    });
  });

  // The requirement this Issue was re-scoped around: a `C-u` cannot remove a
  // suggestion that is not in the buffer, so publishing one would produce a bar
  // whose Clear button visibly does nothing.
  it('never publishes Claude’s dim rotating suggestion', () => {
    expect(extractComposerText(claudeFrame('composer-ghost-suggestion'), 'claude')).toEqual({
      text: '',
      state: 'ghost',
    });
  });

  it('never publishes Claude’s dim history suggestion (the #1878 frame)', () => {
    expect(extractComposerText(claudeFrame('composer-ghost-history-1878'), 'claude')).toEqual({
      text: '',
      state: 'ghost',
    });
  });

  it.each(['gemini', 'copilot', 'opencode', 'antigravity', 'vibe-local'])(
    'reports %s as an unsupported composer layout',
    (tool) => {
      expect(extractComposerText(claudeFrame('composer-residual-plain'), tool)).toEqual({
        text: '',
        state: 'unsupported_tool',
      });
    },
  );

  // #1890 taught the reader codex, and nothing else. The tools above are still
  // out of #1880's pre-send clear because of this line, so it is asserted rather
  // than assumed: widening the set is what turns an unmeasured input box into a
  // `C-e`+`C-u` volley.
  it('supports exactly claude and codex', () => {
    expect([...SUPPORTED_COMPOSER_TOOLS].sort()).toEqual(['claude', 'codex']);
  });
});

describe('codex fixtures are raw (Issue #1890)', () => {
  it.each(['composer-placeholder-ask'])('%s still carries the dim SGR sequence', (name) => {
    expect(codexFrame(name)).toContain(DIM);
  });

  it('the placeholder row is indistinguishable from real input once stripped', () => {
    // The premise the codex half rests on. Stripped, the empty composer and the
    // one holding `echo PREFILLED` differ only in which words follow the glyph;
    // nothing in the rendered text says one of them is not in the buffer.
    const GLYPH = '\u203A';
    expect(stripAnsi(codexFrame('composer-placeholder-ask')))
      .toContain(`${GLYPH} Ask Codex to do anything`);
    expect(stripAnsi(codexFrame('composer-residual-plain')))
      .toContain(`${GLYPH} echo PREFILLED`);
  });

  it('the dialog row that must NOT be read as a composer is bold, not dim', () => {
    // The whole codex rejection rule in one assertion: the model picker's
    // selected option carries `ESC[1m` + a colour over the text, where the
    // composer resets to plain right after the glyph.
    expect(codexFrame('dialog-model-picker')).toContain('\u001b[1m\u001b[38;5;6m\u203A 1. ');
    expect(codexFrame('composer-residual-plain')).toContain('\u001b[1m\u203A\u001b[0m echo PREFILLED');
  });
});

describe('extractComposerText — codex (Issue #1890)', () => {
  // The acceptance criterion this Issue was opened on. A `content` verdict here
  // would make #1880's pre-send clear fire on every idle codex send, spin to its
  // pass cap against a buffer that was empty all along, and then throw instead
  // of sending.
  it('never publishes the `Ask Codex to do anything` placeholder', () => {
    expect(extractComposerText(codexFrame('composer-placeholder-ask'), 'codex')).toEqual({
      text: '',
      state: 'ghost',
    });
  });

  it.each([
    ['codex-live-1628', 'idle-ready', 'Use /skills to list available skills'],
    ['codex-live-1628', 'working', 'Use /skills to list available skills'],
    ['codex-live-1671', 'reported-session-tail', 'Find and fix a bug in @filename'],
  ])('never publishes the placeholder rotation in %s/%s', (dir, name, placeholder) => {
    const frame = codexFrameFrom(dir, name);
    expect(stripAnsi(frame)).toContain(placeholder);
    expect(extractComposerText(frame, 'codex')).toEqual({ text: '', state: 'ghost' });
  });

  it('reports real residual text typed at the prompt', () => {
    expect(extractComposerText(codexFrame('composer-residual-plain'), 'codex')).toEqual({
      text: 'echo PREFILLED',
      state: 'content',
    });
  });

  it('reports a residual slash command under its completion popup', () => {
    // The popup replaces the model/cwd footer, so the composer is no longer the
    // second block from the bottom — and its own highlighted row is bold, which
    // is the same attribute that rejects a dialog's selected option.
    expect(extractComposerText(codexFrame('composer-residual-slash'), 'codex')).toEqual({
      text: '/status',
      state: 'content',
    });
  });

  it('joins the rows of a multi-line composer', () => {
    expect(extractComposerText(codexFrame('composer-residual-multiline'), 'codex')).toEqual({
      text: 'RESIDLINE1\nRESIDLINE2',
      state: 'content',
    });
  });

  it('reports hand-typed text shaped like a dialog option as content', () => {
    // Guards the rejection rule against being rewritten as "reject `› <digit>. `",
    // which is the cheap-looking way to exclude the dialogs and would silently
    // stop clearing a composer holding a numbered list.
    expect(extractComposerText(codexFrame('composer-residual-leading-number'), 'codex')).toEqual({
      text: '1. buy milk',
      state: 'content',
    });
  });
});

describe('extractComposerText — codex frames with no composer on screen (Issue #1890)', () => {
  // Every one of these ends in a `›` row at column 0, and every one of them has
  // the composer genuinely off screen. Reading any of them as `content` is the
  // expensive failure: #1880's clear would send `C-e`+`C-u` into the dialog —
  // which on an approval screen is a keypress with consequences — and then
  // refuse the send.
  it.each([
    ['codex-live-1890', 'dialog-model-picker'],
    ['codex-live-1628', 'approval-run-command'],
    ['codex-live-1628', 'approval-apply-patch'],
    ['codex-live-1628', 'model-picker-step1'],
    ['codex-live-1628', 'model-picker-step2'],
  ])('reports no_composer for %s/%s', (dir, name) => {
    const frame = codexFrameFrom(dir, name);
    expect(frame).toMatch(/\u001b\[1m\u001b\[38;5;6m\u203A \d\. /);
    expect(extractComposerText(frame, 'codex')).toEqual({ text: '', state: 'no_composer' });
  });

  it('never mistakes the transcript echo of a sent message for the composer', () => {
    // `ESC[1;2m› ESC[0mRun the shell command: …` — codex prints what the user
    // sent back into the transcript with the same glyph at column 0, dimmed. The
    // live composer is 12 rows below it in this frame and must win.
    const frame = codexFrameFrom('codex-live-1671', 'turn-running-command');
    expect(frame).toContain('\u001b[1;2m\u203A \u001b[0mRun the shell command');
    expect(extractComposerText(frame, 'codex')).toEqual({ text: '', state: 'ghost' });
  });

  it('never mistakes the dim transcript echo for the composer once the composer is gone', () => {
    // The live frame above still has a real composer under the echo, so the
    // block walk reaches the right row for the wrong reason. This is the case
    // that isolates the glyph-dim rule: a dialog has taken the composer off
    // screen and the echo is now the last `\u203A` row in the frame. The row is the
    // verbatim one codex printed in `approval-run-command.txt`.
    const echo =
      '\u001b[1;2m\u203A \u001b[0mCreate a file scripts/greet.sh containing a hello-world '
      + 'shell script, then run: git add scripts/greet.sh';
    expect(codexFrameFrom('codex-live-1628', 'approval-run-command')).toContain(echo);

    const frame = [
      '\u2022 some output',
      '',
      echo,
      '',
      '  \u001b[2mPress enter to confirm or esc to cancel\u001b[0m',
    ].join('\n');
    expect(extractComposerText(frame, 'codex')).toEqual({ text: '', state: 'no_composer' });
  });

  it('reports no_composer for a codex frame with no glyph row at all', () => {
    expect(extractComposerText('• just a reply\nand more text\n', 'codex')).toEqual({
      text: '',
      state: 'no_composer',
    });
  });

  it('reports no_composer for an empty capture', () => {
    expect(extractComposerText('', 'codex')).toEqual({ text: '', state: 'no_composer' });
  });
});

describe('findCodexInputBox — the trailing-block bound (Issue #1890)', () => {
  it('takes the live composer, not the stale one left in the scrollback', () => {
    // `turn-running-command.txt` renders three `›` rows: an old composer at the
    // top of the visible scrollback, the dim transcript echo, and the live
    // composer at the bottom. Only the last is the answer.
    const lines = codexFrameFrom('codex-live-1671', 'turn-running-command').split('\n');
    const glyphRows = lines
      .map((line, i) => [i, stripAnsi(line)] as const)
      .filter(([, text]) => text.startsWith('\u203A'))
      .map(([i]) => i);

    expect(glyphRows.length).toBeGreaterThan(1);
    expect(findCodexInputBox(lines)?.firstRow).toBe(glyphRows[glyphRows.length - 1]);
  });

  it('stops before reaching a composer buried further up than the frame tail', () => {
    // Four blocks of dialog chrome between the bottom and a composer row is
    // beyond the bound, and beyond it the honest answer is "not on screen".
    const frame = [
      '\u001b[1m\u203A\u001b[0m echo PREFILLED',
      '',
      '  block one',
      '',
      '  block two',
      '',
      '  block three',
      '',
      '  block four',
      '',
      '  block five',
    ].join('\n');
    expect(findCodexInputBox(frame.split('\n'))).toBeNull();
    expect(extractComposerText(frame, 'codex').state).toBe('no_composer');
  });

  it('finds a composer three blocks up, as an @-mention popup leaves it', () => {
    const frame = [
      '\u001b[1m\u203A\u001b[0m @READ',
      '',
      '\u001b[1m\u001b[38;5;6m> README.md  ./\u001b[0m',
      '',
      '  \u001b[2menter insert · esc close\u001b[0m',
    ].join('\n');
    expect(extractComposerText(frame, 'codex')).toEqual({ text: '@READ', state: 'content' });
  });

  it('refuses a glyph row whose gutter is not the measured single space', () => {
    // Fail closed on an unmeasured row shape. Every codex frame captured for
    // this Issue puts exactly one ASCII space between `\u203A` and the text; a row
    // that does not is some layout nobody has looked at, and the safe answer for
    // an unread layout is `no_composer` — that costs the #1879 bar and leaves
    // #1880's splice in place, where guessing costs a `C-e`+`C-u` volley.
    const frame = ['\u001b[1m\u203A\u001b[0mNOGUTTER', '', '  gpt-5.6-sol xhigh'].join('\n');
    expect(findCodexInputBox(frame.split('\n'))).toBeNull();
    expect(extractComposerText(frame, 'codex').state).toBe('no_composer');
  });

  it('reads a codex composer with neither text nor placeholder as empty', () => {
    // `capture-pane` trims the trailing gutter space, so an unadorned glyph row
    // is what an empty composer looks like if the placeholder is ever dropped.
    const frame = ['\u001b[1m\u203A\u001b[0m', '', '  gpt-5.6-sol xhigh'].join('\n');
    expect(extractComposerText(frame, 'codex')).toEqual({ text: '', state: 'empty' });
  });
});

describe('claude is untouched by the codex reader (Issue #1890)', () => {
  // The Issue's hardest acceptance criterion, and the one a shared reader is
  // most likely to break: every claude verdict is pinned above, and these are
  // the two crossings that a tool-dispatch mistake would produce.
  it('does not read a codex frame when told it is claude', () => {
    // claude's locator needs a closing separator; a codex frame has none, so the
    // honest answer stays `no_composer` rather than borrowing codex's rules.
    expect(extractComposerText(codexFrame('composer-residual-plain'), 'claude')).toEqual({
      text: '',
      state: 'no_composer',
    });
  });

  it('does not read a claude frame when told it is codex', () => {
    // claude's `❯` is not codex's `›`, and the separator-fenced box is not a
    // trailing block that opens with one.
    expect(extractComposerText(claudeFrame('composer-residual-plain'), 'codex')).toEqual({
      text: '',
      state: 'no_composer',
    });
  });
});

describe('extractComposerText — frames with no input box (Issue #1879)', () => {
  it('reports no_composer for a frame whose box is not on screen', () => {
    expect(extractComposerText('⏺ just a reply\nand more text\n', 'claude')).toEqual({
      text: '',
      state: 'no_composer',
    });
  });

  it('reports no_composer for an empty capture', () => {
    expect(extractComposerText('', 'claude')).toEqual({ text: '', state: 'no_composer' });
  });

  it('does not mistake a reply fenced by two horizontal rules for the composer', () => {
    const sep = '─'.repeat(40);
    const frame = [sep, 'a reply that happens to be fenced', sep, '  status bar'].join('\n');
    expect(extractComposerText(frame, 'claude').state).toBe('no_composer');
  });
});

describe('extractComposerText — bounds (Issue #1879)', () => {
  it('truncates a composer larger than the published cap', () => {
    const long = 'x'.repeat(COMPOSER_TEXT_MAX_CHARS + 500);
    const sep = '─'.repeat(40);
    const frame = [sep, `❯ ${long}`, sep, '  status bar'].join('\n');

    const result = extractComposerText(frame, 'claude');

    expect(result.state).toBe('content');
    expect(result.text).toHaveLength(COMPOSER_TEXT_MAX_CHARS);
  });
});

describe('findClaudeInputBox stays in lock-step with findClaudeChromeStart (Issue #1879)', () => {
  // The locator was extracted from `findClaudeChromeStart` (#1289) so the footer
  // trimmer and the composer reader cannot drift about where the box is. Assert
  // the delegation, not just the extraction.
  it.each([
    'composer-empty',
    'composer-ghost-suggestion',
    'composer-residual-plain',
    'composer-residual-multiline',
  ])('agrees with the chrome trimmer on %s', (name) => {
    const lines = claudeFrame(name).split('\n');
    const box = findClaudeInputBox(lines);
    expect(box).not.toBeNull();
    expect(findClaudeChromeStart(lines)).toBe(Math.max(0, box!.openingSeparator - 1));
  });

  it('returns null exactly where the trimmer returns -1', () => {
    const lines = ['⏺ reply', 'more text'];
    expect(findClaudeInputBox(lines)).toBeNull();
    expect(findClaudeChromeStart(lines)).toBe(-1);
  });
});
