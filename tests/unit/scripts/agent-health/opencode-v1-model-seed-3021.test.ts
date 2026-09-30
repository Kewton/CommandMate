/**
 * Issue #3021 / #3022: the opencode (v1) probe copies the user's model pick
 * (`$XDG_STATE_HOME/opencode/model.json`) into the isolated state dir #2953
 * introduced.
 *
 * With that dir empty, opencode 1.18.33 started on its built-in default model
 * (LM Studio's `Qwen3 Coder 30B` on the measuring machine), which answered every
 * turn with "No models loaded" — so `screen-running` never saw a running
 * screen and `screen-quoted-dialog` never saw a finished turn.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedStateFiles } from '../../../../scripts/agent-health/probe-tool';
import { TOOL_PROBE_SPECS, userStateHome } from '../../../../scripts/agent-health/tool-table';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-model-seed-3021-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('userStateHome (Issue #3021)', () => {
  it('reads an absolute XDG_STATE_HOME', () => {
    expect(userStateHome({ XDG_STATE_HOME: '/x/state' })).toBe('/x/state');
  });

  it('falls back to ~/.local/state when unset or relative', () => {
    const fallback = path.join(os.homedir(), '.local', 'state');
    expect(userStateHome({})).toBe(fallback);
    expect(userStateHome({ XDG_STATE_HOME: 'relative/state' })).toBe(fallback);
  });
});

describe('opencode (v1) model seed (Issue #3021 / #3022)', () => {
  it('copies only model.json from the user state into the isolated XDG_STATE_HOME', () => {
    const workDir = '/tmp/cm-agent-health-x/opencode';
    const seeds = TOOL_PROBE_SPECS.opencode.seedFiles?.(workDir);
    const isolated = TOOL_PROBE_SPECS.opencode.launchEnv?.(workDir).XDG_STATE_HOME;
    expect(seeds).toEqual([
      {
        from: path.join(userStateHome(), 'opencode', 'model.json'),
        to: path.join(isolated as string, 'opencode', 'model.json'),
      },
    ]);
    // The prompt history (#2953) is never among them.
    expect(JSON.stringify(seeds)).not.toContain('prompt-history');
  });

  it('seedStateFiles copies an existing source and leaves the source untouched', () => {
    const from = path.join(root, 'user', 'opencode', 'model.json');
    const to = path.join(root, 'work-xdg-state', 'opencode', 'model.json');
    const body = '{"recent":[{"providerID":"github-copilot","modelID":"gpt-5-mini"}]}';
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.writeFileSync(from, body);

    expect(seedStateFiles([{ from, to }])).toEqual([to]);
    expect(fs.readFileSync(to, 'utf8')).toBe(body);
    expect(fs.readFileSync(from, 'utf8')).toBe(body);
  });

  it('seedStateFiles skips a missing source (the CLI then uses its own default)', () => {
    const to = path.join(root, 'work-xdg-state', 'opencode', 'model.json');
    expect(seedStateFiles([{ from: path.join(root, 'absent.json'), to }])).toEqual([]);
    expect(fs.existsSync(to)).toBe(false);
  });
});
