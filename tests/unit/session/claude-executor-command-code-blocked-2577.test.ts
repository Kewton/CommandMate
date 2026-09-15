/**
 * command-code runs whose tool calls were blocked (Issue #2577).
 *
 * `commandcode -p` without `--yolo` gets the `print-permission-gate` mod, and a
 * call that mod blocks does not fail the run: it ends exit 0 with
 * `subtype: "success"`. The executor used to keep only the result line, so a
 * schedule whose every write was refused was recorded as a plain `completed`.
 *
 * The behaviours pinned:
 *
 *  - **The block is read off the `tool_hook_blocked` event**, with its
 *    `toolName` and `hookOutput` — not off `finalText`, which in the all-blocked
 *    fixture is just `DONE`.
 *  - **A fully blocked run is never a warning-less `completed`.**
 *  - **A blocked run that still got work done is not `failed`**, and its
 *    warning is kept.
 *  - **Failed and timed-out runs stay failed and timed out.**
 *  - **The warning is the first line of the output**, in a shape the list API
 *    can read back from the head of the stored result.
 *
 * Every stream here except the ones labelled synthetic is read off
 * `fixtures/command-code-tool-hook-blocked-2577/`, the verbatim stdout of real
 * 1.53.1 runs (see the README there).
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import {
  COMMAND_CODE_BLOCKED_WARNING_PREFIX,
  EXECUTION_LOG_WARNING_HEAD_LENGTH,
  describeCommandCodeBlockedToolCalls,
  executeClaudeCommand,
  extractCommandCodeResult,
  readCommandCodeStream,
  readExecutionLogWarning,
  type CommandCodeStream,
} from '@/lib/session/claude-executor';

const mockedExecFile = vi.mocked(execFile);

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/command-code-tool-hook-blocked-2577');

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

const GATE_MESSAGE =
  'Error: Tool "write_file" requires permissions. Use --yolo (or --dangerously-skip-permissions) to enable file writes and shell commands in print mode.';

function makeMockChild(): ChildProcess {
  return {
    stdin: { end: vi.fn() },
    on: vi.fn(),
    pid: undefined,
  } as unknown as ChildProcess;
}

type Outcome =
  | { kind: 'exit'; code: number }
  | { kind: 'timeout' };

/** Run `executeClaudeCommand` against one canned `execFile` outcome. */
async function runWith(
  stdout: string,
  stderr: string,
  outcome: Outcome,
  cliToolId = 'command-code'
): Promise<Awaited<ReturnType<typeof executeClaudeCommand>>> {
  mockedExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    if (outcome.kind === 'exit' && outcome.code === 0) {
      callback(null, stdout, stderr);
    } else if (outcome.kind === 'exit') {
      const error = new Error(`Command failed with exit code ${outcome.code}`) as NodeJS.ErrnoException;
      error.code = outcome.code as unknown as string;
      callback(error, stdout, stderr);
    } else {
      // What execFile hands the callback when its `timeout` kills the child.
      const error = Object.assign(new Error('Command failed: commandcode -p …'), {
        killed: true,
        signal: 'SIGTERM',
      });
      callback(error, stdout, stderr);
    }
    return makeMockChild();
  }) as unknown as typeof execFile);

  return executeClaudeCommand('hi', '/tmp/wt', cliToolId);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// reading the stream
// ---------------------------------------------------------------------------

describe('readCommandCodeStream', () => {
  it('reads the tool_hook_blocked event with its toolName and hookOutput', () => {
    const stream = readCommandCodeStream(fixture('all-blocked.jsonl'));
    expect(stream.blockedToolCalls).toEqual([
      {
        toolCallId: 'call_00_GeFwzbbXD8VJiZvEHNLB4846',
        toolName: 'write_file',
        hookOutput: GATE_MESSAGE,
      },
    ]);
    // The blocked call never started, and nothing else was called.
    expect(stream.startedToolCalls).toBe(0);
  });

  it('keeps the result line the fixture closes with', () => {
    const stdout = fixture('all-blocked.jsonl');
    expect(readCommandCodeStream(stdout).result).toEqual({ subtype: 'success', finalText: 'DONE' });
    expect(extractCommandCodeResult(stdout)).toEqual({ subtype: 'success', finalText: 'DONE' });
  });

  it('counts the tool that did run separately from the one that was blocked', () => {
    const stream = readCommandCodeStream(fixture('blocked-then-read.jsonl'));
    expect(stream.blockedToolCalls.map((call) => call.toolName)).toEqual(['write_file']);
    expect(stream.startedToolCalls).toBe(1);
    expect(stream.result).toEqual({ subtype: 'success', finalText: 'report-208-lines' });
  });

  it('finds nothing blocked in a stream that only carries ordinary tool events', () => {
    // Synthetic: the event shapes of a tool call that ran and one that errored.
    const stdout = [
      '{"type":"event","event":{"type":"tool_queued","toolCallId":"c1","toolName":"write_file","input":{}}}',
      '{"type":"event","event":{"type":"tool_running","toolCallId":"c1","toolName":"write_file","description":null}}',
      `{"type":"event","event":{"type":"tool_errored","toolCallId":"c1","toolName":"write_file","error":${JSON.stringify(GATE_MESSAGE)}}}`,
      '{"type":"result","subtype":"success","finalText":"ok"}',
    ].join('\n');
    const stream = readCommandCodeStream(stdout);
    expect(stream.blockedToolCalls).toEqual([]);
    expect(stream.startedToolCalls).toBe(1);
  });

  it('only reads the event inside its {"type":"event"} frame', () => {
    // Synthetic: the stream never writes an agent event unwrapped
    // (`serializeAgentEventLine`), so a bare one is not a block.
    const stdout = `{"type":"tool_hook_blocked","toolName":"write_file","hookOutput":${JSON.stringify(GATE_MESSAGE)}}`;
    expect(readCommandCodeStream(stdout).blockedToolCalls).toEqual([]);
  });

  it('skips unparseable lines and still counts a block with no name', () => {
    // Synthetic.
    const stdout = [
      'not json',
      '{"type":"event","event":{"type":"tool_hook_blocked"}}',
      '{"type":"event"',
    ].join('\n');
    expect(readCommandCodeStream(stdout).blockedToolCalls).toEqual([
      { toolCallId: null, toolName: '(unnamed tool)', hookOutput: '' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// the warning block
// ---------------------------------------------------------------------------

describe('describeCommandCodeBlockedToolCalls', () => {
  it('says nothing when no call was blocked', () => {
    expect(
      describeCommandCodeBlockedToolCalls({ result: null, blockedToolCalls: [], startedToolCalls: 3 })
    ).toBeNull();
  });

  it('summarises the blocks on the first line and gives each reason once after it', () => {
    const lines = describeCommandCodeBlockedToolCalls(readCommandCodeStream(fixture('all-blocked.jsonl')));
    expect(lines).toEqual([
      'Warning: command-code blocked 1 tool call(s) (tool_hook_blocked): write_file (1); 0 tool call(s) ran',
      `Blocked write_file: ${GATE_MESSAGE}`,
    ]);
  });

  it('counts per tool and does not repeat an identical reason', () => {
    // Synthetic: three blocks of two tools, as a longer all-blocked run would emit.
    const block = (id: string, toolName: string) => ({
      toolCallId: id,
      toolName,
      hookOutput: `Error: Tool "${toolName}" requires permissions.`,
    });
    const stream: CommandCodeStream = {
      result: null,
      blockedToolCalls: [block('a', 'write_file'), block('b', 'shell_command'), block('c', 'write_file')],
      startedToolCalls: 2,
    };
    expect(describeCommandCodeBlockedToolCalls(stream)).toEqual([
      'Warning: command-code blocked 3 tool call(s) (tool_hook_blocked): write_file (2), shell_command (1); 2 tool call(s) ran',
      'Blocked write_file: Error: Tool "write_file" requires permissions.',
      'Blocked shell_command: Error: Tool "shell_command" requires permissions.',
    ]);
  });

  it('keeps the summary on one line and inside the head the list API reads', () => {
    // Synthetic: many long, hostile tool names and multi-line hook output.
    const blockedToolCalls = Array.from({ length: 40 }, (_, index) => ({
      toolCallId: `c${index}`,
      toolName: `${index}_mcp__server__${'x'.repeat(200)}\nsecond line`,
      hookOutput: `line one\n[31mline two[0m ${'y'.repeat(1000)}`,
    }));
    const lines = describeCommandCodeBlockedToolCalls({ result: null, blockedToolCalls, startedToolCalls: 0 });
    expect(lines).not.toBeNull();
    const [summary, ...details] = lines as string[];

    expect(summary.length).toBeLessThan(EXECUTION_LOG_WARNING_HEAD_LENGTH);
    expect(summary).toContain('+35 more');
    for (const line of lines as string[]) {
      expect(line).not.toMatch(/[\n\r]/);
    }
    // Five distinct reasons, then a count of the rest.
    expect(details).toHaveLength(6);
    expect(details[5]).toBe('Blocked: +35 more distinct reason(s)');
    expect(readExecutionLogWarning(`${(lines as string[]).join('\n')}\nbody`)).toBe(summary);
  });
});

// ---------------------------------------------------------------------------
// end to end through executeClaudeCommand
// ---------------------------------------------------------------------------

describe('executeClaudeCommand with blocked command-code tool calls', () => {
  it('does not record a fully blocked run as a warning-less completed', async () => {
    const result = await runWith(fixture('all-blocked.jsonl'), '', { kind: 'exit', code: 0 });

    // The CLI's verdict is kept as the CLI's verdict …
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('completed');
    // … and the blocks are recorded beside it, where job-executor persists them.
    expect(result.warning).toBe(
      'Warning: command-code blocked 1 tool call(s) (tool_hook_blocked): write_file (1); 0 tool call(s) ran'
    );
    expect(result.output).toBe(
      [result.warning, `Blocked write_file: ${GATE_MESSAGE}`, 'DONE'].join('\n')
    );
    expect(readExecutionLogWarning(result.output)).toBe(result.warning);
  });

  it('does not depend on the final answer mentioning the block', async () => {
    const stdout = fixture('all-blocked.jsonl');
    const finalText = extractCommandCodeResult(stdout)?.finalText ?? '';
    // The fixture's answer says nothing about permissions, tools or blocks.
    expect(finalText).toBe('DONE');
    expect(finalText).not.toMatch(/block|permission|write_file|yolo/i);

    const result = await runWith(stdout, '', { kind: 'exit', code: 0 });
    expect(readExecutionLogWarning(result.output)).not.toBeNull();
  });

  it('does not read a warning out of an answer that only talks about a refusal', async () => {
    // Synthetic: no tool_hook_blocked event, an answer quoting the gate and even
    // the warning prefix. The event is the evidence, not the words.
    const finalText = `${COMMAND_CODE_BLOCKED_WARNING_PREFIX}1 tool call(s)\n${GATE_MESSAGE}`;
    const result = await runWith(
      JSON.stringify({ type: 'result', subtype: 'success', finalText }),
      '',
      { kind: 'exit', code: 0 }
    );
    expect(result.status).toBe('completed');
    expect(result.warning).toBeUndefined();
    expect(result.output).toBe(finalText);
    expect(readExecutionLogWarning(result.output)).toBeNull();
  });

  it('keeps a blocked run that still got work done out of failed, with its warning', async () => {
    const result = await runWith(fixture('blocked-then-read.jsonl'), '', { kind: 'exit', code: 0 });

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.warning).toBe(
      'Warning: command-code blocked 1 tool call(s) (tool_hook_blocked): write_file (1); 1 tool call(s) ran'
    );
    expect(result.output.split('\n')[0]).toBe(result.warning);
    expect(result.output.endsWith('\nreport-208-lines')).toBe(true);
  });

  it('keeps a non-zero exit failed, and still records the block first', async () => {
    const result = await runWith(
      fixture('blocked-max-turns.jsonl'),
      fixture('blocked-max-turns.stderr.txt'),
      { kind: 'exit', code: 8 }
    );

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(8);
    expect(result.output).toContain('Reason: command-code exit 8 (max turns reached) / subtype=max_turns');
    expect(result.output).toContain('Error: Command failed with exit code 8');
    expect(result.warning).toMatch(/^Warning: command-code blocked 1 tool call\(s\)/);
    expect(readExecutionLogWarning(result.output)).toBe(result.warning);
  });

  it('keeps an exit-0 error subtype failed when calls were also blocked', async () => {
    // Synthetic: the fixture's block, closed by a non-success result line.
    const events = fixture('all-blocked.jsonl')
      .split('\n')
      .filter((line) => line.includes('"tool_hook_blocked"'));
    const stdout = [...events, '{"type":"result","subtype":"error","finalText":"","error":"Error: boom"}'].join('\n');

    const result = await runWith(stdout, '', { kind: 'exit', code: 0 });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Reason: command-code subtype=error / Error: boom');
    expect(result.warning).toMatch(/^Warning: command-code blocked 1 tool call\(s\)/);
    expect(result.output.split('\n')).toEqual([
      result.warning,
      `Blocked write_file: ${GATE_MESSAGE}`,
      'Reason: command-code subtype=error / Error: boom',
      '',
    ]);
  });

  it('keeps a timed-out run a timeout when its partial stream carried a block', async () => {
    // A run killed by the executor's timeout hands back whatever it had written:
    // here, the fixture up to and including the block.
    const lines = fixture('all-blocked.jsonl').split('\n');
    const upToBlock = lines.slice(0, lines.findIndex((line) => line.includes('"tool_hook_blocked"')) + 1);

    const result = await runWith(upToBlock.join('\n'), '', { kind: 'timeout' });
    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(result.warning).toMatch(/^Warning: command-code blocked 1 tool call\(s\)/);
  });

  it('leaves a run with no blocks exactly as before', async () => {
    const result = await runWith('{"type":"result","subtype":"success","finalText":"OK"}', '', {
      kind: 'exit',
      code: 0,
    });
    expect(result).toEqual({ output: 'OK', exitCode: 0, status: 'completed' });
  });

  it('does not decode other tools’ output as a command-code stream', async () => {
    const stdout = fixture('all-blocked.jsonl');
    const result = await runWith(stdout, '', { kind: 'exit', code: 0 }, 'claude');
    expect(result.warning).toBeUndefined();
    expect(readExecutionLogWarning(result.output)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reading the warning back from a stored result
// ---------------------------------------------------------------------------

describe('readExecutionLogWarning', () => {
  const summary =
    'Warning: command-code blocked 2 tool call(s) (tool_hook_blocked): write_file (2); 0 tool call(s) ran';

  it('returns the first line when it is the summary', () => {
    expect(readExecutionLogWarning(`${summary}\nBlocked write_file: …\nDONE`)).toBe(summary);
    expect(readExecutionLogWarning(summary)).toBe(summary);
  });

  it('ignores null, rows written before the warning existed, and the summary further down', () => {
    expect(readExecutionLogWarning(null)).toBeNull();
    expect(readExecutionLogWarning(undefined)).toBeNull();
    expect(readExecutionLogWarning('DONE')).toBeNull();
    expect(readExecutionLogWarning(`Reason: command-code subtype=error\n${summary}`)).toBeNull();
    expect(readExecutionLogWarning(`${COMMAND_CODE_BLOCKED_WARNING_PREFIX}everything, apparently`)).toBeNull();
  });
});
