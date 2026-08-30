/**
 * Unit tests for selected-agents-validator
 * Issue #368: Agent settings tab - validator functions
 */

import { describe, it, expect } from 'vitest';
import {
  parseSelectedAgents,
  resolveSelectedAgents,
  validateSelectedAgentsInput,
  validateAgentsPair,
  DEFAULT_SELECTED_AGENTS,
  MAX_SELECTED_AGENTS,
  MIN_SELECTED_AGENTS,
  SELECTED_AGENTS_LAYERS,
} from '@/lib/selected-agents-validator';


/**
 * Issue #2065 replaced the constant pin that used to live here.
 *
 * The old test asserted `DEFAULT_SELECTED_AGENTS === ['claude','codex','antigravity']`
 * and nothing else, which was the right guard while the constant WAS the answer.
 * It is not any more: the answer is the first layer of `resolveSelectedAgents()`
 * that validates, and a test that only pins the constant stays green through the
 * one mutation that matters — dropping a layer, or reading them in the wrong
 * order. So the constant is now asserted as the LAST layer (the value a fresh
 * install with no setting gets, which is the "unchanged behaviour" acceptance
 * criterion), and the order itself is asserted layer by layer below.
 */
describe('resolveSelectedAgents(): setting -> constant (Issue #2065)', () => {
  it('declares the layers highest-priority first, with repo reserved for #2066', () => {
    expect([...SELECTED_AGENTS_LAYERS]).toEqual(['worktree', 'repo', 'appSettings']);
  });

  it('falls back to the constant when no layer answers', () => {
    expect(resolveSelectedAgents()).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(resolveSelectedAgents({})).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(resolveSelectedAgents({ appSettings: null, worktree: undefined }))
      .toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('prefers the app_settings layer over the constant', () => {
    expect(resolveSelectedAgents({ appSettings: ['codex', 'claude'] }))
      .toEqual(['codex', 'claude']);
  });

  it('prefers the worktree layer over app_settings', () => {
    expect(
      resolveSelectedAgents({
        worktree: ['gemini', 'copilot'],
        appSettings: ['codex', 'claude'],
      })
    ).toEqual(['gemini', 'copilot']);
  });

  /**
   * The layer #2066 fills in. Asserted now so that Issue landing between the two
   * populated layers is a one-line change here rather than a re-derivation: if
   * someone reorders the array, this and the two cases above disagree.
   */
  it('sits the repo layer between worktree and app_settings', () => {
    expect(
      resolveSelectedAgents({
        repo: ['gemini', 'copilot'],
        appSettings: ['codex', 'claude'],
      })
    ).toEqual(['gemini', 'copilot']);

    expect(
      resolveSelectedAgents({
        worktree: ['opencode', 'claude'],
        repo: ['gemini', 'copilot'],
        appSettings: ['codex', 'claude'],
      })
    ).toEqual(['opencode', 'claude']);
  });

  it('preserves order, so [0] is the primary', () => {
    expect(resolveSelectedAgents({ appSettings: ['codex', 'claude', 'gemini'] })[0])
      .toBe('codex');
    expect(resolveSelectedAgents({ appSettings: ['claude', 'codex', 'gemini'] })[0])
      .toBe('claude');
  });

  it('SKIPS an invalid layer rather than failing or returning it', () => {
    // Too short, unknown id, duplicate: each must fall through to the next layer,
    // never blank the roster and never propagate.
    for (const bad of [['claude'], ['claude', 'nope'], ['claude', 'claude'], []]) {
      expect(resolveSelectedAgents({ worktree: bad, appSettings: ['codex', 'claude'] }))
        .toEqual(['codex', 'claude']);
      expect(resolveSelectedAgents({ worktree: bad })).toEqual(DEFAULT_SELECTED_AGENTS);
    }
  });

  it('does not hand back the caller\'s array, so a mutation cannot leak into the store', () => {
    const stored: string[] = ['codex', 'claude'];
    const resolved = resolveSelectedAgents({ appSettings: stored });
    expect(resolved).not.toBe(stored);
    resolved.push('gemini');
    expect(stored).toEqual(['codex', 'claude']);
  });
});

describe('DEFAULT_SELECTED_AGENTS (Issue #1516) — the last layer', () => {
  it('is still claude/codex/antigravity, so an install with no setting is unchanged', () => {
    expect(DEFAULT_SELECTED_AGENTS).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);
  });

  it('should itself be a valid agents pair (2-6 unique valid IDs)', () => {
    const result = validateAgentsPair(DEFAULT_SELECTED_AGENTS);
    expect(result.valid).toBe(true);
  });

  it('is within the bounds the API validates against', () => {
    expect(DEFAULT_SELECTED_AGENTS.length).toBeGreaterThanOrEqual(MIN_SELECTED_AGENTS);
    expect(DEFAULT_SELECTED_AGENTS.length).toBeLessThanOrEqual(MAX_SELECTED_AGENTS);
  });
});

describe('MAX_SELECTED_AGENTS (Issue #989)', () => {
  it('should be 6', () => {
    expect(MAX_SELECTED_AGENTS).toBe(6);
  });
});

describe('validateAgentsPair()', () => {
  it('should return valid for a correct pair of tool IDs', () => {
    const result = validateAgentsPair(['claude', 'codex']);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(['claude', 'codex']);
  });

  it('should return valid for all valid CLI tool combinations', () => {
    const result1 = validateAgentsPair(['claude', 'gemini']);
    expect(result1.valid).toBe(true);
    expect(result1.value).toEqual(['claude', 'gemini']);

    const result2 = validateAgentsPair(['codex', 'gemini']);
    expect(result2.valid).toBe(true);
    expect(result2.value).toEqual(['codex', 'gemini']);

    const result3 = validateAgentsPair(['vibe-local', 'claude']);
    expect(result3.valid).toBe(true);
    expect(result3.value).toEqual(['vibe-local', 'claude']);
  });

  it('should return valid for 3, 4, 5, or 6 tool IDs', () => {
    const result3 = validateAgentsPair(['claude', 'codex', 'gemini']);
    expect(result3.valid).toBe(true);
    expect(result3.value).toEqual(['claude', 'codex', 'gemini']);

    const result4 = validateAgentsPair(['claude', 'codex', 'gemini', 'vibe-local']);
    expect(result4.valid).toBe(true);
    expect(result4.value).toEqual(['claude', 'codex', 'gemini', 'vibe-local']);

    // Issue #836: PC default expands to 5 agents
    const result5 = validateAgentsPair(['claude', 'codex', 'gemini', 'opencode', 'copilot']);
    expect(result5.valid).toBe(true);
    expect(result5.value).toEqual(['claude', 'codex', 'gemini', 'opencode', 'copilot']);

    // Issue #989: PC default expands to 6 agents (antigravity added)
    const result6 = validateAgentsPair(['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity']);
    expect(result6.valid).toBe(true);
    expect(result6.value).toEqual(['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity']);
  });

  it('should return invalid for arrays with length < 2 or > 6', () => {
    const result1 = validateAgentsPair([]);
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain('2-6 elements');

    const result2 = validateAgentsPair(['claude']);
    expect(result2.valid).toBe(false);

    // Issue #989: 7 elements (all CLI tool IDs) exceeds the new MAX of 6
    const result7 = validateAgentsPair(['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot', 'antigravity']);
    expect(result7.valid).toBe(false);
  });

  it('should return invalid for non-string elements', () => {
    const result = validateAgentsPair([123, 'codex']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid CLI tool ID');
  });

  it('should return invalid for unknown tool IDs', () => {
    const result = validateAgentsPair(['claude', 'unknown']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid CLI tool ID');
  });

  it('should return invalid for duplicate tool IDs', () => {
    const result = validateAgentsPair(['claude', 'claude']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate');
  });
});

describe('parseSelectedAgents()', () => {

  it('should return default for null input', () => {
    const result = parseSelectedAgents(null);
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should return default for empty string input', () => {
    const result = parseSelectedAgents('');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should parse valid JSON array', () => {
    const result = parseSelectedAgents('["claude","codex"]');
    expect(result).toEqual(['claude', 'codex']);
  });

  it('should parse valid JSON with vibe-local', () => {
    const result = parseSelectedAgents('["vibe-local","gemini"]');
    expect(result).toEqual(['vibe-local', 'gemini']);
  });

  it('should return default for invalid JSON', () => {
    const result = parseSelectedAgents('not-json');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should return default for non-array JSON', () => {
    const result = parseSelectedAgents('{"key":"value"}');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should parse valid JSON with 3, 4, 5, or 6 agents', () => {
    const result3 = parseSelectedAgents('["claude","codex","gemini"]');
    expect(result3).toEqual(['claude', 'codex', 'gemini']);

    const result4 = parseSelectedAgents('["claude","codex","gemini","vibe-local"]');
    expect(result4).toEqual(['claude', 'codex', 'gemini', 'vibe-local']);

    // Issue #836: PC default expands to 5 agents
    const result5 = parseSelectedAgents('["claude","codex","gemini","opencode","copilot"]');
    expect(result5).toEqual(['claude', 'codex', 'gemini', 'opencode', 'copilot']);

    // Issue #989: PC default expands to 6 agents (antigravity added)
    const result6 = parseSelectedAgents('["claude","codex","gemini","opencode","copilot","antigravity"]');
    expect(result6).toEqual(['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity']);
  });

  it('should return default for array with wrong length', () => {
    const result = parseSelectedAgents('["claude"]');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should return default for invalid tool IDs', () => {
    const result = parseSelectedAgents('["claude","invalid"]');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should return default for duplicate tool IDs', () => {
    const result = parseSelectedAgents('["claude","claude"]');
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('should return default for malicious input', () => {
    const maliciousRaw = '\x1b[31m' + 'a'.repeat(200) + '\n\rend';
    const result = parseSelectedAgents(maliciousRaw);
    expect(result).toEqual(DEFAULT_SELECTED_AGENTS);
  });

  /**
   * Issue #2065. This is the path that gives a synced worktree its tabs:
   * `upsertWorktree` never writes `selected_agents`, so every row scan/sync
   * creates arrives here with `raw === null`.
   */
  describe('app_settings fallback (Issue #2065)', () => {
    it('uses the setting when the row has no selected_agents', () => {
      expect(parseSelectedAgents(null, ['codex', 'claude'])).toEqual(['codex', 'claude']);
      expect(parseSelectedAgents('', ['codex', 'claude'])).toEqual(['codex', 'claude']);
    });

    it('keeps the primary the setting names first', () => {
      expect(parseSelectedAgents(null, ['codex', 'claude'])[0]).toBe('codex');
    });

    it('lets the row win over the setting', () => {
      expect(parseSelectedAgents('["gemini","copilot"]', ['codex', 'claude']))
        .toEqual(['gemini', 'copilot']);
    });

    it('falls through a malformed row to the setting', () => {
      for (const raw of ['not-json', '{"key":"value"}', '["claude"]', '["claude","claude"]']) {
        expect(parseSelectedAgents(raw, ['codex', 'claude'])).toEqual(['codex', 'claude']);
      }
    });

    it('is byte-for-byte the old behaviour when no setting is passed', () => {
      // The acceptance criterion "an environment with no setting is unchanged".
      for (const raw of [null, '', 'not-json', '{"a":1}', '["claude"]', '["claude","claude"]']) {
        expect(parseSelectedAgents(raw)).toEqual(DEFAULT_SELECTED_AGENTS);
        expect(parseSelectedAgents(raw, null)).toEqual(DEFAULT_SELECTED_AGENTS);
      }
      expect(parseSelectedAgents('["claude","codex"]')).toEqual(['claude', 'codex']);
    });
  });
});

describe('validateSelectedAgentsInput()', () => {
  it('should return valid for correct input', () => {
    const result = validateSelectedAgentsInput(['claude', 'codex']);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(['claude', 'codex']);
  });

  it('should return valid for 3, 4, 5, or 6 agents', () => {
    const result3 = validateSelectedAgentsInput(['claude', 'codex', 'gemini']);
    expect(result3.valid).toBe(true);
    expect(result3.value).toEqual(['claude', 'codex', 'gemini']);

    const result4 = validateSelectedAgentsInput(['claude', 'codex', 'gemini', 'vibe-local']);
    expect(result4.valid).toBe(true);

    // Issue #836: PC default expands to 5 agents
    const result5 = validateSelectedAgentsInput(['claude', 'codex', 'gemini', 'opencode', 'copilot']);
    expect(result5.valid).toBe(true);
    expect(result5.value).toEqual(['claude', 'codex', 'gemini', 'opencode', 'copilot']);

    // Issue #989: PC default expands to 6 agents (antigravity added)
    const result6 = validateSelectedAgentsInput(['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity']);
    expect(result6.valid).toBe(true);
    expect(result6.value).toEqual(['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity']);
  });

  it('should return invalid for non-array input', () => {
    const result = validateSelectedAgentsInput('claude,codex');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('array of 2-6 elements');
  });

  it('should return invalid for null input', () => {
    const result = validateSelectedAgentsInput(null);
    expect(result.valid).toBe(false);
  });

  it('should return invalid for array with wrong length', () => {
    const result1 = validateSelectedAgentsInput(['claude']);
    expect(result1.valid).toBe(false);

    // Issue #989: 7 elements (all CLI tool IDs) exceeds the new MAX of 6
    const result7 = validateSelectedAgentsInput(['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot', 'antigravity']);
    expect(result7.valid).toBe(false);
  });

  it('should return invalid for invalid tool IDs', () => {
    const result = validateSelectedAgentsInput(['claude', 'notreal']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid CLI tool ID');
  });

  it('should return invalid for duplicate tool IDs', () => {
    const result = validateSelectedAgentsInput(['codex', 'codex']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate');
  });

  it('should return valid for vibe-local combination', () => {
    const result = validateSelectedAgentsInput(['vibe-local', 'claude']);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual(['vibe-local', 'claude']);
  });
});
