/**
 * `commandmate docs --section delegation` (Issue #2376).
 *
 * The section an agent reads before it delegates. What is pinned is that it
 * teaches the SAME protocol the GUI's brief hands over — `ask`, report a prompt
 * instead of answering it, leave the other session's Auto-Yes alone — because
 * two documents saying different things is how one session ends up answering
 * another's permission dialog.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AGENT_DELEGATION_GUIDE, AGENT_OPERATIONS_GUIDE } from '../../../../src/cli/docs/agent-operations';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function stdout(): string {
  return mockConsoleLog.mock.calls.flat().join('\n');
}

describe('docs --section delegation', () => {
  it('prints the delegation guide', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--section', 'delegation']);

    // `toContain`, not `toBe`: process.exit is mocked to a no-op here, so the
    // action falls through to its own help footer after printing the section.
    expect(stdout()).toContain(AGENT_DELEGATION_GUIDE);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('lists the section alongside the reader\'s own', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--all']);

    const out = stdout();
    expect(out).toContain('- delegation');
    // Still every section the reader owns.
    expect(out).toContain('- agent-operations');
    expect(out).toContain('- quick-start');
  });

  it('is searchable, like every other section', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--search', 'commandmate ask']);

    expect(stdout()).toContain('--- delegation ---');
  });
});

describe('the delegation guide teaches the brief\'s protocol', () => {
  it('names ask as the round trip, not send + wait + capture by hand', () => {
    expect(AGENT_DELEGATION_GUIDE).toContain('commandmate ask <worktree-id>');
    expect(AGENT_DELEGATION_GUIDE).toContain('commandmate whoami');
    expect(AGENT_DELEGATION_GUIDE).toContain('commandmate peers');
  });

  it('states the exit codes a caller has to branch on', () => {
    for (const code of ['0', '10', '21', '124']) {
      expect(AGENT_DELEGATION_GUIDE).toMatch(new RegExp(`\\b${code}\\b`));
    }
  });

  it('forbids answering the other session\'s prompt and touching its Auto-Yes', () => {
    expect(AGENT_DELEGATION_GUIDE).toMatch(/REPORTED, not answered/);
    expect(AGENT_DELEGATION_GUIDE).toMatch(/Never enable Auto-Yes/);
    // The reason, not just the rule: #1681 is why `respond` cannot be trusted
    // to resolve somebody else's dialog.
    expect(AGENT_DELEGATION_GUIDE).toContain('#1681');
  });

  it('is reachable from the guide that describes multi-session work', () => {
    expect(AGENT_OPERATIONS_GUIDE).toContain("commandmate docs --section delegation");
  });

  it('says --instance takes an alias, where the operations guide does too', () => {
    expect(AGENT_OPERATIONS_GUIDE).toMatch(/--instance also accepts the ALIAS/);
    expect(AGENT_DELEGATION_GUIDE).toMatch(/roster\s*\n?\s*alias/i);
  });
});
