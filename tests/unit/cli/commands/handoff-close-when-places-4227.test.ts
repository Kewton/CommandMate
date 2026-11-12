/**
 * G9 (Issue #4227, g-pr4-g9f): every place that names which kinds need `--close-when` uses ONE generated
 * text, `closeWhenKindsText()` (`src/lib/handoff/close-when-kinds.ts`, built from `CLOSE_WHEN_DEFAULTS`).
 * No words are extracted from a place (the extraction of g9d filtered words to the proposable kinds and so
 * hid a `/ now` added to a guide — codex #65). A place passes only when
 *  (a) the generated string is there exactly once — as a whole line where the place is lines
 *      (request text, help body, guides), as the whole description for the option — and
 *  (b) with that string taken out, no list of two kinds or more is left (the old, hand-written form).
 *
 * Places (file, what is read):
 *  1. the request text, `src/lib/handoff/template.ts` — `handoffRequestText()`; the `ja` line
 *  2. the help body of `commandmate handoff` (`HANDOFF_HELP`, `src/cli/commands/handoff.ts`); the `en` line
 *  3. the description of `propose add --close-when` (`src/cli/commands/handoff.ts`); `option`
 *  4. `docs/user-guide/cli-operations-guide.md` (ja), the `## commandmate handoff` chapter; the `ja` line
 *  5. `docs/en/user-guide/cli-operations-guide.md` (en), the same chapter; the `en` line
 *
 * Mutations (in memory, the repository is not written): the generated list in each place gets `/ now`,
 * gets an unknown word, or loses a kind; each is red at each place (5 × 3). One more: a hand-written list
 * line added next to the right one is red too.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildProgram } from '../../../../src/cli/program';
import { closeWhenKindsText } from '../../../../src/lib/handoff/close-when-kinds';
import { handoffRequestText } from '../../../../src/lib/handoff/template';
import * as closeWhenModule from '../../../../src/lib/mem/close-when';
import * as typesModule from '../../../../src/types/mem';
import { CLOSE_WHEN_DEFAULTS, MEM_EXIT_BY_CODE, MEM_KINDS, type MemKind } from '../../../../src/types/mem';

const ROOT = path.resolve(__dirname, '../../../..');
const RULE = closeWhenKindsText();
const PROPOSE_KINDS = MEM_KINDS.filter((kind): kind is Exclude<MemKind, 'now'> => kind !== 'now');

type Form = 'line' | 'whole';
interface Place {
  name: string;
  /** The generated string this place uses. */
  generated: string;
  form: Form;
  read: () => string;
}

function handoffCommand() {
  return buildProgram().commands.find((c) => c.name() === 'handoff')!;
}

function requestText(): string {
  return handoffRequestText('req-places', new Date('2026-11-10T00:05:00.000Z'));
}

function helpBody(): string {
  const command = handoffCommand();
  let help = '';
  command.configureOutput({ writeOut: (t) => void (help += t), writeErr: () => undefined });
  command.outputHelp();
  return help;
}

function optionHelp(): string {
  const add = handoffCommand().commands.find((c) => c.name() === 'propose')!.commands.find((c) => c.name() === 'add')!;
  return add.options.find((o) => o.long === '--close-when')!.description;
}

/** The `## commandmate handoff` chapter, up to the next `## ` heading. */
function chapter(file: string): string {
  const text = readFileSync(path.join(ROOT, file), 'utf-8');
  const start = text.indexOf('\n## commandmate handoff\n');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start + 1, end < 0 ? undefined : end);
}

const PLACES: Place[] = [
  { name: '1 template.ts: the request text', generated: RULE.ja, form: 'line', read: requestText },
  { name: '2 handoff.ts: HANDOFF_HELP', generated: RULE.en, form: 'line', read: helpBody },
  { name: '3 handoff.ts: propose add --close-when', generated: RULE.option, form: 'whole', read: optionHelp },
  { name: '4 docs/user-guide/cli-operations-guide.md', generated: RULE.ja, form: 'line', read: () => chapter('docs/user-guide/cli-operations-guide.md') },
  { name: '5 docs/en/user-guide/cli-operations-guide.md', generated: RULE.en, form: 'line', read: () => chapter('docs/en/user-guide/cli-operations-guide.md') },
];

const KIND = `(?:${MEM_KINDS.join('|')})`;
/** Two kinds or more in a row, with or without backticks: `waiting / next`, `` `waiting`・`next` ``, `waiting, next`, `waiting or next`. */
const OLD_LIST = new RegExp(`\`?\\b${KIND}\\b\`?\\s*(?:/|・|、|,|\\bor\\b|\\band\\b)\\s*\`?\\b${KIND}\\b`, 'g');

/** What is wrong with a place's text: empty when it uses the generated string once and has no other list. */
function problems(text: string, generated: string, form: Form): string[] {
  const out: string[] = [];
  let rest: string;
  if (form === 'whole') {
    if (text !== generated) out.push(`not the generated string: ${JSON.stringify(text)}`);
    rest = text === generated ? '' : text;
  } else {
    const lines = text.split('\n');
    const hits = lines.filter((line) => line === generated).length;
    if (hits !== 1) out.push(`the generated line is there ${hits} times, not once`);
    rest = lines.filter((line) => line !== generated).join('\n');
  }
  for (const match of rest.matchAll(OLD_LIST)) out.push(`a list not from the generator: ${JSON.stringify(match[0])}`);
  return out;
}

const MUTATIONS: Array<[string, (list: string) => string]> = [
  ['add / now', (list) => `${list} / now`],
  ['add an unknown word', (list) => `${list} / later`],
  ['drop a kind', (list) => list.split(' / ').slice(1).join(' / ')],
];

describe('[#4227 G9] the generated text of the kinds that need --close-when', () => {
  it('(i) equals the rule: CLOSE_WHEN_DEFAULTS === null is required, the rest optional, now never named', () => {
    expect(RULE.required).toEqual(PROPOSE_KINDS.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] === null));
    expect(RULE.optional).toEqual(PROPOSE_KINDS.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] !== null));
    expect(RULE.required).toEqual(['waiting', 'next', 'external']);
    expect(RULE.optional).toEqual(['decision', 'note']);
    expect(RULE.requiredList).toBe('waiting / next / external');
    expect(RULE.optionalList).toBe('decision / note');
    for (const text of [RULE.ja, RULE.en, RULE.option]) {
      expect(text).toContain(RULE.requiredList);
      expect(text).not.toMatch(/\bnow\b/);
      expect(text).not.toContain('\n');
    }
    for (const text of [RULE.ja, RULE.en]) expect(text).toContain(RULE.optionalList);
    expect(RULE.ja).toContain(`終了コード ${MEM_EXIT_BY_CODE.invalid_close_when}`);
    expect(RULE.en).toContain(`exit ${MEM_EXIT_BY_CODE.invalid_close_when}`);
  });

  it('the tables lib/mem/close-when exports are the very objects of types/mem (moved, re-exported)', () => {
    expect(closeWhenModule.CLOSE_WHEN_DEFAULTS).toBe(typesModule.CLOSE_WHEN_DEFAULTS);
    expect(closeWhenModule.CLOSE_WHEN_ALLOWED).toBe(typesModule.CLOSE_WHEN_ALLOWED);
    expect(closeWhenModule.CLOSE_WHEN_TYPES).toBe(typesModule.CLOSE_WHEN_TYPES);
  });

  it('the generator imports relative paths only (the CLI build has no @/ alias)', () => {
    const source = readFileSync(path.join(ROOT, 'src/lib/handoff/close-when-kinds.ts'), 'utf-8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['../../types/mem']);
    expect(readFileSync(path.join(ROOT, 'src/types/mem.ts'), 'utf-8')).not.toMatch(/^import /m);
  });
});

describe('[#4227 G9] every place that names the kinds uses the generated text, and no hand-written list', () => {
  it.each(PLACES.map((p) => [p.name, p] as const))('(ii) %s', (_name, place) => {
    expect(problems(place.read(), place.generated, place.form)).toEqual([]);
  });

  const cases = PLACES.flatMap((place) => MUTATIONS.map(([mutation, change]) => [place.name, mutation, place, change] as const));
  it.each(cases)('(iii) %s: %s is red', (_name, _mutation, place, change) => {
    const text = place.read();
    expect(text).toContain(RULE.requiredList);
    const mutated = text.replace(RULE.requiredList, change(RULE.requiredList));
    expect(mutated).not.toBe(text);
    expect(problems(mutated, place.generated, place.form)).not.toEqual([]);
  });

  it.each(['src/lib/handoff/template.ts', 'src/cli/commands/handoff.ts'])(
    '(ii) the source of %s writes no list of kinds by hand (its text comes from the generator)',
    (file) => {
      const source = readFileSync(path.join(ROOT, file), 'utf-8');
      expect([...source.matchAll(OLD_LIST)].map((m) => m[0])).toEqual([]);
      expect(source).toContain('closeWhenKindsText()');
    }
  );

  it.each(PLACES.filter((p) => p.form === 'line').map((p) => [p.name, p] as const))(
    '(iii) %s: a hand-written list line added beside the generated one is red',
    (_name, place) => {
      const mutated = `${place.read()}\n- \`waiting\`・\`next\`・\`external\`・\`now\` require it`;
      expect(problems(mutated, place.generated, place.form)).not.toEqual([]);
    }
  );
});
