/**
 * `commandmate docs --section delegation` (Issue #2376, Issue #2388).
 *
 * The section an agent reads before it delegates. What is pinned is that it
 * teaches the SAME protocol the GUI's brief hands over — `ask`, report a prompt
 * instead of answering it, leave the other session's Auto-Yes alone — because
 * two documents saying different things is how one session ends up answering
 * another's permission dialog.
 *
 * Issue #2388 adds the half that went stale: `--reply-to` / `ask --async`
 * landed in #2377 and this section still closed by saying the reply is not
 * delivered back automatically. The assertions below therefore pin BOTH
 * directions — that the asynchronous form is reachable from here, and that the
 * claim it contradicts is gone — because either one alone is satisfied by a
 * section that teaches two opposite things at once.
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

describe('the delegation guide teaches the relay form too (Issue #2388)', () => {
  it('no longer claims the reply has to be collected by hand', () => {
    // The exact sentence #2377 falsified, plus the generalisation of it. A
    // section that still says this cannot be reconciled with the paragraph
    // above it, whatever else it gained.
    expect(AGENT_DELEGATION_GUIDE).not.toMatch(/not delivered back automatically/i);
    expect(AGENT_DELEGATION_GUIDE).not.toMatch(/Nothing here starts a background job/i);
  });

  it('names the three commands the asynchronous form needs', () => {
    expect(AGENT_DELEGATION_GUIDE).toContain('--async');
    expect(AGENT_DELEGATION_GUIDE).toContain('--reply-to self');
    expect(AGENT_DELEGATION_GUIDE).toContain('commandmate relays');
    // Withdrawing is part of the loop: a relay you registered by mistake is
    // otherwise open for 24h.
    expect(AGENT_DELEGATION_GUIDE).toContain('commandmate relays cancel <relay-id>');
  });

  it('says the reply arrives in a composer rather than on stdout', () => {
    expect(AGENT_DELEGATION_GUIDE).toMatch(/\[from <alias> \/ <worktree>\]/);
  });

  it('gives a basis for choosing the blocking form, not just the new one', () => {
    // Issue #2388: teaching only `--async` would have agents registering relays
    // for answers they are about to sit and wait for anyway. The criterion is
    // the brief's own (`buildDelegationBrief`), so both readers get one rule.
    const start = AGENT_DELEGATION_GUIDE.indexOf('## Which of the two to use');
    expect(start).toBeGreaterThan(-1);
    const section = AGENT_DELEGATION_GUIDE.slice(start);
    expect(section).toMatch(/the next thing you need/);
    expect(section).toMatch(/Do not wait/);
  });

  it('keeps the three rules binding over a relay', () => {
    const start = AGENT_DELEGATION_GUIDE.indexOf('## The three rules');
    expect(start).toBeGreaterThan(-1);
    const rules = AGENT_DELEGATION_GUIDE.slice(start);
    expect(rules).toMatch(/hold for both forms/);
    // The relay's own prompt state is the one an agent reading only the exit
    // codes would miss.
    expect(rules).toMatch(/'prompt' state/);
  });

  it('agrees with the operations guide about the relay commands', () => {
    // Both sections are read by the same agent. #2377 updated Multi-Session and
    // left delegation behind; this pins the pointer that connects them.
    expect(AGENT_OPERATIONS_GUIDE).toContain('--reply-to');
    expect(AGENT_OPERATIONS_GUIDE).toContain('### commandmate relays');
    const multiSession = AGENT_OPERATIONS_GUIDE.slice(
      AGENT_OPERATIONS_GUIDE.indexOf('## Multi-Session'),
      AGENT_OPERATIONS_GUIDE.indexOf('## All Exit Codes')
    );
    expect(multiSession).toContain('ask --async');
    expect(multiSession).toContain("commandmate docs --section delegation");
  });
});
