/**
 * Every key written into a pane through tmux is on a ledger, with its decision
 * (Issue #3981).
 *
 * ## Why
 *
 * #3945 → #3952 → #3975 widened the instance input lock to the sites the last
 * review named, and four generations running the same invariant ("keys typed
 * into a pane are ordered") came back with a counterpart left over: tmux's
 * `sendKeys` takes no ticket, anyone can call it, and nothing listed the
 * callers that do so outside the lock. This file is that list, read off the
 * source by `pane-key-writers-scan.ts`, and checked both ways.
 *
 * ## The ledger's rules (review 3)
 *
 * - One row per `{file, site, callee}`, with how many references it covers.
 *   A reference the ledger does not have — a new `sendKeys(`, also inside a
 *   wrapper whose name nobody knows — fails. A row with nothing behind it fails.
 * - `lock`: the keys go out while the writer holds a ticket. `held: 'lexical'`
 *   rows are checked in the source (the reference sits in a function passed to
 *   the lock, or one that takes a ticket), so taking the wrapper off fails here;
 *   every `lock` row names a behavioural test that runs it under the lock.
 *   `lock` rows may be added, with such a test.
 * - `decided-outside` / `kill` / `dead` are the un-ordered rows. They may only
 *   go down ({@link UNMEDIATED_BASELINE}); every `decided-outside` row names a
 *   test of the decision.
 *
 * Stage 2 (another Issue): once the un-ordered rows are 0, narrow `sendKeys`
 * to a ticket-taking API in the type system.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './route-tmux-reach';
import { candidateFiles, scanKeyWriters, scanRepository, srcFiles, type KeySite } from './pane-key-writers-scan';

type Kind = 'lock' | 'decided-outside' | 'kill' | 'dead';

interface LedgerRow {
  file: string;
  /** Innermost named function holding the reference (see the scanner). */
  site: string;
  callee: string;
  kind: Kind;
  /** For `lock`: whether the source shows the lock (`lexical`) or the caller holds it (`caller`). */
  held?: 'lexical' | 'caller';
  /** References this row covers; 1 when omitted. */
  count?: number;
  reason: string;
  /** Required for `lock` and `decided-outside`. */
  evidence?: string;
}

const LAUNCH_EVIDENCE = 'tests/unit/cli-tools/launch-lines-input-lock-3981.test.ts';
const NON_PARTICIPANTS_EVIDENCE = 'tests/unit/session/input-lock-non-participants-3952.test.ts';
const PROMPT_ANSWER_EVIDENCE = 'tests/unit/prompt-answer-sender-input-lock-3952.test.ts';
const KILL_REASON =
  'Exit keys of a stop (`requestExitAndKill` / `stopSession`): not ordered against sends, by decision (#3981, cli-operations-guide) — a stop must not queue behind the send it may be meant to end, and the session is torn down right after.';

export const LEDGER: readonly LedgerRow[] = [
  {
    file: 'src/lib/cli-tools/launch-keys.ts',
    site: 'typeLaunchLines',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'Every tool’s launch line, in one exclusive turn (#3981); joins the launcher’s own ticket inside a send.',
    evidence: LAUNCH_EVIDENCE,
  },
  {
    file: 'src/lib/session/claude-session.ts',
    site: 'sendTrustDialogKey',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'claude’s folder-trust Enter at launch, as an exclusive answer (#3975).',
    evidence: 'tests/unit/session/launch-keys-input-lock-3975.test.ts',
  },
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.waitForReady',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    count: 2,
    reason: 'codex’s launch-time update and trust digits, as answers under the lock (#3952).',
    evidence: 'tests/unit/cli-tools/codex-launch-dialog-ticket-3981.test.ts',
  },
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.sendCodexHooksScreenKey',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'caller',
    count: 2,
    reason: 'codex’s hooks-screen keys; only called from `answerCodexHooksScreen`’s `answerUnderInstanceInputLock` (#3952).',
    evidence: 'tests/unit/cli-tools/codex-hooks-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/command-code-plan-review.ts',
    site: 'sendCommandCodePlanReviewKeys',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'caller',
    reason: 'Command Code plan-review comment text; sent by the plan-review answer under the lock, ticket asked before each step (#3952).',
    evidence: 'tests/unit/api/plan-review-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/copilot.ts',
    site: 'typeLeavingMarkOnFailure',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'copilot’s own selection-list and `/model` commands, typed with the owner’s ticket (#3945).',
    evidence: 'tests/unit/cli-tools/copilot-input-lock-3945.test.ts',
  },
  {
    file: 'src/lib/cli-tools/copilot.ts',
    site: 'CopilotTool.answerFolderTrustDialog',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'copilot’s folder-trust digit at launch, as an answer under the lock (#3952).',
    evidence: 'tests/unit/cli-tools/copilot-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'sendUnderInputLock',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'A message body typed by the shared sender, ownership asserted before the key (#3945).',
    evidence: 'tests/unit/cli-tools/submit-verified-sender-input-lock-3945.test.ts',
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'sendPromptAnswerKeys',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'caller',
    reason: 'The Enter after a typed answer; inside the callback `sendAsInputWriter` runs under `answerUnderInstanceInputLock` (#3952).',
    evidence: PROMPT_ANSWER_EVIDENCE,
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'typeText',
    callee: 'sendKeys',
    kind: 'decided-outside',
    reason: 'An answer’s text. Under the writer’s lock when an Enter follows; an `answer_only` digit with no Enter is typed without waiting, by #3952’s decision.',
    evidence: PROMPT_ANSWER_EVIDENCE,
  },
  {
    file: 'src/lib/tmux/control-mode-tmux-transport.ts',
    site: 'ControlModeTmuxTransport.sendInput',
    callee: 'sendKeys',
    kind: 'decided-outside',
    reason: 'A person’s terminal input (WebSocket `terminal_input`): neither refused nor held, by #3952’s decision.',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  {
    file: 'src/lib/tmux/polling-tmux-transport.ts',
    site: 'PollingTmuxTransport.sendInput',
    callee: 'sendKeys',
    kind: 'decided-outside',
    reason: 'The same terminal input on the polling transport: neither refused nor held, by #3952’s decision.',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  { file: 'src/lib/cli-tools/gemini.ts', site: 'GeminiTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/command-code.ts', site: 'CommandCodeTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/copilot.ts', site: 'CopilotTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/opencode.ts', site: 'OpenCodeTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/opencode-v2.ts', site: 'OpenCodeV2Tool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/session-key-sender.ts', site: 'stopSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  {
    file: 'src/lib/session-key-sender.ts',
    site: 'sanitizeSessionEnvironment',
    callee: 'sendKeys',
    kind: 'dead',
    reason: 'No longer called (#3981): `startClaudeSession` types `unset CLAUDECODE` itself, in the launch line’s lock turn. Left in place (outside this Issue’s scope); removing it removes the row.',
  },
  {
    file: 'src/lib/pasted-text-helper.ts',
    site: 'detectAndResendIfPastedText',
    callee: 'sendKeys',
    kind: 'dead',
    reason: 'No module in `src` calls this helper (checked below); recorded rather than deleted, outside this Issue’s scope.',
  },
];

/**
 * How many un-ordered rows (`decided-outside` + `kill` + `dead`) the ledger
 * may hold. May only go DOWN: lower it when a row moves to `lock` or goes away.
 */
export const UNMEDIATED_BASELINE = 11;

/**
 * Out of this ledger's reach but on the same invariant, tracked for a later
 * Issue (#3981 横展開): they type through the shared sender, so they are not
 * `sendKeys` sites, but their readiness is not decided before the keys.
 */
const READINESS_FOLLOW_UPS: readonly { file: string; what: string }[] = [
  { file: 'src/lib/cli-tools/copilot.ts', what: 'the normal send drops `ready: false` from its prompt wait' },
  { file: 'src/lib/cli-tools/vibe-local.ts', what: 'no readiness wait before a send' },
  { file: 'src/lib/cli-tools/opencode.ts', what: 'the tmux fallback when no server can be attached' },
];

const LOCK_EVIDENCE = /currentInstanceInputTicket|withInstanceInputLock|answerUnderInstanceInputLock/;

const keyOf = (r: { file: string; site: string; callee: string }): string => `${r.file} :: ${r.site} :: ${r.callee}`;

/** What is wrong between the sites found and a ledger. Empty when they agree. */
export function reconcile(sites: readonly KeySite[], ledger: readonly LedgerRow[], baseline = UNMEDIATED_BASELINE): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, KeySite[]>();
  for (const site of sites) byKey.set(keyOf(site), [...(byKey.get(keyOf(site)) ?? []), site]);
  const rows = new Map(ledger.map((r) => [keyOf(r), r]));

  for (const [key, found] of byKey) {
    const row = rows.get(key);
    if (row === undefined) {
      problems.push(`not on the ledger: ${key} (lines ${found.map((s) => s.line).join(', ')})`);
      continue;
    }
    if (found.length !== (row.count ?? 1)) {
      problems.push(`count changed: ${key} has ${found.length}, the ledger says ${row.count ?? 1}`);
    }
    if (row.kind === 'lock' && row.held === 'lexical') {
      for (const site of found.filter((s) => !s.lexicallyLocked)) {
        problems.push(`no longer under the lock in the source: ${key} (line ${site.line})`);
      }
    }
  }
  for (const key of rows.keys()) {
    if (!byKey.has(key)) problems.push(`ledger row with no site behind it: ${key}`);
  }
  for (const row of ledger) {
    if (row.kind === 'lock' && row.held === undefined) problems.push(`lock row without \`held\`: ${keyOf(row)}`);
    if ((row.kind === 'lock' || row.kind === 'decided-outside') && row.evidence === undefined) {
      problems.push(`${row.kind} row without an evidence test: ${keyOf(row)}`);
    }
  }
  const unmediated = ledger.filter((r) => r.kind !== 'lock').length;
  if (unmediated > baseline) problems.push(`un-ordered rows went up: ${unmediated} > ${baseline}`);
  return problems;
}

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8');

/** The source with its comments taken out, so prose naming a function is not a use. */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('[#3981] every pane key writer in src is on the ledger', () => {
  it('the scan of src agrees with the ledger (negative control: today’s tree passes)', () => {
    expect(reconcile(scanRepository(), LEDGER)).toEqual([]);
  });

  it('every evidence test exists; a lock row’s runs the lock', () => {
    for (const row of LEDGER) {
      if (row.evidence === undefined) continue;
      expect(existsSync(join(REPO_ROOT, row.evidence)), `${row.evidence} is missing`).toBe(true);
      if (row.kind === 'lock') expect(read(row.evidence), row.evidence).toMatch(LOCK_EVIDENCE);
    }
  });

  it('every row states a reason', () => {
    for (const row of LEDGER) expect(row.reason.length, keyOf(row)).toBeGreaterThan(40);
  });

  it('the un-ordered rows are at the baseline (lower it when one goes)', () => {
    expect(LEDGER.filter((r) => r.kind !== 'lock')).toHaveLength(UNMEDIATED_BASELINE);
  });

  it('a `dead` row is dead: no other file in src names its function', () => {
    for (const row of LEDGER.filter((r) => r.kind === 'dead')) {
      const name = row.site.split('.').pop() as string;
      const callers = srcFiles().filter((f) => f !== row.file && new RegExp(`\\b${name}\\b`).test(codeOf(read(f))));
      expect(callers, keyOf(row)).toEqual([]);
    }
  });

  it('the readiness follow-ups still name files that exist', () => {
    for (const { file, what } of READINESS_FOLLOW_UPS) {
      expect(existsSync(join(REPO_ROOT, file)), what).toBe(true);
    }
  });
});

describe('[#3981] the scanner and the rules are not vacuous', () => {
  const TMUX = "import { sendKeys } from '../tmux/tmux';\n";

  it('positive: a new `sendKeys(` that is not on the ledger fails', () => {
    const sites = [...scanRepository(), ...scanKeyWriters('src/lib/x.ts', `${TMUX}export async function f(s: string) { await sendKeys(s, 'x', true); }\n`)];
    expect(reconcile(sites, LEDGER)).toEqual([expect.stringContaining('not on the ledger: src/lib/x.ts :: f :: sendKeys')]);
  });

  it('positive: a wrapper nobody has named is still a site — renamed, namespaced, dynamic, or handed on', () => {
    const cases: Array<[string, string]> = [
      ["import { sendKeys as typeIt } from '@/lib/tmux/tmux';\nconst helper = async (s: string) => typeIt(s, 'x', true);\n", 'helper'],
      ["import * as tmux from '../tmux/tmux';\nclass A { async go(s: string) { await tmux.sendKeys(s, 'x', true); } }\n", 'A.go'],
      ["async function late(s: string) { const { sendKeys } = await import('@/lib/tmux/tmux'); await sendKeys(s, 'x', true); }\n", 'late'],
      [`${TMUX}function retry(fn: unknown) { return fn; }\nexport function wire() { return retry(sendKeys); }\n`, 'wire'],
      ["export { sendKeys } from '../tmux/tmux';\n", '<re-export>'],
    ];
    for (const [text, site] of cases) {
      const found = scanKeyWriters('src/lib/x.ts', text);
      expect(found.map((s) => s.site), text).toEqual([site]);
      expect(reconcile([...scanRepository(), ...found], LEDGER), text).toHaveLength(1);
    }
  });

  it('negative: prose, another module’s `sendKeys`, and a property of that name are not sites', () => {
    const text =
      "import { capturePane } from '../tmux/tmux';\n/** sendKeys(s, 'x') */\nconst sendKeys = (k: string[]) => k;\nobj.sendKeys(['a']);\nsendKeys(['b']);\n";
    expect(scanKeyWriters('src/lib/x.ts', text)).toEqual([]);
  });

  it('positive: taking the lock off a `lexical` lock row fails (launch-keys without its wrapper)', () => {
    const file = 'src/lib/cli-tools/launch-keys.ts';
    const original = read(file);
    const unwrapped = original.replace('await withInstanceInputLock(sessionName, async () => {', 'await (async () => {').replace(/\n {2}\}\);\n\}\n?$/, '\n  })();\n}\n');
    expect(unwrapped).not.toBe(original);
    const sites = scanRepository().filter((s) => s.file !== file).concat(scanKeyWriters(file, unwrapped));
    expect(reconcile(sites, LEDGER)).toEqual([expect.stringContaining('no longer under the lock in the source: src/lib/cli-tools/launch-keys.ts')]);
  });

  it('positive: the same for claude’s trust Enter (its `answerUnderInstanceInputLock` taken off)', () => {
    const file = 'src/lib/session/claude-session.ts';
    const original = read(file);
    const unwrapped = original.replace(/answerUnderInstanceInputLock\(/g, 'notALock(');
    expect(unwrapped).not.toBe(original);
    const sites = scanRepository().filter((s) => s.file !== file).concat(scanKeyWriters(file, unwrapped));
    expect(reconcile(sites, LEDGER)).toEqual([expect.stringContaining('no longer under the lock in the source: src/lib/session/claude-session.ts :: sendTrustDialogKey')]);
  });

  it('negative: one more `lock` row, with its site and evidence, passes', () => {
    const text = "import { sendKeys } from '../tmux/tmux';\nimport { withInstanceInputLock } from '../session/instance-input-lock';\nexport async function g(s: string) { await withInstanceInputLock(s, () => sendKeys(s, 'x', true)); }\n";
    const row: LedgerRow = { file: 'src/lib/y.ts', site: 'g', callee: 'sendKeys', kind: 'lock', held: 'lexical', reason: 'fixture', evidence: LAUNCH_EVIDENCE };
    expect(reconcile([...scanRepository(), ...scanKeyWriters('src/lib/y.ts', text)], [...LEDGER, row])).toEqual([]);
  });

  it('positive: one more un-ordered row fails, even with its site behind it', () => {
    const text = `${TMUX}export async function h(s: string) { await sendKeys(s, 'x', true); }\n`;
    const row: LedgerRow = { file: 'src/lib/z.ts', site: 'h', callee: 'sendKeys', kind: 'kill', reason: 'fixture' };
    expect(reconcile([...scanRepository(), ...scanKeyWriters('src/lib/z.ts', text)], [...LEDGER, row])).toEqual([
      expect.stringContaining('un-ordered rows went up'),
    ]);
  });

  it('positive: a `decided-outside` row without an evidence test fails', () => {
    const ledger = LEDGER.map((r) => (r.kind === 'decided-outside' ? { ...r, evidence: undefined } : r));
    expect(reconcile(scanRepository(), ledger).filter((p) => p.includes('without an evidence test'))).toHaveLength(3);
  });

  it('the walk reached every ledger file', () => {
    const files = candidateFiles();
    for (const row of LEDGER) expect(files, row.file).toContain(row.file);
  });
});
