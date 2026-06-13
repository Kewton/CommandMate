/**
 * Tests for agent-instances-validator (Issue #869)
 *
 * Server-side guard behind PATCH /api/worktrees/[id] for the `agentInstances`
 * payload: bounds (MIN..MAX), per-entry shape, unique ids, primary-anchor
 * consistency, alias length, and order normalization.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  validateAgentInstancesInput,
  MIN_AGENT_INSTANCES,
} from '@/lib/agent-instances-validator';
import {
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
} from '@/lib/cli-tools/types';

describe('validateAgentInstancesInput (Issue #869)', () => {
  it('exposes MIN_AGENT_INSTANCES = 1', () => {
    expect(MIN_AGENT_INSTANCES).toBe(1);
  });

  describe('shape rejections', () => {
    it('rejects non-array input', () => {
      expect(validateAgentInstancesInput(null).valid).toBe(false);
      expect(validateAgentInstancesInput(undefined).valid).toBe(false);
      expect(validateAgentInstancesInput('x').valid).toBe(false);
      expect(validateAgentInstancesInput({}).valid).toBe(false);
    });

    it('rejects an entry that is not an object', () => {
      const result = validateAgentInstancesInput(['claude']);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/must be an object/);
    });
  });

  describe('bounds (min / max)', () => {
    it('rejects an empty roster (below MIN)', () => {
      const result = validateAgentInstancesInput([]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/at least/);
    });

    it('accepts exactly MAX_AGENT_INSTANCES entries', () => {
      const roster = Array.from({ length: MAX_AGENT_INSTANCES }, (_, i) =>
        i === 0
          ? { id: 'claude', cliTool: 'claude', alias: 'Primary' }
          : { id: `claude-${i + 1}`, cliTool: 'claude', alias: `Claude ${i + 1}` },
      );
      const result = validateAgentInstancesInput(roster);
      expect(result.valid).toBe(true);
      expect(result.value).toHaveLength(MAX_AGENT_INSTANCES);
    });

    it('rejects more than MAX_AGENT_INSTANCES entries', () => {
      const roster = Array.from({ length: MAX_AGENT_INSTANCES + 1 }, (_, i) =>
        i === 0
          ? { id: 'claude', cliTool: 'claude' }
          : { id: `claude-${i + 1}`, cliTool: 'claude' },
      );
      const result = validateAgentInstancesInput(roster);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/at most/);
    });
  });

  describe('per-entry validation', () => {
    it('rejects an invalid instance id', () => {
      const result = validateAgentInstancesInput([{ id: 'bad id!', cliTool: 'claude' }]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/\.id is invalid/);
    });

    it('rejects duplicate instance ids', () => {
      const result = validateAgentInstancesInput([
        { id: 'claude', cliTool: 'claude' },
        { id: 'claude', cliTool: 'claude' },
      ]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/duplicated/);
    });

    it('rejects an unknown cliTool', () => {
      const result = validateAgentInstancesInput([{ id: 'x-1', cliTool: 'no-such-tool' }]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/\.cliTool is invalid/);
    });

    it('rejects a primary-anchor id whose cliTool does not match (id === cliTool rule)', () => {
      // id 'claude' is a CLI tool id, so its cliTool MUST be 'claude'.
      const result = validateAgentInstancesInput([{ id: 'claude', cliTool: 'codex' }]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/conflicts with cliTool/);
    });

    it('rejects a non-string alias', () => {
      const result = validateAgentInstancesInput([{ id: 'claude', cliTool: 'claude', alias: 42 }]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/alias must be a string/);
    });

    it('rejects an alias longer than MAX_AGENT_ALIAS_LENGTH', () => {
      const result = validateAgentInstancesInput([
        { id: 'claude', cliTool: 'claude', alias: 'a'.repeat(MAX_AGENT_ALIAS_LENGTH + 1) },
      ]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/exceeds/);
    });

    it('accepts an alias of exactly MAX_AGENT_ALIAS_LENGTH', () => {
      const result = validateAgentInstancesInput([
        { id: 'claude', cliTool: 'claude', alias: 'a'.repeat(MAX_AGENT_ALIAS_LENGTH) },
      ]);
      expect(result.valid).toBe(true);
    });
  });

  describe('normalization', () => {
    it('normalizes order to the array position and defaults a missing alias to ""', () => {
      const result = validateAgentInstancesInput([
        { id: 'codex', cliTool: 'codex', order: 99 },
        { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 3 },
      ]);
      expect(result.valid).toBe(true);
      expect(result.value).toEqual([
        { id: 'codex', cliTool: 'codex', alias: '', order: 0 },
        { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 1 },
      ]);
    });

    it('accepts two instances of the same CLI tool (Claude × 2 via {tool}-2)', () => {
      const result = validateAgentInstancesInput([
        { id: 'claude', cliTool: 'claude', alias: 'Primary' },
        { id: 'claude-2', cliTool: 'claude', alias: 'Review' },
      ]);
      expect(result.valid).toBe(true);
      expect(result.value?.map((i) => i.id)).toEqual(['claude', 'claude-2']);
      expect(result.value?.every((i) => i.cliTool === 'claude')).toBe(true);
    });
  });
});
