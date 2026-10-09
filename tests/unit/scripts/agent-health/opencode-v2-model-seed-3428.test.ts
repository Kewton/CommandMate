/**
 * Issue #3428: the opencode-v2 probe copies the user's model pick into the
 * isolated `XDG_STATE_HOME`, as the v1 probe does since #3021.
 *
 * opencode2 2.0.18 keeps the pick in the same `$XDG_STATE_HOME/opencode/model.json`
 * as v1. With the isolated dir empty it started on the first listed model
 * (`Mistral Large 4`, Ollama Cloud on 2026-10-08), which the provider refused
 * with `Error: Unauthorized` (#3420 / #3421 / #3422).
 *
 * @vitest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedStateFiles } from '../../../../scripts/agent-health/probe-tool';
import { TOOL_PROBE_SPECS } from '../../../../scripts/agent-health/tool-table';

const spec = TOOL_PROBE_SPECS['opencode-v2'];

/** Every file under `dir`, relative to it, sorted. */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((entry) => fs.statSync(path.join(dir, entry)).isFile())
    .sort();
}

let root: string;
let userState: string;
let workDir: string;

/** The user's own state as opencode2 leaves it: the model pick and everything else. */
const USER_FILES: Record<string, string> = {
  'opencode/model.json': '{"recent":[{"providerID":"github-copilot","modelID":"claude-sonnet-5.5"}],"favorite":[],"variant":{}}',
  'opencode/prompt-history.jsonl': '{"input":"secret prompt"}\n',
  'opencode/service.json': '{"url":"http://127.0.0.1:4096","pid":1}',
  'opencode/kv.json': '{"sidebar":"auto"}',
  'opencode/latest/tui/tabs.json': '{"global":{"tabs":[]}}',
  'opencode/locks/model.json.lock': 'held',
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-model-seed-3428-'));
  userState = path.join(root, 'user-state');
  workDir = path.join(root, 'run', 'opencode-v2');
  for (const [rel, body] of Object.entries(USER_FILES)) {
    fs.mkdirSync(path.dirname(path.join(userState, rel)), { recursive: true });
    fs.writeFileSync(path.join(userState, rel), body);
  }
  vi.stubEnv('XDG_STATE_HOME', userState);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('opencode-v2 model seed (Issue #3428)', () => {
  it('seeds model.json from the user state into the XDG_STATE_HOME the launch line sets', () => {
    const isolated = spec.launchEnv?.(workDir).XDG_STATE_HOME as string;
    expect(spec.seedFiles?.(workDir)).toEqual([
      {
        from: path.join(userState, 'opencode', 'model.json'),
        to: path.join(isolated, 'opencode', 'model.json'),
      },
    ]);
  });

  it('copies only the model pick and leaves every user file as it was', () => {
    const isolated = spec.launchEnv?.(workDir).XDG_STATE_HOME as string;
    const before = listFiles(userState).map((rel) => [rel, fs.readFileSync(path.join(userState, rel), 'utf8')]);

    const copied = seedStateFiles(spec.seedFiles?.(workDir) ?? []);

    // Positive: the pick is there, byte for byte.
    expect(copied).toEqual([path.join(isolated, 'opencode', 'model.json')]);
    expect(fs.readFileSync(path.join(isolated, 'opencode', 'model.json'), 'utf8')).toBe(
      USER_FILES['opencode/model.json']
    );
    // Negative: history, service.json, kv, tabs and locks stay out.
    expect(listFiles(isolated)).toEqual([path.join('opencode', 'model.json')]);
    // The user's files are read, never moved or rewritten.
    const after = listFiles(userState).map((rel) => [rel, fs.readFileSync(path.join(userState, rel), 'utf8')]);
    expect(after).toEqual(before);
  });

  it('seeds nothing when the user never picked a model (opencode2 keeps its own default)', () => {
    fs.rmSync(path.join(userState, 'opencode', 'model.json'));
    const isolated = spec.launchEnv?.(workDir).XDG_STATE_HOME as string;
    expect(seedStateFiles(spec.seedFiles?.(workDir) ?? [])).toEqual([]);
    expect(fs.existsSync(isolated)).toBe(false);
  });
});
