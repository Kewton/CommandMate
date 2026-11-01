/**
 * The shared sender's pure reads of a captured composer (Issue #4056: split out
 * of `submit-verified-sender.ts`). No tmux, no keys, no logging.
 *
 * Imports nothing from `submit-verified-sender.ts`.
 */

import type { ComposerSpec } from '../../types/cli-tool-contracts';
import { stripAnsi } from '../detection/cli-patterns';
import type { CLIToolType } from './types';
import {
  VERIFY_WINDOW_LINES,
  classifyPasteLanded,
  compactText,
  findPasteTokens,
  readSubmitComposer,
  withoutTrailingBlankRows,
  type SubmitRule,
  type SubmitState,
} from './submit-composer-read';

export function describeComposer(
  output: string,
  cliToolId: CLIToolType,
  composerSpec: ComposerSpec,
  message: string
): string {
  const lines = withoutTrailingBlankRows(stripAnsi(output).split('\n'));
  const composer = readSubmitComposer(
    output,
    cliToolId,
    composerSpec.reader,
    lines,
    lines.slice(-VERIFY_WINDOW_LINES),
    message
  );
  if (composer.kind === 'absent') return 'no composer on screen';
  if (composer.kind === 'empty') return 'an empty composer';
  const text = composer.text.length > 80 ? `${composer.text.slice(0, 80)}…` : composer.text;
  return JSON.stringify(text);
}

/** Whether the composer in `output` holds any text at all, read as the sender reads it. */
export function composerHoldsText(output: string, cliToolId: CLIToolType, composerSpec: ComposerSpec, message: string): boolean {
  const lines = withoutTrailingBlankRows(stripAnsi(output).split('\n'));
  return (
    readSubmitComposer(output, cliToolId, composerSpec.reader, lines, lines.slice(-VERIFY_WINDOW_LINES), message)
      .kind === 'text'
  );
}

/**
 * Whether the composer shows a paste placeholder whose count is not this body's
 * (Issue #3945): one counting fewer or more, or more than one placeholder.
 */
export function composerShowsForeignPasteToken(
  output: string,
  cliToolId: CLIToolType,
  message: string,
  composerSpec: ComposerSpec
): boolean {
  const lines = withoutTrailingBlankRows(stripAnsi(output).split('\n'));
  const composer = readSubmitComposer(
    output,
    cliToolId,
    composerSpec.reader,
    lines,
    lines.slice(-VERIFY_WINDOW_LINES),
    message
  );
  if (composer.kind !== 'text') return false;
  if (!composer.rows.some((row) => findPasteTokens(row).tokens.length > 0)) return false;
  return classifyPasteLanded(output, cliToolId, message, composerSpec) !== 'landed';
}

/**
 * The part of a typed body the composer reader can see (Issue #3366).
 *
 * The codex reader takes the composer as one run of non-blank rows, so a blank
 * line inside the body ends what it returns: what it can show is the body up to
 * its first blank line after the first non-blank one. Leading blank lines are
 * kept — they are drawn as composer rows of their own and compact to nothing.
 */
export function visibleTypedBody(message: string): string {
  const lines = message.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0) return '';
  const blank = lines.findIndex((line, index) => index > first && line.trim() === '');
  return lines.slice(0, blank < 0 ? lines.length : blank).join('\n');
}

/** Whether the whole codex composer, read past the bounded readers (Issue #3906), is exactly `message`. */
export function codexComposerShowsWholeBody(output: string, message: string, composerSpec: ComposerSpec): boolean {
  const lines = withoutTrailingBlankRows(stripAnsi(output).split('\n'));
  const composer = readSubmitComposer(
    output,
    'codex',
    composerSpec.reader,
    lines,
    lines.slice(-VERIFY_WINDOW_LINES),
    message
  );
  return composer.kind === 'text' && composer.region !== undefined && compactText(composer.region) === compactText(message);
}

/**
 * Whether a verdict is one the agent's own report must back (Issue #4035):
 * `submitted` from B or F — the screen saying only that the body is not in the
 * composer. A (generating) stands on its own. A body starting with `/` or `!`
 * is run by the TUI itself, which is not measured to report it as a prompt.
 */
export function needsPromptReport(state: SubmitState, rule: SubmitRule, message: string): boolean {
  if (state !== 'submitted' || rule === 'A') return false;
  return !/^\s*[/!]/.test(message);
}
