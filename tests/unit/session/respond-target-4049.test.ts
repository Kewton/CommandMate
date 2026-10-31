/**
 * Issue #4049 (item 1): the `respond` a guidance sentence names reaches the
 * tool an `--agent`-only request named.
 *
 * #4031 added ` --instance <id>` when the request named an instance. A request
 * that named only a tool other than the worktree default (`send … --agent
 * codex` on a claude worktree) still got a bare `commandmate respond <id>
 * <answer>`, which the CLI resolves to the default tool.
 *
 * Positive: ` --agent codex` in the PROMPT_WAITING refusal (both layers) and in
 * the structured question. Negative: a request that named nothing, or the
 * default tool, gets exactly the sentence it had; an instance still wins.
 * Also pinned here: what "the default" is (`resolveSessionTarget` with nothing
 * named) and that `--instance <tool>` reaches the same session as `--agent
 * <tool>` alone — the fact the strict respond's `prompt` hint (item 2) uses.
 *
 * The DB is in memory; nothing on disk is touched.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { respondAgentFor, respondTargetFlags } from '@/lib/session/respond-target';
import { promptWaitingMessage } from '@/lib/session/prompt-waiting-guard';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  buildStructuredPromptQuestion,
  STRUCTURED_DECISION_OPTIONS,
} from '@/lib/session/structured-prompt';
import { resolveSessionTarget, resolveSessionTargetStrict } from '@/lib/session/resolve-session-target';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-4049';
const FACTS = { source: 'notification' as const, message: 'touch /tmp/marker.txt', toolName: 'bash' };

describe('[#4049] respondTargetFlags', () => {
  it('an instance wins over a tool (the CLI\'s targetFlags order)', () => {
    expect(respondTargetFlags('codex-2', 'codex')).toBe(' --instance codex-2');
  });
  it('positive: a tool alone — ` --agent <tool>`', () => {
    expect(respondTargetFlags(undefined, 'codex')).toBe(' --agent codex');
  });
  it('negative: nothing — no flag', () => {
    expect(respondTargetFlags()).toBe('');
  });
});

describe('[#4049] respondAgentFor', () => {
  it('positive: an explicit tool other than the default is named', () => {
    expect(respondAgentFor('codex', undefined, 'claude')).toBe('codex');
  });
  it('negative: the default tool named explicitly is not', () => {
    expect(respondAgentFor('claude', undefined, 'claude')).toBeUndefined();
  });
  it('negative: no tool named is not', () => {
    expect(respondAgentFor(undefined, undefined, 'claude')).toBeUndefined();
  });
  it('negative: an instance was named — the instance carries it', () => {
    expect(respondAgentFor('codex', 'codex-2', 'claude')).toBeUndefined();
  });
});

describe('[#4049] promptWaitingMessage names the tool', () => {
  it('positive: scraper refusal after `--agent codex`', () => {
    expect(promptWaitingMessage(WT, 'scraper', undefined, 'codex')).toContain(
      `\`commandmate respond ${WT} <answer> --agent codex\``,
    );
  });

  it('positive: structured refusal — the respond and the bypass send', () => {
    const text = promptWaitingMessage(WT, 'structured', undefined, 'codex');
    expect(text).toContain(`\`commandmate respond ${WT} <answer> --agent codex\``);
    expect(text).toContain(`\`commandmate send ${WT} <message> --agent codex --ignore-structured-prompt\``);
  });

  it('negative: no tool — the sentence is identical to before', () => {
    for (const layer of [undefined, 'scraper', 'structured'] as const) {
      expect(promptWaitingMessage(WT, layer, undefined, undefined)).toBe(promptWaitingMessage(WT, layer));
      expect(promptWaitingMessage(WT, layer)).not.toContain('--agent');
    }
    expect(promptWaitingMessage(WT)).toBe(
      `${WT} is waiting on a prompt. Sending now would type into the prompt's input line instead of ` +
        `reaching the agent, and would leave that text in place for the next answer. Answer the prompt ` +
        `first: \`commandmate respond ${WT} <answer>\`.`,
    );
  });

  it('an instance still names the instance only', () => {
    const text = promptWaitingMessage(WT, 'structured', 'codex-2', 'codex');
    expect(text).toContain('--instance codex-2');
    expect(text).not.toContain('--agent');
  });
});

describe('[#4049] structured prompt questions name the tool', () => {
  const PLACES = [
    ['the screen dialog', (agent?: CLIToolType) => buildStructuredPromptQuestion(WT, FACTS, undefined, agent)],
    [
      'the decision verdicts',
      (agent?: CLIToolType) =>
        buildStructuredPromptQuestion(WT, { ...FACTS, decisionOptions: STRUCTURED_DECISION_OPTIONS }, undefined, agent),
    ],
  ] as const;

  it.each(PLACES)('positive: %s — `--agent codex`', (_name, build) => {
    expect(build('codex')).toContain(`\`commandmate respond ${WT} <number> --agent codex\``);
  });

  it.each(PLACES)('negative: %s — no tool, the sentence as before', (_name, build) => {
    expect(build(undefined)).toBe(build());
    expect(build(undefined)).not.toContain('--agent');
  });

  it('the live payload and the history row carry the same question', () => {
    expect(buildStructuredPromptData(WT, FACTS, undefined, 'codex').question).toBe(
      buildStructuredPromptQuestion(WT, FACTS, undefined, 'codex'),
    );
    expect(buildStructuredPromptHistoryRecord(WT, FACTS, undefined, 'codex').question).toBe(
      buildStructuredPromptQuestion(WT, FACTS, undefined, 'codex'),
    );
  });
});

describe('[#4049] the resolution the guidance relies on', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    upsertWorktree(db, {
      id: WT,
      name: WT,
      path: `/path/to/${WT}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('a request naming nothing resolves to the worktree default (what a bare respond reaches)', () => {
    const unqualified = resolveSessionTargetStrict(db, WT, {});
    expect(unqualified.ok && unqualified.target.cliToolId).toBe('claude');
  });

  it('`--instance codex` reaches the session `--agent codex` alone does (no roster row)', () => {
    const byAgent = resolveSessionTarget(db, WT, { requestedCliTool: 'codex' });
    const byInstance = resolveSessionTarget(db, WT, { instanceId: 'codex' });
    expect({ cliToolId: byInstance.cliToolId, instanceId: byInstance.instanceId }).toEqual({
      cliToolId: byAgent.cliToolId,
      instanceId: byAgent.instanceId,
    });
    expect(byInstance).toMatchObject({ cliToolId: 'codex', instanceId: 'codex' });
  });

  it('`--instance codex` reaches the session `--agent codex` alone does (with a roster row)', () => {
    setAgentInstances(db, WT, [{ id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 }]);
    const byAgent = resolveSessionTarget(db, WT, { requestedCliTool: 'codex' });
    const byInstance = resolveSessionTarget(db, WT, { instanceId: 'codex' });
    expect(byInstance).toMatchObject({ cliToolId: byAgent.cliToolId, instanceId: byAgent.instanceId });
  });
});
