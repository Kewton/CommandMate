/**
 * A document of a worktree that an agent CLI reads as its instructions is never a
 * destination of the promote path (Issue #4225, PM review P3-8, Epic #4220 D12: a
 * decision an agent wrote is data, never an instruction to the agents after it).
 *
 * Table-driven: every row of `AGENT_INSTRUCTION_PATHS` is pinned here, and each row's
 * paths are refused both when the destination is checked (`checkDocPath`, the preview and
 * the approval) and right before the write (`writeDocBlock`). The worktrees live in a
 * `mkdtemp` directory removed after each test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { AGENT_INSTRUCTION_PATHS, agentInstructionPathOf, checkDocPath } from '@/lib/promote/destination';
import { writeDocBlock } from '@/lib/promote/doc-write';

const OP = '00000000-0000-4000-8000-000000000001';

/** The table as it stands: removing or adding a row fails here until this list says so. */
const PINNED = [
  'dir:.claude',
  'dir:.agents',
  'dir:.codex',
  'dir:.gemini',
  'dir:.agent',
  'dir:.cursor',
  'dir:.windsurf',
  'dir:.clinerules',
  'dir:.commandcode',
  'dir:.opencode',
  'file:CLAUDE.md',
  'file:CLAUDE.local.md',
  'file:AGENTS.md',
  'file:AGENTS.override.md',
  'file:GEMINI.md',
  'file:CMATE.md',
  'path:.github/copilot-instructions.md',
  'path:.github/instructions',
  'path:.github/prompts',
  'path:.github/chatmodes',
  'path:.github/skills',
  'path:.config/opencode',
];

/** The paths each row must refuse: at the root, nested, and in another case. */
function refusedPathsOf(entry: (typeof AGENT_INSTRUCTION_PATHS)[number]): string[] {
  switch (entry.match) {
    case 'dir':
      return [`${entry.name}/commands/x.md`, `packages/a/${entry.name}/x.md`, `${entry.name.toUpperCase()}/x.md`];
    case 'file':
      return [entry.name, `docs/${entry.name}`, entry.name.toLowerCase()];
    case 'path':
      return entry.name.endsWith('.md') ? [entry.name, entry.name.toUpperCase()] : [`${entry.name}/x.md`, `${entry.name.toUpperCase()}/x.md`];
  }
}

const CASES = AGENT_INSTRUCTION_PATHS.flatMap((entry) => refusedPathsOf(entry).map((rel) => [`${entry.match}:${entry.name}`, rel] as const));

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'promote-agent-instructions-4225-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Make every directory on the way, so that only the table can refuse the path. */
function makeParents(rel: string): void {
  mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
}

describe('P3-8: an agent’s instruction file is not a destination', () => {
  it('the table is the pinned one, and every row says which agent reads it', () => {
    expect(AGENT_INSTRUCTION_PATHS.map((entry) => `${entry.match}:${entry.name}`)).toEqual(PINNED);
    for (const entry of AGENT_INSTRUCTION_PATHS) expect(entry.reader.length).toBeGreaterThan(0);
  });

  it.each(CASES)('%s: %s is refused when checked (agent_instructions)', (key, rel) => {
    makeParents(rel);
    expect(`${agentInstructionPathOf(rel)?.match}:${agentInstructionPathOf(rel)?.name}`).toBe(key);
    expect(checkDocPath(root, rel)).toEqual({ ok: false, code: 'agent_instructions' });
  });

  it.each(CASES)('%s: %s is refused right before the write; nothing is made', (_key, rel) => {
    makeParents(rel);
    const outcome = writeDocBlock({ root, rel, operationId: OP, body: 'body', baseFingerprint: 'absent', leftovers: new Map() });
    expect(outcome).toEqual({ result: 'not_written', reason: 'agent_instructions', refusal: true });
    expect(existsSync(path.join(root, rel))).toBe(false);
  });

  it.each([
    'docs/claude-notes.md',
    'docs/agents/x.md',
    'docs/CLAUDE.md.md',
    'docs/my-AGENTS.md',
    'claude/x.md',
    '.github/workflows-notes.md',
    '.github/instructions.md',
    'docs/prompts/x.md',
  ])('(control) %s beside them is still a destination', (rel) => {
    makeParents(rel);
    expect(agentInstructionPathOf(rel)).toBeNull();
    expect(checkDocPath(root, rel)).toMatchObject({ ok: true, rel });
  });
});
