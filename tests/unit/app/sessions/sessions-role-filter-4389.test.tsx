/**
 * /sessions role filter (Issue #4389): the checklist (PC modal and mobile sheet), which worktrees
 * stay, the list row's counted agents and role names, and the row link's `?instance=`.
 *
 * Positive control: red before #4389 (no checklist; the link never carried `?instance=`).
 * Negative control: with no role chosen the link and the agents shown are as before.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile, MOBILE_BREAKPOINT: 768 }));

let mockWorktrees: Array<Record<string, unknown>> = [];
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

let mockRoleSource: { roleByWorktree: Record<string, Record<string, unknown>>; rolesUnavailable?: boolean } | null = null;
const reloadRoles = vi.fn();
vi.mock('@/hooks/useSessionsRoles', () => ({
  useSessionsRoles: () => ({
    roles: [
      { id: 'review', name: 'レビュー担当' },
      { id: 'impl', name: '実装担当' },
    ],
    source: mockRoleSource,
    reload: reloadRoles,
  }),
}));

import SessionsPage from '@/app/sessions/page';

const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };
const idle = { isRunning: false, isWaitingForResponse: false, isProcessing: false };

const row = (id: string, name: string) => ({
  id, name, path: `/tmp/${id}`, repositoryPath: '/tmp/repo', repositoryName: 'Repo',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
    { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 2 },
  ],
  sessionStatusByCli: { claude: running, codex: idle },
  sessionStatusByInstance: { claude: running, codex: idle, 'codex-2': idle },
});

const role = (roleId: string, roleName: string) => ({ kind: 'role', roleId, roleName, basis: 'launched' });

beforeEach(() => {
  mockIsMobile = false;
  mockWorktrees = [row('1', 'feature/1-a'), row('2', 'feature/2-b'), row('3', 'main')];
  mockRoleSource = {
    roleByWorktree: {
      '1': { claude: role('impl', '実装担当'), codex: { kind: 'none' }, 'codex-2': role('review', 'レビュー担当') },
      '2': { claude: { kind: 'ambiguous' }, codex: role('impl', '実装担当'), 'codex-2': role('impl', '実装担当') },
      '3': { claude: { kind: 'none' }, codex: { kind: 'none' }, 'codex-2': { kind: 'none' } },
    },
  };
});
afterEach(() => cleanup());

function openPanel() {
  render(<SessionsPage />);
  fireEvent.click(screen.getByTestId('sessions-filter-button'));
}
const link = (id: string) => screen.getByTestId(`session-item-${id}`).getAttribute('href');

describe('[#4389] /sessions role filter', () => {
  it('control: nothing chosen keeps every row, plain links, no role names', () => {
    render(<SessionsPage />);
    expect(link('1')).toBe('/worktrees/1');
    expect(link('3')).toBe('/worktrees/3');
    expect(screen.queryByTestId('session-roles-1')).toBeNull();
    // Unchanged: the agents of selectedAgents (claude working, codex idle → +1).
    expect(within(screen.getByTestId('session-agents-1')).getByTestId('session-agent-claude')).toBeTruthy();
    expect(screen.getByTestId('session-idle-cluster-1')).toHaveTextContent('+1');
    expect(screen.queryByTestId('sessions-filter-count')).toBeNull();
  });

  it('choosing a role keeps the worktrees with that role and links to the first match', () => {
    openPanel();
    fireEvent.click(screen.getByTestId('sessions-role-filter-role-review'));
    expect(screen.getByTestId('sessions-filter-count')).toHaveTextContent('1');
    expect(screen.getByTestId('session-item-1')).toBeTruthy();
    expect(screen.queryByTestId('session-item-2')).toBeNull();
    expect(screen.queryByTestId('session-item-3')).toBeNull();
    expect(link('1')).toBe('/worktrees/1?instance=codex-2');
    // Only the matching instance is counted (idle → +1, no working chip) and named.
    expect(screen.queryByTestId('session-agent-claude')).toBeNull();
    expect(screen.getByTestId('session-idle-cluster-1')).toHaveTextContent('+1');
    expect(screen.getByTestId('session-roles-1')).toHaveTextContent('Codex 2: レビュー担当');
  });

  it('several roles, roster order: the link opens the first matching instance', () => {
    openPanel();
    fireEvent.click(screen.getByTestId('sessions-role-filter-role-review'));
    fireEvent.click(screen.getByTestId('sessions-role-filter-role-impl'));
    expect(link('1')).toBe('/worktrees/1?instance=claude');
    expect(link('2')).toBe('/worktrees/2?instance=codex');
    expect(screen.queryByTestId('session-item-3')).toBeNull();
    // Worktree 1: claude (working chip) + codex-2 (idle) — codex (no role) is not counted.
    expect(within(screen.getByTestId('session-agents-1')).getByTestId('session-agent-claude')).toHaveTextContent('Claude');
    expect(screen.getByTestId('session-idle-cluster-1')).toHaveTextContent('+1');
    expect(screen.getByTestId('session-role-1-claude')).toHaveTextContent('Claude: 実装担当');
  });

  it('"no role" and "cannot tell" are separate choices', () => {
    openPanel();
    fireEvent.click(screen.getByTestId('sessions-role-filter-ambiguous'));
    expect(screen.queryByTestId('session-item-1')).toBeNull();
    expect(link('2')).toBe('/worktrees/2?instance=claude');
    expect(screen.queryByTestId('session-item-3')).toBeNull();
    fireEvent.click(screen.getByTestId('sessions-role-filter-ambiguous'));
    fireEvent.click(screen.getByTestId('sessions-role-filter-none'));
    expect(link('1')).toBe('/worktrees/1?instance=codex');
    expect(link('3')).toBe('/worktrees/3?instance=claude');
    expect(screen.queryByTestId('session-item-2')).toBeNull();
    expect(screen.getByTestId('session-role-1-codex')).toHaveTextContent('Codex: ロールなし');
  });

  it('no match shows the empty message', () => {
    mockRoleSource = { roleByWorktree: { '1': {}, '2': {}, '3': {} } };
    openPanel();
    fireEvent.click(screen.getByTestId('sessions-role-filter-role-review'));
    expect(screen.getByTestId('sessions-empty')).toBeTruthy();
  });

  it('rolesUnavailable: says so, keeps every row with plain links, does not count the condition', () => {
    mockRoleSource = { roleByWorktree: {}, rolesUnavailable: true };
    openPanel();
    fireEvent.click(screen.getByTestId('sessions-role-filter-role-review'));
    expect(screen.getByTestId('sessions-role-filter-unavailable')).toBeTruthy();
    expect(screen.getByTestId('sessions-role-unavailable-banner')).toBeTruthy();
    expect(link('1')).toBe('/worktrees/1');
    expect(screen.getByTestId('session-item-3')).toBeTruthy();
    expect(screen.queryByTestId('sessions-filter-count')).toBeNull();
  });

  it('clear drops the role condition too', () => {
    openPanel();
    fireEvent.click(screen.getByTestId('sessions-role-filter-role-review'));
    fireEvent.click(screen.getByTestId('sessions-filter-clear'));
    expect(screen.getByTestId('session-item-3')).toBeTruthy();
    expect(link('1')).toBe('/worktrees/1');
  });

  for (const mobile of [false, true]) {
    it(`${mobile ? 'mobile sheet' : 'PC modal'}: the checklist filters and the link carries ?instance=`, () => {
      mockIsMobile = mobile;
      openPanel();
      expect(Boolean(screen.queryByTestId('sessions-filter-sheet'))).toBe(mobile);
      expect(screen.getByTestId('sessions-role-filter-none')).toBeTruthy();
      expect(screen.getByTestId('sessions-role-filter-ambiguous')).toBeTruthy();
      fireEvent.click(screen.getByTestId('sessions-role-filter-role-review'));
      expect(link('1')).toBe('/worktrees/1?instance=codex-2');
      expect(screen.queryByTestId('session-item-3')).toBeNull();
    });
  }
});
