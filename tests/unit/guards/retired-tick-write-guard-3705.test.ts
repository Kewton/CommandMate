/**
 * Every write a response-poller tick makes after an `await` is behind the
 * "may I still act for this key" question, with no `await` between the
 * question and the write (Issue #3705).
 *
 * #3663, #3684 and #3701 each added the question at the one write that had
 * been reported, and the sweep that led to #3705 found a dozen more that had
 * none. The behaviour is pinned by the suites next to the code; this guard is
 * the structural half — it reads the functions the tick runs through and fails
 * when a listed write appears after an `await` without a judgement that
 * dominates it. A write added later, or a judgement moved above a new `await`,
 * fails here before it fails in production.
 *
 * ## The rule, on the TypeScript AST
 *
 * A call to a listed side effect, inside a listed function, that comes after
 * the function's first `await` in source order (or anywhere, for the
 * synchronous steps that receive the tick's answer as `owns`), is judged when
 * either
 *
 *  (a) it sits in the `then` branch of an `if` whose condition contains a
 *      judgement that is not negated, with no `await` in that branch before
 *      the statement holding the call; or
 *  (b) an earlier statement of an enclosing block is `if (… !judgement …)`
 *      whose `then` leaves the block (`return` / `throw` / `break`), with no
 *      `await` in any statement between that `if` and the one holding the call.
 *
 * A judgement is a call to one of {@link JUDGEMENTS}, or the identifier `owns`
 * — accepted only where it cannot have gone stale: in a function with no
 * `await` at all (the synchronous steps it is passed to), or after a
 * `const owns = <judgement>` of the same function with no `await` between the
 * declaration and the write.
 *
 * Not a string search for "the line after `await`": the detector's own cases
 * below include a judgement that is separated from its write by a second
 * `await`, which such a search would pass.
 *
 * A target's `file` names the module's family (Issue #4050,
 * `split-family.ts`): the function is looked for in the file and in the pieces
 * split off it (`<dir>/<base>-*.ts`), so moving it into one is not a failure,
 * while moving it anywhere else is ("not found"), and the same name in two of
 * them is ambiguous and fails too.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, posix } from 'path';
import ts from 'typescript';
import { inFamily } from './split-family';

const JUDGEMENTS = new Set([
  'mayActForPollerKey',
  'mayStillActAfter',
  'mayReaderWrite',
  'mayActForAgentInstance',
  'maySnapshotPublish',
  'mayWrite',
]);

interface Target {
  file: string;
  fn: string;
  /** Callee names (the last identifier of the callee expression). */
  writes: string[];
  /** `after-await` (default): only calls after the first `await`; `all`: every call. */
  scope?: 'after-await' | 'all';
}

const TARGETS: Target[] = [
  {
    file: 'src/lib/polling/response-checker.ts',
    fn: 'checkForResponse',
    // `clearInProgressMessageId` is left out on purpose: the Issue sets it
    // aside as harmless (nothing sets the id non-null or reads it).
    writes: ['updateSessionState', 'resetDuplicateResponseSkipStreak', 'resetDuplicatePromptSkipStreak'],
  },
  {
    file: 'src/lib/polling/response-checker.ts',
    fn: 'extractCompletedTurn',
    scope: 'all',
    writes: [
      'observeUpstreamFaultForPush',
      'accumulateTuiContent',
      'resetDuplicatePromptSkipStreak',
      'resetDuplicateResponseSkipStreak',
      'markPendingPromptsAsAnswered',
    ],
  },
  { file: 'src/lib/polling/response-checker.ts', fn: 'cleanCompletedResponse', scope: 'all', writes: ['clearTuiAccumulator'] },
  {
    // `all`, not `after-await` (#3705 review): a hash match answers the dedup
    // before it asks about ownership, so a retired tick can arrive here, and
    // the writes ahead of the reader's `await` are this function's to judge.
    file: 'src/lib/polling/response-checker.ts',
    fn: 'recheckDuplicateResponse',
    scope: 'all',
    writes: [
      'claimDuplicateResponseSkipLog',
      'updateSessionState',
      'claimStructuredHistoryRecheck',
      'settleStructuredHistoryRecheck',
      'discardPendingScrapedResponse',
    ],
  },
  {
    file: 'src/lib/polling/response-checker.ts',
    fn: 'recordCompletedResponse',
    writes: [
      'markOrSettleStructuredHistoryRecheck',
      'markPendingPromptsAsAnswered',
      'observeWaiting',
      'notifyPushSubscribers',
      'updateSessionState',
    ],
  },
  { file: 'src/lib/hooks/sources/claude/history.ts', fn: 'writeClaudeTurn', writes: ['createMessage', 'broadcastMessage'] },
  { file: 'src/lib/hooks/sources/codex/history.ts', fn: 'writeCodexTurn', writes: ['createMessage', 'broadcastMessage'] },
  {
    file: 'src/lib/hooks/sources/command-code/history.ts',
    fn: 'writeCommandCodeTurn',
    writes: ['createMessage', 'broadcastMessage'],
  },
  {
    file: 'src/lib/hooks/sources/antigravity/history.ts',
    fn: 'writeAntigravityTurn',
    writes: ['createMessage', 'broadcastMessage'],
  },
  {
    file: 'src/lib/hooks/sources/antigravity/history.ts',
    fn: 'growAntigravityTurnRow',
    writes: ['updateMessageContent', 'broadcastMessage'],
  },
  {
    file: 'src/lib/hooks/sources/antigravity/history.ts',
    fn: 'refreshAntigravityTurnRows',
    writes: ['noteAntigravityTurnCompletion', 'noteUnsettledAntigravityTurn'],
  },
  {
    file: 'src/lib/hooks/sources/antigravity/history.ts',
    fn: 'captureAntigravityTranscriptTurn',
    writes: ['forgetAntigravityTurnsOutsideWindow', 'unsettledStepsFor', 'noteUnsettledAntigravityTurn'],
  },
  {
    file: 'src/lib/hooks/sources/transcript-history.ts',
    fn: 'growTurnRowTo',
    writes: ['updateMessageContent', 'broadcastMessage'],
  },
  {
    file: 'src/lib/history/user-turn-recorder.ts',
    fn: 'recordUserTurn',
    writes: ['adoptExistingRow', 'createMessage', 'broadcastMessage'],
  },
  {
    file: 'src/lib/assistant-response-saver.ts',
    fn: 'advanceCapturedLineForTranscriptTurn',
    writes: ['updateSessionState'],
  },
  { file: 'src/lib/log-manager.ts', fn: 'createLog', writes: ['writeFile'] },
  {
    file: 'src/lib/realtime/terminal-broadcast.ts',
    fn: 'broadcastTerminalSnapshot',
    writes: ['emitTerminalSnapshot'],
  },
  {
    file: 'src/lib/session/current-output-builder.ts',
    fn: 'buildPayload',
    writes: [
      'forgetLastKnownStatus',
      'observeScraperCompletionEvidence',
      'recordUnclassifiedFrame',
      'markStructuredPromptRecorded',
      'recordStructuredPrompt',
      'observeStatusEvidence',
    ],
  },
  { file: 'src/lib/session/current-output-builder.ts', fn: 'buildCurrentOutput', writes: ['publishChatTurnProgress'] },
  {
    // The body is remembered by the commit, so it is judged like the broadcast
    // (#3705 review: remembered then refused, it suppressed the successor's frame).
    file: 'src/lib/session/chat-turn-progress.ts',
    fn: 'emitChatTurnProgress',
    writes: ['commitChatTurnProgress', 'broadcast'],
  },
  { file: 'src/lib/session/chat-turn-progress.ts', fn: 'publishChatTurnProgress', writes: ['emitChatTurnProgress'] },
];

interface Finding {
  fn: string;
  write: string;
  line: number;
}

interface Scan {
  /** Writes found that are subject to the rule (judged or not). */
  checked: Finding[];
  /** The unjudged ones. */
  violations: Finding[];
  /** Whether the function was found at all. */
  found: boolean;
}

function calleeName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function containsAwait(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // A nested function's awaits are its own.
    if (n !== node && ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Judgements in `node`, each with whether it is negated (under `!`). */
function judgementsIn(node: ts.Node, allowOwns: boolean): Array<{ negated: boolean }> {
  const out: Array<{ negated: boolean }> = [];
  const negatedAt = (n: ts.Node): boolean => {
    let negated = false;
    let current: ts.Node = n;
    while (current.parent && current !== node) {
      const parent: ts.Node = current.parent;
      if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) negated = !negated;
      current = parent;
    }
    return negated;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && JUDGEMENTS.has(name)) out.push({ negated: negatedAt(n) });
    } else if (allowOwns && ts.isIdentifier(n) && n.text === 'owns') {
      out.push({ negated: negatedAt(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function leavesBlock(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isBreakStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return last !== undefined && leavesBlock(last);
  }
  return false;
}

/** Whether the call is dominated by a judgement under rules (a) and (b). */
function isJudged(call: ts.CallExpression, fnNode: ts.Node, allowOwns: boolean): boolean {
  let child: ts.Node = call;
  let current: ts.Node | undefined = call.parent;
  while (current && current !== fnNode.parent) {
    // (a) the then-branch of a positive judgement
    if (ts.isIfStatement(current) && current.thenStatement === child) {
      const positive = judgementsIn(current.expression, allowOwns).some((j) => !j.negated);
      if (positive && !awaitBefore(current.thenStatement, call)) return true;
    }
    // (b) an earlier early-exit on a negated judgement in an enclosing block
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      const statements = (current as ts.Block).statements;
      const index = statements.indexOf(child as ts.Statement);
      for (let i = index - 1; i >= 0; i -= 1) {
        const statement = statements[i];
        if (containsAwait(statement)) break;
        if (
          ts.isIfStatement(statement) &&
          leavesBlock(statement.thenStatement) &&
          judgementsIn(statement.expression, allowOwns).some((j) => j.negated)
        ) {
          if (index >= 0 && !awaitBefore(statements[index], call)) return true;
        }
      }
    }
    if (current === fnNode) break;
    child = current;
    current = current.parent;
  }
  return false;
}

/** Whether `container` holds an `await` that comes before `call` in source order. */
function awaitBefore(container: ts.Node, call: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || n.getStart() >= call.getStart()) return;
    if (n !== container && ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n) && n.getEnd() <= call.getStart()) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(container);
  return found;
}

function findFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return found;
}

/** Apply the rule to one function of `code`. */
function scan(code: string, fn: string, writes: string[], scope: Target['scope'] = 'after-await'): Scan {
  const source = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
  const fnNode = findFunction(source, fn);
  if (!fnNode || !fnNode.body) return { checked: [], violations: [], found: false };
  const awaitsAnywhere = containsAwait(fnNode.body);

  // `const owns = <judgement>` in this function, and every await's position.
  let ownsDeclaredAt: number | null = null;
  const awaitEnds: number[] = [];
  const collect = (n: ts.Node): void => {
    if (n !== fnNode && ts.isFunctionLike(n)) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'owns' &&
      n.initializer &&
      judgementsIn(n.initializer, false).some((j) => !j.negated)
    ) {
      ownsDeclaredAt = n.getEnd();
    }
    if (ts.isAwaitExpression(n)) awaitEnds.push(n.getEnd());
    ts.forEachChild(n, collect);
  };
  collect(fnNode.body);
  const ownsIsFresh = (call: ts.Node): boolean => {
    if (!awaitsAnywhere) return true;
    const declaredAt = ownsDeclaredAt;
    if (declaredAt === null || declaredAt > call.getStart()) return false;
    return !awaitEnds.some((end) => end > declaredAt && end <= call.getStart());
  };

  let firstAwait = Number.POSITIVE_INFINITY;
  const findFirstAwait = (n: ts.Node): void => {
    if (n !== fnNode && ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n)) firstAwait = Math.min(firstAwait, n.getEnd());
    ts.forEachChild(n, findFirstAwait);
  };
  findFirstAwait(fnNode.body);

  const checked: Finding[] = [];
  const violations: Finding[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fnNode && ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && writes.includes(name) && (scope === 'all' || n.getStart() > firstAwait)) {
        const finding = { fn, write: name, line: source.getLineAndCharacterOfPosition(n.getStart()).line + 1 };
        checked.push(finding);
        if (!isJudged(n, fnNode, ownsIsFresh(n))) violations.push(finding);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fnNode.body);
  return { checked, violations, found: true };
}

/** Where a target's function was looked for (Issue #4050). */
interface FamilyScan {
  /** The scan of the one file defining the function; `found: false` when none or several do. */
  result: Scan;
  /** The family's files that define the function. */
  definedIn: string[];
}

/**
 * Apply the rule to `fn` wherever it is defined in `origin`'s family under
 * `root` — the file and its pieces on disk (Issue #4050).
 */
function scanFamily(root: string, origin: string, fn: string, writes: string[], scope?: Target['scope']): FamilyScan {
  const dir = posix.dirname(origin);
  const members = readdirSync(join(root, dir))
    .map((name) => `${dir}/${name}`)
    .filter((rel) => inFamily(rel, origin) && statSync(join(root, rel)).isFile())
    .sort();
  const scans = members.map((file) => ({ file, result: scan(readFileSync(join(root, file), 'utf8'), fn, writes, scope) }));
  const defining = scans.filter((s) => s.result.found);
  const result = defining.length === 1 ? defining[0].result : { checked: [], violations: [], found: false };
  return { result, definedIn: defining.map((s) => s.file) };
}

// ---------------------------------------------------------------------------
// the detector on its own cases
// ---------------------------------------------------------------------------

describe('[#3705] the detector', () => {
  it('flags a write after an await with no judgement', () => {
    const result = scan(
      `async function tick(key) { await read(); write(key); }`,
      'tick',
      ['write']
    );
    expect(result.violations.map((v) => v.write)).toEqual(['write']);
  });

  it('flags a judgement separated from its write by a second await', () => {
    const result = scan(
      `async function tick(key) {
        await read();
        if (!mayActForPollerKey(key)) return false;
        await again();
        write(key);
      }`,
      'tick',
      ['write']
    );
    expect(result.violations).toHaveLength(1);
  });

  it('flags a write under a NEGATED judgement in the then-branch', () => {
    const result = scan(
      `async function tick(key) { await read(); if (!mayActForPollerKey(key)) { write(key); } }`,
      'tick',
      ['write']
    );
    expect(result.violations).toHaveLength(1);
  });

  it('flags `owns` in a function that awaits (it may have gone stale)', () => {
    const parameter = scan(`async function tick(owns) { await read(); if (owns) write(); }`, 'tick', ['write']);
    const stale = scan(
      `async function tick(ctx) { await a(); const owns = mayStillActAfter(ctx, 'a'); await b(); if (owns) write(); }`,
      'tick',
      ['write']
    );
    expect(parameter.violations).toHaveLength(1);
    expect(stale.violations).toHaveLength(1);
  });

  it('accepts `owns` declared from a judgement with no await before the write', () => {
    const result = scan(
      `async function tick(ctx) { await a(); const owns = mayStillActAfter(ctx, 'a'); if (owns) write(); return await b(); }`,
      'tick',
      ['write']
    );
    expect(result.checked).toHaveLength(1);
    expect(result.violations).toEqual([]);
  });

  it('accepts an early exit on the negated judgement, and a positive guard', () => {
    const early = scan(
      `async function tick(key) { await read(); if (!mayActForPollerKey(key)) return false; const x = 1; write(x); }`,
      'tick',
      ['write']
    );
    const positive = scan(
      `async function tick(ctx) { await read(); if (mayStillActAfter(ctx, 'read')) { write(ctx); } }`,
      'tick',
      ['write']
    );
    const owns = scan(`function step(owns) { if (owns && x) write(); }`, 'step', ['write'], 'all');
    expect(early.violations).toEqual([]);
    expect(positive.violations).toEqual([]);
    expect(owns.violations).toEqual([]);
    expect([early, positive, owns].map((r) => r.checked.length)).toEqual([1, 1, 1]);
  });

  it('flags the writes ahead of an await in an `all`-scope step reached without a judgement', () => {
    // The shape #3705's review found: a dedup that answers "duplicate" before
    // it asks about ownership, followed by the recheck's claim, cursor and read.
    const result = scan(
      `async function recheck(ctx) {
        claimSkipLog(ctx);
        updateSessionState(ctx);
        if (claimRecheck(ctx)) {
          const captured = await read(ctx);
          if (!mayStillActAfter(ctx, 'read')) return captured;
          settle(ctx);
        }
      }`,
      'recheck',
      ['claimSkipLog', 'updateSessionState', 'claimRecheck', 'settle'],
      'all'
    );
    expect(result.violations.map((v) => v.write)).toEqual(['claimSkipLog', 'updateSessionState', 'claimRecheck']);
  });

  it('accepts the same step once it opens on the judgement', () => {
    const result = scan(
      `async function recheck(ctx) {
        if (!mayStillActAfter(ctx, 'capture')) return false;
        claimSkipLog(ctx);
        updateSessionState(ctx);
        if (claimRecheck(ctx)) {
          const captured = await read(ctx);
          if (!mayStillActAfter(ctx, 'read')) return captured;
          settle(ctx);
        }
      }`,
      'recheck',
      ['claimSkipLog', 'updateSessionState', 'claimRecheck', 'settle'],
      'all'
    );
    expect(result.checked).toHaveLength(4);
    expect(result.violations).toEqual([]);
  });

  it('leaves writes before the first await to the caller', () => {
    const result = scan(`async function tick(key) { write(key); await read(); }`, 'tick', ['write']);
    expect(result.checked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the code
// ---------------------------------------------------------------------------

describe('[#3705] every listed write after an await is judged', () => {
  for (const target of TARGETS) {
    it(`${target.file} ${target.fn}`, () => {
      // Issue #4050: in the file or a piece split off it, exactly once.
      const { result, definedIn } = scanFamily(process.cwd(), target.file, target.fn, target.writes, target.scope);

      expect(definedIn, `${target.fn} in the family of ${target.file}`).toHaveLength(1);
      expect(result.found).toBe(true);
      // Every listed write is still there to check: a renamed callee would make
      // this guard pass by checking nothing.
      expect(new Set(result.checked.map((c) => c.write))).toEqual(new Set(target.writes));
      expect(result.violations).toEqual([]);
    });
  }

  it('covers the number of functions the Issue lists', () => {
    expect(TARGETS).toHaveLength(21);
  });
});

// ---------------------------------------------------------------------------
// a target's file is its family (Issue #4050)
// ---------------------------------------------------------------------------

describe('[#4050] a target is looked for in its file and the pieces split off it', () => {
  const ORIGIN = 'src/lib/polling/response-checker.ts';
  const FN = 'cleanCompletedResponse';
  const WRITES = ['clearTuiAccumulator'];
  const judged = `export function ${FN}(owns: boolean) { if (owns) clearTuiAccumulator(); }\n`;
  const unjudged = `export function ${FN}(owns: boolean) { clearTuiAccumulator(); }\n`;
  let root: string | null = null;

  /** A scratch tree of `files` (repo-relative path -> text). */
  const tree = (files: Record<string, string>): string => {
    root = mkdtempSync(join(tmpdir(), 'retired-tick-4050-'));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };

  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('negative control: in the file itself, judged as before', () => {
    const { result, definedIn } = scanFamily(tree({ [ORIGIN]: judged }), ORIGIN, FN, WRITES, 'all');
    expect(definedIn).toEqual([ORIGIN]);
    expect(result.checked).toHaveLength(1);
    expect(result.violations).toEqual([]);
  });

  it('positive: moved into a piece, the same write is found and judged the same way', () => {
    const piece = 'src/lib/polling/response-checker-clean.ts';
    const judgedThere = scanFamily(tree({ [ORIGIN]: '// moved\n', [piece]: judged }), ORIGIN, FN, WRITES, 'all');
    expect(judgedThere.definedIn).toEqual([piece]);
    expect(judgedThere.result.violations).toEqual([]);
    rmSync(root as string, { recursive: true, force: true });
    const unjudgedThere = scanFamily(tree({ [ORIGIN]: '// moved\n', [piece]: unjudged }), ORIGIN, FN, WRITES, 'all');
    expect(unjudgedThere.result.violations.map((v) => v.write)).toEqual(['clearTuiAccumulator']);
  });

  it('negative: moved out of the family — another directory, `<base>2.ts` — it is not found', () => {
    for (const stranger of ['src/lib/response-checker-clean.ts', 'src/lib/polling/response-checker2.ts']) {
      const { result, definedIn } = scanFamily(tree({ [ORIGIN]: '// moved\n', [stranger]: judged }), ORIGIN, FN, WRITES, 'all');
      expect(definedIn, stranger).toEqual([]);
      expect(result.found, stranger).toBe(false);
      rmSync(root as string, { recursive: true, force: true });
      root = null;
    }
  });

  it('negative: the same function in two files of the family is ambiguous — not found', () => {
    const { result, definedIn } = scanFamily(
      tree({ [ORIGIN]: judged, 'src/lib/polling/response-checker-copy.ts': unjudged }),
      ORIGIN,
      FN,
      WRITES,
      'all'
    );
    expect([...definedIn].sort()).toEqual([ORIGIN, 'src/lib/polling/response-checker-copy.ts'].sort());
    expect(result.found).toBe(false);
  });
});
