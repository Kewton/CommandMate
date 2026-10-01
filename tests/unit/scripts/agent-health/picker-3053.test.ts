/**
 * Issue #3053: the pickers `screen-picker` opens (tool-table.ts) and the keys
 * the probe may send to them.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/ansi';
import { CLAUDE_SELECTION_LIST_FOOTER, CODEX_SELECTION_LIST_PATTERN } from '@/lib/detection/cli-patterns';
import { AGENT_HEALTH_TOOLS } from '@/lib/agent-health/types';
import {
  CLAUDE_EFFORT_PICKER_OPEN,
  CLAUDE_MODEL_PICKER_OPEN,
  CODEX_MODEL_PICKER_OPEN,
  TOOL_PROBE_SPECS,
} from '../../../../scripts/agent-health/tool-table';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'agent-health-picker-3053');
const fixture = (name: string) => stripAnsi(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('tool-table pickers', () => {
  it('claude opens /model and /effort, codex /model only, the rest none', () => {
    expect(TOOL_PROBE_SPECS.claude.picker?.screens.map((s) => s.command)).toEqual(['/model', '/effort']);
    expect(TOOL_PROBE_SPECS.codex.picker?.screens.map((s) => s.command)).toEqual(['/model']);
    for (const tool of AGENT_HEALTH_TOOLS.filter((t) => t !== 'claude' && t !== 'codex')) {
      expect(TOOL_PROBE_SPECS[tool].picker).toBeUndefined();
    }
  });

  it('closes every picker with Esc', () => {
    expect(TOOL_PROBE_SPECS.claude.picker?.closeKey).toBe('Escape');
    expect(TOOL_PROBE_SPECS.codex.picker?.closeKey).toBe('Escape');
  });

  it('watches the settings each picker writes', () => {
    const claude = TOOL_PROBE_SPECS.claude.picker!.settings();
    expect(claude.path.endsWith(path.join('.claude', 'settings.json'))).toBe(true);
    expect(claude).toMatchObject({ format: 'json', keys: ['model', 'effortLevel'] });
    const codex = TOOL_PROBE_SPECS.codex.picker!.settings();
    expect(path.basename(codex.path)).toBe('config.toml');
    expect(codex).toMatchObject({ format: 'toml', keys: ['model', 'model_reasoning_effort'] });
  });

  it.each([
    ['claude-model.txt', CLAUDE_MODEL_PICKER_OPEN],
    ['claude-effort.txt', CLAUDE_EFFORT_PICKER_OPEN],
    ['codex-model.txt', CODEX_MODEL_PICKER_OPEN],
  ])('the "opened" text is on the real picker (%s)', (file, pattern) => {
    expect(pattern.test(fixture(file))).toBe(true);
  });

  it('the "opened" text is not the detector\'s footer', () => {
    const footers = [
      'Enter to set as default · s to use this session only · Esc to cancel',
      '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel',
      'enter select · esc back',
      'Press enter to confirm or esc to go back',
    ];
    for (const pattern of [CLAUDE_MODEL_PICKER_OPEN, CLAUDE_EFFORT_PICKER_OPEN, CODEX_MODEL_PICKER_OPEN]) {
      for (const footer of footers) expect(pattern.test(footer)).toBe(false);
      expect(pattern.source).not.toBe(CLAUDE_SELECTION_LIST_FOOTER.source);
      expect(pattern.source).not.toBe(CODEX_SELECTION_LIST_PATTERN.source);
    }
  });

  it('the "opened" text is not on the closed screen (what the picker leaves behind)', () => {
    const closed = ['❯ /model', '  ⎿  Kept model as Haiku 4.5', '❯ /effort', '  ⎿  Cancelled', '❯ '].join('\n');
    expect(CLAUDE_MODEL_PICKER_OPEN.test(closed)).toBe(false);
    expect(CLAUDE_EFFORT_PICKER_OPEN.test(closed)).toBe(false);
    expect(CODEX_MODEL_PICKER_OPEN.test('│ model:     gpt-5.6-sol xhigh   /model to change │')).toBe(false);
  });
});

describe('keys sent while a picker may be up (probe-tool.ts)', () => {
  it('only the command\'s one Enter and the close key', () => {
    const source = fs.readFileSync(path.join(REPO, 'scripts', 'agent-health', 'probe-tool.ts'), 'utf8');
    const start = source.indexOf('async pickerTurn(');
    const end = source.indexOf('async start(', start);
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, end);
    const sent = [...body.matchAll(/sendKey\(this\.name, ([^)]+)\)/g)].map((m) => m[1]);
    expect(sent).toEqual(["'Enter'", 'closeKey']);
    expect(body).not.toMatch(/submit\(|pasteText\(/);
  });
});
