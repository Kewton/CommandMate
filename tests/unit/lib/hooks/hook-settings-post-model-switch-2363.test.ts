/**
 * Issue #2363: `PostModelSwitch` in the `--settings` file CommandMate hands to
 * Claude, and `PreModelSwitch` deliberately not in it.
 *
 * Measured on claude 2.1.263 (2026-09-06, `tests/fixtures/hooks/claude-model-switch-2363/`):
 * a `type: "http"` hook injected through `--settings` receives `PostModelSwitch`
 * on every `/model` and `/fast` that changes the model, with `to_model` in the
 * `SessionStart` spelling. The paired `PreModelSwitch` is a decision hook that
 * fired twice per switch with inconsistent values; it stays unregistered.
 *
 * `tests/unit/hooks/hook-settings-generator.test.ts` pins the full key list and
 * the byte-level shape of the other handlers; this file pins only what #2363
 * adds, and that no other tool's launch gained a hook for it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  AUTH_TOKEN_ENV_VAR,
  buildAgentEventUrl,
  buildAgentHookSettings,
  buildPermissionRequestUrl,
  HOOK_TIMEOUT_SECONDS,
} from '@/lib/hooks/hook-settings-generator';
import {
  CLAUDE_POST_MODEL_SWITCH_EVENT_NAME,
  CLAUDE_PRE_MODEL_SWITCH_EVENT_NAME,
} from '@/lib/hooks/sources/claude/model-switch';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude-model-switch-2363');
const TARGET = { worktreeId: 'wt-2363' } as const;
const TARGET_2 = { worktreeId: 'wt-2363', instanceId: 'claude-2' } as const;

const MANAGED_ENV = ['CM_PORT', 'MCBD_PORT', AUTH_TOKEN_ENV_VAR, 'CM_AUTH_TOKEN_HASH'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('PostModelSwitch is registered (Issue #2363)', () => {
  it('spells the key the way Claude does', () => {
    expect(CLAUDE_POST_MODEL_SWITCH_EVENT_NAME).toBe('PostModelSwitch');
    expect(Object.keys(buildAgentHookSettings(TARGET).hooks)).toContain('PostModelSwitch');
  });

  it('is one http handler posting to the EVENT receiver, with no matcher', () => {
    // The event route, not the permission one: this is an observation, and a
    // `PermissionRequest`-style receiver would answer it with a verdict body.
    // No matcher: the hook fires only when the model actually changed
    // (measured: nothing arrives for `/model haiku` while on Haiku, for
    // `/fast` OFF, or for the picker's Esc), so there is nothing to narrow.
    const groups = buildAgentHookSettings(TARGET).hooks.PostModelSwitch;
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.matcher).toBeUndefined();
    expect(group.hooks).toHaveLength(1);
    const [hook] = group.hooks;
    expect(hook.type).toBe('http');
    expect(hook.type === 'http' && hook.url).toBe(buildAgentEventUrl(TARGET));
    expect(hook.type === 'http' && hook.url).not.toBe(buildPermissionRequestUrl(TARGET));
    expect(hook.timeout).toBe(HOOK_TIMEOUT_SECONDS);
  });

  it('carries the instance in its URL, like every other event hook', () => {
    const [hook] = buildAgentHookSettings(TARGET_2).hooks.PostModelSwitch[0].hooks;
    expect(hook.type === 'http' && hook.url).toBe(buildAgentEventUrl(TARGET_2));
    expect(hook.type === 'http' && hook.url).toContain('instanceId=claude-2');
  });

  it('is byte-identical to the Stop handler, so auth and headers cannot drift', () => {
    // Without a token: plain JSON header. With one: the bearer header plus
    // `allowedEnvVars` (D7). Both cases are the other handlers' cases, and the
    // cheapest way to keep them so is to compare against one of them.
    const plain = buildAgentHookSettings(TARGET).hooks;
    expect(plain.PostModelSwitch[0].hooks[0]).toStrictEqual(plain.Stop[0].hooks[0]);

    process.env[AUTH_TOKEN_ENV_VAR] = 'secret';
    const withAuth = buildAgentHookSettings(TARGET).hooks;
    const [hook] = withAuth.PostModelSwitch[0].hooks;
    expect(hook).toStrictEqual(withAuth.Stop[0].hooks[0]);
    expect(hook.type === 'http' && hook.headers.Authorization).toBe(`Bearer $${AUTH_TOKEN_ENV_VAR}`);
    expect(hook.type === 'http' && hook.allowedEnvVars).toEqual([AUTH_TOKEN_ENV_VAR]);
  });

  it('covers every observed PostModelSwitch fixture', () => {
    // The #2363 fixture directory holds what a real session sent. Every
    // `Post…` capture there has to be a registered event, or the capture is
    // documenting a hook nobody subscribed to.
    const observed = readdirSync(FIXTURE_DIR)
      .filter((name) => name.startsWith('post-model-switch') && name.endsWith('.json'))
      .map((name) => fixture(name).hook_event_name as string);
    expect(observed.length).toBeGreaterThanOrEqual(4);
    const registered = new Set(Object.keys(buildAgentHookSettings(TARGET).hooks));
    for (const event of observed) {
      expect(registered.has(event), `no hook registered for observed event ${event}`).toBe(true);
    }
  });
});

describe('PreModelSwitch is NOT registered (Issue #2363)', () => {
  it('keeps the decision hook out of the injected settings', () => {
    // A `Pre*` hook's reply can block or redirect the switch, and the event
    // receiver's fixed 202 is not a decision; registering it would add a
    // blocking round-trip to every `/model` for a payload the probe measured
    // firing twice with inconsistent `from_model` values.
    expect(CLAUDE_PRE_MODEL_SWITCH_EVENT_NAME).toBe('PreModelSwitch');
    const settings = buildAgentHookSettings(TARGET);
    expect(settings.hooks).not.toHaveProperty(CLAUDE_PRE_MODEL_SWITCH_EVENT_NAME);
    expect(JSON.stringify(settings)).not.toContain('PreModelSwitch');
    // The fixture that motivates the omission really is a `Pre` capture.
    expect(fixture('pre-model-switch-fast-on-second.json').hook_event_name).toBe('PreModelSwitch');
  });
});

describe('no other tool learned the event (Issue #2363, 他ツール不変)', () => {
  const OTHER_TOOLS: CLIToolType[] = [
    'codex',
    'copilot',
    'opencode',
    'gemini',
    'command-code',
    'antigravity',
  ];

  it.each(OTHER_TOOLS)('%s does not map PostModelSwitch to any word', (tool) => {
    const source = getAgentEventSource(tool);
    const normalized = source.normalizeEvent({
      payload: { ...fixture('post-model-switch-command.json'), tool },
      receivedAt: 1,
    });
    expect(normalized).toBeNull();
  });

  it.each(OTHER_TOOLS)('%s does not read to_model as a model on its own events', (tool) => {
    // A `to_model` key smuggled onto an event the tool does map must not be
    // read by that tool's model extraction: the field belongs to Claude.
    const source = getAgentEventSource(tool);
    const normalized = source.normalizeEvent({
      payload: { hook_event_name: 'Stop', to_model: 'claude-sonnet-5', tool },
      event: 'stop',
      receivedAt: 1,
    });
    expect(normalized?.event).toBe('stop');
    expect(normalized?.model).toBeNull();
  });
});
