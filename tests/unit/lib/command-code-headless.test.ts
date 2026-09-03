/**
 * Command Code headless execution (Issue #2253, Epic #2249 Phase D).
 *
 * Covers the three things the scheduler needs from `commandcode -p …`:
 * the argv it is launched with, the executable that argv is handed to, and the
 * decoding of `--output-format json` back into "what the agent said" plus "why
 * it stopped".
 *
 * Every stdout string here is read off `tests/fixtures/command-code-headless-2253/`,
 * which holds the verbatim bytes of four real 1.40.1 runs (see the README
 * there). The one synthetic stream in this file is labelled as such and exists
 * to exercise a pairing the CLI can produce but the fixtures did not catch.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';

// Partial mock: only `execFile` is replaced. `@/lib/cli-tools/command-code`
// (imported below for COMMAND_CODE_COMMAND) reaches `promisify(exec)` through
// its base class at module scope, so a whole-module mock would take the suite
// down before a single test ran.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import {
  buildCliArgs,
  getCommandForTool,
  executeClaudeCommand,
  extractCommandCodeResult,
  describeCommandCodeFailure,
  COMMAND_CODE_EXIT_REASONS,
} from '@/lib/session/claude-executor';
import { COMMAND_CODE_COMMAND } from '@/lib/cli-tools/command-code';
import { COMMAND_CODE_PERMISSIONS } from '@/config/schedule-config';

const mockedExecFile = vi.mocked(execFile);

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/command-code-headless-2253');

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function makeMockChild(): ChildProcess {
  return {
    stdin: { end: vi.fn() },
    on: vi.fn(),
    pid: undefined,
  } as unknown as ChildProcess;
}

/**
 * Run `executeClaudeCommand` against one canned `execFile` outcome.
 *
 * `exitCode` 0 takes the callback's success branch; anything else builds the
 * `ErrnoException` shape Node hands the callback when a child exits non-zero
 * (`error.code` is the numeric status), which is the branch the fixtures with
 * exit 1 and 8 actually travel.
 */
async function runWith(
  stdout: string,
  stderr: string,
  exitCode: number
): Promise<Awaited<ReturnType<typeof executeClaudeCommand>>> {
  mockedExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    if (exitCode === 0) {
      callback(null, stdout, stderr);
    } else {
      const error = new Error(`Command failed with exit code ${exitCode}`) as NodeJS.ErrnoException;
      error.code = exitCode as unknown as string;
      callback(error, stdout, stderr);
    }
    return makeMockChild();
  }) as unknown as typeof execFile);

  return executeClaudeCommand('hi', '/tmp/wt', 'command-code');
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

describe('buildCliArgs("command-code")', () => {
  it('defaults to --yolo with the json output format', () => {
    expect(buildCliArgs('hello', 'command-code')).toEqual([
      '-p',
      'hello',
      '--output-format',
      'json',
      '--yolo',
    ]);
  });

  // The five values are `.choices([...])` in command-code@1.40.1/dist/cli.mjs.
  // `--help` advertises only three of them (standard / plan / auto-accept), so
  // the constant — not the help text — is what this has to agree with.
  it.each([...COMMAND_CODE_PERMISSIONS])(
    'passes --permission-mode %s instead of --yolo',
    (permission) => {
      expect(buildCliArgs('hello', 'command-code', permission)).toEqual([
        '-p',
        'hello',
        '--output-format',
        'json',
        '--permission-mode',
        permission,
      ]);
    }
  );

  /**
   * The exclusivity itself, stated once over every input this function can be
   * called with.
   *
   * `--yolo` is a boolean alias of `--dangerously-skip-permissions`, not a
   * value of `--permission-mode`; emitting both would ask the CLI to run under
   * a mode and to bypass modes in the same argv. This is the assertion the
   * Issue #2253 acceptance criterion names, and the one a mutation has to break.
   */
  it.each([
    ...COMMAND_CODE_PERMISSIONS.map((p) => [p, '--permission-mode'] as const),
    [undefined, '--yolo'] as const,
    ['', '--yolo'] as const,
    ['acceptEdits', '--yolo'] as const,
    ['bypassPermissions', '--yolo'] as const,
    ['yolo', '--yolo'] as const,
    ['--yolo', '--yolo'] as const,
    ['workspace-write', '--yolo'] as const,
  ])('is exclusive for permission %s (expects %s)', (permission, expected) => {
    const args = buildCliArgs('hello', 'command-code', permission);
    const hasYolo = args.includes('--yolo');
    const hasMode = args.includes('--permission-mode');
    expect(hasYolo && hasMode).toBe(false);
    expect(hasYolo || hasMode).toBe(true);
    expect(expected === '--yolo' ? hasYolo : hasMode).toBe(true);
  });

  // A permission the dropdown could not have produced must not reach the CLI:
  // `.choices()` rejects an unknown value and the run dies before the prompt is
  // sent, which is a worse outcome than falling back to the unattended default.
  it('never forwards a permission outside the whitelist', () => {
    for (const bogus of ['acceptEdits', 'plan-mode', 'DONT-ASK', '--yolo; rm -rf /']) {
      expect(buildCliArgs('hello', 'command-code', bogus)).not.toContain(bogus);
    }
  });

  it('keeps the message as one argv element, never shell-joined', () => {
    const args = buildCliArgs('a "b" && c', 'command-code');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('a "b" && c');
  });
});

// ---------------------------------------------------------------------------
// executable
// ---------------------------------------------------------------------------

describe('getCommandForTool("command-code")', () => {
  // getCommandForTool spells the executable as a literal, matching `gh` and
  // `agy` beside it, so the scheduler does not import the tmux transport. This
  // is what stops that literal from drifting away from the launch path's
  // constant (Epic #2249 決定 1: `commandcode`, never `cmd`).
  it('agrees with COMMAND_CODE_COMMAND', () => {
    expect(getCommandForTool('command-code')).toBe(COMMAND_CODE_COMMAND);
    expect(getCommandForTool('command-code')).toBe('commandcode');
  });

  it('is not the tool id', () => {
    expect(getCommandForTool('command-code')).not.toBe('command-code');
  });
});

// ---------------------------------------------------------------------------
// result decoding
// ---------------------------------------------------------------------------

describe('extractCommandCodeResult', () => {
  it('reads finalText and subtype off a successful run', () => {
    expect(extractCommandCodeResult(fixture('success.jsonl'))).toEqual({
      subtype: 'success',
      finalText: 'OK',
    });
  });

  // The whole stream is present on a non-zero exit: the CLI writes every event
  // and the result line, then exits 8.
  it('reads a max_turns result with an empty answer', () => {
    expect(extractCommandCodeResult(fixture('max-turns.jsonl'))).toEqual({
      subtype: 'max_turns',
      finalText: '',
    });
  });

  // The failure shape has no `run_end` event at all — one result line, nothing
  // else — which is why the reader keys on `type: "result"`.
  it('reads an error result and keeps the CLI’s own message', () => {
    const result = extractCommandCodeResult(fixture('no-query-error.jsonl'));
    expect(result?.subtype).toBe('error');
    expect(result?.finalText).toBe('');
    expect(result?.error).toBe('Error: No query provided. Usage: cmd -p "your query"');
  });

  it('answers null for the empty stdout of a run that died before the print loop', () => {
    expect(extractCommandCodeResult(fixture('unknown-model.jsonl'))).toBeNull();
    expect(fixture('unknown-model.stderr.txt')).toContain('unknown model');
  });

  it('answers null rather than throwing on a stream with no result line', () => {
    expect(extractCommandCodeResult('')).toBeNull();
    expect(extractCommandCodeResult('{"type":"event","event":{"type":"run_start"}}')).toBeNull();
    expect(extractCommandCodeResult('not json at all\n{ broken')).toBeNull();
  });

  // A mod's stray console.log lands on the same stdout as the stream.
  it('skips unparseable lines around a real result line', () => {
    const stream = [
      'Debug: loading mods',
      '{ this is not json',
      '{"type":"result","subtype":"success","finalText":"kept"}',
      'trailing noise',
    ].join('\n');
    expect(extractCommandCodeResult(stream)).toEqual({ subtype: 'success', finalText: 'kept' });
  });

  it('takes the last result line when a stream somehow carries two', () => {
    const stream = [
      '{"type":"result","subtype":"error","finalText":"","error":"first"}',
      '{"type":"result","subtype":"success","finalText":"second"}',
    ].join('\n');
    expect(extractCommandCodeResult(stream)?.finalText).toBe('second');
  });

  it('ignores a result frame with no subtype', () => {
    expect(extractCommandCodeResult('{"type":"result","finalText":"x"}')).toBeNull();
  });
});

describe('describeCommandCodeFailure', () => {
  it('says nothing when the run succeeded', () => {
    expect(describeCommandCodeFailure(0, { subtype: 'success', finalText: 'OK' })).toBeNull();
    expect(describeCommandCodeFailure(0, null)).toBeNull();
  });

  // PRINT_EXIT_CODE in command-code@1.40.1/dist/cli.mjs. Issue #2253 names six
  // of these; the map carries all ten failure codes so none falls through to a
  // bare number in the execution log.
  it.each([
    [1, 'error'],
    [3, 'authentication failed'],
    [4, 'permission denied'],
    [5, 'rate limited'],
    [6, 'connection error'],
    [7, 'server error'],
    [8, 'max turns reached'],
    [9, 'no response'],
    [10, 'insufficient credits'],
    [130, 'interrupted'],
  ])('names exit %i as "%s"', (code, reason) => {
    expect(COMMAND_CODE_EXIT_REASONS[code]).toBe(reason);
    expect(describeCommandCodeFailure(code, null)).toBe(`Reason: command-code exit ${code} (${reason})`);
  });

  it('has no entry for a successful exit', () => {
    expect(COMMAND_CODE_EXIT_REASONS[0]).toBeUndefined();
  });

  it('still reports an exit code the map does not know', () => {
    expect(describeCommandCodeFailure(42, null)).toBe('Reason: command-code exit 42');
  });

  it('carries the subtype and the CLI message alongside the code', () => {
    expect(
      describeCommandCodeFailure(1, {
        subtype: 'error',
        finalText: '',
        error: 'Error: No query provided.',
      })
    ).toBe('Reason: command-code exit 1 (error) / subtype=error / Error: No query provided.');
  });

  /**
   * The pair matters in both directions.
   *
   * `classifyPrintOutcome` derives the exit code from the answer (blank answer
   * → NO_RESPONSE 9) while `buildPrintResultLine` derives the subtype from
   * `stopReason`, so the CLI can report `subtype: "success"` on a run that
   * exited 9. Keying on either half alone would call that run a success.
   */
  it('fails a non-zero exit even when the subtype says success', () => {
    expect(describeCommandCodeFailure(9, { subtype: 'success', finalText: '' })).toBe(
      'Reason: command-code exit 9 (no response) / subtype=success'
    );
  });

  it('fails a non-success subtype even when the process exited 0', () => {
    expect(describeCommandCodeFailure(0, { subtype: 'max_turns', finalText: '' })).toBe(
      'Reason: command-code subtype=max_turns'
    );
  });
});

// ---------------------------------------------------------------------------
// end to end through executeClaudeCommand
// ---------------------------------------------------------------------------

describe('executeClaudeCommand with command-code', () => {
  it('launches `commandcode` with the headless argv', async () => {
    await runWith(fixture('success.jsonl'), '', 0);
    const [command, args] = mockedExecFile.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe('commandcode');
    expect(args).toEqual(['-p', 'hi', '--output-format', 'json', '--yolo']);
  });

  it('stores the answer, not the event log', async () => {
    const result = await runWith(fixture('success.jsonl'), '', 0);
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('OK');
    expect(result.output).not.toContain('thinking_delta');
  });

  it('reports max_turns as a failure with the reason and the exit code', async () => {
    const result = await runWith(
      fixture('max-turns.jsonl'),
      'Warning: Reached maximum conversation turns (1).\n',
      8
    );
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(8);
    expect(result.output).toContain('Reason: command-code exit 8 (max turns reached)');
    expect(result.output).toContain('subtype=max_turns');
    // The event dump is what the reason replaces.
    expect(result.output).not.toContain('thinking_delta');
  });

  it('reports the CLI message on a classified error', async () => {
    const result = await runWith(
      fixture('no-query-error.jsonl'),
      'Error: No query provided. Usage: cmd -p "your query"\n',
      1
    );
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Reason: command-code exit 1 (error)');
    expect(result.output).toContain('No query provided');
  });

  it('falls back to stderr when the run died before writing a result line', async () => {
    const result = await runWith(
      fixture('unknown-model.jsonl'),
      fixture('unknown-model.stderr.txt'),
      1
    );
    expect(result.status).toBe('failed');
    expect(result.output).toContain('Reason: command-code exit 1 (error)');
    expect(result.output).toContain('unknown model');
    // No result line was written, so nothing may claim one was.
    expect(result.output).not.toContain('subtype=');
  });

  /**
   * Synthetic, and the only synthetic stream in this file: exit 0 paired with a
   * non-success subtype. The measured CLI cannot produce it — `classifyPrintOutcome`
   * routes max_turns to exit 8 — but the executor reads the subtype rather than
   * assuming it, so this pins that the reading is real.
   */
  it('fails an exit-0 run whose result line does not say success', async () => {
    const result = await runWith('{"type":"result","subtype":"max_turns","finalText":"half"}', '', 0);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('Reason: command-code subtype=max_turns');
    expect(result.output).toContain('half');
  });

  it('reports raw stdout when an exit-0 run carried no result line', async () => {
    const result = await runWith('plain text answer', '', 0);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('plain text answer');
  });
});
