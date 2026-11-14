/**
 * Issue #4385 (A4 差し戻し) positive control: the scenario of `role-refusal-send-4385.test.tsx`
 * under a mutant that takes the reason away — the client does not read the 409's `roleRefusal`
 * (`readSendRoleRefusal` always null, as before the fix). The very same checks must then fail
 * for each of A4 / A5 / A8a: the screen would say only "Failed to send", show no toast and lose
 * the draft. Made with `vi.mock`, so no file of the repository is rewritten.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';
import { ROLE_CASES, expectRoleReasonShown, installFetch, renderPane, roleRefusal409, sendBody } from './role-refusal-4385-harness';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4385',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
    filteredGroups: mockCommandGroups,
    allCommands: mockCommandGroups.flatMap((g) => g.commands),
    loading: false,
    error: null,
    isCatalogStale: false,
  })),
}));
vi.mock('@/hooks/useConnectivity', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useConnectivity')>('@/hooks/useConnectivity');
  return {
    ...actual,
    useConnectivity: () => ({ signals: {} }),
    isServerConfirmedReachable: () => true,
    isConnectionKnownDown: () => false,
  };
});
// The mutant: the 409's reason is not read.
vi.mock('@/components/worktree/role-refusal-notice', async () => {
  const actual = await vi.importActual<typeof import('@/components/worktree/role-refusal-notice')>('@/components/worktree/role-refusal-notice');
  return { ...actual, readSendRoleRefusal: () => null };
});

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('[#4385 A4] (positive control) the mutant without the reason is caught', () => {
  it.each(ROLE_CASES)('$label: the checks fail', async ({ roleRefusal, sentence }) => {
    installFetch(() => roleRefusal409(roleRefusal));
    renderPane();
    await sendBody();
    await expect(expectRoleReasonShown(sentence)).rejects.toThrow();
  });
});
