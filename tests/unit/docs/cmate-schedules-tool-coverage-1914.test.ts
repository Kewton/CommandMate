/**
 * The CMATE schedules guide must list every CLI tool the parser accepts
 * (Issue #1914).
 *
 * The guide's "CLI Tool" column documented five of the seven ids in
 * `CLI_TOOL_IDS`, so `opencode` and `antigravity` looked unsupported while the
 * parser accepted both. A reader who believes the guide either does not use
 * them or — worse — copies claude's `acceptEdits` into the Permission cell of an
 * opencode row, which is the behaviour this Issue also fixed.
 *
 * Anchored to `CLI_TOOL_IDS` rather than to a literal list, so adding an eighth
 * tool without touching the guide is what turns this red.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { TOOLS_WITH_MODEL_SUPPORT } from '@/lib/cmate-cli-tool-parser';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const GUIDES: ReadonlyArray<{ lang: string; file: string }> = [
  { lang: 'ja', file: 'docs/user-guide/cmate-schedules-guide.md' },
  { lang: 'en', file: 'docs/en/user-guide/cmate-schedules-guide.md' },
];

function read(file: string): string {
  const abs = path.join(REPO_ROOT, file);
  expect(fs.existsSync(abs), `${file} is missing`).toBe(true);
  const body = fs.readFileSync(abs, 'utf-8');
  expect(body.length, `${file} is empty`).toBeGreaterThan(0);
  return body;
}

describe('CMATE schedules guide covers every CLI tool (Issue #1914)', () => {
  it('CLI_TOOL_IDS really carries more than the five the guide used to list', () => {
    // Guards the guard: an empty or truncated constant would make every
    // per-tool assertion below vacuous.
    expect(CLI_TOOL_IDS.length).toBeGreaterThanOrEqual(7);
    expect(CLI_TOOL_IDS).toContain('opencode');
    expect(CLI_TOOL_IDS).toContain('antigravity');
  });

  it.each(GUIDES)('$lang guide names every CLI tool id', ({ file }) => {
    const body = read(file);
    for (const toolId of CLI_TOOL_IDS) {
      expect(body, `${file} never mentions \`${toolId}\``).toContain(`\`${toolId}\``);
    }
  });

  it.each(GUIDES)('$lang guide states that opencode has no permission flags', ({ file }) => {
    const body = read(file);
    // The section heading added by this Issue, plus the Issue reference that
    // explains why an existing CMATE.md may start reporting an error.
    expect(body).toContain('### opencode');
    expect(body).toContain('#1914');
  });

  it.each(GUIDES)('$lang guide documents antigravity permissions', ({ file }) => {
    const body = read(file);
    expect(body).toContain('--dangerously-skip-permissions');
  });
});
/**
 * The `--model` half of the CLI Tool column (Issue #1914, second commit).
 *
 * `TOOLS_WITH_MODEL_SUPPORT` is what decides whether `<tool> --model <name>`
 * parses at all; a tool added there without a section in the guide is a feature
 * nobody can find, and a tool removed from it leaves the guide promising syntax
 * that now skips the whole schedule row. Anchored to the Set for that reason.
 */
describe('CMATE schedules guide documents --model for exactly the supported tools (Issue #1914)', () => {
  it('the Set has more than one member', () => {
    // Guards the guard: with one member the loop would say nothing about opencode.
    expect(TOOLS_WITH_MODEL_SUPPORT.size).toBeGreaterThan(1);
    expect(TOOLS_WITH_MODEL_SUPPORT.has('opencode')).toBe(true);
  });

  it.each(GUIDES)('$lang guide shows `<tool> --model` for every supporting tool', ({ file }) => {
    const body = read(file);
    for (const toolId of TOOLS_WITH_MODEL_SUPPORT) {
      expect(body, `${file} never shows \`${toolId} --model\``).toContain(`${toolId} --model`);
    }
  });

  it.each(GUIDES)('$lang guide states opencode takes provider/model, not a bare name', ({ file }) => {
    const body = read(file);
    expect(body).toContain('provider/model');
    // The prefix that used to be synthesised. The guide has to say it is gone,
    // because the only place a reader could otherwise learn it is the diff.
    expect(body).toContain('ollama/');
  });

  it.each(GUIDES)('$lang guide does not claim opencode has no flags at all', ({ file }) => {
    const body = read(file);
    // Measured on opencode 1.18.21: `opencode run` has a boolean `--auto`.
    // "No permission *level*" is true; "no permission flag at all" is not.
    expect(body).not.toContain('the opencode CLI has no permission flag at all');
    expect(body).not.toContain('opencode CLI に許可レベルのフラグが存在しないためで');
    // Quoted from `opencode run --help`, so the assertion cannot be satisfied by
    // an unrelated string that merely starts with `--auto`.
    expect(body).toContain('auto-approve permissions that are not explicitly denied');
  });
});
