/**
 * Invisible characters at the brief's exit, as an allow-list (PM re-review P2-1,
 * 2026-11-09): every Default_Ignorable_Code_Point, every Cf / Zl / Zp / Co code point and
 * every variation selector is replaced by `[U+XXXX]`, and the only exceptions are those
 * of an emoji sequence — a ZWJ between two emoji, VS15 / VS16 after an emoji character,
 * the tags of an RGI subdivision flag.
 *
 * Checked over every code point (U+0000〜U+10FFFF, surrogates excluded), alone and in
 * each context an exception could apply in. A wider exception fails here.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { BRIEF_INVISIBLE, keptInvisible, revealInvisible } from '@/lib/brief/sanitize';
import { applyText, type BriefSourceReader } from '@/lib/brief/sources';
import type { BriefEntry } from '@/types/brief';
import { BriefWorld, resetBriefMemory } from './brief-4223-harness';

/** The rule as the PM wrote it, independent of the implementation's pattern. */
const SPEC = [
  /\p{Default_Ignorable_Code_Point}/u,
  /\p{General_Category=Cf}/u,
  /\p{General_Category=Zl}/u,
  /\p{General_Category=Zp}/u,
  /\p{General_Category=Co}/u,
  /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u,
];
const inSpec = (char: string): boolean => SPEC.some((rule) => rule.test(char));
const tag = (text: string): string => Array.from(text, (char) => String.fromCodePoint(0xe0000 + (char.codePointAt(0) ?? 0))).join('');
const CANCEL = '\u{E007F}';

function* specCodePoints(): Generator<number> {
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (inSpec(String.fromCodePoint(code))) yield code;
  }
}

/** Contexts an exception could apply in, and which code points the PM's rule keeps there. */
const CONTEXTS: Array<{ name: string; wrap: (c: string) => string; index: number; allowed: (code: number) => boolean }> = [
  { name: 'between two emoji', wrap: (c) => `😀${c}😀`, index: 1, allowed: (code) => code === 0x200d || code === 0xfe0e || code === 0xfe0f },
  { name: 'after a keycap digit', wrap: (c) => `1${c}`, index: 1, allowed: (code) => code === 0xfe0e || code === 0xfe0f },
  { name: 'after a letter', wrap: (c) => `a${c}b`, index: 1, allowed: () => false },
  // PM re-review P3-2: a ZWJ needs an emoji before it, not only after.
  { name: 'between a letter and an emoji', wrap: (c) => `a${c}😀`, index: 1, allowed: () => false },
  // codex re-review P2: a VS16 that is replaced is no ground for keeping what follows it.
  { name: 'after a replaced VS16 before an emoji', wrap: (c) => `a\u{FE0F}${c}😀`, index: 2, allowed: () => false },
  { name: 'after a kept VS16 before an emoji', wrap: (c) => `❤\u{FE0F}${c}😀`, index: 2, allowed: (code) => code === 0x200d },
  // 🏴 is an emoji character itself, so VS15 / VS16 right after it are its presentation.
  { name: 'alone after a black flag', wrap: (c) => `🏴${c}${CANCEL}`, index: 1, allowed: (code) => code === 0xfe0e || code === 0xfe0f },
  { name: 'inside an RGI flag', wrap: (c) => `🏴${tag('gbe')}${c}${tag('g')}${CANCEL}`, index: 4, allowed: (code) => code === 0xe006e },
];

type Keep = (codes: readonly number[]) => Set<number>;

/** How many (code point, context) pairs keep what the rule does not allow, or replace what it does. */
function mismatches(keep: Keep): string[] {
  const out: string[] = [];
  for (const code of specCodePoints()) {
    const char = String.fromCodePoint(code);
    const alone = revealInvisible(char, keep);
    if (alone !== `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`) out.push(`alone U+${code.toString(16)}`);
    for (const context of CONTEXTS) {
      const kept = keep(Array.from(context.wrap(char), (c) => c.codePointAt(0) ?? 0)).has(context.index);
      if (kept !== context.allowed(code)) out.push(`${context.name} U+${code.toString(16)}`);
    }
  }
  return out;
}

describe('every invisible code point is replaced, but for the emoji exceptions', () => {
  it('the pattern is the rule: every code point (U+0000〜U+10FFFF, no surrogates) agrees', () => {
    const disagree: number[] = [];
    let covered = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      if (inSpec(char)) covered += 1;
      if (inSpec(char) !== BRIEF_INVISIBLE.test(char)) disagree.push(code);
    }
    expect(disagree).toEqual([]);
    expect(covered).toBeGreaterThan(140_000); // the private-use planes are in it
  });

  it('no invisible code point is left unreplaced, alone or in any context, except the allowed ones', () => {
    expect(mismatches(keptInvisible)).toEqual([]);
  });

  it('positive control: a wider exception fails (any variation selector after an emoji, a ZWJ anywhere, any tag flag)', () => {
    const anyVs: Keep = (codes) => {
      const kept = keptInvisible(codes);
      codes.forEach((code, i) => {
        if (code >= 0xfe00 && code <= 0xfe0f && i > 0 && /\p{Emoji}/u.test(String.fromCodePoint(codes[i - 1]))) kept.add(i);
      });
      return kept;
    };
    const anyZwj: Keep = (codes) => {
      const kept = keptInvisible(codes);
      codes.forEach((code, i) => code === 0x200d && kept.add(i));
      return kept;
    };
    const anyFlag: Keep = (codes) => {
      const kept = keptInvisible(codes);
      codes.forEach((code, i) => code >= 0xe0020 && code <= 0xe007f && i > 0 && kept.add(i));
      return kept;
    };
    // The ZWJ rule without its "an emoji before it" half (PM re-review P3-2).
    const zwjBeforeEmoji: Keep = (codes) => {
      const kept = keptInvisible(codes);
      codes.forEach((code, i) => code === 0x200d && /\p{Extended_Pictographic}/u.test(String.fromCodePoint(codes[i + 1] ?? 0)) && kept.add(i));
      return kept;
    };
    // The ZWJ rule that takes any VS16 before it as an emoji's, replaced or not (codex re-review P2).
    const anyVs16: Keep = (codes) => {
      const kept = keptInvisible(codes);
      codes.forEach((code, i) => code === 0x200d && codes[i - 1] === 0xfe0f && /\p{Extended_Pictographic}/u.test(String.fromCodePoint(codes[i + 1] ?? 0)) && kept.add(i));
      return kept;
    };
    for (const wider of [anyVs, anyZwj, anyFlag, zwjBeforeEmoji, anyVs16]) expect(mismatches(wider).length).toBeGreaterThan(0);
  });

  it('a VS16 and a ZWJ outside an emoji sequence are both shown (codex re-review P2)', () => {
    expect(revealInvisible('a\u{FE0F}\u{200D}😀')).toBe('a[U+FE0F][U+200D]😀');
    expect(revealInvisible('a\u{200D}😀')).toBe('a[U+200D]😀');
    expect(revealInvisible('1\u{FE0F}\u{200D}😀')).toBe('1\u{FE0F}[U+200D]😀');
    expect(Array.from(revealInvisible('x\u{FE0F}\u{200D}\u{FE0F}\u{200D}😀'))).not.toContain('\u{200D}');
  });

  it('negative: Japanese and emoji sequences are kept as they are', () => {
    for (const text of ['🧑‍🦰', '👨‍👩‍👧', '❤️‍🔥', '🏳️‍⚧️', '🫱🏻‍🫲🏼', '1️⃣', `🏴${tag('gbeng')}${CANCEL}`, '日本語の項目 👩‍💻 🇯🇵 é と「引用」']) {
      expect(revealInvisible(text)).toBe(text);
    }
  });

  it('the price of the allow-list (accepted, design §3.3): Persian ZWNJ, Indic ZWJ, a CJK variant and other tag flags are shown', () => {
    expect(revealInvisible('می‌خواهم')).toBe('می[U+200C]خواهم');
    expect(revealInvisible('क्‍ष')).toBe('क्[U+200D]ष');
    expect(revealInvisible('葛\u{E0100}')).toBe('葛[U+E0100]');
    expect(revealInvisible(`🏴${tag('usca')}${CANCEL}`)).toBe('🏴[U+E0075][U+E0073][U+E0063][U+E0061][U+E007F]');
  });
});

describe('through the brief: text and --json', () => {
  const world = new BriefWorld();
  const HIDDEN = 'soft­hy vs\u{FE01}x ivs\u{E0100} mongol᠎ fillerㅤ anchor\u{FFF9} pua\u{E000} tag\u{E0041}';
  const KEEP = '🧑‍🦰 👨‍👩‍👧 ❤️‍🔥 🏳️‍⚧️ 🫱🏻‍🫲🏼 1️⃣ 日本語';
  const mem = (texts: string[]): BriefSourceReader => (ctx) => ({
    status: 'ok',
    items: texts.map((text, index) => {
      const entry: BriefEntry = {
        rank: 5,
        source: 'mem',
        id: `m_${index}`,
        author: { type: 'agent', instanceId: 'claude' },
        updatedAt: '2026-11-09T00:00:00.000Z',
        observedAt: new Date(ctx.now).toISOString(),
        fields: { kind: 'next', state: 'open' },
      };
      applyText(entry, text, 'text', ctx.readAll);
      return { entry, sourceIndex: 7, sortAt: index };
    }),
  });

  beforeEach(() => {
    resetBriefMemory();
    world.open('brief-invisible-4223-');
    world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
    world.setMode('on');
  });
  afterEach(() => {
    world.close();
    resetBriefMemory();
  });

  it.each([null, 'json'] as const)('format %s: no invisible code point left in a mem text or a task title; emoji kept', async (format) => {
    world.task({ title: HIDDEN });
    const out = (await world.brief({ format, all: '1' }, { readers: { mem: mem([HIDDEN, KEEP]) } })).stdout;
    const left = Array.from(out).filter((char) => inSpec(char) && !'‍️'.includes(char));
    expect(left).toEqual([]);
    for (const shown of ['[U+00AD]', '[U+FE01]', '[U+E0100]', '[U+180E]', '[U+3164]', '[U+FFF9]', '[U+E000]', '[U+E0041]']) expect(out).toContain(shown);
    expect(out).toContain(format === 'json' ? KEEP : JSON.stringify(KEEP));
  });
});
