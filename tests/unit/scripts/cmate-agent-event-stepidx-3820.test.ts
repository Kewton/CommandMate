/**
 * scripts/hooks/cmate-agent-event.sh forwards agy's `stepIdx` on
 * `post_tool_use` (Issue #3820, design `docs/design/auto-yes-measurement-3820.md`
 * §2.4, PR 3) — and only there: every other tool and event keeps the body it
 * had, and a payload without a numeric `stepIdx` (an older agy) is posted as
 * before. `permission_mode` is not forwarded (design, mandatory 6).
 *
 * A fake `curl` first on PATH, in a directory under `os.tmpdir()` removed
 * afterwards, records what would have been sent.
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';

const SCRIPT = join(process.cwd(), 'scripts/hooks/cmate-agent-event.sh');
const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');

let fakeBin: string;
let argsFile: string;

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'cmate-hook-stepidx-'));
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

/** The body the relay posted for `--tool <tool> --event <event>` with `stdin` as the payload. */
function posted(tool: string, event: string, stdin: string): Record<string, unknown> {
  const result = spawnSync('bash', [SCRIPT, '--tool', tool, '--event', event, '--cwd', '/tmp/wt', '--stdin-json'], {
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
  const args = readFileSync(argsFile, 'utf8').split('\n').slice(0, -1);
  return JSON.parse(args[args.indexOf('--data-binary') + 1]) as Record<string, unknown>;
}

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const agyPostToolUse = (stepIdx: unknown): string =>
  JSON.stringify({ ...JSON.parse(fixture('antigravity/post-tool-use.json')), stepIdx });

describe('[#3820 PR 3] agy post_tool_use carries stepIdx', () => {
  it('forwards the captured fixture’s stepIdx as a number, beside the body it already had', () => {
    expect(posted('antigravity', 'post_tool_use', fixture('antigravity/post-tool-use.json'))).toEqual({
      tool: 'antigravity',
      event: 'post_tool_use',
      cwd: '/tmp/wt',
      sessionId: '22222222-2222-4222-8222-222222222222',
      detail: 'run_command',
      stepIdx: 16,
    });
  });

  it('reads the top-level stepIdx, not a "stepIdx" quoted inside a tool argument', () => {
    const payload = JSON.parse(fixture('antigravity/post-tool-use.json')) as Record<string, unknown>;
    (payload.toolCall as { args: Record<string, unknown> }).args.CommandLine = 'echo "\\"stepIdx\\": 99"';
    expect(posted('antigravity', 'post_tool_use', JSON.stringify(payload)).stepIdx).toBe(16);
  });
});

describe('[#3820 PR 3] the old body, unchanged (backward compatibility)', () => {
  it('omits stepIdx when the payload has none', () => {
    const payload = JSON.parse(fixture('antigravity/post-tool-use.json')) as Record<string, unknown>;
    delete payload.stepIdx;
    const body = posted('antigravity', 'post_tool_use', JSON.stringify(payload));
    expect(body).not.toHaveProperty('stepIdx');
    expect(body).toMatchObject({ tool: 'antigravity', event: 'post_tool_use', detail: 'run_command' });
  });

  it.each([['"16"'], [-1], [16.5], [null], [1e16]])('omits a stepIdx that is not a safe non-negative integer (%s)', (value) => {
    const stepIdx = typeof value === 'string' ? JSON.parse(value) : value;
    expect(posted('antigravity', 'post_tool_use', agyPostToolUse(stepIdx))).not.toHaveProperty('stepIdx');
  });

  it('does not add it to agy’s other events', () => {
    expect(posted('antigravity', 'pre_tool_use', fixture('antigravity/pre-tool-use.json'))).not.toHaveProperty('stepIdx');
    expect(posted('antigravity', 'stop', agyPostToolUse(16))).not.toHaveProperty('stepIdx');
  });

  it('does not add it to another tool’s post_tool_use, even if its payload had one', () => {
    const claude = JSON.stringify({ ...JSON.parse(fixture('claude/post-tool-use-ask-user-question.json')), stepIdx: 3 });
    expect(posted('claude', 'post_tool_use', claude)).not.toHaveProperty('stepIdx');
  });

  it('never forwards permission_mode', () => {
    const payload = JSON.stringify({ ...JSON.parse(agyPostToolUse(16)), permission_mode: 'default' });
    expect(posted('antigravity', 'post_tool_use', payload)).not.toHaveProperty('permission_mode');
  });
});
