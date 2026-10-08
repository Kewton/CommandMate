/**
 * The relay forwards a Claude `Stop`'s `transcript_path` (Issue #3450).
 *
 * #3430 reads the session's transcript on a Claude `Stop` to tell whether the
 * turn left background work behind, and finds it by the payload's
 * `transcript_path`. The injected `type: "http"` hook posts the payload as it
 * is; a hand-configured Stop hook (docs/user-guide/agent-event-hooks.md §3,
 * Issue #1549) posts through `scripts/hooks/cmate-agent-event.sh`, which built
 * its body from a fixed set of fields and dropped this one.
 *
 * Same harness as `cmate-agent-event.test.ts`: a fake `curl` first on PATH
 * records what would have been sent. No server.
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { claudeStopLeavesBackgroundWork } from '@/lib/hooks/sources/claude/self-resume';

const SCRIPT = join(process.cwd(), 'scripts/hooks/cmate-agent-event.sh');

let root: string;
let fakeBin: string;
let argsFile: string;
let home: string;
let transcript: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cmate-relay-3450-'));
  fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  argsFile = join(fakeBin, 'curl-args.txt');
  const fakeCurl = join(fakeBin, 'curl');
  writeFileSync(
    fakeCurl,
    ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > "$CURL_ARGS_FILE"', 'exit 0', ''].join('\n')
  );
  chmodSync(fakeCurl, 0o755);

  home = join(root, 'home');
  const projectDir = join(home, '.claude', 'projects', '-repos-wt-claude');
  mkdirSync(projectDir, { recursive: true });
  transcript = join(projectDir, 'sess-3450.jsonl');
  // One background Bash with no notification yet: the turn will resume.
  writeFileSync(
    transcript,
    JSON.stringify({ type: 'user', toolUseResult: { backgroundTaskId: 'bg3450' } }) + '\n'
  );
});

afterAll(() => removeTempDir(root));

beforeEach(() => rmSync(argsFile, { force: true }));

function relay(args: string[], stdin: string): Record<string, unknown> {
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
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(argsFile), 'curl was never invoked').toBe(true);
  const curlArgs = readFileSync(argsFile, 'utf8').split('\n').slice(0, -1);
  return JSON.parse(curlArgs[curlArgs.indexOf('--data-binary') + 1]) as Record<string, unknown>;
}

const stopPayload = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: 'sess-3450',
    transcript_path: transcript,
    cwd: '/repos/wt-claude',
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Waiting for the tests to finish.',
    ...extra,
  });

describe('a Claude Stop through the relay (Issue #3450)', () => {
  it('sends transcript_path and the session id, and nothing else from the payload', () => {
    expect(relay(['--stdin-json'], stopPayload())).toEqual({
      tool: 'claude',
      event: 'stop',
      cwd: '/repos/wt-claude',
      sessionId: 'sess-3450',
      transcript_path: transcript,
    });
  });

  it('sends a body the receiver reads as leaving background work behind', () => {
    const body = relay(['--stdin-json'], stopPayload());
    expect(claudeStopLeavesBackgroundWork(body, { homeDir: home })).toBe(true);
  });

  it('also forwards it when the hook passes the payload with --json', () => {
    expect(relay(['--json', stopPayload()], '').transcript_path).toBe(transcript);
  });

  it('omits a path the receiver would refuse anyway', () => {
    for (const path of ['/tmp/t.jsonl', 'relative/.claude/projects/x/s.jsonl', `${transcript}.txt`, '']) {
      const body = relay(['--stdin-json'], stopPayload({ transcript_path: path }));
      expect(body, path).not.toHaveProperty('transcript_path');
    }
  });

  it('omits it when the payload has none', () => {
    const payload = JSON.stringify({ session_id: 's', hook_event_name: 'Stop', cwd: '/r' });
    expect(relay(['--stdin-json'], payload)).not.toHaveProperty('transcript_path');
  });

  it('leaves every other event and every other tool as it was', () => {
    // codex's shared relay is a byte copy of this script; its bodies must not change.
    const codex = relay(['--tool', 'codex', '--stdin-json'], stopPayload());
    expect(codex).not.toHaveProperty('transcript_path');

    const submit = relay(['--stdin-json'], stopPayload({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }));
    expect(submit).toEqual({
      tool: 'claude',
      event: 'user_prompt_submit',
      cwd: '/repos/wt-claude',
      sessionId: 'sess-3450',
    });
  });
});
