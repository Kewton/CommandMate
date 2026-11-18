/**
 * Issue #4458 (2): `send --model opus` — what accepts a claude alias, and what 400s.
 *
 * Findings this file pins (read from the code, not from the 11-17 report):
 *  (I1) the claude model check is a FORMAT check (`CLAUDE_MODEL_NAME_PATTERN`), not
 *       a table of ids: an alias (`opus`, `sonnet`, `haiku`, `opus[1m]`) and a full
 *       id both pass the CLI copy, the server copy and the route's check, and the
 *       launch command passes the value to `claude --model` as typed. There is no
 *       alias table anywhere to match; a value claude itself does not know is
 *       claude's to refuse, not CommandMate's.
 *  (I2) the only 400 a well-formed value can meet is the running-session one
 *       (claude and antigravity fix the model at launch) — still refused;
 *  (I3) copilot's `--model` is never refused for a running session.
 *
 * Positive controls: a value that IS malformed (a space, a leading dash) is still
 * refused, so "everything passes" would fail here. The guide (ja・en) names the
 * aliases, checked against a throwaway copy that lacks them.
 *
 * @vitest-environment node
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateClaudeModelName as cliValidate } from '../../../../src/cli/config/model-validation';
import { validateClaudeModelName as serverValidate } from '../../../../src/lib/cmate-cli-tool-parser';
import { refuseModelOnRunningSession } from '../../../../src/app/api/worktrees/[id]/send/send-session-start';

const ALIASES = ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'];
const FULL_IDS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5@20260101'];
const root = path.resolve(__dirname, '../../../..');

describe('claude --model accepts aliases and full ids (I1)', () => {
  it.each([...ALIASES, ...FULL_IDS])('%s passes the CLI copy and the server copy', (model) => {
    expect(cliValidate(model)).toEqual({ valid: true });
    expect(serverValidate(model)).toEqual({ valid: true });
  });

  it.each(['opus 5', '-opus', 'opus;rm', '', ' '])('malformed %j is still refused (positive control)', (model) => {
    expect(cliValidate(model).valid).toBe(false);
    expect(serverValidate(model).valid).toBe(false);
  });

  it('a not-running claude session is not refused for an alias', () => {
    for (const alias of ALIASES) expect(refuseModelOnRunningSession(alias, 'claude', false)).toBeNull();
  });
});

describe('a running session still refuses --model (I2)', () => {
  it.each(['claude', 'antigravity'] as const)('%s: 400 for an alias on a running session', async (tool) => {
    const response = refuseModelOnRunningSession('opus', tool, true);
    expect(response?.status).toBe(400);
    expect(((await response?.json()) as { error: string }).error).toMatch(/can only be set when starting a new session/);
  });
});

describe('copilot is not touched (I3)', () => {
  it('copilot --model on a running session is not refused (it switches in-session)', () => {
    expect(refuseModelOnRunningSession('gpt-5', 'copilot', true)).toBeNull();
    expect(refuseModelOnRunningSession('gpt-5', 'copilot', false)).toBeNull();
  });
});

describe('the guide names what claude takes (ja・en)', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The `--model` row of the options table, or undefined. */
  const modelRow = (text: string): string | undefined => text.split('\n').find((l) => l.startsWith('| `--model <model>` |'));
  const namesAliases = (row: string | undefined): boolean =>
    Boolean(row && /`sonnet`/.test(row) && /`opus`/.test(row) && /`opus\[1m\]`/.test(row) && /400/.test(row));

  it.each([
    'docs/user-guide/cli-operations-guide.md',
    'docs/en/user-guide/cli-operations-guide.md',
  ])('%s: the --model row names the aliases and the 400', (file) => {
    expect(namesAliases(modelRow(fs.readFileSync(path.join(root, file), 'utf8')))).toBe(true);
  });

  it('positive control: a copy of the row without the aliases fails the check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmate-4458-'));
    tmps.push(dir);
    const file = path.join(dir, 'guide.md');
    fs.writeFileSync(file, '| `--model <model>` | model (copilot / antigravity / claude) |\n');
    expect(namesAliases(modelRow(fs.readFileSync(file, 'utf8')))).toBe(false);
  });
});
