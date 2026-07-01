/**
 * Agent-instance roster helper tests
 * Issue #1000
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { ApiClient } from '../../../../src/cli/utils/api-client';
import {
  fetchAgentInstances,
  saveAgentInstances,
  nextInstanceId,
  defaultAlias,
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
  MIN_AGENT_INSTANCES,
} from '../../../../src/cli/utils/agent-instances';

afterEach(() => {
  restoreFetch();
});

describe('nextInstanceId', () => {
  it('claims the primary id when free', () => {
    expect(nextInstanceId('claude', [])).toBe('claude');
  });

  it('returns <tool>-2 when the primary is taken', () => {
    expect(nextInstanceId('claude', [{ id: 'claude' }])).toBe('claude-2');
  });

  it('returns the smallest free suffix', () => {
    expect(nextInstanceId('claude', [{ id: 'claude' }, { id: 'claude-2' }])).toBe('claude-3');
  });

  it('reuses a gap left by a removed instance', () => {
    expect(nextInstanceId('claude', [{ id: 'claude' }, { id: 'claude-3' }])).toBe('claude-2');
  });
});

describe('defaultAlias', () => {
  it('returns the tool display name for the primary instance', () => {
    expect(defaultAlias('claude', 'claude')).toBe('Claude');
  });

  it('suffixes the display name for additional instances', () => {
    expect(defaultAlias('claude', 'claude-2')).toBe('Claude 2');
  });
});

describe('fetchAgentInstances', () => {
  it('returns the roster from GET /api/worktrees/:id', async () => {
    mockFetchResponse({
      id: 'wt1',
      name: 'main',
      agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
    });
    const client = new ApiClient();
    const result = await fetchAgentInstances(client, 'wt1');
    expect(result).toEqual([{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns an empty array when agentInstances is missing', async () => {
    mockFetchResponse({ id: 'wt1', name: 'main' });
    const client = new ApiClient();
    const result = await fetchAgentInstances(client, 'wt1');
    expect(result).toEqual([]);
  });
});

describe('saveAgentInstances', () => {
  it('PATCHes the roster with order normalized to array position', async () => {
    mockFetchResponse({ success: true });
    const client = new ApiClient();
    await saveAgentInstances(client, 'wt1', [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 5 },
      { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 9 },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
          ],
        }),
      })
    );
  });
});

describe('re-exported roster limits', () => {
  it('mirrors the server-side constants', () => {
    expect(MAX_AGENT_INSTANCES).toBeGreaterThan(0);
    expect(MAX_AGENT_ALIAS_LENGTH).toBeGreaterThan(0);
    expect(MIN_AGENT_INSTANCES).toBe(1);
  });
});
