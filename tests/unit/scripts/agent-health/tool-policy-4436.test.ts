/**
 * Issue #4436: agent-health runs unattended (a Schedule starts `daily.sh`), so it
 * follows the tool policy for `schedule`. Under the default declaration
 * (`personal`) antigravity is left out of the default `--tools` — no probe and no
 * `agy --version` — and an explicit `--tools antigravity` is refused (exit 2, the
 * reason in the report). The other tools, and the version-only rows of the
 * daily run, are unchanged. With `CM_ANTIGRAVITY_USAGE=api-key|enterprise` the
 * default is the six tools as before.
 *
 * Nothing real runs: the lock, the listener and the probes are mocks, and every
 * file lives under os.tmpdir() (harness from relative-codex-home-4343.test.ts).
 *
 * @vitest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_FAQ_URL,
  TOOL_POLICY_DENIED,
  USAGE_DECLARATION_ENV,
  type UsageDeclaration,
} from '@/lib/tool-policy/policy';
import { AGENT_HEALTH_TOOLS } from '@/lib/agent-health/types';
import { checksLimitedTools } from '@/lib/agent-health/coverage';
import { parseAgentHealthArgs } from '@/lib/agent-health/cli-args';

const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'cm-4436-home-'));
});

const mocks = vi.hoisted(() => ({
  acquireRunLock: vi.fn(() => ({ ok: false as const, error: 'locked by the test' })),
  listenerStart: vi.fn(async () => {
    throw new Error('the listener must not start in this test');
  }),
  probeTool: vi.fn(),
  probeLimitedTool: vi.fn(),
  readVersion: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => fakeHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('@/lib/agent-health/run-lock', () => ({ acquireRunLock: mocks.acquireRunLock }));
vi.mock('../../../../scripts/agent-health/hook-listener', () => ({
  HookListener: { start: mocks.listenerStart },
}));
vi.mock('../../../../scripts/agent-health/probe-tool', () => ({
  probeTool: mocks.probeTool,
  probeLimitedTool: mocks.probeLimitedTool,
  readVersion: mocks.readVersion,
}));

const { main } = await import('../../../../scripts/agent-health/main');
const { selectAgentHealthTools } = await import('../../../../scripts/agent-health/tool-policy-selection');

function select(argv: string[], declaration: UsageDeclaration) {
  const parsed = parseAgentHealthArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return selectAgentHealthTools(argv, parsed.options.tools, declaration);
}

describe('Issue #4436: which tools agent-health checks', () => {
  it('4436 I1: the default under personal leaves antigravity out and still counts as the daily run', () => {
    const selection = select([], 'personal');
    expect(selection).toEqual({
      ok: true,
      tools: AGENT_HEALTH_TOOLS.filter((tool) => tool !== 'antigravity'),
      refused: ['antigravity'],
    });
    // The version-only rows (gemini, vibe-local, copilot) are still read on the daily run.
    if (selection.ok) expect(checksLimitedTools([...selection.tools, ...selection.refused])).toBe(true);
  });

  it.each(['api-key', 'enterprise'] as const)('4436 I2: the default with %s is the six tools as before', (declaration) => {
    expect(select([], declaration)).toEqual({ ok: true, tools: [...AGENT_HEALTH_TOOLS], refused: [] });
  });

  it.each([['--tools', 'antigravity'], ['--tools=claude,antigravity'], ['--tools', 'codex,antigravity,claude']])(
    '4436 I1: an explicit %s under personal is refused with the reason and the FAQ',
    (...argv) => {
      const selection = select(argv, 'personal');
      expect(selection.ok).toBe(false);
      if (!selection.ok) {
        expect(selection.error).toContain('antigravity');
        expect(selection.error).toContain(TOOL_POLICY_DENIED);
        expect(selection.error).toContain(ANTIGRAVITY_FAQ_URL);
        expect(selection.error).toContain(USAGE_DECLARATION_ENV);
      }
    }
  );

  it('4436 I2: an explicit --tools antigravity with api-key is accepted as before', () => {
    expect(select(['--tools', 'antigravity'], 'api-key')).toEqual({ ok: true, tools: ['antigravity'], refused: [] });
  });

  it.each(['personal', 'api-key'] as const)('4436 I3: an explicit --tools of other tools is unchanged (%s)', (declaration) => {
    expect(select(['--tools', 'codex,claude'], declaration)).toEqual({ ok: true, tools: ['claude', 'codex'], refused: [] });
  });
});

describe('Issue #4436: main follows the selection', () => {
  let dir: string;
  let stderr: string[];
  const savedDeclaration = process.env[USAGE_DECLARATION_ENV];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4436-main-'));
    stderr = [];
    vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    for (const mock of Object.values(mocks)) mock.mockClear();
    delete process.env[USAGE_DECLARATION_ENV];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedDeclaration === undefined) delete process.env[USAGE_DECLARATION_ENV];
    else process.env[USAGE_DECLARATION_ENV] = savedDeclaration;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(fakeHome, '.commandmate'), { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('4436 I1/I8: --tools antigravity exits 2 before the lock, with the refusal in the report; nothing is launched', async () => {
    const out = path.join(dir, 'report.json');
    const code = await main(['--tools', 'antigravity', '--out', out, '--state', path.join(dir, 'state.json')]);

    expect(code).toBe(2);
    expect(mocks.acquireRunLock).not.toHaveBeenCalled();
    expect(mocks.readVersion).not.toHaveBeenCalled();
    expect(mocks.probeTool).not.toHaveBeenCalled();
    const report = JSON.parse(fs.readFileSync(out, 'utf8')) as { tools: unknown[]; scriptErrors: string[] };
    expect(report.tools).toEqual([]);
    expect(report.scriptErrors).toHaveLength(1);
    expect(report.scriptErrors[0]).toContain(TOOL_POLICY_DENIED);
    expect(report.scriptErrors[0]).toContain(ANTIGRAVITY_FAQ_URL);
  });

  it('4436 I1: the default run says antigravity is not checked and why', async () => {
    const code = await main(['--out', path.join(dir, 'report.json'), '--state', path.join(dir, 'state.json')]);

    expect(code).toBe(2); // the test's lock refuses the run
    expect(mocks.readVersion).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain(`antigravity: not checked — ${TOOL_POLICY_DENIED}`);
  });

  it('4436 I2: with CM_ANTIGRAVITY_USAGE=api-key the default run does not mention a refusal', async () => {
    process.env[USAGE_DECLARATION_ENV] = 'api-key';
    await main(['--out', path.join(dir, 'report.json'), '--state', path.join(dir, 'state.json')]);
    expect(stderr.join('')).not.toContain(TOOL_POLICY_DENIED);
  });
});
