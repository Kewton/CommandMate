/**
 * G9 (Issue #4227, g-pr4-g9d): every place that names which kinds need `--close-when` is compared, as a
 * whole set, with the rule — `CLOSE_WHEN_DEFAULTS` (null = required) of `lib/mem/close-when`. Not a prefix
 * or a "contains": the set extracted from the place must EQUAL the set the rule gives, so a kind added to or
 * dropped from one place's list is red.
 *
 * Places (file, what is read):
 *  1. the request text, `src/lib/handoff/template.ts` — each `- kind=<k>:` line says 必須 or 省略可
 *  2. the help body of `commandmate handoff` (`HANDOFF_HELP`, `src/cli/commands/handoff.ts`)
 *  3. the help of `propose add --close-when` (`src/cli/commands/handoff.ts`)
 *  4. `docs/user-guide/cli-operations-guide.md` (ja), the handoff chapter's `propose add` bullet
 *  5. `docs/en/user-guide/cli-operations-guide.md` (en), the same bullet
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildProgram } from '../../../../src/cli/program';
import { CLOSE_WHEN_DEFAULTS } from '../../../../src/lib/mem/close-when';
import { MEM_KINDS, type MemKind } from '../../../../src/types/mem';
import { handoffRequestText } from '../../../../src/lib/handoff/template';

const ROOT = path.resolve(__dirname, '../../../..');
const PROPOSE_KINDS = MEM_KINDS.filter((kind): kind is Exclude<MemKind, 'now'> => kind !== 'now');
const REQUIRED = PROPOSE_KINDS.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] === null);
const OPTIONAL = PROPOSE_KINDS.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] !== null);

interface Sets {
  required: string[];
  /** null: the place does not list the optional kinds */
  optional: string[] | null;
}

const sorted = (values: string[]): string[] => [...new Set(values)].sort();
const kindsIn = (text: string): string[] => (text.match(/\b[a-z]+\b/g) ?? []).filter((word) => (PROPOSE_KINDS as readonly string[]).includes(word));
const ticked = (text: string): string[] => [...text.matchAll(/`([a-z]+)`/g)].map((m) => m[1]);

function requestText(): Sets {
  const lines = handoffRequestText('req-places', new Date('2026-11-10T00:05:00.000Z')).split('\n');
  const required: string[] = [];
  const optional: string[] = [];
  for (const line of lines) {
    const kind = /^- kind=([a-z]+):/.exec(line)?.[1];
    if (!kind) continue;
    (line.includes('必須') ? required : line.includes('省略可') ? optional : []).push(kind);
  }
  return { required, optional };
}

function handoffCommand() {
  return buildProgram().commands.find((c) => c.name() === 'handoff')!;
}

function helpBody(): Sets {
  const command = handoffCommand();
  let help = '';
  command.configureOutput({ writeOut: (t) => void (help += t), writeErr: () => undefined });
  command.outputHelp();
  const flat = help.replace(/\s+/g, ' ');
  const required = /required for kind ([a-z /]+?) \(/.exec(flat)?.[1] ?? '';
  const optional = /optional for ([a-z /]+?)\./.exec(flat)?.[1] ?? '';
  return { required: kindsIn(required), optional: kindsIn(optional) };
}

function optionHelp(): Sets {
  const add = handoffCommand().commands.find((c) => c.name() === 'propose')!.commands.find((c) => c.name() === 'add')!;
  const description = add.options.find((o) => o.long === '--close-when')!.description;
  return { required: kindsIn(/required for ([a-z /]+)/.exec(description)?.[1] ?? ''), optional: null };
}

function bullet(file: string): string {
  const text = readFileSync(path.join(ROOT, file), 'utf-8');
  const line = text.split('\n').find((l) => l.startsWith('- ') && l.includes('propose add') && l.includes('--close-when'));
  return line ?? '';
}

function guideJa(): Sets {
  const line = bullet('docs/user-guide/cli-operations-guide.md');
  const [head, tail = ''] = line.split('のとき**必須**です');
  const omit = /。([^。]*)は省略できます/.exec(tail)?.[1] ?? '';
  return { required: ticked(head), optional: ticked(omit) };
}

function guideEn(): Sets {
  const line = bullet('docs/en/user-guide/cli-operations-guide.md');
  const required = /\*\*required\*\* when the kind is ([^(]*)\(/.exec(line)?.[1] ?? '';
  const optional = /; ([^;]*) may omit it/.exec(line)?.[1] ?? '';
  return { required: ticked(required), optional: ticked(optional) };
}

const PLACES: Array<[string, () => Sets]> = [
  ['1 template.ts: the request text', requestText],
  ['2 handoff.ts: HANDOFF_HELP', helpBody],
  ['3 handoff.ts: propose add --close-when', optionHelp],
  ['4 docs/user-guide/cli-operations-guide.md', guideJa],
  ['5 docs/en/user-guide/cli-operations-guide.md', guideEn],
];

describe('[#4227 G9] the kinds that need --close-when, at every place that names them, equal the rule', () => {
  it('the rule has required and optional kinds (not an empty comparison)', () => {
    expect(REQUIRED).toEqual(['waiting', 'next', 'external']);
    expect(OPTIONAL).toEqual(['decision', 'note']);
  });

  it.each(PLACES)('%s: required set equals CLOSE_WHEN_DEFAULTS === null', (_name, read) => {
    expect(sorted(read().required)).toEqual(sorted(REQUIRED));
  });

  it.each(PLACES)('%s: optional set (where listed) equals the kinds with a default', (_name, read) => {
    const { optional } = read();
    if (optional === null) return;
    expect(sorted(optional)).toEqual(sorted(OPTIONAL));
  });
});
