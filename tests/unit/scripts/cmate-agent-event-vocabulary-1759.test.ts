/**
 * The relay script's vocabulary (Issue #1759, seam S9).
 *
 * `scripts/hooks/cmate-agent-event.sh` was a Claude convenience when #1549
 * wrote it and is now **the only delivery mechanism four of the six tools
 * have**: #1757 measured `type:"http"` against codex, copilot, gemini and
 * antigravity and none of them accept it — codex discards the entire hooks.json
 * on encountering one, killing every event with a single line on stderr. So a
 * word this script refuses is a word that tool can never report, whatever the
 * API accepts.
 *
 * Two gaps were measured, both silent from the server's side:
 *
 *  1. `--event` accepted five words while `AGENT_EVENT_TYPES` had seven since
 *     #1726. `pre_tool_use` / `post_tool_use` exited 2 without posting.
 *  2. `map_event_name` knew Claude's spellings only, so gemini's `BeforeTool` /
 *     `AfterAgent` family died as "unrecognized hook event name".
 *
 * Driven the way `cmate-agent-event.test.ts` drives it: a fake `curl` first on
 * PATH, and the argv it was handed read back. The payloads are the real
 * captures in `tests/fixtures/hooks/`, piped in on stdin exactly as each CLI
 * pipes them.
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { AGENT_EVENT_TYPES } from '@/lib/hooks/agent-event-types';

const SCRIPT = join(process.cwd(), 'scripts/hooks/cmate-agent-event.sh');
const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

let fakeBin: string;
let argsFile: string;

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'cmate-vocab-bin-'));
  argsFile = join(fakeBin, 'curl-args.txt');
  const fakeCurl = join(fakeBin, 'curl');
  writeFileSync(
    fakeCurl,
    ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > "$CURL_ARGS_FILE"', 'exit 0', ''].join('\n')
  );
  chmodSync(fakeCurl, 0o755);
});

afterAll(() => removeTempDir(fakeBin));

beforeEach(() => rmSync(argsFile, { force: true }));

interface RunResult {
  status: number | null;
  stderr: string;
  curlArgs: string[] | null;
}

function run(args: string[], stdin = ''): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CURL_ARGS_FILE: argsFile,
      CM_HOOK_URL: '',
      CM_AUTH_TOKEN: '',
      CM_AGENT_TOOL: '',
      CM_AGENT_CWD: '',
      CLAUDE_PROJECT_DIR: '',
      CM_HOST: '',
      CM_PORT: '',
    },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    curlArgs: existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').slice(0, -1) : null,
  };
}

function body(result: RunResult): Record<string, unknown> {
  expect(result.curlArgs, `curl was never invoked; stderr: ${result.stderr}`).not.toBeNull();
  const index = result.curlArgs!.indexOf('--data-binary');
  expect(index).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.curlArgs![index + 1]);
}

function fixture(tool: string, name: string): string {
  return readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8');
}

describe('every word the API accepts, the relay can send', () => {
  it.each(AGENT_EVENT_TYPES)('accepts --event %s and posts it', (event) => {
    const result = run(['--event', event, '--cwd', '/tmp/wt', '--worktree-id', 'wt-1']);
    expect(result.status, result.stderr).toBe(0);
    expect(body(result).event).toBe(event);
  });

  it('names all seven in the rejection message, so the next gap is visible', () => {
    const result = run(['--event', 'not_a_word', '--cwd', '/tmp/wt']);
    expect(result.status).toBe(2);
    for (const event of AGENT_EVENT_TYPES) {
      expect(result.stderr).toContain(event);
    }
    expect(result.curlArgs).toBeNull();
  });

  it('still rejects an unknown word rather than posting it', () => {
    // The allowlist is not decoration: the receiver 400s on an unknown event,
    // and a relay that forwarded one would turn a config typo into a request
    // that fails at the far end where nobody is watching.
    expect(run(['--event', 'PreToolUse', '--cwd', '/tmp/wt']).status).toBe(2);
  });
});

describe('native spellings of every push tool', () => {
  /** [tool, fixture, expected event, expected detail] */
  const CASES: ReadonlyArray<[string, string, string, string | null]> = [
    // Claude Code (#1721) — unchanged behaviour, asserted so it stays that way.
    ['claude', 'stop', 'stop', null],
    ['claude', 'session-start', 'session_start', 'startup'],
    ['claude', 'session-end-clear', 'session_end', 'clear'],
    ['claude', 'user-prompt-submit', 'user_prompt_submit', null],
    ['claude', 'notification-permission-prompt', 'notification', 'permission_prompt'],
    // #1726 added these to the API; the relay could not send them until #1759.
    ['claude', 'pre-tool-use-bash', 'pre_tool_use', 'Bash'],
    ['claude', 'post-tool-use-ask-user-question', 'post_tool_use', 'AskUserQuestion'],
    // codex 0.147.0 (#1757).
    ['codex', 'session-start', 'session_start', 'startup'],
    ['codex', 'user-prompt-submit', 'user_prompt_submit', null],
    ['codex', 'pre-tool-use', 'pre_tool_use', 'Bash'],
    ['codex', 'post-tool-use', 'post_tool_use', 'Bash'],
    ['codex', 'stop', 'stop', null],
    ['codex', 'session-end', 'session_end', 'other'],
    // copilot 1.0.77 (#1757).
    ['copilot', 'session-start', 'session_start', 'new'],
    ['copilot', 'user-prompt-submit', 'user_prompt_submit', null],
    ['copilot', 'pre-tool-use', 'pre_tool_use', 'Bash'],
    ['copilot', 'post-tool-use', 'post_tool_use', 'Bash'],
    ['copilot', 'stop', 'stop', null],
    ['copilot', 'session-end', 'session_end', 'complete'],
    // gemini 0.55.1 (#1757) — the four renamed events.
    ['gemini', 'session-start', 'session_start', 'startup'],
    ['gemini', 'before-agent', 'user_prompt_submit', null],
    ['gemini', 'session-end', 'session_end', 'exit'],
  ];

  it.each(CASES)('%s/%s → %s', (tool, name, event, detail) => {
    const result = run(
      ['--tool', tool, '--cwd', '/tmp/wt', '--worktree-id', 'wt-1', '--stdin-json'],
      fixture(tool, name)
    );
    expect(result.status, result.stderr).toBe(0);

    const posted = body(result);
    expect(posted.event).toBe(event);
    expect(posted.tool).toBe(tool);
    if (detail === null) {
      expect(posted.detail).toBeUndefined();
    } else {
      expect(posted.detail).toBe(detail);
    }
  });

  it('maps the gemini names that used to kill the script', () => {
    // `BeforeTool` / `AfterTool` / `AfterAgent` were never captured live — the
    // account could not reach a tool-running turn (#1757 §5.3) — so they are
    // exercised through the CLI's own migration table rather than a fixture.
    for (const [native, event] of [
      ['BeforeTool', 'pre_tool_use'],
      ['AfterTool', 'post_tool_use'],
      ['AfterAgent', 'stop'],
      ['BeforeAgent', 'user_prompt_submit'],
    ] as const) {
      const result = run(
        ['--tool', 'gemini', '--cwd', '/tmp/wt', '--stdin-json'],
        JSON.stringify({ hook_event_name: native, session_id: 'sid', cwd: '/tmp/wt' })
      );
      expect(result.status, `${native}: ${result.stderr}`).toBe(0);
      expect(body(result).event).toBe(event);
    }
  });

  it('refuses a native name with no CommandMate word instead of guessing', () => {
    // `PreInvocation`, `BeforeModel`, `PreCompact` are real events with no
    // counterpart. Filing them under something adjacent would publish a meaning
    // no consumer agreed to.
    for (const native of ['PreInvocation', 'PostInvocation', 'BeforeModel', 'PreCompact']) {
      const result = run(
        ['--cwd', '/tmp/wt', '--stdin-json'],
        JSON.stringify({ hook_event_name: native })
      );
      expect(result.status, native).toBe(2);
      expect(result.stderr).toContain('unrecognized hook event name');
    }
  });
});

describe('antigravity, which can say nothing about itself', () => {
  it('is delivered entirely through arguments', () => {
    // Its payload has no event name, no `cwd` and an empty `workspacePaths`
    // (#1757 R2/R6). Everything correlating it has to be on the command line.
    const result = run(
      [
        '--tool',
        'antigravity',
        '--event',
        'pre_tool_use',
        '--cwd',
        '/tmp/wt',
        '--worktree-id',
        'wt-1',
        '--instance-id',
        'antigravity',
        '--stdin-json',
      ],
      fixture('antigravity', 'pre-tool-use')
    );

    expect(result.status, result.stderr).toBe(0);
    const posted = body(result);
    expect(posted).toMatchObject({
      tool: 'antigravity',
      event: 'pre_tool_use',
      cwd: '/tmp/wt',
      worktreeId: 'wt-1',
      instanceId: 'antigravity',
    });
  });

  it('reads conversationId as the session id', () => {
    const result = run(
      ['--tool', 'antigravity', '--event', 'stop', '--cwd', '/tmp/wt', '--stdin-json'],
      fixture('antigravity', 'stop')
    );
    expect(body(result).sessionId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('finds the nested toolCall.name as the detail', () => {
    // camelCase protojson: there is no flat `tool_name` anywhere in the payload.
    const result = run(
      ['--tool', 'antigravity', '--event', 'post_tool_use', '--cwd', '/tmp/wt', '--stdin-json'],
      fixture('antigravity', 'post-tool-use')
    );
    expect(body(result).detail).toBe('run_command');
  });
});

describe('session id spellings', () => {
  it('prefers session_id, then conversationId, then turn_id', () => {
    const cases: ReadonlyArray<[Record<string, string>, string]> = [
      [{ session_id: 'a', conversationId: 'b', turn_id: 'c' }, 'a'],
      [{ conversationId: 'b', turn_id: 'c' }, 'b'],
      [{ turn_id: 'c' }, 'c'],
    ];
    for (const [payload, expected] of cases) {
      const result = run(
        ['--event', 'stop', '--cwd', '/tmp/wt', '--stdin-json'],
        JSON.stringify(payload)
      );
      expect(body(result).sessionId).toBe(expected);
    }
  });

  it('omits it entirely when the payload has none', () => {
    const result = run(['--event', 'stop', '--cwd', '/tmp/wt', '--stdin-json'], '{"a":"b"}');
    expect(body(result).sessionId).toBeUndefined();
  });
});

describe('--detail', () => {
  it('is passed straight through for a tool whose payload cannot carry one', () => {
    const result = run([
      '--tool',
      'antigravity',
      '--event',
      'notification',
      '--detail',
      'permission_prompt',
      '--cwd',
      '/tmp/wt',
    ]);
    expect(body(result).detail).toBe('permission_prompt');
  });

  it('wins over anything the payload says', () => {
    const result = run(
      ['--event', 'session_start', '--detail', 'resume', '--cwd', '/tmp/wt', '--stdin-json'],
      fixture('claude', 'session-start')
    );
    expect(body(result).detail).toBe('resume');
  });
});

describe('portability', () => {
  it('parses under bash 3.2 syntax rules', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('uses no associative arrays for the widened tables', () => {
    // The obvious way to write a seven-word, four-dialect table is
    // `declare -A`, which macOS's bash 3.2 does not have. It would fail at
    // runtime inside somebody else's agent, where nothing reports it.
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    for (const construct of ['declare -A', 'typeset -A', 'mapfile', 'readarray']) {
      expect(code, `bash 4+ construct present: ${construct}`).not.toContain(construct);
    }
  });
});
