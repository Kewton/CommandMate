/**
 * `commandmate respond` reports an open picker the server could not verify
 * (Issue #2486).
 *
 * The Issue's `respond "1"` printed `Warning: Response may not have been
 * applied. Reason: prompt_no_longer_active` for a picker that was still on
 * screen. The server now answers `unsupported_dialog_layout` with a message for
 * that case; it is a refusal BEFORE sending, so the CLI says so plainly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const MESSAGE =
  "An AskUserQuestion picker is on screen, but its layout could not be verified as one of the agent's dialogs, so no key was sent.";

describe('[#2486] respond on an unverifiable picker', () => {
  it('says the answer was not sent, with the reason and the server message', async () => {
    mockFetchResponse(
      { success: false, answer: '1', reason: 'unsupported_dialog_layout', message: MESSAGE },
      200,
    );
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', '1', '--agent', 'claude']);

    const printed = mockConsoleError.mock.calls.map(call => String(call[0])).join('\n');
    expect(printed).toContain('Answer was not sent. Reason: unsupported_dialog_layout');
    expect(printed).toContain(MESSAGE);
    expect(printed).not.toContain('may not have been applied');
    expect(mockExit).toHaveBeenCalledWith(99); // UNEXPECTED_ERROR, as before
  });

  it('keeps the old wording for prompt_no_longer_active', async () => {
    mockFetchResponse({ success: false, answer: '1', reason: 'prompt_no_longer_active' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', '1']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      'Warning: Response may not have been applied. Reason: prompt_no_longer_active',
    );
    expect(mockExit).toHaveBeenCalledWith(99);
  });
});
