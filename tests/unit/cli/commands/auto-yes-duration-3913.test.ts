/**
 * `commandmate auto-yes --enable --duration` accepts 1h〜24h (Issue #3913).
 *
 * The valid flags must reach the POST as the server's ms; the invalid ones must
 * exit 2 before any request. process.exit is replaced with one that stops the
 * action (the no-op spy elsewhere would fall through to the request).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new ExitSignal(typeof code === 'number' ? code : 0);
}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

async function runAutoYes(args: string[]): Promise<number | undefined> {
  const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
  try {
    await createAutoYesCommand().parseAsync(['node', 'auto-yes', 'wt1', ...args]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  }
  return mockExit.mock.calls[0]?.[0] as number | undefined;
}

describe('[#3913] auto-yes --duration', () => {
  it.each([
    ['2h', 7_200_000],
    ['5h', 18_000_000],
    ['24h', 86_400_000],
  ])('--enable --duration %s posts %i ms', async (flag, ms) => {
    mockFetchResponse({}, 200);

    await runAutoYes(['--enable', '--duration', flag]);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/auto-yes'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ enabled: true, duration: ms }) }),
    );
  });

  it.each(['0h', '25h', '1.5h', '90m', '01h', '+1h', '1H', ' 1h', '1hX'])(
    '--enable --duration %j exits 2 without a request',
    async (flag) => {
      mockFetchResponse({}, 200);

      const code = await runAutoYes(['--enable', '--duration', flag]);

      expect(code).toBe(ExitCode.CONFIG_ERROR);
      expect(mockConsoleError).toHaveBeenCalledWith('Error: Invalid duration. Must be 1h-24h, whole hours (e.g. 5h).');
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('--disable does not read --duration (negative control)', async () => {
    mockFetchResponse({}, 200);

    await runAutoYes(['--disable', '--duration', '25h']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ enabled: false }) }),
    );
  });

  it('names the range in --help', async () => {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    expect(createAutoYesCommand().helpInformation()).toContain('1h-24h');
  });
});
