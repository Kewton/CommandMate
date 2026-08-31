/**
 * Issue #2070 — the sidebar tells "never started" from "died under you".
 *
 * The dot stays `idle`, which is the honest status; what the payload gains is
 * the id of the instance whose tmux session outlived its agent, so the
 * breakdown tooltip can say `Codex: idle (exited)`.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { toBranchItem, formatCliStatusBreakdown, EXITED_STATUS_REASON } from '@/types/sidebar';
import type { Worktree } from '@/types/models';

const BASE = {
  id: 'wt-2070',
  name: 'wt-2070',
  path: '/tmp/wt',
  repositoryPath: '/tmp/repo',
  repositoryName: 'repo',
} as unknown as Worktree;

function withInstances(byInstance: Record<string, Record<string, unknown>>): Worktree {
  return {
    ...BASE,
    isSessionRunning: false,
    isWaitingForResponse: false,
    isProcessing: false,
    selectedAgents: ['claude', 'codex'],
    sessionStatusByInstance: byInstance,
  } as unknown as Worktree;
}

const NOT_RUNNING = { isRunning: false, isWaitingForResponse: false, isProcessing: false };

describe('[#2070] toBranchItem surfaces the exited instances', () => {
  it('names the instance whose agent is gone, and leaves its status `idle`', () => {
    const item = toBranchItem(
      withInstances({
        claude: NOT_RUNNING,
        codex: { ...NOT_RUNNING, sessionStatusReason: EXITED_STATUS_REASON },
      }),
    );

    expect(item.exitedInstanceIds).toEqual(['codex']);
    expect(item.cliStatus?.codex).toBe('idle');
    expect(item.status).toBe('idle');
  });

  it('is empty for an ordinary idle worktree — nothing died', () => {
    const item = toBranchItem(withInstances({ claude: NOT_RUNNING, codex: NOT_RUNNING }));
    expect(item.exitedInstanceIds).toEqual([]);
  });

  it('is empty for a payload that predates the server change', () => {
    const item = toBranchItem({
      ...BASE,
      isSessionRunning: false,
      selectedAgents: ['claude'],
    } as unknown as Worktree);
    expect(item.exitedInstanceIds).toEqual([]);
  });

  it('reads the legacy per-CLI map too, so an older payload still annotates', () => {
    const item = toBranchItem({
      ...BASE,
      isSessionRunning: false,
      selectedAgents: ['codex'],
      sessionStatusByCli: {
        codex: { ...NOT_RUNNING, sessionStatusReason: EXITED_STATUS_REASON },
      },
    } as unknown as Worktree);
    expect(item.exitedInstanceIds).toEqual(['codex']);
  });
});

describe('[#2070] formatCliStatusBreakdown annotation', () => {
  const status = { claude: 'running', codex: 'idle' } as const;

  it('is byte-identical to its pre-#2070 output when no callback is passed', () => {
    expect(formatCliStatusBreakdown(status)).toBe('Claude: running, Codex: idle');
  });

  it('is byte-identical when the callback annotates nothing', () => {
    expect(formatCliStatusBreakdown(status, undefined, () => null)).toBe(
      'Claude: running, Codex: idle',
    );
  });

  it('appends the annotation to the instance it belongs to, and nobody else', () => {
    expect(
      formatCliStatusBreakdown(status, undefined, (id) => (id === 'codex' ? 'exited' : null)),
    ).toBe('Claude: running, Codex: idle (exited)');
  });

  it('keeps working with an alias label map', () => {
    expect(
      formatCliStatusBreakdown(
        { 'codex-2': 'idle' },
        { 'codex-2': 'Reviewer' },
        () => 'exited',
      ),
    ).toBe('Reviewer: idle (exited)');
  });
});
