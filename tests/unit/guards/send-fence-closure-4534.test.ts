/**
 * Issue #4534, G-閉包 (INV-閉包, design §5): the functions a send reaches the
 * send-only layers through are a closed set, and only the four entries open a
 * way into it, under their ticket.
 *
 * A HELPER check: it reads the forms of the design's "赤になると確かめた書き方"
 * table and no others (the limits are listed there). Every control below is
 * an in-memory tree — today's `src` plus the added text — so no repository
 * file is written.
 *
 * - Negative control: today's tree has no violation, six marked layers, four
 *   entries (all free functions), and every member reaches an entry.
 * - Positive controls `[fence-a]` `[fence-b]` `[fence-c]` `[fence-module]`
 *   `[fence-run]` `[fence-literal]`: each added form is a violation.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './route-tmux-reach';
import { srcFiles } from './pane-key-writers-scan';
import { computeSendClosure, NOT_A_SEND } from './send-fence-closure';

function tree(extra: Record<string, string> = {}): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of srcFiles()) files.set(f, readFileSync(join(REPO_ROOT, f), 'utf-8'));
  for (const [f, text] of Object.entries(extra)) files.set(f, text);
  return files;
}

const TODAY = tree();
const withTree = (extra: Record<string, string>): Map<string, string> => {
  const files = new Map(TODAY);
  for (const [f, text] of Object.entries(extra)) files.set(f, text);
  return files;
};

describe('G-閉包: the functions a send reaches the layers through are a closed set', () => {
  it('negative control: today’s tree — six marked layers, four entries, no violation', () => {
    const found = computeSendClosure(TODAY);
    expect(found.violations).toEqual([]);
    expect(found.seeds).toEqual([
      'src/lib/cli-tools/base.ts#BaseCLITool.createLaunchPane',
      'src/lib/cli-tools/copilot.ts#CopilotTool.sendModelCommand',
      'src/lib/cli-tools/launch-keys.ts#typeLaunchLines',
      'src/lib/cli-tools/opencode.ts#OpenCodeTool.dispatchViaServer',
      'src/lib/cli-tools/submit-verified-sender.ts#sendMessageWithSubmitVerification',
      'src/lib/session/claude-session.ts#startClaudeSession',
    ]);
    expect(found.entries).toEqual([
      'src/app/api/worktrees/[id]/send/route.ts#handleSend',
      'src/app/api/worktrees/[id]/terminal/route.ts#POST',
      'src/lib/relay/relay-delivery.ts#attemptDelivery',
      'src/lib/timer-manager.ts#executeTimer',
    ]);
    expect(found.members.size).toBeGreaterThan(20);
    for (const row of Object.keys(NOT_A_SEND)) expect(existsSync(join(REPO_ROOT, row.split('#')[0]))).toBe(true);
  });

  it('[fence-a] a new function outside an entry calls sendMessageToSession → R-root', () => {
    const found = computeSendClosure(withTree({
      'src/lib/zz-rogue-a.ts': "import { sendMessageToSession } from '@/lib/session-key-sender';\nexport async function answerWithTheSender(): Promise<void> {\n  await sendMessageToSession('wt', 'm');\n}\n",
    }));
    expect(found.violations).toEqual(['R-root: src/lib/zz-rogue-a.ts#answerWithTheSender is reached by nothing and opens no ticket']);
  });

  it('[fence-b] a new function outside an entry calls startSessionForSend → R-root', () => {
    const found = computeSendClosure(withTree({
      'src/lib/zz-rogue-b.ts': "import { startSessionForSend } from '@/app/api/worktrees/[id]/send/send-session-start';\nexport async function warmUp(input: never): Promise<void> {\n  await startSessionForSend(input);\n}\n",
    }));
    expect(found.violations).toEqual(['R-root: src/lib/zz-rogue-b.ts#warmUp is reached by nothing and opens no ticket']);
  });

  it('[fence-c] a NEW middle function wraps a marked layer and is called from setInterval outside an entry → R-root', () => {
    const found = computeSendClosure(withTree({
      'src/lib/zz-wrap.ts': "import { typeLaunchLines } from '@/lib/cli-tools/launch-keys';\nexport async function typeOneLine(session: string, line: string): Promise<void> {\n  await typeLaunchLines(session, [line]);\n}\n",
      'src/lib/zz-rogue-c.ts': "import { typeOneLine } from './zz-wrap';\nexport class Nudger {\n  async nudge(session: string): Promise<void> {\n    await typeOneLine(session, 'continue');\n  }\n}\nexport function startNudging(session: string): void {\n  setInterval(() => void new Nudger().nudge(session), 1000);\n}\n",
    }));
    expect(found.members.has('src/lib/zz-wrap.ts#typeOneLine')).toBe(true);
    expect(found.members.has('src/lib/zz-rogue-c.ts#Nudger.nudge')).toBe(true);
    expect(found.violations).toEqual(['R-root: src/lib/zz-rogue-c.ts#startNudging is reached by nothing and opens no ticket']);
  });

  it('[fence-module] from module scope, through a named re-export, an aliased re-export and export default → R-module', () => {
    const found = computeSendClosure(withTree({
      'src/lib/zz-top.ts': "import { sendMessageToSession } from '@/lib/session-key-sender';\nvoid sendMessageToSession('wt', 'boot');\n",
      'src/lib/zz-barrel.ts': "export { typeLaunchLines } from '@/lib/cli-tools/launch-keys';\n",
      'src/lib/zz-barrel-as.ts': "export { typeLaunchLines as typeLines } from '@/lib/cli-tools/launch-keys';\n",
      'src/lib/zz-default.ts': "import { typeLaunchLines } from '@/lib/cli-tools/launch-keys';\nexport default typeLaunchLines;\n",
    }));
    expect(found.violations).toEqual([
      'R-module: src/lib/zz-barrel-as.ts#<re-export> reaches the send layers from re-export',
      'R-module: src/lib/zz-barrel.ts#<re-export> reaches the send layers from re-export',
      'R-module: src/lib/zz-default.ts#<module> reaches the send layers from module scope',
      'R-module: src/lib/zz-top.ts#<module> reaches the send layers from module scope',
    ]);
  });

  it('[fence-run] an entry calls into the set outside the function it runs under its ticket → R-run', () => {
    const file = 'src/lib/timer-manager.ts';
    const text = TODAY.get(file) ?? '';
    const marker = '    const result = await runWithSendTicket(';
    expect(text.includes(marker)).toBe(true);
    const mutated = text.replace(marker, "    await sendUserMessage(db, { worktreeId: timer.worktreeId, content: 'early', cliToolId: timer.cliToolId as CLIToolType });\n" + marker);
    const found = computeSendClosure(withTree({ [file]: mutated }));
    expect(found.violations).toHaveLength(1);
    expect(found.violations[0]).toMatch(/^R-run: src\/lib\/timer-manager\.ts#executeTimer calls sendUserMessage outside its ticket/);
  });

  it('[fence-literal] a string-literal member call tool()[\'sendMessage\'](…) outside an entry → R-root', () => {
    const found = computeSendClosure(withTree({
      'src/lib/zz-literal.ts': "import { CLIToolManager } from '@/lib/cli-tools/manager';\nexport async function poke(): Promise<void> {\n  await CLIToolManager.getInstance().getTool('claude')['sendMessage']('wt', 'm');\n}\n",
    }));
    expect(found.violations).toEqual(['R-root: src/lib/zz-literal.ts#poke is reached by nothing and opens no ticket']);
  });
});
