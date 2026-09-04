/**
 * The session-scope key `s`, end to end through the real registry (Issue #2297).
 *
 * claude's `/model` overlay closes with
 *
 *     Enter to set as default · s to use this session only · Esc to cancel
 *
 * and before this Issue CommandMate could send the first key and not the second.
 * That is not a missing convenience: `Enter` there rewrites `model` in
 * `~/.claude/settings.json` (Issue #1495), so every model change made from the
 * chat surface changed the user's default for every future session, from a
 * button whose cap read `↵`.
 *
 * Making `s` reachable needs THREE things to agree, and the failure mode of each
 * one is silent:
 *
 *  1. the declaring tool publishes it (`ICLITool.navigationKeys()`), or the
 *     route answers 400 for a key the UI is drawing;
 *  2. the transport can deliver it (`ALLOWED_SPECIAL_KEYS`), or the route
 *     validates the request and then throws mid-send — Issue #2032's exact
 *     shape;
 *  3. the CLIENT list the chat surface reads (`SESSION_SCOPE_KEY_TOOL_IDS`)
 *     matches (1), or the button appears for a tool that will refuse it.
 *
 * (1) and (2) are asserted for every tool in the registry by
 * `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts`. What is
 * pinned HERE is the pair (1)↔(3) and the negative half — that `s` reaches
 * exactly two tools — because that is the half a future widening would break
 * without any test going red on its own.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isAllowedSpecialKey, isSendableSpecialKey } from '@/lib/tmux/tmux';
import {
  CLAUDE_NAVIGATION_KEY_VALUES,
  NAVIGATION_KEY_VALUES,
  SESSION_SCOPE_KEY,
  SESSION_SCOPE_KEY_TOOL_IDS,
  TERMINAL_KEY_VALUES,
} from '@/types/terminal-keys';

const manager = CLIToolManager.getInstance();

/** The declared vocabulary of one tool, as plain strings. */
function vocabulary(id: CLIToolType): readonly string[] {
  return manager.getTool(id).navigationKeys().keys as readonly string[];
}

describe('[#2297] the key itself', () => {
  it('is the single character claude prints in its footer', () => {
    expect(SESSION_SCOPE_KEY).toBe('s');
  });

  it('is in the union the transport is checked against', () => {
    expect(TERMINAL_KEY_VALUES as readonly string[]).toContain(SESSION_SCOPE_KEY);
  });

  it('is deliverable by sendSpecialKeys()', () => {
    // Mutation guard the Issue asks for by name: remove `'s'` from
    // ALLOWED_SPECIAL_KEYS and this goes red — as does every "the button works"
    // assertion downstream, which is the point of asserting it at this level too.
    expect(isSendableSpecialKey(SESSION_SCOPE_KEY)).toBe(true);
  });

  it('is NOT in the shared pad, so no tool gets it by default', () => {
    // `s` is a live binding elsewhere — `s sort:relevance` on copilot's session
    // picker (measured on 1.0.82), and a bare composer character in opencode.
    expect(NAVIGATION_KEY_VALUES as readonly string[]).not.toContain(SESSION_SCOPE_KEY);
  });

  it('is the ONLY thing CLAUDE_NAVIGATION_KEY_VALUES adds to the shared pad', () => {
    expect(CLAUDE_NAVIGATION_KEY_VALUES).toEqual([...NAVIGATION_KEY_VALUES, SESSION_SCOPE_KEY]);
    expect(new Set(CLAUDE_NAVIGATION_KEY_VALUES).size).toBe(CLAUDE_NAVIGATION_KEY_VALUES.length);
  });
});

describe('[#2297] which tools declare it', () => {
  it.each([...SESSION_SCOPE_KEY_TOOL_IDS])('%s declares `s`', (id) => {
    expect(vocabulary(id as CLIToolType)).toContain(SESSION_SCOPE_KEY);
  });

  it('names claude and Command Code, and only those two', () => {
    // Command Code is here for KINSHIP, not for a footer of its own: measured on
    // v1.40.1, its `/model` picker is a name list with a search box and an
    // `enter to select · esc to cancel` footer, and nothing on it offers a
    // session scope. The chat surface therefore draws no `s` button there — the
    // button is gated on the FOOTER (`readSelectionListShape`), not on the tool
    // id — so declaring the key costs nothing and keeps the two halves of the
    // claude family from drifting apart.
    expect([...SESSION_SCOPE_KEY_TOOL_IDS].sort()).toEqual(['claude', 'command-code']);
  });

  it('gives it to nobody else, quantified over the whole registry', () => {
    const declaring = CLI_TOOL_IDS.filter((id) => vocabulary(id).includes(SESSION_SCOPE_KEY));

    expect([...declaring].sort()).toEqual([...SESSION_SCOPE_KEY_TOOL_IDS].sort());
  });

  it('keeps the client-side list equal to the declarations', () => {
    // `ChatSurface` cannot call `navigationKeys()` — it lives behind the CLITool
    // gateway on the server — so it reads `SESSION_SCOPE_KEY_TOOL_IDS` instead.
    // A drift here is a visible button that answers 400 when pressed.
    const declaring = CLI_TOOL_IDS.filter((id) => vocabulary(id).includes(SESSION_SCOPE_KEY));

    expect(new Set(SESSION_SCOPE_KEY_TOOL_IDS)).toEqual(new Set(declaring));
  });
});

describe('[#2297] what the route would answer', () => {
  it('accepts `s` for a declaring tool and refuses it for every other', () => {
    for (const id of CLI_TOOL_IDS) {
      const allowed = isAllowedSpecialKey(SESSION_SCOPE_KEY, vocabulary(id));
      expect(allowed, `${id} + s`).toBe(
        (SESSION_SCOPE_KEY_TOOL_IDS as readonly string[]).includes(id),
      );
    }
  });

  it('does not widen the claude family beyond `s`', () => {
    // The letters around it, and the ones #2254 / #2046 deliberately left out,
    // stay refused for claude. A vocabulary that grew by accident would show up
    // here before it showed up on a pane.
    for (const key of ['S', 'z', 'x', '0', '10', 'a', 'C-x']) {
      expect(isAllowedSpecialKey(key, CLAUDE_NAVIGATION_KEY_VALUES), `claude + ${key}`).toBe(false);
    }
  });

  it('leaves every claude-family key deliverable — the #2032 invariant, per tool', () => {
    for (const id of SESSION_SCOPE_KEY_TOOL_IDS) {
      const undeliverable = vocabulary(id as CLIToolType).filter((key) => !isSendableSpecialKey(key));
      expect(undeliverable, `${id} declares undeliverable keys`).toEqual([]);
    }
  });
});
