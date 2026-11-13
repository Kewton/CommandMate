/**
 * The ask envelope's place and its removal (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.2 M2・M3・M4).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { formatAskEnvelope, insertAskEnvelope, isAskId, stripAskEnvelope } from '@/lib/ask/envelope';
import { isAskCommandBody } from '@/lib/ask/ask-correlation';
import { afterDeliveredBrief, normalizeUserTurnContent } from '@/lib/history/user-turn-recorder';

const ASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRIEF = '<<<cmate-brief:0123abcd\nnotice\nstate\ncmate-brief:0123abcd>>>';

describe('M3: brief with / without × multi-line / one-line body', () => {
  it.each([
    ['no brief, one line', '', 'hi'],
    ['no brief, multi-line', '', 'line one\nline two'],
    ['brief, one line', `${BRIEF}\n\n`, 'hi'],
    ['brief, multi-line', `${BRIEF}\n\n`, 'line one\n\nline two'],
  ])('%s: the envelope sits right before the body, and comes off leaving brief + body', (_name, prefix, body) => {
    const typed = insertAskEnvelope(`${prefix}${body}`, body, ASK);
    expect(typed).toBe(`${prefix}${formatAskEnvelope(ASK)}\n${body}`);
    // Never in front of the brief: History's brief rule still sees it.
    if (prefix) expect(typed!.startsWith('<<<cmate-brief:')).toBe(true);
    const stripped = stripAskEnvelope(typed!);
    expect(stripped).toEqual({ askId: ASK, text: `${prefix}${body}` });
    if (prefix) expect(afterDeliveredBrief(normalizeUserTurnContent(stripped!.text))).toBe(normalizeUserTurnContent(body));
  });

  it('reads the transcript\'s CRLF and a trailing blank on the envelope line', () => {
    expect(stripAskEnvelope(`${formatAskEnvelope(ASK)}  \r\nhi`)).toEqual({ askId: ASK, text: 'hi' });
  });

  it('declines a typed text that does not end with the body (no envelope rather than a wrong place)', () => {
    expect(insertAskEnvelope('something else', 'hi', ASK)).toBeNull();
  });
});

describe('M2 negative controls: text without an envelope at its place is untouched', () => {
  it.each([
    ['a plain body', 'hello'],
    ['a relay body', '[from codex / wt]\nthe reply'],
    ['a brief-only send', `${BRIEF}\n\nbody`],
    ['an envelope quoted mid-text', `please read:\n${formatAskEnvelope(ASK)}\nthanks`],
    ['an envelope after the body', `${BRIEF}\n\nbody\n${formatAskEnvelope(ASK)}`],
    ['a malformed envelope', '[cmate-ask v2 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]\nhi'],
  ])('%s', (_name, text) => {
    expect(stripAskEnvelope(text)).toBeNull();
  });
});

describe('M4: command bodies carry no envelope', () => {
  it.each(['/compact', '/model opus', '!ls', '#memo'])('%s is a command body', (body) => {
    expect(isAskCommandBody(body)).toBe(true);
  });
  it.each(['hi', 'what does /compact do?', 'a # inside'])('%s is not', (body) => {
    expect(isAskCommandBody(body)).toBe(false);
  });
});

describe('askId', () => {
  it('accepts a lower-case UUID only', () => {
    expect(isAskId(ASK)).toBe(true);
    expect(isAskId(ASK.toUpperCase())).toBe(false);
    expect(isAskId('x')).toBe(false);
    expect(isAskId(1)).toBe(false);
  });
});
