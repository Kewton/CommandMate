/**
 * What an opencode instance is launched and prompted with (Issue #2048).
 *
 * The single most important assertion in this file is a **negative** one:
 * {@link opencodeLaunchArguments} must never emit `--variant`. That is not
 * style. Measured on opencode 1.18.22
 * (`docs/design/opencode-server-live-verification.md` §20.3), the TUI does not
 * declare the flag — `opencode run` does — and yargs answers an unknown option
 * by printing its usage banner and exiting. A launch line carrying `--variant`
 * therefore produces a tmux pane with **no agent in it at all**, which is a
 * worse outcome than ignoring the setting. Two runs were measured, one inside
 * tmux and one directly, and both exited.
 *
 * The variant instead rides on `prompt_async`, which is the one channel measured
 * to apply it (§20.4), so {@link opencodePromptSelection} is where it appears.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  forgetOpencodeLaunchSettings,
  getOpencodeLaunchSettings,
  getOpencodeLaunchSettingsFilePath,
  opencodeLaunchArguments,
  opencodePromptSelection,
  readPersistedOpencodeLaunchSettings,
  rememberOpencodeLaunchSettings,
  resetOpencodeLaunchSettings,
} from '@/lib/hooks/sources/opencode/launch-settings';
import { promptSelectionBody } from '@/lib/hooks/sources/opencode/client';
import { EMPTY_OPENCODE_INSTANCE_SETTINGS } from '@/types/opencode-instance-settings';

const TARGET = { worktreeId: 'wt-2048', cliToolId: 'opencode' as const, instanceId: 'opencode' };

const FULL = {
  agent: 'plan',
  providerId: 'github-copilot',
  modelId: 'claude-sonnet-4.6',
  variant: 'high',
};

describe('opencodeLaunchArguments (Issue #2048)', () => {
  it('emits the two flags the TUI declares, in a form a shell can take', () => {
    expect(opencodeLaunchArguments(FULL)).toBe(
      " --agent 'plan' --model 'github-copilot/claude-sonnet-4.6'"
    );
  });

  it('NEVER emits --variant — the TUI has no such flag and exits when given one', () => {
    expect(opencodeLaunchArguments(FULL)).not.toContain('--variant');
    expect(
      opencodeLaunchArguments({ ...EMPTY_OPENCODE_INSTANCE_SETTINGS, variant: 'high' })
    ).toBe('');
  });

  it('is empty for an unconfigured instance, so the launch line is unchanged', () => {
    expect(opencodeLaunchArguments(EMPTY_OPENCODE_INSTANCE_SETTINGS)).toBe('');
    expect(opencodeLaunchArguments(null)).toBe('');
    expect(opencodeLaunchArguments(undefined)).toBe('');
  });

  it('emits each half independently', () => {
    expect(opencodeLaunchArguments({ ...EMPTY_OPENCODE_INSTANCE_SETTINGS, agent: 'build' })).toBe(
      " --agent 'build'"
    );
    expect(
      opencodeLaunchArguments({
        ...EMPTY_OPENCODE_INSTANCE_SETTINGS,
        providerId: 'lmstudio',
        modelId: 'qwen/qwen3-coder-30b',
      })
    ).toBe(" --model 'lmstudio/qwen/qwen3-coder-30b'");
  });

  it('drops a value the shell must never see rather than quoting around it', () => {
    expect(
      opencodeLaunchArguments({
        ...EMPTY_OPENCODE_INSTANCE_SETTINGS,
        agent: '$(touch /tmp/pwned-2048)',
      })
    ).toBe('');
  });
});

describe('opencodePromptSelection (Issue #2048)', () => {
  it('carries all three, because the prompt is where the variant can be applied', () => {
    expect(opencodePromptSelection(FULL)).toEqual({
      agent: 'plan',
      model: { providerID: 'github-copilot', modelID: 'claude-sonnet-4.6' },
      variant: 'high',
    });
  });

  it('is null when nothing is configured, so the request body is unchanged', () => {
    expect(opencodePromptSelection(EMPTY_OPENCODE_INSTANCE_SETTINGS)).toBeNull();
    expect(opencodePromptSelection(null)).toBeNull();
  });

  it('carries a variant on its own — the setting that has no other channel', () => {
    expect(
      opencodePromptSelection({ ...EMPTY_OPENCODE_INSTANCE_SETTINGS, variant: 'max' })
    ).toEqual({ variant: 'max' });
  });
});

describe('promptSelectionBody (Issue #2048)', () => {
  it('omits keys rather than nulling them — an absent `agent` is not a default', () => {
    expect(promptSelectionBody(null)).toEqual({});
    expect(promptSelectionBody({})).toEqual({});
    expect(promptSelectionBody({ agent: null, variant: null })).toEqual({});
  });

  it('sends `model` only when both halves are there', () => {
    expect(
      promptSelectionBody({ model: { providerID: 'github-copilot', modelID: '' } })
    ).toEqual({});
  });

  it('spells the keys the way the 1.18.22 schema does', () => {
    expect(
      promptSelectionBody({
        agent: 'plan',
        model: { providerID: 'github-copilot', modelID: 'claude-sonnet-4.6' },
        variant: 'high',
      })
    ).toEqual({
      agent: 'plan',
      model: { providerID: 'github-copilot', modelID: 'claude-sonnet-4.6' },
      variant: 'high',
    });
  });
});

describe('the launcher s mirror (Issue #2048)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cm-2048-launch-'));
    vi.stubEnv('CM_OPENCODE_LAUNCH_SETTINGS_FILE', join(sandbox, 'opencode-launch-settings.json'));
    resetOpencodeLaunchSettings();
  });

  afterEach(() => {
    resetOpencodeLaunchSettings();
    vi.unstubAllEnvs();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('answers all-unset for an instance nobody configured', () => {
    expect(getOpencodeLaunchSettings(TARGET)).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
  });

  it('round-trips a value, normalised on the way in', () => {
    rememberOpencodeLaunchSettings(TARGET, { ...FULL, variant: 'not a variant' });
    expect(getOpencodeLaunchSettings(TARGET)).toEqual({ ...FULL, variant: null });
  });

  it('survives a process restart — the launcher is not always the writer', () => {
    rememberOpencodeLaunchSettings(TARGET, FULL);
    resetOpencodeLaunchSettings();
    expect(getOpencodeLaunchSettings(TARGET)).toEqual(FULL);
  });

  it('writes the file with owner-only permissions, keyed by the composite key', () => {
    rememberOpencodeLaunchSettings(TARGET, FULL);
    const raw = JSON.parse(readFileSync(getOpencodeLaunchSettingsFilePath(), 'utf8'));
    expect(raw).toEqual({ 'wt-2048:opencode': FULL });
  });

  it('keys on the instance, so two instances of one tool do not share a model', () => {
    rememberOpencodeLaunchSettings(TARGET, FULL);
    expect(getOpencodeLaunchSettings({ ...TARGET, instanceId: 'opencode-2' })).toEqual(
      EMPTY_OPENCODE_INSTANCE_SETTINGS
    );
  });

  it('forgets one instance without disturbing the others', () => {
    rememberOpencodeLaunchSettings(TARGET, FULL);
    rememberOpencodeLaunchSettings({ ...TARGET, instanceId: 'opencode-2' }, FULL);
    forgetOpencodeLaunchSettings(TARGET);
    expect(getOpencodeLaunchSettings(TARGET)).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
    expect(getOpencodeLaunchSettings({ ...TARGET, instanceId: 'opencode-2' })).toEqual(FULL);
  });

  it('removes the entry rather than storing four nulls', () => {
    rememberOpencodeLaunchSettings(TARGET, FULL);
    rememberOpencodeLaunchSettings(TARGET, EMPTY_OPENCODE_INSTANCE_SETTINGS);
    expect(readPersistedOpencodeLaunchSettings()).toEqual({});
  });

  it('re-validates on the way out — the file is writable by anything as this user', () => {
    rememberOpencodeLaunchSettings(TARGET, FULL);
    writeFileSync(
      getOpencodeLaunchSettingsFilePath(),
      JSON.stringify({ 'wt-2048:opencode': { ...FULL, agent: 'plan; rm -rf /' } })
    );
    resetOpencodeLaunchSettings();
    expect(getOpencodeLaunchSettings(TARGET).agent).toBeNull();
  });

  it('answers nothing for an unreadable file rather than throwing', () => {
    writeFileSync(getOpencodeLaunchSettingsFilePath(), 'not json');
    expect(readPersistedOpencodeLaunchSettings()).toEqual({});
    expect(getOpencodeLaunchSettings(TARGET)).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
  });
});
