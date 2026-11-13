/**
 * Issue #4304 F1-a (the contract after §6-6, §3.3-1 / -3): what types cannot
 * hold about the answer's delivery and its effects, pinned from the source.
 *
 * 1. `sendPromptAnswer`'s `void` / throw is read in one place: every caller
 *    outside the sender hands it to `deliverAnswer` (`() => sendPromptAnswer(`)
 *    and none awaits it itself, so no caller reads `keysSent` /
 *    `answerDelivery` off an error after the send again.
 * 2. The Auto-Yes tick hands `detectAndRespondToPrompt` its bound frame, so a
 *    production answer is never `sender-bound` (the direct callers' seam).
 * 3. The answer routes and the poller restart the response poll only inside
 *    `applyWhile…PaneIsCurrent`'s effect (the strict route: inside
 *    `settleStrictAnswer`'s `resume`, which runs there), never after a bare send.
 *
 * Each check has a negative control that shows the scan sees what it looks for.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = process.cwd();

/** The source without comments, so a sentence about a function is not a call of it. */
function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function productionTs(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .split('\0')
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'src/lib/prompt-answer-sender.ts');
}

/** Each place `sendPromptAnswer(` is called, with what stands before it. */
function sendCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bsendPromptAnswer\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    calls.push(source.slice(Math.max(0, match.index - 12), match.index));
  }
  return calls;
}

/** A send handed to `deliverAnswer` as its thunk: `=> sendPromptAnswer(`. */
const AS_THUNK = /=>\s*$/;

describe('[#4304 F1-a] the send is read in one place', () => {
  it('every production call of sendPromptAnswer is deliverAnswer\'s thunk', () => {
    const direct = productionTs().flatMap((file) =>
      sendCalls(code(file))
        .filter((before) => !AS_THUNK.test(before))
        .map((before) => `${file}: …${before}sendPromptAnswer(`),
    );
    expect(direct).toEqual([]);
  });

  it('negative control: an awaited call is seen', () => {
    expect(sendCalls('await sendPromptAnswer(params);').filter((b) => !AS_THUNK.test(b))).toHaveLength(1);
    expect(sendCalls('deliverAnswer(o, () => sendPromptAnswer(params));').filter((b) => !AS_THUNK.test(b))).toHaveLength(0);
  });
});

describe('[#4304 F1-a] the tick\'s answers carry its pane', () => {
  it('pollAutoYes hands detectAndRespondToPrompt its bound frame', () => {
    const source = code('src/lib/auto-yes-poller.ts');
    const start = source.indexOf('async function pollAutoYes(');
    expect(start).toBeGreaterThan(-1);
    const call = source.indexOf('await detectAndRespondToPrompt(', start);
    const end = source.indexOf(');', call);
    expect(source.slice(call, end)).toMatch(/\bboundFrame,?\s*$/);
    expect(source.slice(start, call)).toMatch(/bound: boundFrame/);
  });
});

/** `startPolling(` calls outside an `applyWhile…PaneIsCurrent(` effect, by brace depth. */
function startPollingOutsideEntry(source: string, name: RegExp): number {
  let outside = 0;
  const pattern = new RegExp(name.source, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const entry = Math.max(
      source.lastIndexOf('applyWhile', match.index),
      // The strict route's entry: `settleStrictAnswer` runs its `resume` inside `applyWhilePaneIsCurrent`.
      source.lastIndexOf('settleStrictAnswer(', match.index),
    );
    if (entry === -1) {
      outside++;
      continue;
    }
    // Inside the entry's call when the parentheses opened since it are still open.
    let depth = 0;
    for (let i = source.indexOf('(', entry); i < match.index; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    if (depth <= 0) outside++;
  }
  return outside;
}

describe('[#4304 F1-a] the current state is written inside the pane look only', () => {
  it.each([
    ['src/app/api/worktrees/[id]/prompt-response/answer-delivery.ts', /\bstartPolling\(/],
    ['src/app/api/worktrees/[id]/prompt-response/frame-verification.ts', /\bstartPolling\(/],
    ['src/app/api/worktrees/[id]/respond/route.ts', /\bstartPolling\(/],
    ['src/app/api/worktrees/[id]/prompt-response/strict/route.ts', /\bstartPolling\(/],
    ['src/lib/auto-yes-poller.ts', /\bstartResponsePolling\(/],
  ])('%s', (file, name) => {
    const source = code(file);
    expect(source).toMatch(name);
    expect(startPollingOutsideEntry(source, name)).toBe(0);
  });

  it('negative control: a restart after a bare send is seen', () => {
    expect(startPollingOutsideEntry('await send();\nstartPolling(id);', /\bstartPolling\(/)).toBe(1);
    expect(
      startPollingOutsideEntry('await applyWhilePaneIsCurrent(c, o, () => {\n startPolling(id);\n return undefined;\n});', /\bstartPolling\(/),
    ).toBe(0);
  });
});
