/**
 * OpenCode's dispatch and read-back → accepted / delivered / not_sent / unknown
 * (Issue #4535, design §2.3). Not wired into the sender yet (stage 1).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  classifyOpencodePromptAnswer,
  classifyOpencodeReadbacks,
  type OpencodeReadbackAnswer,
} from '@/lib/send-outcome/opencode-dispatch-outcome';

/** The ladder the sender uses today (`OPENCODE_SEND_READBACK_DELAYS_MS`, four reads). */
const LADDER = 4;

describe('classifyOpencodePromptAnswer — the prompt_async POST', () => {
  it('204 is accepted (then read back)', () => {
    expect(classifyOpencodePromptAnswer({ kind: 'response', status: 204, contentType: null })).toBe('accepted');
  });

  it.each([
    ['400', 400, 'application/json'],
    ['404', 404, null],
    ['422', 422, 'application/json'],
    ['the web UI\'s SPA shell (200 text/html, #1931)', 200, 'text/html; charset=utf-8'],
  ])('%s is not_sent (the loopback server did not take it)', (_name, status, contentType) => {
    expect(classifyOpencodePromptAnswer({ kind: 'response', status, contentType })).toBe('not_sent');
  });

  it.each([
    ['a JSON 200', 200, 'application/json'],
    ['a 201 with no type', 201, null],
    ['500', 500, 'application/json'],
    ['503', 503, null],
    ['307', 307, null],
    ['302', 302, 'text/html'],
  ])('%s is unknown — never a keyboard fallback (Q5)', (_name, status, contentType) => {
    expect(classifyOpencodePromptAnswer({ kind: 'response', status, contentType })).toBe('unknown');
  });

  it('no answer is unknown', () => {
    expect(classifyOpencodePromptAnswer({ kind: 'no-answer' })).toBe('unknown');
  });
});

const MISSING: OpencodeReadbackAnswer = { kind: 'missing' };
const UNREADABLE: OpencodeReadbackAnswer = { kind: 'unknown' };
const FOUND: OpencodeReadbackAnswer = { kind: 'found', matches: true };
const MISMATCH: OpencodeReadbackAnswer = { kind: 'found', matches: false };

describe('classifyOpencodeReadbacks — the read-back ladder', () => {
  it('found on the first read is delivered', () => {
    expect(classifyOpencodeReadbacks([FOUND], LADDER)).toBe('delivered');
  });

  it('a 404 then found is delivered — the first 404 is not proof (the race the ladder exists for)', () => {
    expect(classifyOpencodeReadbacks([MISSING, FOUND], LADDER)).toBe('delivered');
  });

  it('404 on every read of the ladder is not_sent', () => {
    expect(classifyOpencodeReadbacks([MISSING, MISSING, MISSING, MISSING], LADDER)).toBe('not_sent');
  });

  it('a single 404 with the ladder unfinished is unknown, not not_sent', () => {
    expect(classifyOpencodeReadbacks([MISSING], LADDER)).toBe('unknown');
  });

  it('404 mixed with an unreadable answer is unknown (404, 500, 404, 404)', () => {
    expect(classifyOpencodeReadbacks([MISSING, UNREADABLE, MISSING, MISSING], LADDER)).toBe('unknown');
  });

  it('the ladder exhausted on unreadable answers is unknown', () => {
    expect(classifyOpencodeReadbacks([UNREADABLE, UNREADABLE, UNREADABLE, UNREADABLE], LADDER)).toBe('unknown');
  });

  it('a message under the id with other text is unknown (mismatch), even after 404s', () => {
    expect(classifyOpencodeReadbacks([MISMATCH], LADDER)).toBe('unknown');
    expect(classifyOpencodeReadbacks([MISSING, MISMATCH], LADDER)).toBe('unknown');
  });

  it('reads after the first found are ignored', () => {
    expect(classifyOpencodeReadbacks([FOUND, MISSING, MISSING, MISSING], LADDER)).toBe('delivered');
  });

  it('no reads at all is unknown', () => {
    expect(classifyOpencodeReadbacks([], LADDER)).toBe('unknown');
  });

  it('more 404s than the ladder is still not_sent; a ladder of 0 never proves anything', () => {
    expect(classifyOpencodeReadbacks([MISSING, MISSING, MISSING, MISSING, MISSING], LADDER)).toBe('not_sent');
    expect(classifyOpencodeReadbacks([], 0)).toBe('unknown');
  });
});
