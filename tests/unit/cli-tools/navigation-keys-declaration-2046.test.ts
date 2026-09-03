/**
 * Issue #2046: the special-keys vocabulary moved from one global list into a
 * per-tool declaration (`ICLITool.navigationKeys()`).
 *
 * Two things have to stay true across that move, and they pull in opposite
 * directions:
 *
 * 1. **Nothing changes for the six tools that were already shipping.** claude,
 *    codex, copilot, gemini, antigravity and vibe-local must publish exactly the
 *    keys `NAVIGATION_KEY_VALUES` published before this Issue — the same set, in
 *    the same order, with no leader. The diff is asserted to be empty in both
 *    directions rather than by spot-checking a few members.
 * 2. **The #2032 invariant survives being quantified.** It used to read
 *    `NAVIGATION_KEY_VALUES` ⊆ `ALLOWED_SPECIAL_KEYS`. Per tool it reads: for
 *    every tool in the registry, every key it declares is one
 *    `sendSpecialKeys()` will actually hand to tmux. Break it and #2032 comes
 *    straight back — the route validates a request and then throws mid-send,
 *    reporting a 500 for a key it just advertised.
 *
 * The registry is walked from `CLI_TOOL_IDS` rather than from a list written
 * here, so a seventh tool is covered the moment it is registered.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isSendableSpecialKey } from '@/lib/tmux/tmux';
import {
  NAVIGATION_KEY_VALUES,
  OPENCODE_DIRECT_KEY_VALUES,
  OPENCODE_LEADER_CHORD_VALUES,
  OPENCODE_LEADER_KEY,
  OPENCODE_NAVIGATION_KEY_VALUES,
  TERMINAL_KEY_VALUES,
} from '@/types/terminal-keys';

/** Every tool but opencode — the ones whose key set this Issue must not move. */
const UNCHANGED_TOOLS: readonly CLIToolType[] = CLI_TOOL_IDS.filter((id) => id !== 'opencode');

const manager = CLIToolManager.getInstance();

/**
 * The base pad as a set, for the Issue #2254 overlap.
 *
 * `n` is both an opencode leader chord (`ctrl+x n`, #2046) and one of the two
 * letters a bare `[y/n]` accepts (#2254), so it is in BOTH lists and the
 * "no tool but opencode gets a chord letter" rule has to be stated as
 * "no tool but opencode gets a chord letter the base pad does not already have".
 */
const BASE_KEYS = new Set<string>(NAVIGATION_KEY_VALUES);

describe('Issue #2046: every tool but opencode declares the pre-#2046 set, unchanged', () => {
  it.each(UNCHANGED_TOOLS)('%s publishes exactly NAVIGATION_KEY_VALUES', (id) => {
    const spec = manager.getTool(id).navigationKeys();

    // Equality, not containment: a tool that quietly gained a key would be as
    // much of a regression as one that lost it.
    expect(spec.keys).toEqual([...NAVIGATION_KEY_VALUES]);
    expect(spec.leaderKey).toBeNull();
  });

  it('names them explicitly, so deleting one from the registry cannot silently shrink this suite', () => {
    expect([...UNCHANGED_TOOLS].sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      // Issue #2250: Command Code takes the shared set. Its TUI is driven by
      // arrows, Enter and Esc like the rest; only opencode has chords.
      'command-code',
      'copilot',
      'gemini',
      'vibe-local',
    ]);
  });

  it('gives none of them a leader key or any opencode-ONLY chord letter', () => {
    for (const id of UNCHANGED_TOOLS) {
      const { keys, leaderKey } = manager.getTool(id).navigationKeys();
      expect(leaderKey).toBeNull();
      expect(keys).not.toContain(OPENCODE_LEADER_KEY);
      for (const letter of OPENCODE_LEADER_CHORD_VALUES) {
        // Issue #2254: `n` is now in the base set as an ANSWER key, exactly as
        // `q` has been since #1017's codex pager quit, so it is not an
        // opencode-only letter any more and excluding it here would fail on
        // every tool. The intersection is pinned to exactly `['n']` in the test
        // below, so this skip cannot quietly grow to cover a letter that really
        // is opencode's alone.
        if ((BASE_KEYS as ReadonlySet<string>).has(letter)) continue;
        expect(keys, `${id} must not accept the bare letter ${letter}`).not.toContain(letter);
      }
    }
  });

  it('shares exactly one chord letter with the base pad — `n`, from Issue #2254', () => {
    // This is the guard the skip above rests on. Widen ANSWER_KEY_VALUES with
    // another chord letter (say `a`, opencode's agent list) and this goes red
    // BEFORE the skip can silently stop excluding it for claude.
    const shared = OPENCODE_LEADER_CHORD_VALUES.filter((letter) =>
      (BASE_KEYS as ReadonlySet<string>).has(letter)
    );
    expect(shared).toEqual(['n']);
  });

  it('derives opencode-only chords by subtracting the base pad, with nothing lost', () => {
    // `OPENCODE_CHORD_ONLY_VALUES` is written out by hand in
    // `src/types/terminal-keys.ts` (an `as const` tuple cannot be `.filter()`ed
    // without losing its literal member types), so the subtraction it stands for
    // is asserted here instead. Both directions: nothing dropped, nothing added.
    const spec = manager.getTool('opencode').navigationKeys();
    const declared = new Set<string>(spec.keys);
    for (const letter of OPENCODE_LEADER_CHORD_VALUES) {
      expect(declared.has(letter), `opencode must still publish ${letter}`).toBe(true);
    }
    // And no key is listed twice, which is what a stale hand-written list would
    // produce the moment ANSWER_KEY_VALUES and the chord letters overlap again.
    expect(new Set(spec.keys).size).toBe(spec.keys.length);
  });
});

describe('Issue #2046: opencode declares its own chords', () => {
  const spec = manager.getTool('opencode').navigationKeys();

  it('keeps the whole base pad and adds the leader, the chord letters and the two direct keys', () => {
    expect(spec.keys).toEqual([...OPENCODE_NAVIGATION_KEY_VALUES]);
    for (const key of NAVIGATION_KEY_VALUES) {
      expect(spec.keys).toContain(key);
    }
    expect(spec.keys).toContain(OPENCODE_LEADER_KEY);
    for (const key of [...OPENCODE_DIRECT_KEY_VALUES, ...OPENCODE_LEADER_CHORD_VALUES]) {
      expect(spec.keys).toContain(key);
    }
  });

  it('names ctrl+x as the leader — opencode 1.18.22’s own default', () => {
    expect(spec.leaderKey).toBe('C-x');
    expect(OPENCODE_LEADER_KEY).toBe('C-x');
  });

  it('does NOT publish `b` (sidebar_toggle) — the key #2046 measured and refused', () => {
    // The reason is in the OpencodeQuickKeys docblock and §22.3 of
    // docs/design/opencode-server-live-verification.md: at the 80-column default
    // an explicit ctrl+x b turns the sidebar on regardless of the 121-column
    // auto-gate, and detection then reads a finished turn as `running` forever.
    // Pinned here, not just in the UI, so the route also answers 400 for it.
    expect(spec.keys).not.toContain('b');
    expect(OPENCODE_LEADER_CHORD_VALUES as readonly string[]).not.toContain('b');
  });

  it('does NOT publish `F2` (model_cycle_recent) — a real binding this Issue could not measure', () => {
    expect(spec.keys as readonly string[]).not.toContain('F2');
    expect(TERMINAL_KEY_VALUES as readonly string[]).not.toContain('F2');
  });

  it('has no duplicate entries', () => {
    expect(new Set(spec.keys).size).toBe(spec.keys.length);
  });
});

describe('Issue #2032 invariant, quantified over the registry (Issue #2046)', () => {
  it('leaves an empty difference set for EVERY tool: nothing declared is undeliverable', () => {
    const undeliverable: Array<{ tool: CLIToolType; key: string }> = [];
    for (const id of CLI_TOOL_IDS) {
      for (const key of manager.getTool(id).navigationKeys().keys) {
        if (!isSendableSpecialKey(key)) undeliverable.push({ tool: id, key });
      }
    }

    // Red the moment a tool publishes a key `sendSpecialKeys()` refuses — which
    // is the exact shape of #2032 (route says 200-worthy, transport throws 500).
    expect(undeliverable).toEqual([]);
  });

  it('holds for a tool’s declared leader key as well as its list', () => {
    for (const id of CLI_TOOL_IDS) {
      const { leaderKey } = manager.getTool(id).navigationKeys();
      if (leaderKey === null) continue;
      expect(isSendableSpecialKey(leaderKey), `${id} leader ${leaderKey}`).toBe(true);
    }
  });

  it('keeps every declaration inside TERMINAL_KEY_VALUES, the union the transport is checked against', () => {
    const union = new Set<string>(TERMINAL_KEY_VALUES);
    for (const id of CLI_TOOL_IDS) {
      for (const key of manager.getTool(id).navigationKeys().keys) {
        expect(union.has(key), `${id} declares ${key}, which is outside TERMINAL_KEY_VALUES`).toBe(true);
      }
    }
  });

  it('is still containment and not equality — `Space` / `BSpace` / `DC` stay deliverable and unpublished', () => {
    const published = new Set<string>();
    for (const id of CLI_TOOL_IDS) {
      for (const key of manager.getTool(id).navigationKeys().keys) published.add(key);
    }
    for (const key of ['Space', 'BSpace', 'DC']) {
      expect(isSendableSpecialKey(key)).toBe(true);
      expect(published.has(key)).toBe(false);
    }
  });
});
