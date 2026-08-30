/**
 * The sidebar's fallback follows the configured default (Issue #2065).
 *
 * `deriveSidebarCliStatus()` is reached through `toBranchItem()` and is a PURE
 * function of one `Worktree` — it can read neither a React context nor a prop,
 * which is why the default it falls back to lives in a module store
 * (`@/config/default-agents`) rather than being threaded in.
 *
 * The existing `sidebar.test.ts` case pins the un-seeded behaviour (the
 * constant). This file pins the other half: with the store seeded, the sidebar
 * agrees with the server. Without it, leaving either of the two sites on the
 * imported constant would stay green everywhere, because the store *starts* at
 * that constant.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { toBranchItem } from '@/types/sidebar';
import {
  resetClientDefaultSelectedAgents,
  setClientDefaultSelectedAgents,
} from '@/config/default-agents';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import type { Worktree } from '@/types/models';

const BARE: Worktree = {
  id: 'feature-2065',
  name: 'feature/2065',
  path: '/tmp/feature-2065',
  repositoryPath: '/tmp/repo',
  repositoryName: 'repo',
  // No selectedAgents: the payload shape that reaches the fallback.
};

afterEach(() => {
  resetClientDefaultSelectedAgents();
});

describe('sidebar fallback honours the configured default (Issue #2065)', () => {
  it('uses the constant while nothing has been seeded', () => {
    expect(Object.keys(toBranchItem(BARE).cliStatus ?? {})).toEqual([...DEFAULT_SELECTED_AGENTS]);
  });

  /** The legacy branch: no `sessionStatusByInstance`, keys come from the agents. */
  it('keys the legacy per-CLI status off the seeded default, in order', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const item = toBranchItem(BARE);

    expect(Object.keys(item.cliStatus ?? {})).toEqual(['codex', 'claude']);
    expect(item.cliStatus).toEqual({ codex: 'idle', claude: 'idle' });
  });

  /** The roster branch: primaries derived from the agents when none are stored. */
  it('derives the instance roster from the seeded default, in order', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const item = toBranchItem({ ...BARE, sessionStatusByInstance: {} });

    expect(Object.keys(item.cliStatus ?? {})).toEqual(['codex', 'claude']);
    expect(item.cliStatusLabels).toEqual({ codex: 'Codex', claude: 'Claude' });
  });

  it('still lets a worktree with its own agents win over the default', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const item = toBranchItem({ ...BARE, selectedAgents: ['gemini', 'copilot'] });

    expect(Object.keys(item.cliStatus ?? {})).toEqual(['gemini', 'copilot']);
  });
});
