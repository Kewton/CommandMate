/**
 * The seam that made `opencode run -m …` unreachable (Issue #1914).
 *
 * `claude-executor.buildCliArgs()` has had a `case 'opencode'` that appends
 * `-m <model>` since Issue #379, and it had never executed. Two independent
 * gates kept it dark:
 *
 *  - `job-executor.resolveModelOption()` answered `undefined` for every tool but
 *    copilot and vibe-local, so the schedule path never supplied `options.model`;
 *  - the only other caller, `daily-summary-generator`, is gated by
 *    `SUMMARY_ALLOWED_TOOLS`, which lists claude / codex / copilot / antigravity.
 *
 * A dead branch is not a neutral thing here: it read as "opencode model
 * selection is implemented", and it carried an `ollama/` prefix that nobody
 * could have observed being wrong.
 *
 * These tests are about the *seam*, not about either function alone. The
 * per-function assertions would both stay green if `resolveModelOption()` went
 * back to hard-coding `'copilot'` — it is the round trip below, from a
 * `ScheduleEntry` to the argv that `execFile` receives, that catches it.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { resolveModelOption } from '@/lib/job-executor';
import { buildCliArgs } from '@/lib/session/claude-executor';
import { TOOLS_WITH_MODEL_SUPPORT } from '@/lib/cmate-cli-tool-parser';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import type { ScheduleEntry } from '@/types/cmate';

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    name: 'task',
    cronExpression: '0 9 * * *',
    message: 'do something',
    cliToolId: 'claude',
    enabled: true,
    permission: '',
    ...overrides,
  };
}

/** The DB row shape `resolveModelOption` reads `vibe_local_model` from. */
const NO_DB_MODEL = { path: '/repo/wt', vibe_local_model: null };

describe('resolveModelOption reads TOOLS_WITH_MODEL_SUPPORT (Issue #1914)', () => {
  it('the Set really has more than one member', () => {
    // Guards the guard: a Set of one would make the loops below say nothing
    // about opencode.
    expect(TOOLS_WITH_MODEL_SUPPORT.size).toBeGreaterThan(1);
    expect(TOOLS_WITH_MODEL_SUPPORT.has('opencode')).toBe(true);
    expect(TOOLS_WITH_MODEL_SUPPORT.has('copilot')).toBe(true);
  });

  it.each([...TOOLS_WITH_MODEL_SUPPORT])(
    '%s: a model on the entry reaches ExecuteCommandOptions',
    (cliToolId) => {
      const options = resolveModelOption(
        entry({ cliToolId, model: 'ollama/qwen3:8b' }),
        NO_DB_MODEL
      );
      expect(options).toEqual({ model: 'ollama/qwen3:8b' });
    }
  );

  it.each(CLI_TOOL_IDS.filter((id) => !TOOLS_WITH_MODEL_SUPPORT.has(id)))(
    '%s: a model on the entry is not forwarded (the column does not accept one)',
    (cliToolId) => {
      expect(resolveModelOption(entry({ cliToolId, model: 'x/y' }), NO_DB_MODEL)).toBeUndefined();
    }
  );

  it('vibe-local still takes its model from the DB, not from the entry', () => {
    expect(
      resolveModelOption(entry({ cliToolId: 'vibe-local' }), {
        path: '/repo/wt',
        vibe_local_model: 'qwen3:8b',
      })
    ).toEqual({ model: 'qwen3:8b' });
  });

  it('no model anywhere means no options object', () => {
    expect(resolveModelOption(entry({ cliToolId: 'opencode' }), NO_DB_MODEL)).toBeUndefined();
    expect(resolveModelOption(entry({ cliToolId: 'copilot' }), NO_DB_MODEL)).toBeUndefined();
  });
});

describe('the CMATE.md model reaches argv (Issue #1914)', () => {
  /**
   * The reachability proof. Before this Issue the opencode row produced
   * `['run', 'do something']` — the `-m` branch was never taken — so the
   * assertion below is exactly what was impossible.
   */
  it.each([
    ['opencode', 'ollama/qwen3:8b', ['run', '-m', 'ollama/qwen3:8b', 'do something']],
    ['opencode', 'anthropic/claude-sonnet-4-5', ['run', '-m', 'anthropic/claude-sonnet-4-5', 'do something']],
  ])('%s + %s', (cliToolId, model, expected) => {
    const e = entry({ cliToolId, model });
    const options = resolveModelOption(e, NO_DB_MODEL);
    expect(options, 'resolveModelOption dropped the model').toBeDefined();
    expect(buildCliArgs(e.message, e.cliToolId, e.permission, options)).toEqual(expected);
  });

  it('copilot keeps its pre-#1914 argv', () => {
    const e = entry({ cliToolId: 'copilot', model: 'gpt-5', permission: 'allow-all-tools' });
    const options = resolveModelOption(e, NO_DB_MODEL);
    expect(buildCliArgs(e.message, e.cliToolId, e.permission, options)).toEqual([
      'copilot',
      '--model',
      'gpt-5',
      '-p',
      'do something',
      '--allow-all-tools',
    ]);
  });

  it('vibe-local keeps its pre-#1914 argv', () => {
    const e = entry({ cliToolId: 'vibe-local' });
    const options = resolveModelOption(e, { path: '/repo/wt', vibe_local_model: 'qwen3:8b' });
    expect(buildCliArgs(e.message, e.cliToolId, e.permission, options)).toEqual([
      '--model',
      'qwen3:8b',
      '-p',
      'do something',
      '-y',
    ]);
  });

  it('an opencode schedule with no model still launches bare', () => {
    const e = entry({ cliToolId: 'opencode' });
    const options = resolveModelOption(e, NO_DB_MODEL);
    expect(buildCliArgs(e.message, e.cliToolId, e.permission, options)).toEqual([
      'run',
      'do something',
    ]);
  });

  it('the ollama/ prefix is gone from every opencode argv', () => {
    for (const model of ['ollama/qwen3:8b', 'anthropic/claude-sonnet-4-5', 'github-copilot/gpt-5']) {
      const e = entry({ cliToolId: 'opencode', model });
      const args = buildCliArgs(e.message, e.cliToolId, e.permission, resolveModelOption(e, NO_DB_MODEL));
      // Exactly one occurrence of the value, and no synthesised provider.
      expect(args.filter((a) => a === model)).toHaveLength(1);
      expect(args.some((a) => a.startsWith('ollama/') && a !== model)).toBe(false);
    }
  });
});
