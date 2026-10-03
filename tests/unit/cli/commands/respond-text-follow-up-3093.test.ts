/**
 * `respond` at a "No, tell … what to do differently" row (Issue #3093).
 *
 * Choosing the row closes the dialog and leaves the agent waiting for the reason
 * in its input box. A second `respond` with the reason then met no dialog and
 * came back `prompt_no_longer_active`, while `send` delivered it. Both halves now
 * name `send` as the way to deliver the text.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('respond: options that continue as text (Issue #3093)', () => {
  it('after choosing the row, names `send` as the way to deliver the text', async () => {
    mockFetchResponse(
      {
        success: true,
        answer: '3',
        textFollowUp: {
          optionNumber: 3,
          optionLabel: 'No, tell Command Code what to do differently',
          message: 'unused by the CLI',
        },
      },
      200,
    );
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', '3', '--agent', 'command-code']);

    const out = stderr();
    expect(out).toContain('Response sent.');
    expect(out).toContain('option 3 ("No, tell Command Code what to do differently") asks for your text');
    expect(out).toContain('commandmate send wt1 "<text>"');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('prints no follow-up for an ordinary choice', async () => {
    mockFetchResponse({ success: true, answer: '1' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', '1']);

    expect(stderr()).not.toContain('commandmate send');
  });

  it('when text meets no dialog, says why it was not delivered and what to use instead', async () => {
    mockFetchResponse(
      { success: false, answer: 'use the other API', reason: 'prompt_no_longer_active' },
      200,
    );
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', 'use the other API']);

    const out = stderr();
    expect(out).toContain('prompt_no_longer_active');
    expect(out).toContain('this text was not delivered');
    expect(out).toContain('commandmate send wt1 "<text>"');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('does not suggest `send` for a number that met no dialog', async () => {
    mockFetchResponse({ success: false, answer: '2', reason: 'prompt_no_longer_active' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', '2']);

    expect(stderr()).not.toContain('commandmate send');
  });
});
