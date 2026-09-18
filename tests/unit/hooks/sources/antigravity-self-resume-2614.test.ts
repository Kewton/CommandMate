/**
 * antigravity's `Stop` says whether background work is still running
 * (Issue #2614).
 *
 * agy's own hook contract, embedded in its binary: `"fullyIdle": true, // true
 * if all background tasks are done`. A `schedule` timer and a backgrounded
 * `run_command` are such tasks, and each wakes the agent when it finishes — so a
 * `Stop` carrying `fullyIdle: false` is not the end of the work, and
 * `commandmate wait` must not report it as such.
 *
 * The field has to survive the relay, which rebuilds the body it posts and drops
 * the rest of the payload. So the `Stop` hook command reads it and hands the
 * relay `--detail self_resume_pending`. Like `antigravity-permission-1779.test.ts`
 * this suite runs that command for real — `sh -c`, the real relay script, a fake
 * `curl` first on PATH — because what matters is what a different program does
 * with the string, and one misplaced quote turns the check into a no-op or the
 * hook into one that prints to the stdout agy obeys.
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { SELF_RESUME_PENDING_DETAIL } from '@/lib/hooks/agent-event-types';
import {
  ANTIGRAVITY_FULLY_IDLE_FIELD,
  buildAntigravityHookCommand,
  buildAntigravityHookConfig,
  buildAntigravityStopHookCommand,
  type AntigravityHookHandler,
  type AntigravityHookMatcherGroup,
} from '@/lib/hooks/sources/antigravity/hooks-config';
import {
  antigravityAgentEventSource,
  extractAntigravityEventDetail,
} from '@/lib/hooks/sources/antigravity/source';

const RELAY = join(process.cwd(), 'scripts/hooks/cmate-agent-event.sh');

/** agy's captured `Stop` (1.1.x), pretty-printed as captured. `fullyIdle: true`. */
const STOP_FIXTURE_TEXT = readFileSync(
  join(process.cwd(), 'tests/fixtures/hooks/antigravity/stop.json'),
  'utf8'
);
const STOP_FIXTURE = JSON.parse(STOP_FIXTURE_TEXT) as Record<string, unknown>;

/** The same payload as it would arrive at 01:28:36 on 2026-09-17: work still running. */
const NOT_IDLE = { ...STOP_FIXTURE, fullyIdle: false };

let sandbox: string;
let curlArgsFile: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cmate-agy-stop-2614-'));
  curlArgsFile = join(sandbox, 'curl-args.txt');
  const fakeCurl = join(sandbox, 'curl');
  writeFileSync(
    fakeCurl,
    ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > "$CURL_ARGS_FILE"', 'exit 0', ''].join('\n')
  );
  chmodSync(fakeCurl, 0o755);
});

afterAll(() => removeTempDir(sandbox));

beforeEach(() => rmSync(curlArgsFile, { force: true }));

interface HookRun {
  status: number | null;
  stdout: string;
  /** The JSON body the relay handed to curl, or null when curl never ran. */
  body: Record<string, unknown> | null;
}

/** Run a hook command the way agy does: `sh -c`, the payload on stdin. */
function runHook(command: string, stdin: string): HookRun {
  const result = spawnSync('sh', ['-c', command], {
    cwd: sandbox,
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      PATH: `${sandbox}:${process.env.PATH ?? ''}`,
      CURL_ARGS_FILE: curlArgsFile,
      // What `buildAntigravityLaunchCommand` puts in the agent's environment.
      CM_HOOK_URL: 'http://127.0.0.1:9/api/hooks/agent-event?worktreeId=wt-2614&instanceId=antigravity',
      CM_AUTH_TOKEN: '',
      CM_AGENT_TOOL: '',
      CM_AGENT_CWD: '',
      CLAUDE_PROJECT_DIR: '',
    },
  });
  let body: Record<string, unknown> | null = null;
  if (existsSync(curlArgsFile)) {
    const args = readFileSync(curlArgsFile, 'utf8').split('\n').slice(0, -1);
    body = JSON.parse(args[args.indexOf('--data-binary') + 1]) as Record<string, unknown>;
  }
  return { status: result.status, stdout: result.stdout ?? '', body };
}

const STOP_COMMAND = buildAntigravityStopHookCommand(RELAY);

describe('the Stop hook passes fullyIdle:false on as a detail', () => {
  it('adds --detail self_resume_pending when agy still has background work', () => {
    const run = runHook(STOP_COMMAND, JSON.stringify(NOT_IDLE));

    expect(run.status).toBe(0);
    expect(run.body).toMatchObject({
      tool: 'antigravity',
      event: 'stop',
      detail: SELF_RESUME_PENDING_DETAIL,
      // The payload still reached the relay: the session id is read from it.
      sessionId: STOP_FIXTURE.conversationId,
    });
  });

  it.each([
    ['pretty-printed', JSON.stringify(NOT_IDLE, null, 2)],
    ['protojson-style spacing', JSON.stringify(NOT_IDLE).replace('"fullyIdle":false', '"fullyIdle":  false')],
    ['a space before the colon', JSON.stringify(NOT_IDLE).replace('"fullyIdle":false', '"fullyIdle" :false')],
    ['a tab and a CRLF', JSON.stringify(NOT_IDLE).replace('"fullyIdle":false', '"fullyIdle":\t\r\nfalse')],
  ])('reads it through %s', (_label, payload) => {
    expect(runHook(STOP_COMMAND, payload).body?.detail).toBe(SELF_RESUME_PENDING_DETAIL);
  });

  it('prints nothing, because agy obeys a decision on this stdout', () => {
    // `{"decision":"continue"}` here would restart the agent's loop.
    expect(runHook(STOP_COMMAND, JSON.stringify(NOT_IDLE)).stdout).toBe('');
    expect(runHook(STOP_COMMAND, STOP_FIXTURE_TEXT).stdout).toBe('');
    expect(runHook(STOP_COMMAND, '').stdout).toBe('');
  });
});

describe('any other Stop is the plain relay call, unchanged', () => {
  /** What the relay posted before this Issue for the same stdin. */
  const plain = (stdin: string) => runHook(buildAntigravityHookCommand(RELAY, 'stop'), stdin).body;

  it.each([
    ['the captured fixture (fullyIdle: true)', STOP_FIXTURE_TEXT],
    ['a payload without the field', JSON.stringify({ ...STOP_FIXTURE, fullyIdle: undefined })],
    ['a string "false"', JSON.stringify({ ...STOP_FIXTURE, fullyIdle: 'false' })],
    ['an empty payload', ''],
    [
      'the words inside an escaped string',
      JSON.stringify({ ...STOP_FIXTURE, error: 'saw "fullyIdle":false somewhere' }),
    ],
  ])('%s', (_label, stdin) => {
    const run = runHook(STOP_COMMAND, stdin);

    expect(run.status).toBe(0);
    expect(run.body).not.toBeNull();
    expect(run.body).not.toHaveProperty('detail');
    expect(run.body).toEqual(plain(stdin));
  });
});

describe('the config and the source agree', () => {
  it('uses the self-resume command for Stop and the plain relay for the other two', () => {
    const config = buildAntigravityHookConfig(RELAY);

    expect((config.Stop as AntigravityHookHandler[])[0].command).toBe(STOP_COMMAND);
    expect((config.SessionStart as AntigravityHookHandler[])[0].command).toBe(
      buildAntigravityHookCommand(RELAY, 'session_start')
    );
    expect((config.PostToolUse as AntigravityHookMatcherGroup[])[0].hooks[0].command).toBe(
      buildAntigravityHookCommand(RELAY, 'post_tool_use')
    );
  });

  it('matches on the field the source reads', () => {
    expect(STOP_COMMAND).toContain(`"${ANTIGRAVITY_FULLY_IDLE_FIELD}":false`);
    expect(ANTIGRAVITY_FULLY_IDLE_FIELD in STOP_FIXTURE).toBe(true);
  });

  it('declares that its stop can say so', () => {
    // Flipping this to false is what takes `wait`'s hold away for agy; see
    // tests/unit/cli/commands/wait-self-resume-2614.test.ts.
    expect(antigravityAgentEventSource.capabilities.stopReportsSelfResume).toBe(true);
  });
});

describe('the source reads agy’s own Stop payload the same way', () => {
  it('reads fullyIdle:false as the self-resume detail', () => {
    expect(extractAntigravityEventDetail('stop', NOT_IDLE)).toBe(SELF_RESUME_PENDING_DETAIL);
    expect(
      antigravityAgentEventSource.normalizeEvent({ event: 'stop', payload: NOT_IDLE, receivedAt: 1 })
        ?.detail
    ).toBe(SELF_RESUME_PENDING_DETAIL);
  });

  it.each([
    ['the captured fixture', STOP_FIXTURE],
    ['no field', { ...STOP_FIXTURE, fullyIdle: undefined }],
    ['a string', { ...STOP_FIXTURE, fullyIdle: 'false' }],
    ['a relay body', { tool: 'antigravity', event: 'stop', cwd: '/x', detail: 'ignored-here' }],
  ])('reads %s as a plain stop', (_label, payload) => {
    expect(extractAntigravityEventDetail('stop', payload as Record<string, unknown>)).toBeNull();
  });

  it('still reads the tool name off tool events, and only there', () => {
    const toolEvent = { toolCall: { name: 'schedule', args: { DurationSeconds: 60 } }, fullyIdle: false };
    expect(extractAntigravityEventDetail('post_tool_use', toolEvent)).toBe('schedule');
    expect(extractAntigravityEventDetail('pre_tool_use', toolEvent)).toBe('schedule');
    expect(extractAntigravityEventDetail('session_start', toolEvent)).toBeNull();
  });
});
