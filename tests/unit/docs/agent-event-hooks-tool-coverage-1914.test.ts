/**
 * The hooks guide must name every tool the registry actually injects for
 * (Issue #1914).
 *
 * `docs/user-guide/agent-event-hooks.md` claimed "automatic injection is Claude
 * only, the rest is future work" for the whole of Epic #1720 Phase 4, by which
 * point six sources were registered in `src/lib/hooks/sources/registry.ts`. The
 * damage from that sentence is not that a reader is under-informed: it is that
 * they configure a *machine-wide* file by hand (copilot's
 * `~/.copilot/settings.json`, codex's `~/.codex/hooks.json`) believing nothing
 * else writes there.
 *
 * The guard is deliberately anchored to `listAgentEventSources()` rather than to
 * a literal list of six names. A seventh source registered without a
 * documentation row is the exact failure this file exists to catch, and a
 * hard-coded list would go green through it.
 *
 * Non-vacuous by construction: every assertion below names a string that must be
 * PRESENT, and the tool ids come from the runtime registry. Deleting the
 * `opencode` row from either guide, or dropping `registerAgentEventSource`
 * for any tool, turns this red.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listAgentEventSources } from '@/lib/hooks/sources/registry';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const GUIDES: ReadonlyArray<{ lang: string; file: string }> = [
  { lang: 'ja', file: 'docs/user-guide/agent-event-hooks.md' },
  { lang: 'en', file: 'docs/en/user-guide/agent-event-hooks.md' },
];

function read(file: string): string {
  const abs = path.join(REPO_ROOT, file);
  expect(fs.existsSync(abs), `${file} is missing`).toBe(true);
  const body = fs.readFileSync(abs, 'utf-8');
  expect(body.length, `${file} is empty`).toBeGreaterThan(0);
  return body;
}

/** Registered tool ids, taken from the registry rather than restated here. */
const REGISTERED_TOOL_IDS = listAgentEventSources().map((source) => source.cliToolId);

describe('agent-event-hooks guide covers every registered source (Issue #1914)', () => {
  it('the registry really did register more than Claude', () => {
    // Guards the guard: if the import were tree-shaken or the registrations
    // moved, every per-tool assertion below would iterate an empty list and pass.
    expect(REGISTERED_TOOL_IDS).toContain('claude');
    expect(REGISTERED_TOOL_IDS.length).toBeGreaterThan(1);
  });

  it.each(GUIDES)('$lang guide has a row for every registered tool', ({ file }) => {
    const body = read(file);
    for (const toolId of REGISTERED_TOOL_IDS) {
      expect(body, `${file}: no per-tool row for "${toolId}"`).toContain(`| **${toolId}** |`);
    }
  });

  it.each(GUIDES)('$lang guide no longer says injection is Claude-only', ({ file }) => {
    const body = read(file);
    for (const stale of ['自動注入は Claude のみ', 'Automatic injection is Claude-only']) {
      expect(body, `${file} still carries the pre-#1914 claim`).not.toContain(stale);
    }
  });

  it.each(GUIDES)('$lang guide states the per-tool facts #1914 asked for', ({ file }) => {
    const body = read(file);
    const required = [
      // copilot rewrites the user's machine-wide settings file
      '~/.copilot/settings.json',
      // the hook is inert without this variable, which is what keeps a copilot
      // the operator started themselves from releasing somebody's `wait`
      'CM_AGENT_WORKTREE_ID',
      // the port travels the same way (#1904)
      'CM_HOOK_PORT',
      // copilot's decision budget, two orders of magnitude below Claude's
      '10',
      // the opt-out that turns the whole mechanism off
      'CM_AGENT_HOOKS_INJECT=0',
      // opencode is subscribed to rather than pushing
      '--port',
      'SSE',
      // codex's config.json / hooks.json distinction
      '$CODEX_HOME/hooks.json',
      // gemini is the per-worktree one
      '<worktree>/.gemini/settings.json',
      // antigravity squats in gemini's tree
      '~/.gemini/config/hooks.json',
    ];
    for (const needle of required) {
      expect(body, `${file} does not mention ${needle}`).toContain(needle);
    }
  });

  it.each(GUIDES)('$lang guide documents copilot config.json migration (#1904)', ({ file }) => {
    const body = read(file);
    expect(body, `${file} does not mention copilot's config.json`).toContain('config.json');
    // The two behaviours #1904 shipped, and the reason a reader needs both.
    expect(body.toLowerCase()).toContain('rename');
  });
});
