/**
 * Issue #3205: the read-back after Enter on a codex composer holding several lines.
 *
 * `classifySubmit` read the bottom-most `›` row of the tail as the input line.
 * In the UAT frame (`tests/fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt`)
 * the unsent 6-line body quotes a dialog, so its 3rd row is `  › 1. Yes, proceed (y)`;
 * that row was taken for the input line, did not match the body, and the
 * still-unsent body was classified `submitted`.
 *
 * What is pinned here:
 *   - that frame is `pending` (fails on the pre-#3205 reader);
 *   - a plain two-line body still in the composer is `pending`, as before;
 *   - a submitted multi-line body (empty composer, codex idle or working) is
 *     `submitted`, as before;
 *   - a frame without ANSI keeps the pre-#3205 reading.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { classifySubmit } from '@/lib/cli-tools/submit-verified-sender';
import { extractComposerText } from '@/lib/detection/composer-text';

const FIXTURES = path.resolve(__dirname, '../../fixtures');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf-8');
}

const TC104 = fixture('codex-multiline-composer-3205/tc104-raw-pane.txt');
/** The body the UAT typed: exactly what the composer of the frame holds. */
const TC104_BODY = extractComposerText(TC104, 'codex').text;

describe('Issue #3205: classifySubmit on a multi-line codex composer', () => {
  it('the UAT body is the 6-line composer of the frame', () => {
    expect(TC104_BODY.split('\n')).toHaveLength(6);
    expect(TC104_BODY.split('\n')[2]).toBe('› 1. Yes, proceed (y)');
  });

  it('a body still in the composer whose later row begins with › is pending', () => {
    expect(classifySubmit(TC104, 'codex', TC104_BODY)).toBe('pending');
  });

  it('a plain two-line body still in the composer is pending', () => {
    expect(
      classifySubmit(fixture('codex-multiline-composer-3205/idle-composer-two-lines.txt'), 'codex', 'hello\nworld'),
    ).toBe('pending');
  });

  it('a different multi-line text in the composer is not the body (not pending)', () => {
    expect(classifySubmit(TC104, 'codex', 'something else\nentirely')).toBe('submitted');
  });

  it('a submitted multi-line body (idle, empty composer) is submitted', () => {
    const lines = TC104.split('\n');
    const frame = [...lines.slice(0, 38), '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m', '', ...lines.slice(45)].join('\n');
    expect(classifySubmit(frame, 'codex', TC104_BODY)).toBe('submitted');
  });

  it('codex working with a multi-line follow-up in the composer is submitted', () => {
    expect(
      classifySubmit(fixture('codex-multiline-composer-3205/running-composer-two-lines.txt'), 'codex', 'follow-up line one\nfollow-up line two'),
    ).toBe('submitted');
  });

  it('two-line body, ANSI stripped: still pending (the marker reader, as before)', () => {
    const stripped = fixture('codex-multiline-composer-3205/idle-composer-two-lines.txt').replace(/\x1b\[[0-9;]*m/g, '');
    expect(classifySubmit(stripped, 'codex', 'hello\nworld')).toBe('pending');
  });
});
