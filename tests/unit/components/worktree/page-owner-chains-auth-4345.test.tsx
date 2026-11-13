/**
 * Issue #4345 1c 再指示 1 (指摘 2): the other callers of the same requests, found by following the
 * call chains from the page's surfaces (component → hook → client), report their 401 through the
 * gateway under the page's registration holder: the move dialog's destination tree (`MoveDialog`, the
 * root and a subdirectory), the schedules' warning read (`ExecutionLogPane` → `ExecutionLogsView` →
 * `ScheduleConfigWarnings`), a log's detail (`ExecutionLogsView`), the schedule's save
 * (`ScheduleEditDialog`), the instance's CLI reference and target (`InstanceCliCommandsModal`), the
 * vibe-local models and saves (`AgentSettingsPane` → `VibeLocalSettings`), an HTML preview's images
 * (`useInlinedHtmlImages`), and the key sends of the split (`InterruptButton`, `useDirectInput`,
 * `useSpecialKeys`, `UnsentComposerBar`). Drawn beside the one host (see `page-owner-harness`).
 *
 * Positive controls are red before 再指示 1 (nothing here reported); the negative controls are green
 * before and after.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

import { MoveDialog } from '@/components/worktree/MoveDialog';
import { ScheduleConfigWarnings } from '@/components/worktree/schedules/ScheduleConfigWarnings';
import { ExecutionLogsView } from '@/components/worktree/schedules/ExecutionLogsView';
import { ScheduleEditDialog } from '@/components/worktree/schedules/ScheduleEditDialog';
import { InstanceCliCommandsModal } from '@/components/worktree/InstanceCliCommandsModal';
import { VibeLocalSettings } from '@/components/worktree/VibeLocalSettings';
import { InterruptButton } from '@/components/worktree/InterruptButton';
import { UnsentComposerBar } from '@/components/worktree/UnsentComposerBar';
import { useInlinedHtmlImages } from '@/hooks/useInlinedHtmlImages';
import { useDirectInput } from '@/hooks/useDirectInput';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import type { ExecutionLog } from '@/components/worktree/schedules/ExecutionLogsView';
import { describeEntryCases, json, PAGE_WORKTREE as A, type EntryCase } from '../../lib/handoff/page-owner-harness';

beforeAll(() => installRadixJsdomPolyfills());
beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const noop = () => undefined;
const LOG = { id: 'log-1', schedule_id: 's1', worktree_id: A, message: 'm', result: 'ok', exit_code: 0, status: 'completed', started_at: 0, completed_at: 1, created_at: 0 } as unknown as ExecutionLog;

let sendDirect: (() => void) | null = null;
function DirectInput() {
  const { send } = useDirectInput(A, 'claude');
  sendDirect = () => send([{ type: 'text', text: 'x' }]);
  return null;
}
let sendKeys: (() => void) | null = null;
function SpecialKeys() {
  const send = useSpecialKeys(A, 'claude');
  sendKeys = () => send(['Escape']);
  return null;
}
function HtmlImages() {
  useInlinedHtmlImages(A, 'docs/page.html', '<img src="pic.png">');
  return null;
}

const CASES: Record<string, EntryCase> = {
  'move destination root tree (MoveDialog)': {
    matches: (url) => url === `/api/worktrees/${A}/tree`,
    ok: () => json(200, { items: [{ name: 'dir', type: 'directory' }] }),
    ui: () => <MoveDialog isOpen onClose={noop} onConfirm={noop} worktreeId={A} sourcePath="a.md" sourceType="file" />,
  },
  'move destination subdirectory (MoveDialog)': {
    matches: (url) => url === `/api/worktrees/${A}/tree/dir`,
    ok: () => json(200, { items: [] }),
    ui: () => <MoveDialog isOpen onClose={noop} onConfirm={noop} worktreeId={A} sourcePath="a.md" sourceType="file" />,
    trigger: async () => {
      const toggle = await screen.findByText('dir');
      fireEvent.click(toggle.closest('[role="treeitem"], button, div')!.querySelector('button') ?? toggle);
    },
  },
  'schedules warning read (ScheduleConfigWarnings)': {
    matches: (url) => url === `/api/worktrees/${A}/files/CMATE.md`,
    ok: () => json(200, { content: '' }),
    ui: () => <ScheduleConfigWarnings worktreeId={A} />,
  },
  'log detail (ExecutionLogsView)': {
    matches: (url) => url === `/api/worktrees/${A}/execution-logs/log-1`,
    ok: () => json(200, { log: LOG }),
    ui: () => <ExecutionLogsView worktreeId={A} logs={[LOG]} />,
    trigger: () => fireEvent.click(screen.getByTestId('execution-log-row').querySelector('button')!),
  },
  'schedule save (ScheduleEditDialog)': {
    matches: (url, method) => url === `/api/worktrees/${A}/cmate/schedules` && method === 'POST',
    ok: () => json(200, {}),
    ui: () => (
      <ScheduleEditDialog
        isOpen
        worktreeId={A}
        initialValues={{ name: 'nightly', cronExpression: '0 0 * * *', message: 'm', cliToolId: 'claude' }}
        onClose={noop}
        onSaved={noop}
      />
    ),
    trigger: () => fireEvent.click(screen.getByTestId('schedule-save-button')),
  },
  'CLI reference read (InstanceCliCommandsModal)': {
    matches: (url) => url === `/api/worktrees/${A}/cli-reference`,
    ok: () => json(200, { commands: [] }),
    ui: () => <InstanceCliCommandsModal worktreeId={A} instance={{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }} isOpen onClose={noop} />,
  },
  'vibe-local models (VibeLocalSettings)': {
    matches: (url) => url === '/api/ollama/models',
    ok: () => json(200, { models: [{ name: 'llama' }] }),
    ui: () => <VibeLocalSettings worktreeId={A} vibeLocalModel={null} onVibeLocalModelChange={noop} />,
  },
  'vibe-local model save (VibeLocalSettings)': {
    matches: (url, method) => url === `/api/worktrees/${A}` && method === 'PATCH',
    ok: () => json(200, {}),
    ui: () => <VibeLocalSettings worktreeId={A} vibeLocalModel={null} onVibeLocalModelChange={noop} />,
    trigger: async () => {
      const select = await screen.findByTestId('vibe-local-model-select');
      await screen.findByRole('option', { name: /llama/ });
      fireEvent.change(select, { target: { value: 'llama' } });
    },
  },
  'HTML preview image (useInlinedHtmlImages)': {
    matches: (url) => url === `/api/worktrees/${A}/files/docs/pic.png`,
    ok: () => json(200, { isImage: true, content: 'data:image/png;base64,AA' }),
    ui: () => <HtmlImages />,
  },
  'interrupt (InterruptButton)': {
    matches: (url) => url === `/api/worktrees/${A}/interrupt`,
    ok: () => json(200, {}),
    ui: () => <InterruptButton worktreeId={A} cliToolId="claude" />,
    trigger: () => fireEvent.click(screen.getByTestId('interrupt-button')),
  },
  'direct input (useDirectInput)': {
    matches: (url) => url === `/api/worktrees/${A}/direct-input`,
    ok: () => json(200, {}),
    ui: () => <DirectInput />,
    trigger: () => act(() => sendDirect?.()),
  },
  'special keys (useSpecialKeys)': {
    matches: (url) => url === `/api/worktrees/${A}/special-keys`,
    ok: () => json(200, {}),
    ui: () => <SpecialKeys />,
    trigger: () => act(() => sendKeys?.()),
  },
  'clear composer (UnsentComposerBar)': {
    matches: (url) => url === `/api/worktrees/${A}/clear-composer`,
    ok: () => json(200, { cleared: true }),
    ui: () => <UnsentComposerBar worktreeId={A} cliToolId="claude" composerText="left over" />,
    trigger: () => fireEvent.click(screen.getByRole('button', { name: /clear/i })),
  },
};

function fallback(url: string): Response {
  if (url === `/api/worktrees/${A}/tree`) return json(200, { items: [{ name: 'dir', type: 'directory' }] });
  if (url === '/api/ollama/models') return json(200, { models: [{ name: 'llama' }] });
  if (url.endsWith('/resolve-target?instance=claude')) return json(200, {});
  return json(200, {});
}

describeEntryCases('the other callers along the chains', CASES, fallback);
