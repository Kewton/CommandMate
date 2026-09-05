/**
 * Issue #2317 Phase C — `commandmate capture <id> --pane --follow`.
 *
 * The reading path that needs neither a tmux client nor the server's global key
 * table. That is not a convenience: `tmux attach -r` delivers no keys but the
 * detach one, so #1623's `prefix + g` popup CANNOT open in a read-only attach,
 * and the snapshot popup does not follow a turn as it is generated either.
 *
 * Two properties are load-bearing and both are asserted:
 *
 *  - it makes exactly the request `--pane` already makes, so the detection
 *    pipeline sees no different payload because a human is watching;
 *  - it renders the SQUEEZED tail. On the real fixture 962 of 1000 rows are
 *    blank layout padding, so an unsqueezed tail would be a screen of nothing —
 *    which is the whole defect Issue #2317 is about.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '@/cli/types';
import { squeezeTranscript } from '@/lib/tmux/transcript-squeeze';

/** ESC, written as an escape so the byte is visible in a diff and in review. */
const ESC = '\u001b';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

/** A real 1000-row capture of an idle Claude session (962 blank rows). */
const RAW_PANE = fs.readFileSync(
  path.join(__dirname, '../../lib/tmux/fixtures/capture-claude-idle.txt'),
  'utf-8',
);

function resolveTargetPayload(cliToolId: string, instanceId = cliToolId) {
  return { cliToolId, instanceId, resolvedBy: 'worktree-default', conflict: null };
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

async function runCapture(argv: string[]): Promise<void> {
  const { createCaptureCommand } = await import('@/cli/commands/capture');
  try {
    await createCaptureCommand().parseAsync(['node', 'capture', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
}

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

describe('flag combinations', () => {
  it('refuses --follow without --pane', async () => {
    // Silently ignoring it would look like the flag was accepted and did nothing.
    await runCapture(['wt1', '--follow']);
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(stderr()).toContain('--follow and --interval require --pane');
  });

  it('refuses --interval without --follow', async () => {
    await runCapture(['wt1', '--pane', '--interval', '1000']);
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(stderr()).toContain('--interval requires --follow');
  });

  it('refuses --follow with --json or --raw', async () => {
    // Both mean "give me the bytes", and neither has a meaning that survives
    // being overwritten every two seconds.
    await runCapture(['wt1', '--pane', '--follow', '--json']);
    expect(stderr()).toContain('--follow cannot be combined with --json or --raw');

    mockConsoleError.mockClear();
    await runCapture(['wt1', '--pane', '--follow', '--raw']);
    expect(stderr()).toContain('--follow cannot be combined with --json or --raw');
  });

  it('refuses to redraw a screen that is not a terminal', async () => {
    const isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      await runCapture(['wt1', '--pane', '--follow']);
      expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
      expect(stderr()).toContain('--follow needs a terminal');
      // And it names the thing to do instead, rather than just refusing.
      expect(stderr()).toContain('--pane --tail N');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    }
  });

  it('rejects an --interval outside the accepted range', async () => {
    // A terminal, so the loop gets past the TTY guard and reaches the parse.
    const isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      for (const bad of ['0', '10', '600000', 'soon']) {
        mockConsoleError.mockClear();
        await runCapture(['wt1', '--pane', '--follow', '--interval', bad]);
        expect(stderr(), bad).toContain('--interval must be an integer between');
      }
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    }
  });
});

describe('the redraw loop', () => {
  interface Iteration {
    writes: string[];
    postBodies: unknown[];
  }

  /**
   * Drive exactly one iteration.
   *
   * The loop is unbounded by design (Ctrl-C is the exit), so the SECOND capture
   * request throws and unwinds it — which also exercises the `finally` that puts
   * the cursor back.
   */
  async function runOneIteration(argv: string[]): Promise<Iteration> {
    const writes: string[] = [];
    const postBodies: unknown[] = [];
    const isTTY = process.stdout.isTTY;
    const rows = process.stdout.rows;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    const realFetch = global.fetch;
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/capabilities')) {
        return jsonResponse({
          serverVersion: '0.0.0-test',
          capabilities: ['resolve-session-target'],
        });
      }
      if (url.includes('/resolve-target')) return jsonResponse(resolveTargetPayload('claude'));
      postBodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (postBodies.length > 1) throw new Error('stop-loop');
      return jsonResponse({ output: RAW_PANE });
    }) as unknown as typeof fetch;

    try {
      await runCapture(argv).catch((error: Error) => {
        if (!/stop-loop/.test(error.message)) throw error;
      });
    } finally {
      write.mockRestore();
      global.fetch = realFetch;
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
    }
    return { writes, postBodies };
  }

  it('asks the capture route for exactly the rows `--pane` asks for', async () => {
    // The point of reusing the number: the server has no reason to behave
    // differently because a human is watching, so the detection pipeline's view
    // of the pane is untouched by this command existing.
    const { postBodies } = await runOneIteration([
      'wt1', '--pane', '--follow', '--interval', '250',
    ]);
    expect(postBodies.length).toBeGreaterThan(0);
    expect(postBodies[0]).toEqual({ cliToolId: 'claude', lines: 1000 });
  });

  it('renders the SQUEEZED tail, clearing the screen each time', async () => {
    const { writes } = await runOneIteration([
      'wt1', '--pane', '--follow', '--interval', '250',
    ]);
    const frame = writes.join('');

    // Cursor home + erase display: a redraw, not an append.
    expect(frame).toContain(`${ESC}[H${ESC}[2J`);
    // Cursor hidden while redrawing, and put back whatever ends the loop.
    expect(frame).toContain(`${ESC}[?25l`);
    expect(frame).toContain(`${ESC}[?25h`);
    expect(frame).toContain('[CommandMate] wt1 / claude');
    expect(frame).toContain('Ctrl-C to stop');

    // The defect this whole Issue is about, expressed as an assertion. The
    // fixture's transcript ends at row 45 of 1000 and its composer sits at 997,
    // so the last 23 rows of the RAW frame carry the input box and NOT ONE LINE
    // of conversation — which is exactly what a 24-row terminal sees when it
    // attaches. The squeeze is what brings the transcript back into that window.
    const TRANSCRIPT_MARKER = 'Cooked for 46s';
    const rawTail = RAW_PANE.split('\n').slice(-23).join('\n');
    expect(rawTail).not.toContain(TRANSCRIPT_MARKER);

    const squeezedTail = squeezeTranscript(RAW_PANE).text.split('\n').slice(-23).join('\n');
    expect(squeezedTail).toContain(TRANSCRIPT_MARKER);
    expect(frame).toContain(TRANSCRIPT_MARKER);
  });
});
