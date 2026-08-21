/** @vitest-environment node */

/**
 * Issue #1879: what is really in the composer, read off a RAW pane capture.
 *
 * Every claude fixture under `fixtures/claude-live-1879/` is a live
 * `tmux capture-pane -p -e` of Claude Code v2.1.238 in a disposable 200x1000
 * session (see that directory's README for provenance and the measured
 * `cursor_x` of each). They are raw on purpose: after `stripAnsi`, Claude's dim
 * suggestion text is byte-identical to text a human typed, so a stripped fixture
 * would let a broken extractor pass every assertion in this file.
 *
 * The first test in the file is the guard for exactly that — it asserts the
 * fixtures still carry `ESC[2m`. If someone "normalises" the fixtures, the ghost
 * tests stop being tests and this one says so.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  COMPOSER_TEXT_MAX_CHARS,
  extractComposerText,
  findClaudeInputBox,
} from '@/lib/detection/composer-text';
import { stripAnsi } from '@/lib/detection/ansi';
import { findClaudeChromeStart } from '@/lib/detection/cli-patterns';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const CLAUDE_DIR = path.join(FIXTURES, 'claude-live-1879');

function claudeFrame(name: string): string {
  return fs.readFileSync(path.join(CLAUDE_DIR, `${name}.txt`), 'utf-8');
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

  it('never publishes a codex placeholder', () => {
    // Live codex idle frame (#1628 fixture): `ESC[0;1m› ESC[2mUse /skills to
    // list available skills ESC[0m`. Two independent reasons it cannot leak —
    // codex is not a supported composer layout, and the placeholder is dim.
    const codexIdle = fs.readFileSync(
      path.join(FIXTURES, 'codex-live-1628', 'idle-ready.txt'),
      'utf-8',
    );
    expect(stripAnsi(codexIdle)).toContain('Use /skills to list available skills');

    expect(extractComposerText(codexIdle, 'codex')).toEqual({
      text: '',
      state: 'unsupported_tool',
    });
    // Even if a future change routed codex through the claude reader by mistake,
    // the placeholder still does not become content.
    expect(extractComposerText(codexIdle, 'claude').text).toBe('');
  });

  it.each(['gemini', 'copilot', 'opencode', 'antigravity'])(
    'reports %s as an unsupported composer layout',
    (tool) => {
      expect(extractComposerText(claudeFrame('composer-residual-plain'), tool)).toEqual({
        text: '',
        state: 'unsupported_tool',
      });
    },
  );
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
