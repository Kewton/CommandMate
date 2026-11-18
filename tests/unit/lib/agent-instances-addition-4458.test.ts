/**
 * Issue #4458: the judgment of a roster addition has one definition, the server's
 * validator. `validateAgentInstanceAddition` is that validator applied to the list the
 * save would carry, and the CLI's `rosterAdditionRefusal` only reads its verdict.
 * The `accepted` column is written out, so the limit compared with >= instead of >
 * turns rows red here as well as in the integration table.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { validateAgentInstanceAddition, validateAgentInstancesInput } from '@/lib/agent-instances-validator';
import { rosterAdditionRefusal, defaultAlias } from '@/cli/utils/agent-instances';
import { MAX_AGENT_INSTANCES, type AgentInstance } from '@/lib/cli-tools/types';

function claudeRoster(n: number): AgentInstance[] {
  return Array.from({ length: n }, (_, i) => {
    const id = i === 0 ? 'claude' : `claude-${i + 1}`;
    return { id, cliTool: 'claude', alias: `Claude ${i + 1}`, order: i };
  });
}

const row = (id: string, cliTool = 'claude') => ({ id, cliTool, alias: defaultAlias(cliTool, id) });

describe('Issue #4458: one judgment of a roster addition', () => {
  const cases: Array<{ name: string; size: number; added: ReturnType<typeof row>; accepted: boolean; atLimit?: boolean; error?: RegExp }> = [
    { name: 'room left after the limit (8)', size: 8, added: row('claude-x'), accepted: true },
    { name: 'the last room (9)', size: 9, added: row('claude-x'), accepted: true },
    { name: 'at the limit (10)', size: MAX_AGENT_INSTANCES, added: row('claude-11'), accepted: false, atLimit: true, error: /at most 10 entries/ },
    { name: 'an id with a space', size: 8, added: { id: 'Worker 6', cliTool: 'claude', alias: 'W' }, accepted: false, atLimit: false, error: /agentInstances\[8\]\.id is invalid/ },
    { name: 'a 65-character id', size: 8, added: { id: 'w'.repeat(65), cliTool: 'claude', alias: 'W' }, accepted: false, atLimit: false, error: /\[8\]\.id is invalid/ },
    { name: 'a 64-character id whose default alias is too long', size: 8, added: row('w'.repeat(64)), accepted: false, atLimit: false, error: /\[8\]\.alias exceeds 50/ },
    { name: 'another tool\'s primary id', size: 8, added: { id: 'codex', cliTool: 'claude', alias: 'C' }, accepted: false, atLimit: false, error: /conflicts with cliTool/ },
  ];

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const base = claudeRoster(c.size);
    const server = validateAgentInstancesInput([...base, c.added]);
    expect(server.valid).toBe(c.accepted);
    expect(validateAgentInstanceAddition(base, c.added)).toEqual(server);

    const cli = rosterAdditionRefusal(base, c.added);
    if (c.accepted) {
      expect(cli).toBeNull();
    } else {
      expect(cli).toEqual({ atLimit: c.atLimit, error: server.error });
      expect(cli?.error).toMatch(c.error as RegExp);
    }
  });

  it('a row already on the roster that the server would refuse is not this add\'s to judge', () => {
    const base: AgentInstance[] = [{ id: 'claude', cliTool: 'codex', alias: 'odd', order: 0 }];
    const added = row('codex-2', 'codex');
    expect(validateAgentInstanceAddition(base, added)).toMatchObject({ valid: false, refusal: 'entry', index: 0 });
    expect(rosterAdditionRefusal(base, added)).toBeNull();
    // The added row itself is still judged, at its own index.
    expect(rosterAdditionRefusal(base, { id: 'w w', cliTool: 'codex', alias: 'x' })).toBeNull();
    expect(validateAgentInstanceAddition([], { id: 'w w', cliTool: 'codex', alias: 'x' })).toMatchObject({ refusal: 'entry', index: 0 });
    expect(rosterAdditionRefusal([], { id: 'w w', cliTool: 'codex', alias: 'x' })).toMatchObject({ atLimit: false });
  });

  it('a refusal says what it is for; an accepted list carries none', () => {
    expect(validateAgentInstancesInput('x').refusal).toBe('shape');
    expect(validateAgentInstancesInput([]).refusal).toBe('limit');
    expect(validateAgentInstancesInput([{ id: 'a b', cliTool: 'claude' }]).refusal).toBe('entry');
    expect(validateAgentInstancesInput(claudeRoster(2))).not.toHaveProperty('refusal');
  });
});
