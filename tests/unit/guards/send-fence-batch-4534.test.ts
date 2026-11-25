/**
 * Issue #4534, G-印 (INV-束 R3 and the retraction sites of R7, design §5): where
 * a creation's batch is made, where it may go, how long it lasts — by type and
 * by a static reading of the source — and the three places a retraction is
 * written.
 *
 * - Types: each line of {@link typeLevel} must NOT compile (`tsc --noEmit` fails
 *   on an `@ts-expect-error` that is not needed). Never run.
 * - G-印 negative control: today's tree — one place opens a batch
 *   (`createSession`), two private functions take one (`respawnLoginShell`,
 *   `reconcileGeometry`), five further steps, nothing public, nothing outside
 *   `tmux.ts`; retractions at exactly `withdrawUnsentBody` (twice),
 *   `sendUnderInputLock` and `launchSessionWithRole`.
 * - Positive controls: each added form is a violation. In-memory trees only.
 *
 * The run-time half of (d)(e) is in `tests/unit/lib/session/terminal-fence-4534.test.ts` (T12).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './route-tmux-reach';
import { srcFiles, TMUX_MODULE } from './pane-key-writers-scan';
import { FENCE_MODULE, freeReferences } from './send-fence-closure';
import { fenceBatchOpen, fenceBatchStep, fenceGate, type FenceBatch } from '@/lib/session/terminal-fence';
import { reconcileSessionGeometry } from '@/lib/tmux/tmux';

/** Never run: every line must fail to compile. */
export function typeLevel(batch: FenceBatch): void {
  // @ts-expect-error (d) a single gate hands nothing back to keep
  const kept: FenceBatch = fenceGate('key');
  // @ts-expect-error (d) a step takes a batch, not a gate's return
  fenceBatchStep(fenceGate('geometry'));
  // @ts-expect-error (d) the public options of reconcileSessionGeometry have no way in for a batch
  void reconcileSessionGeometry('s', { fenceBatch: batch });
  // @ts-expect-error an object shaped like a batch is not one
  const forged: FenceBatch = { active: true, ticket: null, kind: 'create' };
  // @ts-expect-error a batch opens for a creation only
  fenceBatchOpen('key');
  void kept;
  void forged;
}

const read = (f: string): string => readFileSync(join(REPO_ROOT, f), 'utf-8');

function tree(extra: Record<string, string> = {}): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of srcFiles()) files.set(f, read(f));
  for (const [f, text] of Object.entries(extra)) files.set(f, text);
  return files;
}

interface BatchSites {
  open: string[];
  step: string[];
  end: string[];
  takers: string[];
  publicTakers: string[];
  mentions: string[];
  retractions: string[];
}

function batchSites(files: ReadonlyMap<string, string>): BatchSites {
  const refs = (name: string): string[] => freeReferences(files, FENCE_MODULE, name).filter((n) => !n.startsWith(`${FENCE_MODULE}#`)).sort();
  const takers: string[] = [];
  const publicTakers: string[] = [];
  const mentions: string[] = [];
  for (const [f, text] of files) {
    if (f === FENCE_MODULE || !/FenceBatch|fenceBatch/.test(text)) continue;
    mentions.push(f);
    const source = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        node.parameters.some((p) => p.type?.getText(source).includes('FenceBatch'))
      ) {
        const name = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name ? node.name.getText(source) : '<anonymous>';
        takers.push(`${f}#${name}`);
        const exported = ts.isFunctionDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
        if (exported || !ts.isFunctionDeclaration(node)) publicTakers.push(`${f}#${name}`);
      }
      if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.getText(source).includes('FenceBatch')) {
        publicTakers.push(`${f}#type ${node.name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    open: refs('fenceBatchOpen'),
    step: refs('fenceBatchStep'),
    end: refs('fenceBatchEnd'),
    takers: takers.sort(),
    publicTakers: publicTakers.sort(),
    mentions: mentions.sort(),
    retractions: refs('asRetraction'),
  };
}

/** The retraction calls (B4: three places; the withdraw clears in two ways). */
const EXPECTED_RETRACTIONS = [
  'src/lib/cli-tools/base.ts#BaseCLITool.launchSessionWithRole',
  'src/lib/cli-tools/submit-verified-sender.ts#sendUnderInputLock',
  'src/lib/cli-tools/submit-verified-sender.ts#withdrawUnsentBody',
  'src/lib/cli-tools/submit-verified-sender.ts#withdrawUnsentBody',
];

/** INV-束 and the retraction sites, as rules over what the scan found. */
function batchViolations(found: BatchSites): string[] {
  const v: string[] = [];
  for (const m of found.mentions) if (m !== TMUX_MODULE) v.push(`a batch is named outside the tmux module: ${m}`);
  for (const o of found.open) if (o !== `${TMUX_MODULE}#createSession`) v.push(`a batch is opened outside createSession: ${o}`);
  for (const t of found.publicTakers) v.push(`a batch crosses a public signature: ${t}`);
  const allowed = new Set([`${TMUX_MODULE}#createSession`, ...found.takers]);
  for (const s of found.step) if (!allowed.has(s)) v.push(`a step outside createSession and the functions it hands its batch to: ${s}`);
  for (const e of found.end) if (e !== `${TMUX_MODULE}#createSession`) v.push(`a batch is ended outside createSession: ${e}`);
  const expected = [...EXPECTED_RETRACTIONS];
  for (const r of found.retractions) {
    const i = expected.indexOf(r);
    if (i === -1) v.push(`a retraction outside its three places: ${r}`);
    else expected.splice(i, 1);
  }
  for (const r of expected) v.push(`a retraction place lost its retraction: ${r}`);
  return v;
}

describe('G-印 (static)', () => {
  it('negative control: one place opens a batch, two private functions take one, five steps, nothing public; four retraction calls at three places', () => {
    const found = batchSites(tree());
    expect(batchViolations(found)).toEqual([]);
    expect(found.open).toEqual([`${TMUX_MODULE}#createSession`]);
    expect(found.takers).toEqual([`${TMUX_MODULE}#reconcileGeometry`, `${TMUX_MODULE}#respawnLoginShell`]);
    expect(found.step).toHaveLength(5);
    expect(found.retractions).toEqual(EXPECTED_RETRACTIONS);
  });

  it('[fence-d] [fence-e] positive controls: opened elsewhere / taken by an exported function / carried in public options / stepped elsewhere → red', () => {
    const tmux = read(TMUX_MODULE);
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      [
        'opened elsewhere',
        { 'src/lib/zz-batch.ts': "import { fenceBatchOpen, fenceBatchStep } from '@/lib/session/terminal-fence';\nexport function sneak(): void { const b = fenceBatchOpen('create'); fenceBatchStep(b); }\n" },
        /opened outside createSession: src\/lib\/zz-batch\.ts#sneak/,
      ],
      [
        'an exported function takes one',
        { [TMUX_MODULE]: tmux.replace('async function reconcileGeometry(', 'export async function reconcileGeometry(') },
        /crosses a public signature: src\/lib\/tmux\/tmux\.ts#reconcileGeometry/,
      ],
      [
        'public options carry one',
        { [TMUX_MODULE]: tmux.replace('  respectAttachedClient?: boolean;\n}', '  respectAttachedClient?: boolean;\n  fenceBatch?: FenceBatch;\n}') },
        /crosses a public signature: src\/lib\/tmux\/tmux\.ts#type SessionGeometryOptions/,
      ],
      [
        'a step in another function',
        { [TMUX_MODULE]: tmux.replace("  fenceGate('kill');", '  fenceBatchStep(undefined as never);') },
        /a step outside createSession and the functions it hands its batch to: src\/lib\/tmux\/tmux\.ts#killSession/,
      ],
    ];
    for (const [label, extra, expected] of cases) {
      const v = batchViolations(batchSites(tree(extra)));
      expect(v.join('\n'), label).toMatch(expected);
    }
  });

  it('positive controls: a retraction added at a fourth place, or one taken away → red', () => {
    const sender = 'src/lib/cli-tools/submit-verified-sender.ts';
    const text = read(sender);
    const added = text.replace(
      "export async function sendMessageWithSubmitVerification(\n  params: SubmitVerifiedSendParams\n): Promise<void> {\n",
      "export async function sendMessageWithSubmitVerification(\n  params: SubmitVerifiedSendParams\n): Promise<void> {\n  await asRetraction('sneak', async () => undefined);\n",
    );
    expect(added).not.toBe(text);
    expect(batchViolations(batchSites(tree({ [sender]: added }))).join('\n')).toMatch(
      /a retraction outside its three places: src\/lib\/cli-tools\/submit-verified-sender\.ts#sendMessageWithSubmitVerification/,
    );
    const removed = text.replace("await asRetraction('replaced-clear', () => clearInputLine(sessionName));", 'await clearInputLine(sessionName);');
    expect(removed).not.toBe(text);
    expect(batchViolations(batchSites(tree({ [sender]: removed }))).join('\n')).toMatch(
      /a retraction place lost its retraction: src\/lib\/cli-tools\/submit-verified-sender\.ts#sendUnderInputLock/,
    );
  });
});
