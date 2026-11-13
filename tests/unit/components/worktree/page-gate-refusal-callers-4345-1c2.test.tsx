/**
 * Issue #4345 1c-2: the callers of the settings, schedule, editor and attachment writes take the
 * page gate's refusal (`HandoffPageOperationRefusedError`: the page's registration lapsed, nothing was
 * sent) as "nothing happened": no failure display, no fetch, what the person entered is kept, and
 * nothing looks saved. The existing re-sign-in prompt is left to the gateway.
 *
 * Positive controls: red before 1c-2 (each told its failure / reverted the input / looked saved).
 * Negative controls: an ordinary failure (500, no response) is still told as before.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/components/ui/ConfirmDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/ConfirmDialog')>();
  return { ...actual, useConfirm: () => async () => true };
});

import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';
import { VibeLocalSettings } from '@/components/worktree/VibeLocalSettings';
import { AgentSettingsPane, OpencodeInstanceSettings } from '@/components/worktree/AgentSettingsPane';
import { ExecutionLogPane } from '@/components/worktree/ExecutionLogPane';
import { ScheduleEditDialog } from '@/components/worktree/schedules/ScheduleEditDialog';
import { ToastProvider } from '@/components/common/Toast';
import { useFileOperations } from '@/hooks/useFileOperations';
import { useImageAttachment } from '@/hooks/useImageAttachment';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { beginHandoffPageRequest, HandoffPageOperationRefusedError, reportHandoffPageResponse, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { json, PAGE_WORKTREE as A, PageTree, standInPage, settle, type StandInPage } from '../../lib/handoff/page-owner-harness';

beforeAll(() => installRadixJsdomPolyfills());

interface Sent { url: string; method: string }
let sent: Sent[];
/** What the write answers: a status, `0` for no response, `undefined` for its normal answer. */
let writeStatus: number | undefined;
let writeOk: () => Response;
let errorLog: ReturnType<typeof vi.spyOn>;

const OPENCODE = { settings: { opencode: { agent: null, providerId: null, modelId: null, variant: null } }, catalog: { connected: true, providers: [], agents: [{ name: 'build', mode: 'primary' }] } };
const SCHEDULE = { id: 's1', worktree_id: A, name: 'nightly', message: 'm', cron_expression: '0 0 * * *', cli_tool_id: 'claude', enabled: 1, last_executed_at: null, next_execute_at: null, created_at: 0, updated_at: 0 };

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  sent = [];
  writeStatus = undefined;
  writeOk = () => json(200, { success: true });
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/mem/mode')) return json(200, { ok: true, mode: 'on', features: { popup: true } });
    if (url.includes('/mem/handoff/requests/r1')) return (await import('../../lib/handoff/page-owner-harness')).answerHandoffDialog(url)!;
    if (method === 'GET') {
      if (url === '/api/ollama/models') return json(200, { models: [{ name: 'llama' }] });
      if (url === `/api/worktrees/${A}/instances/opencode`) return json(200, OPENCODE);
      if (url === `/api/worktrees/${A}/schedules`) return json(200, { schedules: [SCHEDULE] });
      if (url === `/api/worktrees/${A}/execution-logs`) return json(200, { logs: [] });
      if (url === `/api/worktrees/${A}/schedules/active`) return json(200, { schedules: [] });
      if (url === `/api/worktrees/${A}/files/docs/a.md`) return json(200, { success: true, content: '# a' });
      return json(200, {});
    }
    sent.push({ url, method });
    if (writeStatus === 0) throw new TypeError('Failed to fetch');
    if (writeStatus !== undefined) return json(writeStatus, { success: false, error: url.includes('/cmate/schedules') ? 'boom' : { message: 'boom' } });
    return writeOk();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

/** The surface drawn under a page; then the page's session lapses (another entry's 401). */
async function drawn(ui: React.ReactElement): Promise<StandInPage> {
  const page = standInPage();
  render(
    <ToastProvider>
      <PageTree owner={page.owner}>{ui}</PageTree>
    </ToastProvider>,
  );
  await settle();
  return page;
}
function lapse(page: StandInPage): void {
  act(() => {
    reportHandoffPageResponse(beginHandoffPageRequest(page.registration), { status: 401 });
  });
}
const writes = () => sent.length;

describe('[#4345 1c-2] MarkdownEditor save', () => {
  const edit = async () => {
    const textarea = (await screen.findByTestId('markdown-editor-textarea')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'changed' } });
    return textarea;
  };

  it('refused: nothing sent, no toast (neither saved nor failed), the text is kept', async () => {
    const onSave = vi.fn();
    const page = await drawn(<MarkdownEditor worktreeId={A} filePath="docs/a.md" onSave={onSave} />);
    const textarea = await edit();
    lapse(page);
    fireEvent.click(screen.getByTestId('save-button'));
    await settle();
    await settle();
    expect(writes()).toBe(0);
    expect(document.body.textContent).not.toMatch(/expired|failed|boom/i);
    expect(onSave).not.toHaveBeenCalled();
    expect(textarea.value).toBe('changed');
  });

  it('(negative) a 500 is still told as the save error', async () => {
    writeStatus = 500;
    await drawn(<MarkdownEditor worktreeId={A} filePath="docs/a.md" />);
    await edit();
    fireEvent.click(screen.getByTestId('save-button'));
    await waitFor(() => expect(document.body.textContent).toMatch(/boom/));
  });
});

describe('[#4345 1c-2] VibeLocalSettings context window', () => {
  const type = async () => {
    const input = (await screen.findByTestId('vibe-local-context-window-input')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4096' } });
    return input;
  };

  it('refused: nothing sent, the typed value is kept', async () => {
    const page = await drawn(<VibeLocalSettings worktreeId={A} vibeLocalModel={null} onVibeLocalModelChange={vi.fn()} onVibeLocalContextWindowChange={vi.fn()} />);
    const input = await type();
    lapse(page);
    fireEvent.blur(input);
    await settle();
    await settle();
    expect(writes()).toBe(0);
    expect(input.value).toBe('4096');
  });

  it('(negative) a failed save still reverts the input', async () => {
    writeStatus = 500;
    await drawn(<VibeLocalSettings worktreeId={A} vibeLocalModel={null} onVibeLocalModelChange={vi.fn()} onVibeLocalContextWindowChange={vi.fn()} />);
    const input = await type();
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe(''));
  });
});

describe('[#4345 1c-2] AgentSettingsPane', () => {
  const pick = async () => {
    const select = (await screen.findByTestId('opencode-agent-select-opencode')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'build' } });
    return select;
  };
  const opencode = () => <OpencodeInstanceSettings worktreeId={A} instances={[{ id: 'opencode', label: 'OpenCode' }]} />;

  it('OpenCode settings write refused: no save error, and the choice does not look saved', async () => {
    const page = await drawn(opencode());
    const select = await screen.findByTestId('opencode-agent-select-opencode');
    await settle();
    lapse(page);
    fireEvent.change(select, { target: { value: 'build' } });
    await settle();
    await settle();
    expect(writes()).toBe(0);
    expect(screen.queryByTestId('opencode-settings-error')).toBeNull();
    expect((select as HTMLSelectElement).value).toBe('');
  });

  it('(negative) OpenCode settings write answering 500: the save error', async () => {
    writeStatus = 500;
    await drawn(opencode());
    await pick();
    await waitFor(() => expect(screen.getByTestId('opencode-settings-error')).toBeInTheDocument());
  });

  const agents = () => (
    <AgentSettingsPane worktreeId={A} selectedAgents={['claude', 'codex']} onSelectedAgentsChange={vi.fn()} vibeLocalModel={null} onVibeLocalModelChange={vi.fn()} />
  );
  const choose = () => {
    fireEvent.click(screen.getByTestId('agent-checkbox-claude'));
    fireEvent.click(screen.getByTestId('agent-checkbox-gemini'));
  };

  it('agents PATCH refused: nothing sent, the chosen pair stays', async () => {
    const page = await drawn(agents());
    lapse(page);
    choose();
    await settle();
    await settle();
    expect(writes()).toBe(0);
    expect(screen.getByTestId('agent-checkbox-gemini')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('agent-checkbox-claude')).toHaveAttribute('data-state', 'unchecked');
  });

  it('(negative) agents PATCH answering 500: the choice reverts', async () => {
    writeStatus = 500;
    await drawn(agents());
    choose();
    await waitFor(() => expect(screen.getByTestId('agent-checkbox-claude')).toHaveAttribute('data-state', 'checked'));
    expect(screen.getByTestId('agent-checkbox-gemini')).toHaveAttribute('data-state', 'unchecked');
  });
});

describe('[#4345 1c-2] ExecutionLogPane schedule toggle / delete', () => {
  it.each(['schedule-toggle-nightly', 'schedule-delete-nightly'])('%s refused: nothing sent, nothing logged', async (testId) => {
    const page = await drawn(<ExecutionLogPane worktreeId={A} />);
    const button = await screen.findByTestId(testId);
    lapse(page);
    errorLog.mockClear();
    fireEvent.click(button);
    await settle();
    await settle();
    expect(writes()).toBe(0);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each(['schedule-toggle-nightly', 'schedule-delete-nightly'])('(negative) %s with no response: still logged', async (testId) => {
    writeStatus = 0;
    await drawn(<ExecutionLogPane worktreeId={A} />);
    const button = await screen.findByTestId(testId);
    errorLog.mockClear();
    fireEvent.click(button);
    await waitFor(() => expect(errorLog).toHaveBeenCalled());
  });
});

describe('[#4345 1c-2] ScheduleEditDialog save', () => {
  const dialog = () => (
    <ScheduleEditDialog isOpen worktreeId={A} initialValues={{ name: 'nightly', cronExpression: '0 0 * * *', message: 'm', cliToolId: 'claude' }} onClose={vi.fn()} onSaved={vi.fn()} />
  );

  it('refused: no save error, nothing sent, not closed or saved', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const page = standInPage();
    render(
      <PageTree owner={page.owner}>
        <ScheduleEditDialog isOpen worktreeId={A} initialValues={{ name: 'nightly', cronExpression: '0 0 * * *', message: 'm', cliToolId: 'claude' }} onClose={onClose} onSaved={onSaved} />
      </PageTree>,
    );
    await settle();
    lapse(page);
    fireEvent.click(screen.getByTestId('schedule-save-button'));
    await settle();
    await settle();
    expect(writes()).toBe(0);
    expect(screen.queryByTestId('schedule-submit-error')).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('(negative) a 500 is still the save error', async () => {
    writeStatus = 500;
    await drawn(dialog());
    fireEvent.click(screen.getByTestId('schedule-save-button'));
    await waitFor(() => expect(screen.getByTestId('schedule-submit-error')).toBeInTheDocument());
  });
});

describe('[#4345 1c-2] useFileOperations (move)', () => {
  function setup(page: StandInPage | null) {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const hook = renderHook(() => useFileOperations(A, vi.fn(), onSuccess, onError, page?.owner));
    act(() => hook.result.current.handleMove('a.md', 'file'));
    return { hook, onError, onSuccess };
  }

  it('refused: no error, the dialog and its target stay', async () => {
    const page = standInPage();
    const { hook, onError } = setup(page);
    lapse(page);
    await act(async () => hook.result.current.handleMoveConfirm('dir'));
    expect(writes()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    expect(hook.result.current.isMoveDialogOpen).toBe(true);
    expect(hook.result.current.moveTarget).toEqual({ path: 'a.md', type: 'file' });
  });

  it('(negative) a 500 is still the error and the dialog closes', async () => {
    writeStatus = 500;
    const page = standInPage();
    const { hook, onError } = setup(page);
    await act(async () => hook.result.current.handleMoveConfirm('dir'));
    expect(onError).toHaveBeenCalledWith('boom');
    expect(hook.result.current.isMoveDialogOpen).toBe(false);
  });
});

describe('[#4345 1c-2] useImageAttachment', () => {
  const pickFile = async (uploadFn: () => Promise<{ path: string }>) => {
    const hook = renderHook(() => useImageAttachment(A, uploadFn));
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await act(async () => hook.result.current.handleFileSelect({ target: { files: [file] } } as unknown as React.ChangeEvent<HTMLInputElement>));
    return hook;
  };

  it('refused upload: no error, nothing attached', async () => {
    const hook = await pickFile(async () => {
      throw new HandoffPageOperationRefusedError();
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.attachedImage).toBeNull();
    expect(hook.result.current.isUploading).toBe(false);
  });

  it('(negative) an ordinary upload failure is still told', async () => {
    const hook = await pickFile(async () => {
      throw new Error('Upload broke');
    });
    expect(hook.result.current.error).toBe('Upload broke');
  });
});
