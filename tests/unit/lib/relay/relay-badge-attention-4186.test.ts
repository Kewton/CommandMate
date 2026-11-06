import { describe, it, expect } from 'vitest';
import { relayToneNeedsAttention, type RelayBadgeTone } from '@/lib/relay/relay-badges';

// Record<RelayBadgeTone, boolean>: adding a tone to the type is a tsc error here until it is listed.
const EXPECTED: Record<RelayBadgeTone, boolean> = {
  prompt: true,
  held: true,
  blocked: true,
  owed: false,
  awaiting: false,
};

describe('relayToneNeedsAttention (#4186)', () => {
  it.each(Object.entries(EXPECTED) as [RelayBadgeTone, boolean][])('%s -> %s', (tone, expected) => {
    expect(relayToneNeedsAttention(tone)).toBe(expected);
  });
});
