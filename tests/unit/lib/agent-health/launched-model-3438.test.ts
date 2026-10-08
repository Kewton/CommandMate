/**
 * Issue #3438: the report says which model each probed tool was launched on.
 *
 * A pass keeps no evidence, so before this a passing opencode-v2 could not be
 * told apart from one that started on the wrong model (#3428). The screen is
 * read with real frames the daily probe captured (`opencode-agent-health-3021/`,
 * `-3420/`, `model-info-captures.ts`), hooks with the recorded payloads under
 * `tests/fixtures/hooks/`, and a report written before #3438 must still read.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildCoverage, summarizeCoverage } from '@/lib/agent-health/coverage';
import {
  UNKNOWN_LAUNCHED_MODEL,
  laterScreenModel,
  launchedModelLabel,
  readHookModel,
  readScreenModel,
  readSeededModel,
  resolveLaunchedModel,
} from '@/lib/agent-health/launched-model';
import { buildToolResult } from '@/lib/agent-health/report';
import {
  AGENT_HEALTH_CHECK_IDS,
  AGENT_HEALTH_TOOLS,
  type AgentHealthReport,
  type AgentHealthToolResult,
} from '@/lib/agent-health/types';
import {
  ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI,
  CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232,
  CODEX_FOOTER_CAPTURE_V0_147_ANSI,
} from '../../../fixtures/model-info-captures';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const frame = (dir: string, file: string) => fs.readFileSync(path.join(FIXTURES, dir, file), 'utf8');
const hookPayload = (tool: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'hooks', tool, file), 'utf8')) as Record<string, unknown>;

describe('readScreenModel — real probe frames', () => {
  it('opencode 1.18.33: the `▣  Build · <model>` step row (raw ANSI capture)', () => {
    expect(readScreenModel('opencode', frame('opencode-agent-health-3021', 'running-turn-sleep.txt'))).toEqual({
      model: 'Claude Sonnet 5.5',
      source: 'screen',
    });
  });

  it('opencode 1.18.33: the model the error turn ran on (the report evidence of 2026-09-30)', () => {
    expect(readScreenModel('opencode', frame('opencode-agent-health-3021', 'model-error-running-turn.txt'))).toEqual({
      model: 'Qwen3 Coder 30B',
      source: 'screen',
    });
  });

  it('opencode-v2 2.0.18: the step row without `▣` (raw ANSI capture of 2026-10-08)', () => {
    expect(readScreenModel('opencode-v2', frame('opencode-agent-health-3420', 'unauthorized-running-turn.txt'))).toEqual({
      model: 'Mistral Large 4',
      source: 'screen',
    });
    expect(
      readScreenModel('opencode-v2', frame('opencode-agent-health-3420', 'unauthorized-quoted-after-running-turn.txt'))
    ).toEqual({ model: 'Mistral Large 4', source: 'screen' });
  });

  it('opencode: with no step row yet, the composer bar is kept whole, provider included', () => {
    const lines = frame('opencode-agent-health-3021', 'running-turn-sleep.txt').split('\n');
    // The same frame before any step row was drawn: drop the step row only.
    const idle = lines.filter((line) => !line.includes('▣')).join('\n');
    expect(readScreenModel('opencode', idle)).toEqual({
      model: 'Claude Sonnet 5.5 GitHub Copilot',
      source: 'screen-footer',
    });
    const v2 = frame('opencode-agent-health-3420', 'unauthorized-quoted-after-running-turn.txt')
      .split('\n')
      .filter((line) => !/·\s+\d+ms\s*$/.test(line))
      .join('\n');
    expect(readScreenModel('opencode-v2', v2)).toEqual({ model: 'Mistral Large 4 Ollama Cloud', source: 'screen-footer' });
  });

  it('claude / codex / antigravity go through the production reader', () => {
    expect(readScreenModel('claude', CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232)?.model).toBe('Opus 5 (1M context)');
    expect(readScreenModel('codex', CODEX_FOOTER_CAPTURE_V0_147_ANSI)?.model).toBe('gpt-5.6-sol');
    expect(readScreenModel('antigravity', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI)?.model).toBe('Gemini 3.7 Flash');
  });

  it('a frame that shows no model answers null, not a guess', () => {
    expect(readScreenModel('claude', '❯ \n  ? for shortcuts')).toBeNull();
    expect(readScreenModel('opencode', '')).toBeNull();
    expect(readScreenModel('gemini', CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232)).toBeNull();
  });
});

describe('laterScreenModel', () => {
  it('a step row is not replaced by the composer bar; a newer step row is', () => {
    const step = { model: 'A', source: 'screen' as const };
    const bar = { model: 'A Provider', source: 'screen-footer' as const };
    expect(laterScreenModel(step, bar)).toBe(step);
    expect(laterScreenModel(bar, step)).toBe(step);
    expect(laterScreenModel(step, { model: 'B', source: 'screen' })).toEqual({ model: 'B', source: 'screen' });
    expect(laterScreenModel(step, null)).toBe(step);
  });
});

describe('readHookModel', () => {
  it("claude's SessionStart names the model", () => {
    const body = hookPayload('claude', 'session-start.json');
    expect(readHookModel('claude', [{ kind: 'agent-event', event: 'session_start', body }])).toBe('claude-opus-5[1m]');
  });

  it("antigravity's modelName, with the event word the relay passed", () => {
    const body = hookPayload('antigravity', 'session-start.json');
    expect(readHookModel('antigravity', [{ kind: 'agent-event', event: 'session_start', body }])).toBe(
      'gemini-3.5-flash-low'
    );
  });

  it('permission requests and payloads without a model name none', () => {
    const body = hookPayload('claude', 'session-start.json');
    expect(readHookModel('claude', [{ kind: 'permission-request', event: 'permission_request', body }])).toBeNull();
    expect(readHookModel('claude', [{ kind: 'agent-event', event: null, body: null }])).toBeNull();
    expect(readHookModel('claude', [])).toBeNull();
  });
});

describe('readSeededModel', () => {
  it("is `<providerID>/<modelID>` of model.json's recent[0]", () => {
    const text = '{"recent":[{"providerID":"github-copilot","modelID":"claude-sonnet-5.5"},{"providerID":"x","modelID":"y"}],"favorite":[],"variant":{}}';
    expect(readSeededModel(text)).toBe('github-copilot/claude-sonnet-5.5');
  });

  it('is null for no file, an empty recent, or a broken file', () => {
    expect(readSeededModel(null)).toBeNull();
    expect(readSeededModel('{"recent":[]}')).toBeNull();
    expect(readSeededModel('{not json')).toBeNull();
  });
});

describe('resolveLaunchedModel / launchedModelLabel', () => {
  it('the screen step row wins, then the hook, then the composer bar', () => {
    expect(resolveLaunchedModel({ screen: { model: 'Haiku 4.5', source: 'screen' }, hook: 'claude-haiku-4-5' })).toEqual({
      model: 'Haiku 4.5',
      source: 'screen',
    });
    expect(resolveLaunchedModel({ screen: { model: 'M P', source: 'screen-footer' }, hook: 'm' })).toEqual({
      model: 'm',
      source: 'hook',
    });
    expect(resolveLaunchedModel({ screen: { model: 'M P', source: 'screen-footer' }, hook: null })).toEqual({
      model: 'M P',
      source: 'screen-footer',
    });
  });

  it('nothing read is null (不明), with the seeded pick beside it', () => {
    const launched = resolveLaunchedModel({ screen: null, hook: null, seeded: 'ollama-cloud/mistral-large-4' });
    expect(launched).toEqual({ model: null, seeded: 'ollama-cloud/mistral-large-4' });
    expect(launchedModelLabel(launched)).toBe('不明（設定: ollama-cloud/mistral-large-4）');
  });

  it('labels say where the value came from', () => {
    expect(launchedModelLabel({ model: 'Haiku 4.5', source: 'screen' })).toBe('Haiku 4.5（画面）');
    expect(launchedModelLabel({ model: 'M P', source: 'screen-footer', seeded: 'p/m' })).toBe(
      'M P（画面下端・プロバイダ名を含む・設定: p/m）'
    );
    expect(launchedModelLabel({ model: null })).toBe(UNKNOWN_LAUNCHED_MODEL);
    expect(launchedModelLabel(undefined)).toBe('不明');
  });
});

describe('the report', () => {
  const checks = AGENT_HEALTH_CHECK_IDS.map((checkId) => ({ checkId, status: 'pass' as const, summary: 'ok' }));
  const selected = { selectedTools: [...AGENT_HEALTH_TOOLS], selectedChecks: [...AGENT_HEALTH_CHECK_IDS] };

  it('buildToolResult keeps launchedModel, and leaves it out when the tool was not launched', () => {
    const launched = { model: 'Haiku 4.5', source: 'screen' as const };
    expect(buildToolResult({ tool: 'claude', version: '1', previousVersion: null, checks, launchedModel: launched }).launchedModel).toEqual(launched);
    expect('launchedModel' in buildToolResult({ tool: 'claude', version: '1', previousVersion: null, checks })).toBe(false);
  });

  it('the summary lists every launched tool, unknown ones as 不明', () => {
    const results: AgentHealthToolResult[] = AGENT_HEALTH_TOOLS.map((tool) =>
      buildToolResult({
        tool,
        version: '1',
        previousVersion: null,
        checks,
        ...(tool === 'claude' ? { launchedModel: { model: 'Haiku 4.5', source: 'screen' as const } } : {}),
        ...(tool === 'opencode-v2' ? { launchedModel: { model: null, seeded: 'github-copilot/claude-sonnet-5.5' } } : {}),
      })
    );
    const lines = summarizeCoverage(buildCoverage({ results, ...selected }), results);
    const at = lines.indexOf('起動したモデル:');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1)).toEqual([
      '- claude: Haiku 4.5（画面）',
      '- codex: 不明',
      '- antigravity: 不明',
      '- opencode: 不明',
      '- command-code: 不明',
      '- opencode-v2: 不明（設定: github-copilot/claude-sonnet-5.5）',
    ]);
  });

  it('a report written before #3438 (no launchedModel) still reads, as 不明', () => {
    // The shape of a pre-#3438 report file: tools without the field.
    const old = JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        startedAt: '2026-10-07T22:00:00.000Z',
        completedAt: '2026-10-07T22:20:00.000Z',
        host: { commandmateCommit: 'a698d5f5a', node: 'v22' },
        tools: [{ tool: 'opencode-v2', version: '2.0.18', previousVersion: '2.0.18', versionChanged: false, checks }],
        safety: { globalConfigRestored: [], tmuxSocket: 'cm-agent-health' },
      })
    ) as AgentHealthReport;
    expect(old.tools[0].launchedModel).toBeUndefined();
    expect(launchedModelLabel(old.tools[0].launchedModel)).toBe('不明');
    const coverage = buildCoverage({ results: old.tools, selectedTools: ['opencode-v2'], selectedChecks: [...AGENT_HEALTH_CHECK_IDS] });
    expect(summarizeCoverage(coverage, old.tools)).toContain('- opencode-v2: 不明');
  });
});
