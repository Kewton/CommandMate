/**
 * CLI parsing, scenario selection and fixture serialization for the detection
 * canary (Issue #1727).
 *
 * The serializer matters more than it looks: it writes TypeScript modules into
 * `tests/fixtures/canary/`, which `npx tsc --noEmit` then compiles. A missed
 * backtick or `${` in a captured frame would break the repo's type check on the
 * next run, so the escaping is pinned here.
 */

import { describe, it, expect } from 'vitest';

import { parseArgs, formatHelp } from '../../../scripts/canary/cli';
import { SCENARIOS, selectScenarios } from '../../../scripts/canary/scenarios';
import {
  escapeForTemplateLiteral,
  fixtureConstName,
  redactIdentity,
  serializeFixtureModule,
} from '../../../scripts/canary/fixtures';

describe('parseArgs', () => {
  it('defaults to running everything', () => {
    const options = parseArgs([]);
    expect(options).toMatchObject({ only: [], skip: [], json: false, mutate: false, keep: false });
  });

  it('accepts both --only a,b and --only=a,b', () => {
    expect(parseArgs(['--only', 'idle,generating']).only).toEqual(['idle', 'generating']);
    expect(parseArgs(['--only=idle']).only).toEqual(['idle']);
  });

  it('rejects unknown flags and contradictory selections', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--only', 'idle', '--skip', 'idle'])).toThrow(/both --only and --skip/);
    expect(() => parseArgs(['--only'])).toThrow(/comma-separated/);
  });

  it('documents the scenarios in --help', () => {
    const help = formatHelp(SCENARIOS.map(scenario => scenario.id));
    expect(help).toContain('--mutate');
    expect(help).toContain('idle');
  });
});

describe('selectScenarios', () => {
  it('keeps declaration order and applies --skip', () => {
    expect(selectScenarios([], ['idle']).map(s => s.id)).toEqual(
      SCENARIOS.filter(s => s.id !== 'idle').map(s => s.id)
    );
    expect(selectScenarios(['generating', 'idle'], []).map(s => s.id)).toEqual(['idle', 'generating']);
  });

  it('rejects unknown ids instead of silently running nothing', () => {
    expect(() => selectScenarios(['typo'], [])).toThrow(/unknown scenario/);
  });
});

describe('scenario definitions', () => {
  it('gives every scenario a DIFFERENT mutant expectation, so --mutate can prove non-vacuity', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.mutantExpectation.label, scenario.id).not.toBe(scenario.expectation.label);
    }
  });

  it('uses filename-safe ids (they name the fixture files)', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
    expect(new Set(SCENARIOS.map(s => s.id)).size).toBe(SCENARIOS.length);
  });
});

describe('fixture serialization', () => {
  it('escapes what would otherwise break the generated module', () => {
    expect(escapeForTemplateLiteral('a`b')).toBe('a\\`b');
    expect(escapeForTemplateLiteral('cost: ${total}')).toBe('cost: \\${total}');
    expect(escapeForTemplateLiteral('c:\\path')).toBe('c:\\\\path');
  });

  it('escapes raw control characters so the fixture stays greppable (Issue #1432)', () => {
    expect(escapeForTemplateLiteral('a\u0000b')).toBe('a\\x00b');
    expect(escapeForTemplateLiteral('esc\u001b[0m')).toBe('esc\\x1b[0m');
    // Tabs and newlines are legitimate frame content and must survive.
    expect(escapeForTemplateLiteral('a\tb\nc')).toBe('a\tb\nc');
  });

  it('redacts email addresses before a frame is committed', () => {
    expect(redactIdentity("dev.person+tag@example.org's Organization")).toBe(
      "canary@example.com's Organization"
    );
  });

  it('names the exported constant after the scenario id', () => {
    expect(fixtureConstName('askuserquestion-task-panel')).toBe('CANARY_ASKUSERQUESTION_TASK_PANEL');
  });

  it('produces a module whose header records the version and the verdict', () => {
    const module = serializeFixtureModule({
      scenarioId: 'idle',
      title: 'Idle composer right after startup',
      claudeVersion: '2.1.223 (Claude Code)',
      capturedAtIso: '2026-08-06T08:00:00.000Z',
      expectationLabel: 'status=ready reason=input_prompt',
      passed: false,
      observed: { status: 'running' },
      frame: 'line one\n❯ `tick` and ${brace}\n',
    });

    expect(module).toContain('Claude Code version : 2.1.223 (Claude Code)');
    expect(module).toContain('did NOT match the expectation');
    expect(module).toContain('export const CANARY_IDLE = `');
    expect(module).toContain('\\`tick\\`');
    expect(module).toContain('\\${brace}');
    expect(module.endsWith('`;\n')).toBe(true);
  });
});
