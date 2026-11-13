/**
 * Issue #4343 (PR A): the predicate of the entry refusal, its exit code, and the
 * daily prompt that reads the report it leaves.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { decideExitCode, relativeCodexHomeError } from '@/lib/agent-health/report';
import type { AgentHealthReport } from '@/lib/agent-health/types';

const ROOT = path.resolve(__dirname, '../../../..');

describe('[#4343] relativeCodexHomeError', () => {
  it.each(['rel', './rel', '../rel', 'rel/codex', ' ', '~/.codex'])('refuses the relative value %j', (value) => {
    const error = relativeCodexHomeError({ CODEX_HOME: value });
    expect(error).toContain('環境の誤り: CODEX_HOME が相対パス');
    expect(error).toContain(JSON.stringify(value));
  });

  it.each([
    ['an absolute value', { CODEX_HOME: '/home/u/.codex' }],
    ['/proc (left to buildChildEnv and the fallbacks)', { CODEX_HOME: '/proc/self/x' }],
    ['an empty value', { CODEX_HOME: '' }],
    ['an unset value', {}],
  ])('does not touch %s', (_label, env) => {
    expect(relativeCodexHomeError(env)).toBeNull();
  });

  it('does not look at CLAUDE_CONFIG_DIR', () => {
    expect(relativeCodexHomeError({ CLAUDE_CONFIG_DIR: 'rel' })).toBeNull();
  });

  it('a report carrying it decides exit 2, like an argument error', () => {
    const report: AgentHealthReport = {
      schemaVersion: 1,
      startedAt: '2026-11-13T00:00:00.000Z',
      completedAt: '2026-11-13T00:00:00.000Z',
      host: { commandmateCommit: 'x', node: 'v22' },
      tools: [],
      safety: { globalConfigRestored: [], tmuxSocket: 'cm-agent-health' },
      scriptErrors: [relativeCodexHomeError({ CODEX_HOME: 'rel' })!],
    };
    expect(decideExitCode(report)).toBe(2);
  });
});

describe('[#4343] the daily prompt reads the refusal', () => {
  const prompt = fs.readFileSync(path.join(ROOT, 'docs/agent-health/daily-triage-prompt.md'), 'utf8');

  it('treats the relative CODEX_HOME refusal as a script error and does not retry', () => {
    expect(prompt).toContain('CODEX_HOME が相対パス');
    expect(prompt).toMatch(/CODEX_HOME が相対パス[^\n]*スクリプトの異常[^\n]*再実行しない/);
  });

  it('does not guess counts when summary / coverage are missing, and says how the last line reads', () => {
    expect(prompt).toMatch(/`summary`・`coverage` が無い[^\n]*未実施[^\n]*推測しない/);
    expect(prompt).toContain('pass=- fail=- skip=- skip_kinds=-');
  });

  it('checks the report was saved by this run before reading it, and never reads an earlier same-day file', () => {
    expect(prompt).toContain('could not write the report to');
    expect(prompt).toMatch(/以前の同日[^\n]*読まない/);
  });

  it('does not claim daily.sh runs nothing on the refusal', () => {
    expect(prompt).toMatch(/daily\.sh[^\n]*同期・ロック[^\n]*対象外/);
  });
});
