/**
 * Unit tests for the sentences a relay puts in front of an agent (#2377).
 *
 * The header is asserted in BOTH languages, because it is the one token a
 * consumer may match on and a translation that moved it would break attribution
 * silently.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  RELAY_HEADER_PREFIX,
  buildRelayExpiredMessage,
  buildRelayHeader,
  buildRelayPromptMessage,
  buildRelayReplyMessage,
  buildRelaySystemLine,
} from '@/lib/relay/relay-messages';

const SENDER = { alias: 'Codex 2', worktreeId: 'anvil-feature-2377' };

describe('buildRelayHeader', () => {
  it('names both the alias and the worktree', () => {
    expect(buildRelayHeader(SENDER)).toBe('[from Codex 2 / anvil-feature-2377]');
  });

  it('starts with the machine-readable prefix', () => {
    expect(buildRelayHeader(SENDER).startsWith(RELAY_HEADER_PREFIX)).toBe(true);
  });
});

describe('buildRelayReplyMessage', () => {
  it('passes the body through verbatim after the header', () => {
    const body = 'Done. Changed `src/lib/x.ts`:\n\n- one\n- two';

    expect(buildRelayReplyMessage(SENDER, body)).toBe(
      `[from Codex 2 / anvil-feature-2377] ${body}`
    );
  });

  it('trims the body without rewrapping it', () => {
    expect(buildRelayReplyMessage(SENDER, '  hello  ')).toBe(
      '[from Codex 2 / anvil-feature-2377] hello'
    );
  });

  it('still delivers a header when the turn produced nothing', () => {
    const message = buildRelayReplyMessage(SENDER, '   ');

    expect(message.startsWith(RELAY_HEADER_PREFIX)).toBe(true);
    expect(message).toContain('no reply body');
  });
});

describe('buildRelayPromptMessage', () => {
  const notice = {
    question: 'Allow Bash(rm -rf build)?',
    options: [
      { key: '1', label: 'Yes' },
      { key: '2', label: 'Yes, and do not ask again' },
      { key: '3', label: 'No' },
    ],
  };

  it('quotes the question and lists the options', () => {
    const message = buildRelayPromptMessage('en', SENDER, notice);

    expect(message).toContain('[from Codex 2 / anvil-feature-2377]');
    expect(message).toContain('Allow Bash(rm -rf build)?');
    expect(message).toContain('1) Yes');
    expect(message).toContain('3) No');
  });

  it('is written in Japanese for a ja reader, header unchanged', () => {
    const message = buildRelayPromptMessage('ja', SENDER, notice);

    expect(message.startsWith(RELAY_HEADER_PREFIX)).toBe(true);
    expect(message).toContain('確認待ちです:');
    expect(message).toContain('選択肢:');
  });

  it('flattens a multi-line question onto one line', () => {
    const message = buildRelayPromptMessage('en', SENDER, {
      question: 'line one\n  line two\n\nline three',
      options: [],
    });

    expect(message).toContain('line one line two line three');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('clips a very long question rather than pasting a pane into a composer', () => {
    const message = buildRelayPromptMessage('en', SENDER, {
      question: 'x'.repeat(500),
      options: [],
    });

    expect(message.length).toBeLessThan(300);
    expect(message).toContain('…');
  });

  it('counts the options it did not list', () => {
    const message = buildRelayPromptMessage('en', SENDER, {
      question: 'Pick one',
      options: Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), label: `opt ${i}` })),
    });

    expect(message).toContain('(+3 more)');
  });

  it('omits the option line entirely when there are none', () => {
    const message = buildRelayPromptMessage('en', SENDER, { question: 'Waiting', options: [] });

    expect(message).not.toContain('Options:');
  });
});

describe('buildRelayExpiredMessage', () => {
  it('reports the window in hours, in one line', () => {
    const message = buildRelayExpiredMessage('en', SENDER, 24 * 60 * 60 * 1000);

    expect(message).toContain('24h');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('is written in Japanese for a ja reader', () => {
    expect(buildRelayExpiredMessage('ja', SENDER, 24 * 60 * 60 * 1000)).toContain('期限切れ');
  });

  it('never reports less than an hour', () => {
    expect(buildRelayExpiredMessage('en', SENDER, 60_000)).toContain('1h');
  });
});

describe('buildRelaySystemLine', () => {
  it('names the other session in every line', () => {
    for (const kind of ['requested', 'replied', 'waiting', 'expired'] as const) {
      expect(buildRelaySystemLine('en', kind, 'Codex 2')).toContain('Codex 2');
      expect(buildRelaySystemLine('ja', kind, 'Codex 2')).toContain('Codex 2');
    }
  });

  it('uses the Issue\'s own Japanese wording', () => {
    expect(buildRelaySystemLine('ja', 'requested', 'Codex 2')).toBe('Codex 2 へ委任、返信待ち');
    expect(buildRelaySystemLine('ja', 'replied', 'Codex 2')).toBe('Codex 2 から返信');
  });

  it('leaves no placeholder behind', () => {
    for (const locale of ['en', 'ja'] as const) {
      for (const kind of ['requested', 'replied', 'waiting', 'expired'] as const) {
        expect(buildRelaySystemLine(locale, kind, 'X')).not.toContain('{alias}');
      }
    }
  });
});
