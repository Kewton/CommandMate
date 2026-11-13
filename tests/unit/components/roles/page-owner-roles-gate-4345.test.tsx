/**
 * Issue #4345 1c 再指示 1 (指摘 1・2): the role rows and the update card a worktree page draws in its
 * agents pane.
 *
 * - The running read (`readRunningInstances` of `api-client-agent-roles`, the same detail GET) is the
 *   page's (`readRunningInstancesForPage`): its 401 expires the session and the host draws nothing.
 * - A restart pressed in the page starts no kill once a 401 was taken: (b) the person is confirming
 *   when another entry's 401 is taken, then says yes — no kill; at the press while expired — none.
 *   The update card's restart likewise.
 *
 * Positive controls are red before 再指示 1. Negative controls (green before and after): with no 401
 * the kill goes as before; drawn outside any page (the settings screen) the kill goes as before even
 * while the registry is expired (no page owns it).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

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
// The person's answer to the confirmation is the test's to give (held until `answer`).
const { confirmation } = vi.hoisted(() => ({ confirmation: { answer: null as null | ((yes: boolean) => void), asked: 0 } }));
vi.mock('@/components/ui/ConfirmDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/ConfirmDialog')>();
  return {
    ...actual,
    useConfirm: () => () => {
      confirmation.asked += 1;
      return new Promise<boolean>((resolve) => (confirmation.answer = resolve));
    },
  };
});

import { InstanceRolesSection } from '@/components/roles/InstanceRolesSection';
import { AgentUpdatesCard } from '@/components/settings/AgentUpdatesCard';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { beginHandoffPageRequest, reportHandoffPageResponse, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { FakeRoleServer, launched } from './fake-role-server';
import {
  describeEntryCases,
  handoffDialog,
  json,
  PAGE_WORKTREE as A,
  PageTree,
  sessionExpired,
  standInPage,
  type EntryCase,
  type StandInPage,
} from '../../lib/handoff/page-owner-harness';

beforeAll(() => installRadixJsdomPolyfills());

let roleServer: FakeRoleServer;
let kills: number;
beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  confirmation.answer = null;
  confirmation.asked = 0;
  kills = 0;
  roleServer = new FakeRoleServer([{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }]);
  roleServer.running.claude = true;
  roleServer.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  confirmation.answer?.(false);
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const VERSIONS = {
  status: 'success',
  updatable: ['codex'],
  tools: [{ tool: 'codex', installed: '0.149.1', latestVersion: '0.151.0', dismissedVersion: null, updateAvailable: true, dismissedInCodex: false, updatable: true, source: 'version.json' }],
};
const UPDATE_INSTANCES = [{ id: 'codex-2', cliTool: 'codex', alias: 'Codex 2' }];

async function fallback(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  if (url.includes('/kill-session')) {
    kills += 1;
    return json(200, {});
  }
  if (url.startsWith('/api/agents/versions')) return json(200, VERSIONS);
  if (url.startsWith('/api/agents/update')) {
    const done = { type: 'done', ok: true, exitCode: 0, previousVersion: '0.149.1', installed: '0.151.0' };
    return new Response(`${JSON.stringify(done)}\n`, { status: 200 });
  }
  if (url === `/api/worktrees/${A}` && method === 'GET') {
    return json(200, { id: A, sessionStatusByInstance: { claude: { isRunning: true }, 'codex-2': { isRunning: true } } });
  }
  return roleServer.fetch(url, init);
}

const roles = () => <InstanceRolesSection worktreeId={A} rosterKey="claude" />;

const CASES: Record<string, EntryCase> = {
  'role rows running read (InstanceRolesSection → readRunningInstances)': {
    matches: (url, method) => url === `/api/worktrees/${A}` && method === 'GET',
    ok: () => json(200, { id: A, sessionStatusByInstance: { claude: { isRunning: true } } }),
    ui: roles,
    trigger: () => fireEvent.click(screen.getByTestId('instance-roles-toggle')),
  },
};
describeEntryCases('the role rows’ running read', CASES, fallback);

/** Another entry of the page answers 401 (taken through the gateway under the page's registration). */
function anotherEntryAnswers401(page: StandInPage): void {
  act(() => {
    reportHandoffPageResponse(beginHandoffPageRequest(page.registration), { status: 401 });
  });
}

async function openRoles(owner: StandInPage['owner'] | null): Promise<void> {
  global.fetch = vi.fn(fallback) as unknown as typeof fetch;
  render(<PageTree owner={owner}>{roles()}</PageTree>);
  fireEvent.click(screen.getByTestId('instance-roles-toggle'));
  await screen.findByTestId('instance-role-restart-claude');
}

describe('[#4345 1c 再指示 1] (b) the role restart starts no kill once a 401 was taken', () => {
  it('401 taken while confirming, then yes: no kill (the session expired, nothing drawn)', async () => {
    const page = standInPage();
    await openRoles(page.owner);
    fireEvent.click(screen.getByTestId('instance-role-restart-claude'));
    await waitFor(() => expect(confirmation.answer).not.toBeNull());
    anotherEntryAnswers401(page);
    await act(async () => confirmation.answer!(true));
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(kills).toBe(0);
    expect(sessionExpired()).toBe(true);
    expect(handoffDialog()).toBeNull();
  });

  it('pressed while expired: neither asked nor killed', async () => {
    const page = standInPage();
    await openRoles(page.owner);
    anotherEntryAnswers401(page);
    fireEvent.click(screen.getByTestId('instance-role-restart-claude'));
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(confirmation.asked).toBe(0);
    expect(kills).toBe(0);
  });

  it('(negative control) no 401: confirmed, killed once', async () => {
    const page = standInPage();
    await openRoles(page.owner);
    fireEvent.click(screen.getByTestId('instance-role-restart-claude'));
    await waitFor(() => expect(confirmation.answer).not.toBeNull());
    await act(async () => confirmation.answer!(true));
    await waitFor(() => expect(kills).toBe(1));
  });

  it('(negative control) on the settings screen (no page) the registry’s expiry does not stop it', async () => {
    const page = standInPage();
    await openRoles(null);
    anotherEntryAnswers401(page);
    fireEvent.click(screen.getByTestId('instance-role-restart-claude'));
    await waitFor(() => expect(confirmation.answer).not.toBeNull());
    await act(async () => confirmation.answer!(true));
    await waitFor(() => expect(kills).toBe(1));
  });
});

describe('[#4345 1c 再指示 1] the update card’s restart starts no kill once a 401 was taken', () => {
  async function drawCard(owner: StandInPage['owner'] | null): Promise<void> {
    global.fetch = vi.fn(fallback) as unknown as typeof fetch;
    render(<PageTree owner={owner}><AgentUpdatesCard worktreeId={A} instances={UPDATE_INSTANCES} /></PageTree>);
    fireEvent.click(await screen.findByTestId('agent-updates-update-codex'));
    await screen.findByTestId('agent-updates-restart-codex-2');
  }

  it('pressed after a 401 was taken: no kill', async () => {
    const page = standInPage();
    await drawCard(page.owner);
    anotherEntryAnswers401(page);
    fireEvent.click(screen.getByTestId('agent-updates-restart-codex-2'));
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(kills).toBe(0);
  });

  it('(negative control) no 401: killed once', async () => {
    const page = standInPage();
    await drawCard(page.owner);
    fireEvent.click(screen.getByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(kills).toBe(1));
  });

  it('(negative control) on the settings screen (no page): killed once while the registry is expired', async () => {
    const page = standInPage();
    await drawCard(null);
    anotherEntryAnswers401(page);
    fireEvent.click(screen.getByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(kills).toBe(1));
  });
});
