/**
 * Tests for claude-executor.ts
 * Issue #294: Claude CLI executor for scheduled executions
 * Issue #719: Add execFile error handling tests (maxBuffer, ETIMEDOUT, signal, exit code)
 * Issue #2974: OpenCode V2 (`opencode2 run --standalone --format json`) against measured fixtures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Issue #2974: the executor resolves OpenCode V2's binary before running it.
const { mockResolveOpencodeV2 } = vi.hoisted(() => ({ mockResolveOpencodeV2: vi.fn() }));
vi.mock('@/lib/cli-tools/opencode-executable', () => ({
  OPENCODE_V2_BINARY_NAME: 'opencode2',
  resolveOpencodeV2Executable: mockResolveOpencodeV2,
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import {
  truncateOutput,
  buildCliArgs,
  executeClaudeCommand,
  MAX_OUTPUT_SIZE,
  MAX_STORED_OUTPUT_SIZE,
  EXECUTION_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH,
  ALLOWED_CLI_TOOLS,
  getActiveProcesses,
  getCommandForTool,
  findOpencodeTrailingError,
} from '../../../src/lib/session/claude-executor';
import { SENSITIVE_ENV_KEYS } from '../../../src/lib/security/env-sanitizer';

const mockedExecFile = vi.mocked(execFile);

/**
 * Create a minimal mock ChildProcess for execFile return value.
 */
function makeMockChild(): ChildProcess {
  return {
    stdin: { end: vi.fn() },
    on: vi.fn(),
    pid: undefined,
  } as unknown as ChildProcess;
}

/**
 * Configure mocked execFile to invoke its callback with the given (error, stdout, stderr).
 * Returns the mock child for further assertion if needed.
 */
function setupExecFileMock(
  error: (Error & { code?: string | number; signal?: string; killed?: boolean }) | null,
  stdout: string,
  stderr: string
): ChildProcess {
  const child = makeMockChild();
  mockedExecFile.mockImplementationOnce(((
    _cmd: string,
    _args: readonly string[],
    _options: unknown,
    cb: (
      err: (Error & { code?: string | number; signal?: string; killed?: boolean }) | null,
      out: string,
      err2: string
    ) => void
  ) => {
    // Invoke callback asynchronously to match real Node behavior
    queueMicrotask(() => cb(error, stdout, stderr));
    return child;
  }) as unknown as typeof execFile);
  return child;
}

describe('claude-executor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedExecFile.mockReset();
    // Clear active processes
    globalThis.__scheduleActiveProcesses = undefined;
  });

  afterEach(() => {
    globalThis.__scheduleActiveProcesses = undefined;
  });

  describe('constants', () => {
    it('should have MAX_OUTPUT_SIZE = 10MB (Issue #719: bumped from 1MB)', () => {
      expect(MAX_OUTPUT_SIZE).toBe(10 * 1024 * 1024);
    });

    it('should have MAX_STORED_OUTPUT_SIZE = 100KB', () => {
      expect(MAX_STORED_OUTPUT_SIZE).toBe(100 * 1024);
    });

    it('should have EXECUTION_TIMEOUT_MS = 15 minutes', () => {
      expect(EXECUTION_TIMEOUT_MS).toBe(15 * 60 * 1000);
    });

    it('should have MAX_MESSAGE_LENGTH = 10000', () => {
      expect(MAX_MESSAGE_LENGTH).toBe(10000);
    });
  });

  describe('truncateOutput', () => {
    it('should not truncate output within limits', () => {
      const output = 'Hello, world!';
      expect(truncateOutput(output)).toBe(output);
    });

    it('should truncate output exceeding MAX_STORED_OUTPUT_SIZE', () => {
      const largeOutput = 'x'.repeat(MAX_STORED_OUTPUT_SIZE + 1000);
      const result = truncateOutput(largeOutput);
      expect(result).toContain('--- Output truncated');
      expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(
        MAX_STORED_OUTPUT_SIZE + 100 // truncation notice overhead
      );
    });

    it('should handle empty string', () => {
      expect(truncateOutput('')).toBe('');
    });

    it('should preserve output at exactly MAX_STORED_OUTPUT_SIZE', () => {
      // Use ASCII to ensure 1 byte per char
      const exactOutput = 'a'.repeat(MAX_STORED_OUTPUT_SIZE);
      expect(truncateOutput(exactOutput)).toBe(exactOutput);
    });

    it('should handle multi-byte characters correctly', () => {
      // Japanese characters are 3 bytes each in UTF-8
      // Create a string that exceeds MAX_STORED_OUTPUT_SIZE in bytes
      const japaneseChar = '\u3042'; // hiragana 'a' = 3 bytes
      const charCount = Math.ceil(MAX_STORED_OUTPUT_SIZE / 3) + 100;
      const multiByteOutput = japaneseChar.repeat(charCount);
      const result = truncateOutput(multiByteOutput);
      expect(result).toContain('--- Output truncated');
    });

    it('should include truncation notice with size limit info', () => {
      const largeOutput = 'x'.repeat(MAX_STORED_OUTPUT_SIZE + 500);
      const result = truncateOutput(largeOutput);
      expect(result).toContain('100KB');
    });
  });

  describe('getActiveProcesses', () => {
    it('should return a Map', () => {
      const processes = getActiveProcesses();
      expect(processes).toBeInstanceOf(Map);
    });

    it('should return the same instance on subsequent calls', () => {
      const first = getActiveProcesses();
      const second = getActiveProcesses();
      expect(first).toBe(second);
    });

    it('should persist across calls (globalThis)', () => {
      const processes = getActiveProcesses();
      processes.set(12345, {} as import('child_process').ChildProcess);

      const processes2 = getActiveProcesses();
      expect(processes2.has(12345)).toBe(true);
    });
  });

  describe('buildCliArgs', () => {
    it('should build claude args with -p, --output-format, --permission-mode', () => {
      const args = buildCliArgs('hello', 'claude');
      expect(args).toEqual(['-p', 'hello', '--output-format', 'text', '--permission-mode', 'acceptEdits']);
    });

    it('should build codex args with exec and --sandbox', () => {
      const args = buildCliArgs('hello', 'codex');
      expect(args).toEqual(['exec', 'hello', '--sandbox', 'workspace-write']);
    });

    it('should build gemini args with -p only', () => {
      const args = buildCliArgs('hello', 'gemini');
      expect(args).toEqual(['-p', 'hello']);
    });

    it('should build vibe-local args with -p and -y', () => {
      const args = buildCliArgs('hello', 'vibe-local');
      expect(args).toEqual(['-p', 'hello', '-y']);
    });

    it('should build vibe-local args with --model when model is specified', () => {
      const args = buildCliArgs('hello', 'vibe-local', undefined, { model: 'llama3' });
      expect(args).toEqual(['--model', 'llama3', '-p', 'hello', '-y']);
    });

    it('should build vibe-local args without --model when model is not specified', () => {
      const args = buildCliArgs('hello', 'vibe-local', undefined, {});
      expect(args).toEqual(['-p', 'hello', '-y']);
    });

    // Issue #2044: `--format json` is unconditional. `--format default` writes a
    // decorated transcript whose layout is not a contract, so the executor asks
    // for the machine format and extracts the answer from it.
    it('should build opencode args with run command', () => {
      const args = buildCliArgs('hello', 'opencode');
      expect(args).toEqual(['run', '--format', 'json', 'hello']);
    });

    // Issue #1914: the value reaches `-m` verbatim. `opencode run --help`
    // documents `-m, --model` as taking "provider/model" (measured on 1.18.21),
    // so the `ollama/` prefix this branch used to add made every other provider
    // unreachable and doubled up on any value that already named one.
    it.each([
      'ollama/qwen3:8b',
      'anthropic/claude-sonnet-4-5',
      'github-copilot/gpt-5',
    ])('should build opencode args with -m %s verbatim', (model) => {
      const args = buildCliArgs('hello', 'opencode', undefined, { model });
      expect(args).toEqual(['run', '--format', 'json', '-m', model, 'hello']);
    });

    it('should not prefix an opencode model with ollama/', () => {
      const args = buildCliArgs('hello', 'opencode', undefined, { model: 'anthropic/claude-sonnet-4-5' });
      expect(args.join(' ')).not.toContain('ollama/');
    });

    it('should build opencode args without -m when model is not specified', () => {
      const args = buildCliArgs('hello', 'opencode', undefined, {});
      expect(args).toEqual(['run', '--format', 'json', 'hello']);
    });

    it('should default to claude args for unknown tools', () => {
      const args = buildCliArgs('hello', 'unknown');
      expect(args).toEqual(['-p', 'hello', '--output-format', 'text', '--permission-mode', 'acceptEdits']);
    });
  });

  describe('ALLOWED_CLI_TOOLS', () => {
    it('should contain claude and codex', () => {
      expect(ALLOWED_CLI_TOOLS.has('claude')).toBe(true);
      expect(ALLOWED_CLI_TOOLS.has('codex')).toBe(true);
    });

    it('should contain gemini and vibe-local', () => {
      expect(ALLOWED_CLI_TOOLS.has('gemini')).toBe(true);
      expect(ALLOWED_CLI_TOOLS.has('vibe-local')).toBe(true);
    });

    it('should contain opencode', () => {
      expect(ALLOWED_CLI_TOOLS.has('opencode')).toBe(true);
    });

    it('should not contain arbitrary tools', () => {
      expect(ALLOWED_CLI_TOOLS.has('bash')).toBe(false);
      expect(ALLOWED_CLI_TOOLS.has('sh')).toBe(false);
    });
  });

  describe('executeClaudeCommand - cliToolId validation', () => {
    it('should reject invalid cliToolId without executing', async () => {
      const result = await executeClaudeCommand('hello', '/tmp', 'bash');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid CLI tool');
    });
  });

  describe('SENSITIVE_ENV_KEYS exclusion', () => {
    it('should use env-sanitizer to exclude sensitive keys', () => {
      // This test verifies the SENSITIVE_ENV_KEYS constant is properly defined
      // The actual env sanitization is tested in env-sanitizer.test.ts
      expect(SENSITIVE_ENV_KEYS).toContain('CLAUDECODE');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_AUTH_TOKEN_HASH');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_DB_PATH');
    });
  });

  // ===========================================================================
  // Issue #719: execFile error handling
  // ===========================================================================
  describe('executeClaudeCommand - execFile error handling (Issue #719)', () => {
    it('should handle ERR_CHILD_PROCESS_STDIO_MAXBUFFER as failed with diagnostic output', async () => {
      const hugeStdout = 'x'.repeat(2 * 1024 * 1024); // 2MB to simulate overflow
      const err = Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      setupExecFileMock(err, hugeStdout, '');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
      expect(result.output).toContain('Code: ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect(result.output).toContain('Reason: stdout exceeded execFile maxBuffer (output_limit)');
      expect(result.output).toContain('Error: stdout maxBuffer length exceeded');
      expect(result.error).toBe('stdout maxBuffer length exceeded');
    });

    it('should handle ETIMEDOUT as timeout status', async () => {
      const err = Object.assign(new Error('command timed out'), {
        code: 'ETIMEDOUT',
      });
      setupExecFileMock(err, '', '');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('timeout');
      expect(result.exitCode).toBeNull();
      expect(result.output).toContain('Code: ETIMEDOUT');
    });

    it('should handle killed=true as timeout status', async () => {
      const err = Object.assign(new Error('killed'), {
        killed: true,
      });
      setupExecFileMock(err, '', '');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('timeout');
    });

    it('should handle numeric exit code 1 as failed with exitCode=1', async () => {
      const err = Object.assign(new Error('command failed'), {
        code: 1,
      });
      setupExecFileMock(err, '', 'something went wrong');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Error: command failed');
      expect(result.output).toContain('Code: 1');
      expect(result.output).toContain('--- stderr ---');
      expect(result.output).toContain('something went wrong');
    });

    it('should handle SIGTERM signal as failed with exitCode=null', async () => {
      const err = Object.assign(new Error('killed by signal'), {
        signal: 'SIGTERM',
      });
      setupExecFileMock(err, '', '');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
      expect(result.output).toContain('Signal: SIGTERM');
    });

    it('should not include errorSummary in output on success path', async () => {
      setupExecFileMock(null, 'hello', '');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('hello');
      expect(result.output).not.toContain('Error:');
      expect(result.output).not.toContain('Code:');
      expect(result.output).not.toContain('Signal:');
    });

    it('should include both stdout and stderr sections when both present on error', async () => {
      const err = Object.assign(new Error('exit 2'), {
        code: 2,
      });
      setupExecFileMock(err, 'partial output', 'error detail');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('--- stdout ---');
      expect(result.output).toContain('partial output');
      expect(result.output).toContain('--- stderr ---');
      expect(result.output).toContain('error detail');
    });

    it('should report Signal: none and Code: unknown when neither is set on a generic error', async () => {
      const err = new Error('mystery failure');
      setupExecFileMock(err, '', '');

      const result = await executeClaudeCommand('hello', '/tmp', 'claude');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
      expect(result.output).toContain('Code: unknown');
      expect(result.output).toContain('Signal: none');
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #2974: OpenCode V2 schedules, against stdout measured on 2.0.18
  // (tests/fixtures/opencode-v2-schedule-2974/README.md)
  // ---------------------------------------------------------------------------
  describe('opencode-v2 (Issue #2974)', () => {
    const FIXTURES = join(__dirname, '../../fixtures/opencode-v2-schedule-2974');
    const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf-8');
    const V2_PATH = '/opt/homebrew/bin/opencode2';

    beforeEach(() => {
      mockResolveOpencodeV2.mockReset();
      mockResolveOpencodeV2.mockResolvedValue({
        executable: { path: V2_PATH, version: '2.0.18', generation: 'v2' },
        probed: [],
      });
    });

    function exitError(code: number): Error & { code: number } {
      return Object.assign(new Error(`Command failed: ${V2_PATH} run`), { code });
    }

    describe('buildCliArgs', () => {
      it('builds the measured line: --standalone, --format json, message after --', () => {
        expect(buildCliArgs('hello', 'opencode-v2', 'default')).toEqual([
          'run', '--standalone', '--format', 'json', '--', 'hello',
        ]);
      });

      it('passes --auto only for the `auto` Permission', () => {
        expect(buildCliArgs('hello', 'opencode-v2', 'auto')).toEqual([
          'run', '--standalone', '--format', 'json', '--auto', '--', 'hello',
        ]);
        for (const permission of [undefined, '', 'default', 'acceptEdits', 'yolo']) {
          expect(buildCliArgs('hello', 'opencode-v2', permission), String(permission)).not.toContain('--auto');
        }
      });

      it('keeps a message that starts with "-" behind --', () => {
        const args = buildCliArgs('--- list', 'opencode-v2', 'default');
        expect(args.slice(-2)).toEqual(['--', '--- list']);
      });

      it('rides the variant on -m (there is no --variant) and keeps -c / --agent / --title', () => {
        const args = buildCliArgs('hello', 'opencode-v2', 'default', {
          model: 'ollama/qwen3:8b',
          variant: 'high',
          agent: 'plan',
          continueSession: true,
          title: 'nightly',
        });
        expect(args).toEqual([
          'run', '--standalone', '--format', 'json',
          '-m', 'ollama/qwen3:8b#high', '--agent', 'plan', '-c', '--title', 'nightly',
          '--', 'hello',
        ]);
        expect(args).not.toContain('--variant');
        expect(buildCliArgs('hello', 'opencode-v2', 'default', { variant: 'high' })).not.toContain('high');
      });

      it('leaves v1 opencode unchanged (no --standalone, no --)', () => {
        expect(buildCliArgs('hello', 'opencode')).toEqual(['run', '--format', 'json', 'hello']);
      });
    });

    it('names opencode2 as the command', () => {
      expect(getCommandForTool('opencode-v2')).toBe('opencode2');
    });

    it('runs the resolved binary and records the answer of a measured run', async () => {
      setupExecFileMock(null, fixture('run-text.ndjson'), '');

      const result = await executeClaudeCommand('Reply with exactly the word PONG.', '/tmp', 'opencode-v2', 'default');

      expect(mockedExecFile).toHaveBeenCalledWith(
        V2_PATH,
        ['run', '--standalone', '--format', 'json', '--', 'Reply with exactly the word PONG.'],
        expect.objectContaining({ cwd: '/tmp' }),
        expect.any(Function)
      );
      expect(result).toMatchObject({ status: 'completed', exitCode: 0, output: 'PONG' });
    });

    it('records the final message of a measured run that called tools', async () => {
      setupExecFileMock(null, fixture('run-tool-use.ndjson'), '');

      const result = await executeClaudeCommand('Reply with exactly PONG2', '/tmp', 'opencode-v2', 'default');

      expect(result).toMatchObject({ status: 'completed', output: 'PONG2' });
    });

    it('records an auto-rejected `ask` as failed, naming the fix', async () => {
      setupExecFileMock(exitError(1), fixture('run-ask-rejected.ndjson'), fixture('run-ask-rejected.stderr.txt'));

      const result = await executeClaudeCommand('Create a file', '/tmp', 'opencode-v2', 'default');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Reason: opencode-v2 auto-rejected a permission request');
      expect(result.output).toContain('`auto`');
      // The decoded error frame, not the event dump.
      expect(result.output).toContain('opencode error: aborted: Step interrupted');
      expect(result.output).not.toContain('"type":"step_start"');
      expect(result.output).toContain('permission requested: edit (created.txt); auto-rejecting');
    });

    it('renders v2\'s error frame shape for other measured failures', async () => {
      setupExecFileMock(exitError(1), fixture('run-agent-not-found.ndjson'), '');

      const result = await executeClaudeCommand('Reply PONG', '/tmp', 'opencode-v2', 'default');

      expect(result.status).toBe('failed');
      expect(result.output).toContain('Reason: opencode error: unknown: Agent not found: "nosuchagent"');
      expect(findOpencodeTrailingError(fixture('run-model-unavailable.ndjson'))).toBe(
        'opencode error: provider.no-route: Model unavailable: ollama/nonexistent-model'
      );
    });

    it('does not record exit 0 as completed when the stream ends in an error frame', async () => {
      setupExecFileMock(null, fixture('run-ask-rejected.ndjson'), '');

      const result = await executeClaudeCommand('Create a file', '/tmp', 'opencode-v2', 'default');

      expect(result.status).toBe('failed');
      expect(result.error).toBe('opencode error: aborted: Step interrupted');
    });

    it('only a trailing error frame counts: an answered stream is not an error', () => {
      expect(findOpencodeTrailingError(fixture('run-text.ndjson'))).toBeNull();
      expect(findOpencodeTrailingError(fixture('run-tool-use.ndjson'))).toBeNull();
    });

    it('fails without running anything when no OpenCode V2 binary is found', async () => {
      mockResolveOpencodeV2.mockResolvedValue({ executable: null, probed: [] });

      const result = await executeClaudeCommand('hello', '/tmp', 'opencode-v2', 'default');

      expect(result.status).toBe('failed');
      expect(result.error).toContain('OpenCode V2 not found');
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it('does not resolve a binary for other tools', async () => {
      setupExecFileMock(null, fixture('run-text.ndjson'), '');

      await executeClaudeCommand('hello', '/tmp', 'opencode');

      expect(mockResolveOpencodeV2).not.toHaveBeenCalled();
      expect(mockedExecFile.mock.calls[0][0]).toBe('opencode');
    });
  });
});
