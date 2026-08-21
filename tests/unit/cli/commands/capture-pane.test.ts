/**
 * Issue #1623 — `commandmate capture <id> --pane`, the CLI transcript viewer (案B).
 *
 * This is the half of reading mode that does not care about tmux versions,
 * attaching, or the server's global key table: it asks the existing capture API
 * for the pane and squeezes it locally. It is also the documented fallback for a
 * tmux older than 3.2, where the popup cannot exist at all — so it has to work on
 * its own terms, not as an afterthought of 案A.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { mockFetchResponse, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { squeezeTranscript, isVisuallyBlank } from '@/lib/tmux/transcript-squeeze';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

/** A real 1000-row capture of an idle Claude session (962 blank rows). */
const RAW_PANE = fs.readFileSync(
  path.join(__dirname, '../../lib/tmux/fixtures/capture-claude-idle.txt'),
  'utf-8'
);

const WORKTREE = { id: 'wt1', name: 'wt1', cliToolId: 'claude', agentInstances: [] };

async function runCapture(argv: string[]): Promise<void> {
  const { createCaptureCommand } = await import('@/cli/commands/capture');
  await createCaptureCommand().parseAsync(['node', 'capture', ...argv]);
}

/**
 * Response of GET /api/worktrees/:id/resolve-target (Issue #1925).
 *
 * `--pane` has to name a CLI tool in the POST body — POST /capture takes no
 * default — and since #1925 it asks the server which one rather than deriving
 * it from the worktree row itself.
 */
function resolveTarget(cliToolId: string, instanceId = cliToolId, resolvedBy = 'worktree-default') {
  return { data: { cliToolId, instanceId, resolvedBy, conflict: null } };
}

/** GET /api/worktrees/:id/resolve-target then POST /api/worktrees/:id/capture. */
function mockPaneFetch(output: string = RAW_PANE): void {
  mockFetchSequence([resolveTarget('claude'), { data: { output } }]);
}

/** The POST /capture call, located by URL rather than by position: the
 * capability probe and the resolve both precede it and neither is the subject. */
function captureCall(): [string, RequestInit | undefined] {
  const call = vi.mocked(global.fetch).mock.calls.find((c) => String(c[0]).includes('/capture'));
  expect(call).toBeDefined();
  return call as unknown as [string, RequestInit | undefined];
}

function lastLoggedLine(): string {
  return mockConsoleLog.mock.calls[mockConsoleLog.mock.calls.length - 1][0] as string;
}

describe('capture --pane', () => {
  it('POSTs to the existing capture route for the raw pane', async () => {
    mockPaneFetch();
    await runCapture(['wt1', '--pane']);

    const [url, init] = captureCall();
    expect(url).toContain('/api/worktrees/wt1/capture');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ cliToolId: 'claude', lines: 1000 });
  });

  it('squeezes the pane before printing it', async () => {
    mockPaneFetch();
    await runCapture(['wt1', '--pane']);

    const printed = lastLoggedLine();
    expect(printed).toBe(squeezeTranscript(RAW_PANE).text);
    // The point of the whole feature: 1000 rows of mostly-blank canvas becomes
    // something that fits on a screen.
    expect(printed.split('\n').length).toBeLessThan(RAW_PANE.split('\n').length / 10);
  });

  it('--raw prints the frame verbatim', async () => {
    mockPaneFetch();
    await runCapture(['wt1', '--pane', '--raw']);
    expect(lastLoggedLine()).toBe(RAW_PANE);
  });

  it('--tail keeps the last N lines of the SQUEEZED transcript', async () => {
    mockPaneFetch();
    await runCapture(['wt1', '--pane', '--tail', '20']);

    const printed = lastLoggedLine();
    expect(printed.split('\n')).toHaveLength(20);
    expect(printed).toBe(squeezeTranscript(RAW_PANE).text.split('\n').slice(-20).join('\n'));

    // Why "after the squeeze" is the useful reading of N. The blank padding sits
    // BETWEEN the transcript and the composer, not below it, so tailing the raw
    // frame spends the budget on padding: measured on this capture, the last 20
    // raw rows hold 4 readable lines while the last 20 squeezed rows hold 13.
    const readable = (lines: string[]): number => lines.filter((l) => !isVisuallyBlank(l)).length;
    expect(readable(RAW_PANE.split('\n').slice(-20))).toBe(4);
    expect(readable(printed.split('\n'))).toBeGreaterThan(10);
  });

  it('rejects a --tail that is not a positive integer', async () => {
    for (const bad of ['0', '-3', 'abc', '2.5']) {
      mockPaneFetch();
      mockExit.mockClear();
      await runCapture(['wt1', '--pane', '--tail', bad]);
      expect(mockExit, bad).toHaveBeenCalledWith(2);
    }
  });

  it('rejects --tail / --raw without --pane instead of ignoring them', async () => {
    mockFetchResponse({ content: 'x' });
    await runCapture(['wt1', '--tail', '5']);
    expect(mockExit).toHaveBeenCalledWith(2);

    mockExit.mockClear();
    mockFetchResponse({ content: 'x' });
    await runCapture(['wt1', '--raw']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('capture --pane CLI tool resolution', () => {
  it("uses the worktree's own default when nothing else names an agent", async () => {
    mockFetchSequence([resolveTarget('codex'), { data: { output: 'hello' } }]);
    await runCapture(['wt1', '--pane']);

    const body = JSON.parse(captureCall()[1]?.body as string);
    expect(body.cliToolId).toBe('codex');
  });

  /**
   * Issue #1925: reaching the last stage of the chain is the server's business
   * and it says so (`resolvedBy: 'fallback'` — the shape of the #1909 bug). The
   * CLI's job here is to repeat the answer rather than re-derive it, so what is
   * pinned is that it does not second-guess a 'fallback'.
   */
  it('uses the last-resort agent the server reports, without overriding it', async () => {
    mockFetchSequence([
      resolveTarget('claude', 'claude', 'fallback'),
      { data: { output: 'hello' } },
    ]);
    await runCapture(['wt1', '--pane']);

    const body = JSON.parse(captureCall()[1]?.body as string);
    expect(body.cliToolId).toBe('claude');
  });

  /**
   * Issue #1925: --agent goes to the server too. Short-circuiting it here would
   * put one stage of the precedence chain back in the CLI, and one stage is how
   * the second implementation started (design §3 P4).
   */
  it('sends --agent to the server and uses what comes back', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex', 'explicit'),
      { data: { output: 'hello' } },
    ]);
    await runCapture(['wt1', '--pane', '--agent', 'codex']);

    const resolveCall = vi.mocked(global.fetch).mock.calls.find((c) =>
      String(c[0]).includes('/resolve-target')
    );
    expect(String(resolveCall?.[0])).toContain('cliTool=codex');
    const body = JSON.parse(captureCall()[1]?.body as string);
    expect(body.cliToolId).toBe('codex');
  });

  it('passes --instance through to the route', async () => {
    // Issue #1629: the roster decides which tool an instance belongs to.
    mockFetchSequence([
      resolveTarget('codex', 'codex-2', 'roster'),
      { data: { output: 'hello' } },
    ]);
    await runCapture(['wt1', '--pane', '--instance', 'codex-2']);

    const body = JSON.parse(captureCall()[1]?.body as string);
    expect(body.cliToolId).toBe('codex');
    expect(body.instanceId).toBe('codex-2');
  });

  it('rejects an invalid agent before any request', async () => {
    await runCapture(['wt1', '--pane', '--agent', 'not-a-tool']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

describe('capture --pane --json', () => {
  it('reports the squeezed text with before/after counts', async () => {
    mockPaneFetch();
    await runCapture(['wt1', '--pane', '--json']);

    const json = JSON.parse(lastLoggedLine());
    expect(json.cliToolId).toBe('claude');
    expect(json.squeezed).toBe(true);
    expect(json.output).toBe(squeezeTranscript(RAW_PANE).text);
    expect(json.rawLines).toBe(RAW_PANE.split('\n').length);
    expect(json.lines).toBe(json.output.split('\n').length);
    expect(json.lines).toBeLessThan(json.rawLines);
  });

  it('marks --raw output as unsqueezed and counts the raw rows', async () => {
    mockPaneFetch();
    await runCapture(['wt1', '--pane', '--raw', '--json']);

    const json = JSON.parse(lastLoggedLine());
    expect(json.squeezed).toBe(false);
    expect(json.output).toBe(RAW_PANE);
    expect(json.lines).toBe(json.rawLines);
  });

  it('flags whether --tail actually truncated anything', async () => {
    mockPaneFetch();
    await runCapture(['wt1', '--pane', '--tail', '5', '--json']);
    expect(JSON.parse(lastLoggedLine()).tailed).toBe(true);

    mockConsoleLog.mockClear();
    mockPaneFetch();
    await runCapture(['wt1', '--pane', '--tail', '99999', '--json']);
    expect(JSON.parse(lastLoggedLine()).tailed).toBe(false);
  });
});

describe('capture without --pane is unchanged', () => {
  it('still reads the accumulated response from /current-output', async () => {
    mockFetchResponse({ content: 'Hello from agent', fullOutput: 'x' });
    await runCapture(['wt1']);

    expect(vi.mocked(global.fetch).mock.calls[0][0]).toContain('/current-output');
    expect(mockConsoleLog).toHaveBeenCalledWith('Hello from agent');
  });
});
