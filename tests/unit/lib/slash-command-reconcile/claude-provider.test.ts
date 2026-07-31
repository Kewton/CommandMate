/**
 * Tests for the claude docs-table provider parser (Issue #1489).
 *
 * The fixture mirrors the real code.claude.com/docs/en/commands.md table shape:
 * backtick-wrapped `/name [args]`, escaped pipes in args, MDX min-version notes,
 * bold Skill/Workflow badges, and Markdown links in the purpose cell.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { parseClaudeCommandsDoc } from '@/lib/slash-command-reconcile/providers/claude';

const FIXTURE = [
  '# Commands',
  '',
  'Some intro prose that is not a table.',
  '',
  '| Command | Purpose |',
  '| :------ | :------ |',
  '| `/add-dir <path>` | Add a working directory for file access during the current session. Extra sentence. |',
  '| `/advisor [model\\|off]` | Enable or disable the [advisor tool](/docs/en/advisor), which consults a second model |',
  '| `/agents` | {/* min-version: 2.1.198 */}As of v2.1.198, running `/agents` prints a reminder. {/* max-version: 2.1.197 */}On v2.1.197 and earlier, opens an interactive interface for managing [subagents](/docs/en/sub-agents) |',
  '| `/code-review [low\\|high]` | **[Skill](/docs/en/skills).** Review the current diff for correctness bugs |',
  '| `/cost` | Alias for `/usage` |',
  '| `/loop` | Run a prompt repeatedly while the session stays open |',
  '| `/pr-comments [PR]` | {/* max-version: 2.1.90 */}Removed in v2.1.91. Ask Claude directly to view pull request comments instead |',
  '| `/simplify [target]` | {/* min-version: 2.1.154 */}**[Skill](/docs/en/skills#bundled-skills).** Review the changed code for cleanup opportunities and apply the fixes. Four review agents run in parallel |',
  '| `/stats` | Alias for `/usage`. Opens on the Stats tab |',
  '| `/vim` | {/* max-version: 2.1.91 */}Removed in v2.1.92. To toggle between Vim and Normal editing modes, use `/config` |',
  '| not-a-command | this row has no slash token and must be skipped |',
  '',
  'Trailing prose after the table.',
].join('\n');

describe('parseClaudeCommandsDoc', () => {
  const commands = parseClaudeCommandsDoc(FIXTURE);
  const byName = (name: string) => commands.find((c) => c.name === name);

  it('extracts every command name, stripping the slash and argument hints', () => {
    expect(commands.map((c) => c.name)).toEqual([
      'add-dir',
      'advisor',
      'agents',
      'code-review',
      'cost',
      'loop',
      'pr-comments',
      'simplify',
      'stats',
      'vim',
    ]);
  });

  it('skips rows without a /command token', () => {
    expect(byName('not-a-command')).toBeUndefined();
  });

  it('treats an escaped pipe inside args as one cell, not a column split', () => {
    expect(byName('advisor')).toBeDefined();
    expect(byName('code-review')).toBeDefined();
  });

  it('keeps only the first sentence of the purpose', () => {
    expect(byName('add-dir')?.description).toBe(
      'Add a working directory for file access during the current session'
    );
  });

  it('resolves Markdown links to their text and drops bold Skill/Workflow badges', () => {
    expect(byName('advisor')?.description).toBe(
      'Enable or disable the advisor tool, which consults a second model'
    );
    expect(byName('code-review')?.description).toBe('Review the current diff for correctness bugs');
  });

  it('captures the MDX min-version note and removes it from the description', () => {
    const agents = byName('agents');
    expect(agents?.minVersion).toBe('2.1.198');
    expect(agents?.description).not.toContain('min-version');
    expect(agents?.description).toContain('running /agents prints a reminder');
  });

  // Issue #1603: the docs table mixes live commands with history rows and alias
  // rows. The parser labels them; refusing them is the engine's job.
  it('labels a history row with its max-version and removed status', () => {
    expect(byName('vim')).toMatchObject({ maxVersion: '2.1.91', status: 'removed' });
    expect(byName('pr-comments')).toMatchObject({ maxVersion: '2.1.90', status: 'removed' });
  });

  it('keeps a live command that merely documents its legacy behavior (/agents)', () => {
    const agents = byName('agents');
    expect(agents?.status).toBeUndefined();
    // The mid-cell max-version note describes the old behavior, not the row.
    expect(agents?.maxVersion).toBeUndefined();
    expect(agents?.minVersion).toBe('2.1.198');
  });

  it('labels an alias row with the command it points at', () => {
    expect(byName('cost')?.aliasOf).toBe('usage');
    expect(byName('stats')?.aliasOf).toBe('usage');
    // A row that only *mentions* aliases stays a normal command.
    expect(byName('loop')?.aliasOf).toBeUndefined();
  });

  // Issue #1603: an MDX note is replaced by a space, so the badge regex stopped
  // anchoring at ^ and `**[Skill](…).**` survived into the description — the
  // first-sentence split then reduced /simplify to the single word "Skill".
  it('strips the badge even when an MDX note precedes it (/simplify regression)', () => {
    const simplify = byName('simplify');
    expect(simplify?.description).toBe(
      'Review the changed code for cleanup opportunities and apply the fixes'
    );
    expect(simplify?.minVersion).toBe('2.1.154');
    expect(simplify?.kind).toBe('skill');
  });

  it('records the badge label as kind, and only for known badges', () => {
    expect(byName('code-review')?.kind).toBe('skill');
    expect(byName('add-dir')?.kind).toBeUndefined();
  });

  it('returns an empty array for input with no table (never throws)', () => {
    expect(parseClaudeCommandsDoc('no table here')).toEqual([]);
    expect(parseClaudeCommandsDoc('')).toEqual([]);
  });
});
