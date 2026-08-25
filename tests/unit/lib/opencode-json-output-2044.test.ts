/**
 * `opencode run --format json` extraction (Issue #2044)
 *
 * Every input here is a **captured** stdout from opencode 1.18.22 rather than a
 * hand-written approximation — see `tests/fixtures/opencode-run-json-2044/README.md`
 * for how each one was produced. That matters more than usual for this function:
 * its whole job is to agree with a format nobody in this repository controls, and
 * a fixture written from memory would let the suite pass against a stream shape
 * that does not exist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractOpencodeFinalText } from '@/lib/session/claude-executor';

const FIXTURES = join(process.cwd(), 'tests/fixtures/opencode-run-json-2044');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('extractOpencodeFinalText (Issue #2044)', () => {
  it('returns the assistant text from a plain run', () => {
    expect(extractOpencodeFinalText(fixture('plain-text.jsonl'))).toBe('hello-2044');
  });

  it('returns the answer, not the message that called the tool', () => {
    // The captured run emits `tool_use` under msg_0382da04a0…, then `text` under
    // msg_0382dafbd0…. Only the second is the answer.
    const text = extractOpencodeFinalText(fixture('tool-use-then-text.jsonl'));
    expect(text).toContain('hello');
    expect(text).not.toContain('tool_use');
    expect(text).not.toContain('step-start');
  });

  it('returns the answer from a --continue run', () => {
    expect(extractOpencodeFinalText(fixture('continue-session.jsonl'))).toBe('cont-ok');
  });

  it('renders an error frame instead of answering null', () => {
    // Measured: exit 1, empty stderr, one `error` frame on stdout. Returning
    // null here would leave the execution log with the raw JSON; returning the
    // rendered line is what makes a failed schedule legible.
    const text = extractOpencodeFinalText(fixture('error.jsonl'));
    expect(text).toBe(
      'opencode error: UnknownError: Unexpected server error. Check server logs for details.'
    );
  });

  it('answers null for a stream carrying neither text nor error', () => {
    const onlySteps = fixture('plain-text.jsonl')
      .split('\n')
      .filter((line) => line.includes('"step_'))
      .join('\n');
    expect(onlySteps).not.toBe('');
    expect(extractOpencodeFinalText(onlySteps)).toBeNull();
  });

  it('answers null for empty stdout, so the caller falls back to raw output', () => {
    expect(extractOpencodeFinalText('')).toBeNull();
  });

  it('skips lines that are not JSON rather than failing the whole extraction', () => {
    // `--print-logs`, a plugin's console.log, a shell warning: all land on the
    // same stdout and none of them should cost the answer.
    const noisy = [
      'WARN  some plugin said something',
      fixture('plain-text.jsonl').trim(),
      'not json either',
    ].join('\n');
    expect(extractOpencodeFinalText(noisy)).toBe('hello-2044');
  });

  it('joins several text parts of the final message, in order', () => {
    // Not observed in the captured runs (each message carried one text part),
    // but the shape the format allows. Returning only the last part would be a
    // silent truncation indistinguishable from a short answer.
    const stream = [
      JSON.stringify({ type: 'text', part: { messageID: 'msg_a', type: 'text', text: 'first' } }),
      JSON.stringify({ type: 'text', part: { messageID: 'msg_b', type: 'text', text: 'head' } }),
      JSON.stringify({ type: 'text', part: { messageID: 'msg_b', type: 'text', text: 'tail' } }),
    ].join('\n');
    expect(extractOpencodeFinalText(stream)).toBe('head\n\ntail');
  });

  it('falls back to the last text part when no message ids are present', () => {
    const stream = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'earlier' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'final' } }),
    ].join('\n');
    expect(extractOpencodeFinalText(stream)).toBe('final');
  });

  it('does not confuse an unknown event word for text', () => {
    // A word opencode adds in a later release must be ignored, not guessed at.
    const stream = [
      JSON.stringify({ type: 'reasoning', part: { messageID: 'msg_a', text: 'thinking out loud' } }),
      JSON.stringify({ type: 'text', part: { messageID: 'msg_a', type: 'text', text: 'answer' } }),
    ].join('\n');
    expect(extractOpencodeFinalText(stream)).toBe('answer');
  });
});

describe('the fixtures are the measured stream (Issue #2044)', () => {
  it('every fixture line is one JSON object with a `type`', () => {
    for (const name of [
      'plain-text.jsonl',
      'tool-use-then-text.jsonl',
      'continue-session.jsonl',
      'error.jsonl',
    ]) {
      const lines = fixture(name).split('\n').filter((line) => line.trim());
      expect(lines.length, name).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed = JSON.parse(line) as { type?: unknown };
        expect(typeof parsed.type, `${name}: ${line.slice(0, 60)}`).toBe('string');
      }
    }
  });

  it('a session cost equals the sum of its step costs', () => {
    // The measurement migration v58's last-write-wins rule rests on: the
    // session-level number opencode publishes is cumulative, so a sampler may
    // overwrite but must never add.
    const steps = fixture('tool-use-then-text.jsonl')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type: string; part?: { cost?: number } })
      .filter((frame) => frame.type === 'step_finish')
      .map((frame) => frame.part?.cost ?? 0);

    expect(steps).toEqual([0.03372225, 0.0038181]);
    // `GET /session` answered 0.03754035 for this session after the run.
    expect(steps[0] + steps[1]).toBeCloseTo(0.03754035, 10);
  });
});
