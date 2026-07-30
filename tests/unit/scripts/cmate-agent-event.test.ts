/**
 * scripts/hooks/cmate-agent-event.sh (Issue #1549).
 *
 * The script runs inside other people's agent CLIs, on whatever bash they have —
 * macOS still ships 3.2 — so the constructs that only exist in bash 4 are
 * checked for by name rather than trusted to show up in a failure.
 *
 * Behaviour is exercised by putting a fake `curl` first on PATH and reading back
 * exactly what the script would have sent. That is the whole contract of a thin
 * POST wrapper, and it needs no server.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(process.cwd(), 'scripts/hooks/cmate-agent-event.sh');

let fakeBin: string;
let argsFile: string;

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'cmate-hook-bin-'));
  argsFile = join(fakeBin, 'curl-args.txt');
  const fakeCurl = join(fakeBin, 'curl');
  writeFileSync(
    fakeCurl,
    ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > "$CURL_ARGS_FILE"', 'exit "${FAKE_CURL_EXIT:-0}"', ''].join('\n')
  );
  chmodSync(fakeCurl, 0o755);
});

afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));

beforeEach(() => rmSync(argsFile, { force: true }));

interface RunResult {
  status: number | null;
  stderr: string;
  /** curl argv, or null when the script never invoked curl. */
  curlArgs: string[] | null;
}

function run(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {}
): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    input: options.stdin ?? '',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CURL_ARGS_FILE: argsFile,
      // Cleared so a developer's own shell exports cannot change the defaults
      // this suite is asserting.
      CM_HOOK_URL: '',
      CM_AUTH_TOKEN: '',
      CM_AGENT_TOOL: '',
      CM_AGENT_CWD: '',
      CLAUDE_PROJECT_DIR: '',
      CM_HOST: '',
      CM_PORT: '',
      ...options.env,
    },
  });

  return {
    status: result.status,
    stderr: result.stderr ?? '',
    curlArgs: existsSync(argsFile)
      ? readFileSync(argsFile, 'utf8').split('\n').slice(0, -1)
      : null,
  };
}

/** The JSON body the script handed to curl. */
function body(result: RunResult): Record<string, unknown> {
  expect(result.curlArgs, 'curl was never invoked').not.toBeNull();
  const index = result.curlArgs!.indexOf('--data-binary');
  expect(index, `no --data-binary in ${JSON.stringify(result.curlArgs)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.curlArgs![index + 1]);
}

function url(result: RunResult): string {
  return result.curlArgs![result.curlArgs!.length - 1];
}

describe('portability', () => {
  it('parses under bash 3.2 syntax rules', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('uses no bash 4+ constructs', () => {
    // Comment lines are stripped: the prose explaining which constructs are
    // banned necessarily names them.
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    for (const construct of ['declare -A', 'typeset -A', 'mapfile', 'readarray', '${!', ',,}', '^^}']) {
      expect(code, `bash 4+ construct present: ${construct}`).not.toContain(construct);
    }
  });
});

describe('request construction', () => {
  it('defaults to a stop event for claude against the local server', () => {
    const result = run(['--cwd', '/repos/wt-a']);

    expect(result.status).toBe(0);
    expect(body(result)).toEqual({ tool: 'claude', event: 'stop', cwd: '/repos/wt-a' });
    expect(url(result)).toBe('http://127.0.0.1:3000/api/hooks/agent-event');
    expect(result.curlArgs).toContain('POST');
  });

  it('honours CM_HOST and CM_PORT, and CM_HOOK_URL over both', () => {
    expect(url(run(['--cwd', '/r'], { env: { CM_HOST: 'example.test', CM_PORT: '3135' } }))).toBe(
      'http://example.test:3135/api/hooks/agent-event'
    );
    expect(
      url(
        run(['--cwd', '/r'], {
          env: { CM_HOST: 'ignored', CM_PORT: '1', CM_HOOK_URL: 'http://elsewhere/hook' },
        })
      )
    ).toBe('http://elsewhere/hook');
  });

  it('sends CM_AUTH_TOKEN as a bearer header and omits it when unset', () => {
    expect(run(['--cwd', '/r'], { env: { CM_AUTH_TOKEN: 's3cret' } }).curlArgs).toContain(
      'Authorization: Bearer s3cret'
    );
    expect(
      run(['--cwd', '/r']).curlArgs!.some((arg) => arg.startsWith('Authorization:'))
    ).toBe(false);
  });

  it('escapes quotes and backslashes so the body stays valid JSON', () => {
    const result = run(['--cwd', '/repos/we"ird\\path', '--session-id', 'a"b']);

    expect(body(result)).toEqual({
      tool: 'claude',
      event: 'stop',
      cwd: '/repos/we"ird\\path',
      sessionId: 'a"b',
    });
  });
});

describe('Claude Code Stop hook payload', () => {
  const payload = JSON.stringify({
    session_id: 'sess-42',
    transcript_path: '/tmp/t.jsonl',
    hook_event_name: 'Stop',
    cwd: '/repos/wt-claude',
  });

  it('reads cwd, session id and event name from stdin', () => {
    const result = run(['--stdin-json'], { stdin: payload });

    expect(body(result)).toEqual({
      tool: 'claude',
      event: 'stop',
      cwd: '/repos/wt-claude',
      sessionId: 'sess-42',
    });
  });

  it('maps the other hook event names', () => {
    const withEvent = (name: string) =>
      body(run(['--stdin-json'], { stdin: JSON.stringify({ hook_event_name: name, cwd: '/r' }) }))
        .event;

    expect(withEvent('SubagentStop')).toBe('stop');
    expect(withEvent('Notification')).toBe('notification');
    expect(withEvent('SessionStart')).toBe('session_start');
  });

  it('lets an explicit --cwd win over the payload', () => {
    const result = run(['--stdin-json', '--cwd', '/repos/override'], { stdin: payload });
    expect(body(result).cwd).toBe('/repos/override');
  });

  it('falls back to CLAUDE_PROJECT_DIR when the payload carries no cwd', () => {
    const result = run(['--stdin-json'], {
      stdin: JSON.stringify({ hook_event_name: 'Stop' }),
      env: { CLAUDE_PROJECT_DIR: '/repos/from-env' },
    });
    expect(body(result).cwd).toBe('/repos/from-env');
  });
});

describe('Codex notify payload', () => {
  it('reads the positional JSON argument Codex appends', () => {
    const result = run([
      '--tool',
      'codex',
      '--cwd',
      '/repos/wt-codex',
      JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 'turn-7' }),
    ]);

    expect(body(result)).toEqual({
      tool: 'codex',
      event: 'stop',
      cwd: '/repos/wt-codex',
      sessionId: 'turn-7',
    });
  });
});

describe('failures are refused rather than sent', () => {
  it('exits non-zero and sends nothing for an unknown --event', () => {
    const result = run(['--event', 'exploded', '--cwd', '/r']);

    expect(result.status).toBe(2);
    expect(result.curlArgs).toBeNull();
    expect(result.stderr).toContain('--event must be one of');
  });

  it('exits non-zero and sends nothing for an unrecognized hook event name', () => {
    const result = run(['--stdin-json'], {
      stdin: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '/r' }),
    });

    expect(result.status).toBe(2);
    expect(result.curlArgs).toBeNull();
  });

  it('exits non-zero and sends nothing for a relative --cwd', () => {
    const result = run(['--cwd', 'relative/path']);

    expect(result.status).toBe(2);
    expect(result.curlArgs).toBeNull();
    expect(result.stderr).toContain('absolute');
  });

  it('exits non-zero and sends nothing for an unknown option or a missing value', () => {
    expect(run(['--nope']).status).toBe(2);
    expect(run(['--nope']).curlArgs).toBeNull();
    expect(run(['--cwd']).status).toBe(2);
  });
});

describe('transport failure does not break the agent', () => {
  it('exits 0 when curl fails, and warns on stderr', () => {
    const result = run(['--cwd', '/r'], { env: { FAKE_CURL_EXIT: '7' } });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('failed to POST');
  });

  it('propagates the failure under --strict', () => {
    const result = run(['--strict', '--cwd', '/r'], { env: { FAKE_CURL_EXIT: '7' } });

    expect(result.status).toBe(1);
  });
});
