/**
 * Issue #4034 (item 3): the model-auth section of the agent-health guide names
 * the per-tool refusal rows (#3994), not only opencode's `Error: Unauthorized`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_CODE_MODEL_AUTH_FAILURE_ROWS } from '@/lib/agent-health/model-auth';

const guide = fs.readFileSync(path.join(process.cwd(), 'docs/user-guide/agent-health.md'), 'utf-8');
const start = guide.indexOf('### モデルの認可エラー');
const section = guide.slice(start, guide.indexOf('\n### ', start + 1));

describe('[#4034] agent-health.md: モデルの認可エラー', () => {
  it('has the section', () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it('names the command-code rows and the definition they come from', () => {
    expect(COMMAND_CODE_MODEL_AUTH_FAILURE_ROWS).toHaveLength(2);
    expect(section).toContain('modelAuthFailureRows');
    expect(section).toContain('command-code');
    expect(section).toContain('Authentication failed');
    expect(section).toContain("Invalid 'Authorization'");
  });

  it('names the conditions of screen-approval and the hooks hook-correlation', () => {
    expect(section).toContain('screen-approval');
    expect(section).toContain('session_start');
    expect(section).toContain('`stop`');
  });

  it('says tools without a definition are out of scope', () => {
    expect(section).toMatch(/定義の無いツール[\s\S]*対象外/);
    for (const tool of ['claude', 'codex', 'antigravity']) expect(section).toContain(tool);
  });
});
