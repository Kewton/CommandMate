/**
 * Issue #4345 1c: the detail screen's own panes report their 401 through the gateway under the
 * page's registration holder (`HandoffPageOwnerContext`): the agents pane's source read
 * (`AgentInstancesPane`), the OpenCode settings read and write and the agents' PATCH
 * (`AgentSettingsPane`), the schedules' reads and writes (`ExecutionLogPane`), the plan review's
 * answer (`PlanReviewControls`), and — drawn in the page's agents pane — the update card's read and
 * kill (`AgentUpdatesCard`) and the role row's kill (`InstanceRolesSection`). The same card and
 * section drawn on the settings screen (no page) report nothing (the "no owner" control).
 * Drawn beside the one host (see `page-owner-harness`).
 *
 * Positive controls are red before 1c (nothing here reported); the negative controls are green
 * before and after.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
// The schedule's delete asks first; the person says yes.
vi.mock('@/components/ui/ConfirmDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/ConfirmDialog')>();
  return { ...actual, useConfirm: () => async () => true };
});

import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { AgentSettingsPane, OpencodeInstanceSettings } from '@/components/worktree/AgentSettingsPane';
import { ExecutionLogPane } from '@/components/worktree/ExecutionLogPane';
import { PlanReviewControls } from '@/components/worktree/PlanReviewControls';
import { AgentUpdatesCard } from '@/components/settings/AgentUpdatesCard';
import { InstanceRolesSection } from '@/components/roles/InstanceRolesSection';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { FakeRoleServer, launched } from '../roles/fake-role-server';
import { describeEntryCases, json, PAGE_WORKTREE as A, type EntryCase } from '../../lib/handoff/page-owner-harness';

beforeAll(() => installRadixJsdomPolyfills());

let roleServer: FakeRoleServer;
beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  roleServer = new FakeRoleServer([{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }]);
  roleServer.running.claude = true;
  roleServer.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const noop = () => undefined;
const OPENCODE = { settings: { opencode: { agent: null, providerId: null, modelId: null, variant: null } }, catalog: { connected: true, providers: [], agents: [{ name: 'build', mode: 'primary' }] } };
const SCHEDULE = { id: 's1', worktree_id: A, name: 'nightly', message: 'm', cron_expression: '0 0 * * *', cli_tool_id: 'claude', enabled: 1, last_executed_at: null, next_execute_at: null, created_at: 0, updated_at: 0 };
const VERSIONS = {
  status: 'success',
  updatable: ['codex'],
  tools: [{ tool: 'codex', installed: '0.149.1', latestVersion: '0.151.0', dismissedVersion: null, updateAvailable: true, dismissedInCodex: false, updatable: true, source: 'version.json' }],
};
const UPDATE_INSTANCES = [{ id: 'codex-2', cliTool: 'codex', alias: 'Codex 2' }];

const agentsPane = (instances = [{ id: 'opencode', cliTool: 'opencode' as const, alias: 'OpenCode', order: 0 }]) => (
  <AgentInstancesPane worktreeId={A} instances={instances} onInstancesChange={noop} vibeLocalModel={null} onVibeLocalModelChange={noop} />
);

const CASES: Record<string, EntryCase> = {
  'agents pane source read (AgentInstancesPane)': {
    matches: (url, method) => url === `/api/worktrees/${A}` && method === 'GET',
    ok: () => json(200, { id: A, sessionStatusByInstance: {} }),
    ui: () => agentsPane(),
  },
  'OpenCode settings read (AgentSettingsPane)': {
    matches: (url, method) => url === `/api/worktrees/${A}/instances/opencode` && method === 'GET',
    ok: () => json(200, OPENCODE),
    ui: () => <OpencodeInstanceSettings worktreeId={A} instances={[{ id: 'opencode', label: 'OpenCode' }]} />,
  },
  'OpenCode settings write (AgentSettingsPane)': {
    operation: true,
    matches: (url, method) => url === `/api/worktrees/${A}/instances/opencode` && method === 'PUT',
    ok: () => json(200, { settings: { agent: 'build', providerId: null, modelId: null, variant: null } }),
    ui: () => <OpencodeInstanceSettings worktreeId={A} instances={[{ id: 'opencode', label: 'OpenCode' }]} />,
    trigger: async () => {
      fireEvent.change(await screen.findByTestId('opencode-agent-select-opencode'), { target: { value: 'build' } });
    },
  },
  'agents PATCH (AgentSettingsPane)': {
    operation: true,
    matches: (url, method) => url === `/api/worktrees/${A}` && method === 'PATCH',
    ok: () => json(200, {}),
    ui: () => (
      <AgentSettingsPane worktreeId={A} selectedAgents={['claude', 'codex']} onSelectedAgentsChange={noop} vibeLocalModel={null} onVibeLocalModelChange={noop} />
    ),
    trigger: () => {
      fireEvent.click(screen.getByTestId('agent-checkbox-claude'));
      // Drawn again between the two: gemini is enabled once claude is off.
      fireEvent.click(screen.getByTestId('agent-checkbox-gemini'));
    },
  },
  'execution logs read (ExecutionLogPane)': {
    matches: (url) => url === `/api/worktrees/${A}/execution-logs`,
    ok: () => json(200, { logs: [] }),
    ui: () => <ExecutionLogPane worktreeId={A} />,
  },
  'schedules read (ExecutionLogPane)': {
    matches: (url) => url === `/api/worktrees/${A}/schedules`,
    ok: () => json(200, { schedules: [SCHEDULE] }),
    ui: () => <ExecutionLogPane worktreeId={A} />,
  },
  'active schedules read (ExecutionLogPane)': {
    matches: (url) => url === `/api/worktrees/${A}/schedules/active`,
    ok: () => json(200, { schedules: [] }),
    ui: () => <ExecutionLogPane worktreeId={A} />,
  },
  'CMATE.md read for the edit (ExecutionLogPane)': {
    matches: (url) => url === `/api/worktrees/${A}/files/CMATE.md`,
    ok: () => json(200, { content: '' }),
    ui: () => <ExecutionLogPane worktreeId={A} />,
    trigger: async () => fireEvent.click(await screen.findByTestId('schedule-edit-nightly')),
  },
  'schedule toggle (ExecutionLogPane)': {
    operation: true,
    matches: (url, method) => url === `/api/worktrees/${A}/cmate/schedules` && method === 'PATCH',
    ok: () => json(200, {}),
    ui: () => <ExecutionLogPane worktreeId={A} />,
    trigger: async () => fireEvent.click(await screen.findByTestId('schedule-toggle-nightly')),
  },
  'schedule delete (ExecutionLogPane)': {
    operation: true,
    matches: (url, method) => url === `/api/worktrees/${A}/cmate/schedules` && method === 'DELETE',
    ok: () => json(200, {}),
    ui: () => <ExecutionLogPane worktreeId={A} />,
    trigger: async () => fireEvent.click(await screen.findByTestId('schedule-delete-nightly')),
  },
  'plan review answer (PlanReviewControls)': {
    operation: true,
    matches: (url) => url === `/api/worktrees/${A}/prompt-response`,
    ok: () => json(200, { success: true }),
    ui: () => <PlanReviewControls worktreeId={A} cliToolId="command-code" instanceId="command-code" />,
    trigger: () => fireEvent.click(screen.getByTestId('plan-review-submit')),
  },
  'update card running read (AgentUpdatesCard)': {
    matches: (url, method) => url === `/api/worktrees/${A}` && method === 'GET',
    ok: () => json(200, { sessionStatusByInstance: { 'codex-2': { isRunning: true } } }),
    ui: () => <AgentUpdatesCard worktreeId={A} instances={UPDATE_INSTANCES} />,
  },
  'update card kill (AgentUpdatesCard)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/kill-session`),
    ok: () => json(200, {}),
    ui: () => <AgentUpdatesCard worktreeId={A} instances={UPDATE_INSTANCES} />,
    trigger: async () => {
      fireEvent.click(await screen.findByTestId('agent-updates-update-codex'));
      fireEvent.click(await screen.findByTestId('agent-updates-restart-codex-2'));
    },
    operation: true,
  },
  'role row kill (InstanceRolesSection)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/kill-session`),
    ok: () => json(200, {}),
    ui: () => <InstanceRolesSection worktreeId={A} rosterKey="claude" />,
    trigger: async () => {
      fireEvent.click(screen.getByTestId('instance-roles-toggle'));
      fireEvent.click(await screen.findByTestId('instance-role-restart-claude'));
    },
    operation: true,
  },
};

/** Everything else: the role server, the versions, the schedules, the OpenCode settings. */
async function fallback(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  if (url.startsWith('/api/agents/versions')) return json(200, VERSIONS);
  if (url.startsWith('/api/agents/update')) {
    const done = { type: 'done', ok: true, exitCode: 0, previousVersion: '0.149.1', installed: '0.151.0' };
    return new Response(`${JSON.stringify(done)}\n`, { status: 200 });
  }
  if (url === `/api/worktrees/${A}/instances/opencode`) return json(200, OPENCODE);
  if (url === `/api/worktrees/${A}/schedules`) return json(200, { schedules: [SCHEDULE] });
  if (url === `/api/worktrees/${A}/execution-logs` || url === `/api/worktrees/${A}/schedules/active`) return json(200, { logs: [], schedules: [] });
  if (url === `/api/worktrees/${A}` && method === 'GET') return json(200, { id: A, sessionStatusByInstance: { claude: { isRunning: true }, 'codex-2': { isRunning: true } } });
  return roleServer.fetch(url, init);
}

describeEntryCases('the detail screen’s panes', CASES, fallback);
