/**
 * The mode declaration, end to end through the real registry (Issue #2592).
 *
 * Modelled on `./session-scope-key-2297.test.ts`, because it is the same shape
 * of fact and the same shape of silent failure. Making a mode button work needs
 * FOUR things to agree, and none of them fails loudly on its own:
 *
 *  1. the tool DECLARES a cycle (`ICLITool.agentModeSpec()`), or there is
 *     nothing to draw;
 *  2. the declared key is in that tool's `navigationKeys()`, or
 *     `POST /api/worktrees/[id]/special-keys` answers 400 for the very key the
 *     button sends (Issue #2046's per-tool vocabulary);
 *  3. the transport can deliver it (`ALLOWED_SPECIAL_KEYS`), or the route
 *     validates the request and then throws mid-send — Issue #2032's exact
 *     shape, reported to the user as a 500;
 *  4. the CLIENT list the surfaces read (`AGENT_MODE_TOOL_IDS`) matches (1), or
 *     a button appears for a tool that has no mode at all.
 *
 * The NEGATIVE half is what this file is really for. "Five tools declare a mode
 * and three deliberately do not" is a decision with a reason per tool
 * (see `src/lib/cli-tools/agent-mode-spec.ts`), and nothing else in the suite
 * would go red if a sixth quietly appeared.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { AGENT_MODE_TOOL_IDS, resolveAgentModeSpec } from '@/lib/cli-tools/agent-mode-spec';
import { isAllowedSpecialKey, isSendableSpecialKey } from '@/lib/tmux/tmux';
import {
  AGENT_MODE_IDS,
  isAgentModeId,
  type AgentModeSpec,
} from '@/types/cli-tool-contracts';

const manager = CLIToolManager.getInstance();

/** The tools Issue #2592 measured a `shift+tab` mode cycle on. */
const DECLARING = ['antigravity', 'claude', 'codex', 'command-code', 'copilot'] as const;

/**
 * The tools that must NOT declare one, and why.
 *
 *  - `opencode` — `BTab` there is `agent_cycle_reverse`, already surfaced by
 *    `OpencodeQuickKeys`' `agentPrev` button (#2046). Two buttons on one key
 *    promising different things is the thing this absence prevents.
 *  - `vibe-local` — measured: five presses, byte-identical frame.
 *  - `gemini` — the binding exists in its own docs, the footer spelling does
 *    not exist anywhere. A button is a promise about what happens.
 */
const NOT_DECLARING = ['gemini', 'opencode', 'vibe-local'] as const;

function spec(id: CLIToolType): AgentModeSpec | null {
  return manager.getTool(id).agentModeSpec();
}

function vocabulary(id: CLIToolType): readonly string[] {
  return manager.getTool(id).navigationKeys().keys as readonly string[];
}

describe('[#2592] which tools declare a mode cycle', () => {
  it.each([...DECLARING])('%s declares one', (id) => {
    expect(spec(id)).not.toBeNull();
  });

  it.each([...NOT_DECLARING])('%s declares none', (id) => {
    expect(spec(id)).toBeNull();
  });

  it('is exactly those five, quantified over the whole registry', () => {
    const declaring = CLI_TOOL_IDS.filter((id) => spec(id) !== null);

    expect([...declaring].sort()).toEqual([...DECLARING]);
  });

  it('accounts for every supported tool, so a new one cannot slip through', () => {
    expect([...DECLARING, ...NOT_DECLARING].sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it('keeps the client-side list equal to the declarations', () => {
    // The browser cannot call `agentModeSpec()` — `ICLITool` lives behind the
    // CLITool gateway on the server (§4 D4) — so the surfaces read
    // `AGENT_MODE_TOOL_IDS` instead. Same arrangement, and same hazard, as
    // `SESSION_SCOPE_KEY_TOOL_IDS` since #2297.
    const declaring = CLI_TOOL_IDS.filter((id) => spec(id) !== null);

    expect(new Set(AGENT_MODE_TOOL_IDS)).toEqual(new Set(declaring));
  });

  it('answers the same thing through the class and through the table', () => {
    // `BaseCLITool.agentModeSpec()` is a thin delegation today. If a tool ever
    // overrides it, this is where the table stops being the whole truth.
    for (const id of CLI_TOOL_IDS) {
      expect(spec(id), id).toBe(resolveAgentModeSpec(id));
    }
  });
});

describe('[#2592] the key every declaration sends', () => {
  it('is `BTab` for all five', () => {
    for (const id of DECLARING) {
      expect(spec(id)?.key, id).toBe('BTab');
    }
  });

  it('is in the declaring tool’s own navigation vocabulary (#2046)', () => {
    // Without this the button draws a request the route answers 400 for, which
    // is invisible until somebody presses it.
    for (const id of DECLARING) {
      expect(vocabulary(id), id).toContain(spec(id)!.key);
    }
  });

  it('passes isSendableSpecialKey() — the #2032 invariant', () => {
    // Stated for the declared key specifically, and not merely inherited from
    // the #2046 suite's sweep, because THIS is the key a new button sends.
    for (const id of DECLARING) {
      expect(isSendableSpecialKey(spec(id)!.key), id).toBe(true);
    }
  });

  it('is what the route would accept for that tool, and only through that tool’s list', () => {
    for (const id of CLI_TOOL_IDS) {
      // `BTab` has been in the shared pad since #473, so every tool accepts it —
      // including the three with no mode. That is the pre-existing contract and
      // this Issue does not narrow it; what stops a mode button appearing for
      // them is the DECLARATION, not the vocabulary.
      expect(isAllowedSpecialKey('BTab', vocabulary(id)), id).toBe(true);
    }
  });
});

describe('[#2592] the shape of each declaration', () => {
  it('names a non-empty cycle of known mode ids', () => {
    for (const id of DECLARING) {
      const { cycle } = spec(id)!;
      expect(cycle.length, id).toBeGreaterThanOrEqual(2);
      for (const mode of cycle) expect(isAgentModeId(mode), `${id}/${mode}`).toBe(true);
      expect(new Set(cycle).size, `${id} repeats a mode`).toBe(cycle.length);
    }
  });

  it('records the measured cycle for each tool, in the measured order', () => {
    // The orders Issue #2592 read off the live TUIs on 2026-09-16. Pinned
    // because the UI states them to the user, and a reordered list would be a
    // confident lie about what the next press does.
    expect(spec('claude')!.cycle).toEqual(['auto', 'manual', 'accept-edits', 'plan']);
    expect(spec('command-code')!.cycle).toEqual(['default', 'accept-edits', 'plan']);
    expect(spec('codex')!.cycle).toEqual(['default', 'plan']);
    expect(spec('copilot')!.cycle).toEqual(['default', 'plan', 'autopilot']);
    expect(spec('antigravity')!.cycle).toEqual(['default', 'accept-edits', 'plan']);
  });

  it('can read at least every mode its own cycle contains, or knowingly cannot', () => {
    // Four of the five draw nothing in their base mode (#2592 §3), so a
    // declaration whose indicators cover the whole cycle is the exception, not
    // the rule. What must hold is the direction: every indicator names a mode,
    // and any cycle member WITHOUT an indicator is one of the measured silent
    // base modes — never a mode somebody forgot a pattern for.
    const SILENT_BASE_MODES: Partial<Record<CLIToolType, readonly string[]>> = {
      codex: ['default'],
      copilot: ['default'],
      antigravity: ['default'],
    };
    for (const id of DECLARING) {
      const { cycle, indicators } = spec(id)!;
      const readable = new Set(indicators.map((i) => i.mode));
      const missing = cycle.filter((mode) => !readable.has(mode));
      expect(missing, `${id} cannot read`).toEqual([...(SILENT_BASE_MODES[id] ?? [])]);
    }
  });

  it('may declare indicators for modes OUTSIDE the cycle, and Command Code does', () => {
    // `shift+tab` cannot reach `permission bypass` / `don't-ask`, but a user can
    // get there from the terminal — and on 1.53.1, where `? for shortcuts` is
    // drawn in every mode, a reader without these would fall through and publish
    // `default` for a pane that is bypassing permissions.
    const readable = spec('command-code')!.indicators.map((i) => i.mode);
    expect(readable).toContain('bypass');
    expect(readable).toContain('dont-ask');
    expect(spec('command-code')!.cycle).not.toContain('bypass');
    expect(spec('command-code')!.cycle).not.toContain('dont-ask');
  });

  it('puts the catch-all indicator LAST where one exists', () => {
    // Command Code's `? for shortcuts` is drawn in every mode on 1.53.1, so it
    // is only a correct reading of `default` once every mode row has been
    // checked. The reader returns the first match, so the order IS the rule.
    const indicators = spec('command-code')!.indicators;
    expect(indicators[indicators.length - 1].mode).toBe('default');
  });

  it('asks for a small, positive tail window', () => {
    for (const id of DECLARING) {
      const { tailRows } = spec(id)!;
      expect(tailRows, id).toBeGreaterThan(0);
      // A window, not the frame. See `AgentModeSpec.tailRows`: a mode row
      // scrolls up rather than disappearing, so a generous window answers with
      // a footer from an hour ago.
      expect(tailRows, id).toBeLessThanOrEqual(8);
    }
  });

  it('carries the codex model-coupling caution, and nobody else carries one', () => {
    // #2592 §「設計に効く事実」4: codex's modes move the model tier and the
    // reasoning effort with them (xhigh <-> medium, measured), so one press of a
    // button labelled "mode" also changes the model. That has to be printed, not
    // discovered.
    expect(spec('codex')!.noteId).toBe('codexModelCoupled');
    for (const id of DECLARING) {
      if (id === 'codex') continue;
      expect(spec(id)!.noteId, id).toBeNull();
    }
  });

  it('uses stateless, non-global patterns', () => {
    // A `/g` regex carries `lastIndex` between `.test()` calls, and these
    // objects are module-level singletons shared by every pane on the server.
    for (const id of DECLARING) {
      for (const indicator of spec(id)!.indicators) {
        expect(indicator.pattern.global, `${id}/${indicator.mode}`).toBe(false);
      }
    }
  });

  it('declares only mode ids the contract knows', () => {
    for (const id of DECLARING) {
      for (const indicator of spec(id)!.indicators) {
        expect(AGENT_MODE_IDS as readonly string[]).toContain(indicator.mode);
      }
    }
  });
});
