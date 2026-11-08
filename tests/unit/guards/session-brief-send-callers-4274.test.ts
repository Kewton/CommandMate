/**
 * Which callers of the send service may carry a session brief (Issue #4274, design
 * §4.1 and §9 "付けない経路").
 *
 * `sendUserMessage` defaults to `brief: 'never'`, so a caller that does not say
 * puts nothing in front of its body and claims nothing. This pins every caller and
 * the value it passes: a new caller fails here until its row says whether it may.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const SRC = path.join(process.cwd(), 'src');
const SERVICE = path.join('src', 'lib', 'session', 'send-user-message.ts');

/** Caller → the `brief:` value it passes (null: none, the service's `never`). */
const CALLERS: Record<string, string | null> = {
  // The screen, `send`, `ask`, `send --contract`: `skip` / `force` from the body, else `auto`.
  'src/app/api/worktrees/[id]/send/route.ts': "body.brief ?? 'auto'",
  // A timer: the design attaches it (#1028's "same path as a manual send"), but
  // `tests/unit/lib/timer-manager.test.ts` pins the whole argument object, so D1
  // leaves it at the default and reports it (wired with that test's change in D2).
  'src/lib/timer-manager.ts': null,
  // Relay delivery: the body is the other agent's reply, tracked by its digest (#3957・#4064).
  'src/lib/relay/relay-delivery.ts': null,
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The argument object of each `sendUserMessage(` call in a source. */
function callsIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bsendUserMessage\(/g)) {
    let depth = 0;
    let end = match.index + 'sendUserMessage'.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      if (source[end] === ')' && --depth === 0) break;
    }
    found.push(source.slice(match.index, end + 1));
  }
  return found;
}

function briefOf(call: string): string | null {
  const match = /\bbrief:\s*([^,\n]+?),?\s*$/m.exec(call);
  return match ? match[1].trim() : null;
}

describe('[#4274] who may carry a session brief', () => {
  it('every caller of sendUserMessage is in the table, with the brief value it passes', () => {
    const found: Record<string, string | null> = {};
    for (const file of sources(SRC)) {
      const relative = path.relative(process.cwd(), file);
      if (relative === SERVICE) continue;
      const calls = callsIn(readFileSync(file, 'utf8')).filter((call) => !/^\s*\*/.test(call));
      const real = calls.filter((call) => /sendUserMessage\(\s*db\b/.test(call));
      for (const call of real) found[relative.split(path.sep).join('/')] = briefOf(call);
    }
    expect(found).toEqual(CALLERS);
  });

  it('the service’s default is never', () => {
    const service = readFileSync(path.join(process.cwd(), SERVICE), 'utf8');
    expect(service).toMatch(/mode: params\.brief \?\? 'never'/);
  });

  it('(control) the reader sees a brief value and its absence', () => {
    expect(briefOf("sendUserMessage(db, {\n  content,\n  brief: 'auto',\n})")).toBe("'auto'");
    expect(briefOf('sendUserMessage(db, {\n  content,\n})')).toBeNull();
  });
});
