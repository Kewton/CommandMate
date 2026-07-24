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
  '| `/agents` | {/* min-version: 2.1.198 */}As of v2.1.198, running `/agents` prints a reminder |',
  '| `/code-review [low\\|high]` | **[Skill](/docs/en/skills).** Review the current diff for correctness bugs |',
  '| `/loop` | Run a prompt repeatedly while the session stays open |',
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
      'loop',
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

  it('returns an empty array for input with no table (never throws)', () => {
    expect(parseClaudeCommandsDoc('no table here')).toEqual([]);
    expect(parseClaudeCommandsDoc('')).toEqual([]);
  });
});
