/**
 * Command Code の Plan review 承認キー `C-a`（Issue #2760）
 *
 * `s`（#2297）と同じ形の宣言: transport は届けられる、command-code だけが宣言する、
 * 他のツールには route が 400 を返す。
 */
import { describe, it, expect } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isAllowedSpecialKey, isSendableSpecialKey } from '@/lib/tmux/tmux';
import {
  CLAUDE_NAVIGATION_KEY_VALUES,
  COMMAND_CODE_NAVIGATION_KEY_VALUES,
  NAVIGATION_KEY_VALUES,
  PLAN_APPROVE_KEY,
  PLAN_APPROVE_KEY_TOOL_IDS,
  TERMINAL_KEY_VALUES,
} from '@/types/terminal-keys';

const manager = CLIToolManager.getInstance();
const vocabulary = (id: CLIToolType): readonly string[] =>
  manager.getTool(id).navigationKeys().keys as readonly string[];

describe('[#2760] the key itself', () => {
  it('is the tmux name of ctrl+a', () => {
    expect(PLAN_APPROVE_KEY).toBe('C-a');
  });

  it('is in the union the transport is checked against, and deliverable', () => {
    expect(TERMINAL_KEY_VALUES as readonly string[]).toContain(PLAN_APPROVE_KEY);
    expect(isSendableSpecialKey(PLAN_APPROVE_KEY)).toBe(true);
  });

  it('is in neither the shared pad nor the claude-family pad', () => {
    expect(NAVIGATION_KEY_VALUES as readonly string[]).not.toContain(PLAN_APPROVE_KEY);
    expect(CLAUDE_NAVIGATION_KEY_VALUES as readonly string[]).not.toContain(PLAN_APPROVE_KEY);
  });

  it('is the ONLY thing COMMAND_CODE_NAVIGATION_KEY_VALUES adds to the claude-family pad', () => {
    expect(COMMAND_CODE_NAVIGATION_KEY_VALUES).toEqual([...CLAUDE_NAVIGATION_KEY_VALUES, PLAN_APPROVE_KEY]);
    expect(new Set(COMMAND_CODE_NAVIGATION_KEY_VALUES).size).toBe(COMMAND_CODE_NAVIGATION_KEY_VALUES.length);
  });
});

describe('[#2760] which tools declare it', () => {
  it('names Command Code and nobody else', () => {
    expect([...PLAN_APPROVE_KEY_TOOL_IDS]).toEqual(['command-code']);
  });

  it('matches the registry in both directions', () => {
    const declaring = CLI_TOOL_IDS.filter((id) => vocabulary(id).includes(PLAN_APPROVE_KEY));
    expect([...declaring].sort()).toEqual([...PLAN_APPROVE_KEY_TOOL_IDS].sort());
  });

  it('is accepted for Command Code and refused for every other tool', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(isAllowedSpecialKey(PLAN_APPROVE_KEY, vocabulary(id)), `${id} + C-a`).toBe(
        (PLAN_APPROVE_KEY_TOOL_IDS as readonly string[]).includes(id),
      );
    }
  });
});

describe('[#2760] what it does NOT open', () => {
  it('keeps the other control keys out of the transport (injection guard)', () => {
    for (const key of ['C-c', 'C-b', 'C-d', 'C-z', 'c-a', 'C-A', 'C-aa']) {
      expect(isSendableSpecialKey(key), key).toBe(false);
      expect(isAllowedSpecialKey(key, COMMAND_CODE_NAVIGATION_KEY_VALUES), key).toBe(false);
    }
  });
});
