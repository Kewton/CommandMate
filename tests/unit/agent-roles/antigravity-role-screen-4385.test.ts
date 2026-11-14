/**
 * Issue #4385: what one Antigravity screen proves about the role, and what a
 * refusal may say. Pure functions; the driver test
 * (`tests/unit/cli-tools/antigravity-role-gate-4385.test.ts`) runs them on panes.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_ROLE_VERIFIED_VERSION,
  describeAntigravityRoleRefusal,
  findUnknownToolName,
  judgeAntigravityRoleFrame,
  statusRowNamesAgent,
} from '@/lib/agent-roles/antigravity';

const NAME = 'cm-role-abc123';
/** The row agy 1.5.8 drew with `--agent cm-role-x` (evidence/4-tui.txt), with this name. */
const WITH_ROLE = `auto · ${NAME} (Gemini 4 Hydrogen · high)  /agents`;
const WITHOUT_ROLE = 'auto · Gemini 4 Hydrogen · high';

describe('statusRowNamesAgent', () => {
  it('positive: the measured shape names the agent', () => {
    expect(statusRowNamesAgent(WITH_ROLE, NAME)).toBe(true);
  });

  it.each([
    ['no agent', WITHOUT_ROLE],
    ['a longer name', `auto · ${NAME}x (Gemini 4 Hydrogen · high)`],
    ['a name with something in front', `auto · z${NAME} (Gemini 4 Hydrogen · high)`],
    ['the name without its delimiters', `${NAME}`],
  ])('negative: %s', (_label, row) => {
    expect(statusRowNamesAgent(row, NAME)).toBe(false);
  });

  it('an empty name names nothing', () => {
    expect(statusRowNamesAgent(WITH_ROLE, '')).toBe(false);
  });
});

describe('judgeAntigravityRoleFrame', () => {
  it('a drawn screen naming the agent confirms; on the trust screen too', () => {
    expect(judgeAntigravityRoleFrame({ kind: 'input-box', statusRow: `? for shortcuts  ${WITH_ROLE}` }, NAME)).toEqual({ kind: 'confirmed' });
    expect(judgeAntigravityRoleFrame({ kind: 'trust', statusRow: WITH_ROLE }, NAME)).toEqual({ kind: 'confirmed' });
  });

  it('a drawn screen without it plainly runs without the role', () => {
    expect(judgeAntigravityRoleFrame({ kind: 'input-box', statusRow: WITHOUT_ROLE }, NAME)).toEqual({
      kind: 'not-applied',
      cause: 'role-not-selected',
    });
    expect(judgeAntigravityRoleFrame({ kind: 'trust', statusRow: '' }, NAME).kind).toBe('not-applied');
  });

  it('anything else proves nothing yet', () => {
    expect(judgeAntigravityRoleFrame({ kind: 'other', statusRow: null }, NAME)).toEqual({ kind: 'undetermined' });
  });
});

describe('findUnknownToolName', () => {
  it('reads the tool after the last launch line naming the agent', () => {
    const screen = [
      'error: unknown component: tool "old_one"',
      `$ agy --agent ${NAME}`,
      'error: unknown component: tool "swarm"',
    ].join('\n');
    expect(findUnknownToolName(screen, NAME)).toBe('swarm');
  });

  it('a name outside the tool shape is not repeated', () => {
    expect(findUnknownToolName('error: unknown component: tool "Rm -rf; x"', NAME)).toBeNull();
    expect(findUnknownToolName('nothing here', NAME)).toBeNull();
  });
});

describe('describeAntigravityRoleRefusal', () => {
  it('says what to do, the cause, the names and both versions', () => {
    const text = describeAntigravityRoleRefusal({
      cause: 'unknown-tool',
      toolName: 'swarm',
      runningVersion: '1.5.9',
      artifactName: NAME,
      artifactPath: `/h/.gemini/config/agents/${NAME}/agent.md`,
    });
    expect(text).toContain('nothing was sent');
    expect(text).toContain('Stop the session and start it again');
    expect(text).toContain('tool "swarm"');
    expect(text).toContain(`agy 1.5.9, checked on ${ANTIGRAVITY_ROLE_VERIFIED_VERSION}`);
  });

  it('a version or a tool name of another shape is not repeated', () => {
    const text = describeAntigravityRoleRefusal({ cause: 'unknown-tool', toolName: 'BAD NAME', runningVersion: 'error: ROLE_BODY' });
    expect(text).not.toContain('BAD NAME');
    expect(text).not.toContain('ROLE_BODY');
    expect(text).toContain('agy unknown');
  });
});
