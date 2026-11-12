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
 *  6. the help body of `commandmate mem` (`MEM_HELP`, `src/cli/commands/mem.ts`); the `memHelp` line
 *  7. the description of `mem add --close-when` (`src/cli/commands/mem.ts`); `option`
 *  8. `docs/user-guide/cli-operations-guide.md` (ja), the `## commandmate mem` chapter; the `memJa` line
 *  9. `docs/en/user-guide/cli-operations-guide.md` (en), the same chapter; the `memEn` line
 * (g-pr4-g9g added 6-9. The mem chapters keep their other kind inventories — all six kinds, the limits
 * table. g-pr4-g9h: places 8, 9 are read by PARAGRAPH (blocks between blank lines), not by line: in a paragraph
 * that talks about `--close-when` / 必須 / required, every line but the generated one is searched for a list,
 * so "--close-when is required for:" and "waiting / next / external / now" on the next line are red. Lists of
 * other facts are named in ALLOWED_OTHER_LISTS.)
 *
 * Mutations (in memory, the repository is not written): the generated list in each place gets `/ now`,
 * gets an unknown word, or loses a kind; each is red at each place (9 × 3). One more: a hand-written list
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

type Form = 'line' | 'whole' | 'paragraph';
interface Place {
  name: string;
  /** The generated string this place uses. */
  generated: string;
  form: Form;
  read: () => string;
  /** Only the lines matching this are searched for a hand-written list (default: all lines). Unused by 'paragraph'. */
  scope?: RegExp;
  /** 'paragraph' only: lines that are another fact's list (see ALLOWED_OTHER_LISTS), by the place's file and heading. */
  allowKey?: string;
}

/**
 * Allow table for the 'paragraph' form (places 8, 9). A paragraph (a block between blank lines) that talks
 * about the rule (`--close-when` / 必須 / required) may hold no list of kinds except the generated line.
 * A list of ANOTHER fact (the six kinds of the chapter, ...) is allowed only when a line equals an entry
 * here EXACTLY, named by the file+heading and the line's content, AND only in a paragraph that does not talk
 * about the rule (g-pr4-g9i: next to `--close-when is required for:` the table does not apply). The table never allows a list of the
 * required kinds as the rule: an entry that gets a required word added (or `/ now`) is no longer equal, so
 * it is checked like any other line and is red. Today two lines per chapter are named: the six kinds of the
 * chapter, and the exit-56 row of the limits table (30 for waiting / next / external, 50 for note — a limit,
 * not the --close-when rule).
 */
const ALLOWED_OTHER_LISTS: Record<string, string[]> = {
  'docs/user-guide/cli-operations-guide.md#commandmate mem': ['- kind は `now` / `waiting` / `decision` / `next` / `external` / `note`。',
    '| 56 | `limit_exceeded`：そのブランチの open の項目が多すぎる（`waiting` / `next` / `external` は 30、`note` は 50。`decision` は警告だけ） |',
  ],
  'docs/en/user-guide/cli-operations-guide.md#commandmate mem': ['- Kinds: `now` / `waiting` / `decision` / `next` / `external` / `note`.',
    '| 56 | `limit_exceeded`: too many open items on the branch (30 for `waiting` / `next` / `external`, 50 for `note`; `decision` only warns) |',
  ],
};

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

function memCommand() {
  return buildProgram().commands.find((c) => c.name() === 'mem')!;
}

function memHelpBody(): string {
  const command = memCommand();
  let help = '';
  command.configureOutput({ writeOut: (t) => void (help += t), writeErr: () => undefined });
  command.outputHelp();
  return help;
}

function memAddOptionHelp(): string {
  const add = memCommand().commands.find((c) => c.name() === 'add')!;
  return add.options.find((o) => o.long === '--close-when')!.description;
}

/** `\brequired\b`: the exit-code name `target_required` (an underscore is a word character) is not the rule. */
const TALKS_ABOUT_RULE = /close-when|必須|\brequired\b/i;

/** The `## commandmate <name>` chapter, up to the next `## ` heading. */
function chapter(file: string, name = 'handoff'): string {
  const text = readFileSync(path.join(ROOT, file), 'utf-8');
  const start = text.indexOf(`\n## commandmate ${name}\n`);
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
  { name: '6 mem.ts: MEM_HELP', generated: RULE.memHelp, form: 'line', read: memHelpBody },
  { name: '7 mem.ts: mem add --close-when', generated: RULE.option, form: 'whole', read: memAddOptionHelp },
  { name: '8 docs/user-guide/cli-operations-guide.md (mem)', generated: RULE.memJa, form: 'paragraph', allowKey: 'docs/user-guide/cli-operations-guide.md#commandmate mem', read: () => chapter('docs/user-guide/cli-operations-guide.md', 'mem') },
  { name: '9 docs/en/user-guide/cli-operations-guide.md (mem)', generated: RULE.memEn, form: 'paragraph', allowKey: 'docs/en/user-guide/cli-operations-guide.md#commandmate mem', read: () => chapter('docs/en/user-guide/cli-operations-guide.md', 'mem') },
];

const JA_MEM_KEY = 'docs/user-guide/cli-operations-guide.md#commandmate mem';
const EN_MEM_KEY = 'docs/en/user-guide/cli-operations-guide.md#commandmate mem';
const KIND = `(?:${MEM_KINDS.join('|')})`;
/** Two kinds or more in a row, with or without backticks: `waiting / next`, `` `waiting`・`next` ``, `waiting, next`, `waiting or next`. */
const OLD_LIST = new RegExp(`\`?\\b${KIND}\\b\`?\\s*(?:/|・|、|,|\\bor\\b|\\band\\b)\\s*\`?\\b${KIND}\\b`, 'g');

/** What is wrong with a place's text: empty when it uses the generated string once and has no other list. */
function problems(text: string, generated: string, form: Form, scope?: RegExp, allowKey?: string): string[] {
  const out: string[] = [];
  let rest: string;
  if (form === 'paragraph') {
    const lines = text.split('\n');
    const hits = lines.filter((line) => line === generated).length;
    if (hits !== 1) out.push(`the generated line is there ${hits} times, not once`);
    const allowed = ALLOWED_OTHER_LISTS[allowKey ?? ''] ?? [];
    // Only a paragraph that talks about the rule is searched (a list of another fact in another paragraph —
    // the six kinds, the limits and manual_stale rows — is not the rule). Inside a rule paragraph the allow
    // table does NOT apply: every line but the generated one is searched, so an allowed line cannot be moved
    // next to the rule to pass. (The table names the lines that are fine in the paragraphs not searched, and
    // is the reference for what a rule paragraph must not contain; see the (iii) tests.)
    void allowed;
    rest = text
      .split(/\n[ \t]*\n/)
      .filter((paragraph) => TALKS_ABOUT_RULE.test(paragraph))
      .flatMap((paragraph) => paragraph.split('\n').filter((line) => line !== generated))
      .join('\n');
  } else if (form === 'whole') {
    if (text !== generated) out.push(`not the generated string: ${JSON.stringify(text)}`);
    rest = text === generated ? '' : text;
  } else {
    const lines = text.split('\n');
    const hits = lines.filter((line) => line === generated).length;
    if (hits !== 1) out.push(`the generated line is there ${hits} times, not once`);
    rest = lines.filter((line) => line !== generated && (!scope || scope.test(line))).join('\n');
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
    expect(problems(place.read(), place.generated, place.form, place.scope, place.allowKey)).toEqual([]);
  });

  const cases = PLACES.flatMap((place) => MUTATIONS.map(([mutation, change]) => [place.name, mutation, place, change] as const));
  it.each(cases)('(iii) %s: %s is red', (_name, _mutation, place, change) => {
    const text = place.read();
    expect(text).toContain(RULE.requiredList);
    const mutated = text.replace(RULE.requiredList, change(RULE.requiredList));
    expect(mutated).not.toBe(text);
    expect(problems(mutated, place.generated, place.form, place.scope, place.allowKey)).not.toEqual([]);
  });

  it('(ii) the source of mem.ts has no hand-written required-kinds sentence and uses the generator', () => {
    const source = readFileSync(path.join(ROOT, 'src/cli/commands/mem.ts'), 'utf-8');
    expect(source).not.toMatch(/required for (?:`?\w+`?\s*\/\s*)+/);
    expect(source).toContain('closeWhenKindsText()');
    expect(source).not.toMatch(/from '@\//);
  });

  it('(iii) positive control: the mem chapter of c12cfeb43 (hand-written rule, no generated line) is red', () => {
    const oldJa = '- kind は `now` / `waiting` / `decision`。`--close-when` は `waiting` / `next` / `external` で必須。省略すると `now` → `replaced`';
    const oldEn = '- Kinds: `now`. `--close-when` is required for `waiting` / `next` / `external`; omitted, `now` → `replaced`';
    expect(problems(oldJa, RULE.memJa, 'paragraph', undefined, JA_MEM_KEY)).not.toEqual([]);
    expect(problems(oldEn, RULE.memEn, 'paragraph', undefined, EN_MEM_KEY)).not.toEqual([]);
    expect(problems(oldJa, RULE.memJa, 'paragraph', undefined, JA_MEM_KEY).join()).toContain('0 times');
  });

  it.each(['src/lib/handoff/template.ts', 'src/cli/commands/handoff.ts'])(
    '(ii) the source of %s writes no list of kinds by hand (its text comes from the generator)',
    (file) => {
      const source = readFileSync(path.join(ROOT, file), 'utf-8');
      expect([...source.matchAll(OLD_LIST)].map((m) => m[0])).toEqual([]);
      expect(source).toContain('closeWhenKindsText()');
    }
  );

  it.each(PLACES.filter((p) => p.form !== 'whole').map((p) => [p.name, p] as const))(
    '(iii) %s: a hand-written list line added beside the generated one is red',
    (_name, place) => {
      const mutated = `${place.read()}\n- \`waiting\`・\`next\`・\`external\`・\`now\` are required for --close-when`;
      expect(problems(mutated, place.generated, place.form, place.scope, place.allowKey)).not.toEqual([]);
    }
  );
});

describe('[#4227 G9h] the mem chapters are read by paragraph, not by line', () => {
  const MEM_PLACES = PLACES.filter((p) => p.form === 'paragraph');
  const SPLIT: Record<string, [string, string]> = {
    [JA_MEM_KEY]: ['--close-when は次の kind で必須:', 'waiting / next / external / now'],
    [EN_MEM_KEY]: ['--close-when is required for:', 'waiting / next / external / now'],
  };

  it('there are two paragraph places (ja, en) and the allow table names real lines, once each', () => {
    expect(MEM_PLACES.map((p) => p.allowKey)).toEqual([JA_MEM_KEY, EN_MEM_KEY]);
    for (const place of MEM_PLACES) {
      const lines = place.read().split('\n');
      for (const allowed of ALLOWED_OTHER_LISTS[place.allowKey!]) expect(lines.filter((l) => l === allowed)).toHaveLength(1);
    }
  });

  it.each(MEM_PLACES.map((p) => [p.name, p] as const))(
    '(iii) %s: the right line kept, a "required for:" line and a "waiting / next / external / now" line added is red',
    (_name, place) => {
      const [intro, list] = SPLIT[place.allowKey!];
      const text = place.read();
      const mutated = text.replace(place.generated, `${place.generated}\n${intro}\n${list}`);
      expect(mutated).not.toBe(text);
      expect(mutated.split('\n')).toContain(place.generated);
      expect(problems(text, place.generated, place.form, undefined, place.allowKey)).toEqual([]);
      expect(problems(mutated, place.generated, place.form, undefined, place.allowKey).join()).toContain('a list not from the generator');
    }
  );

  it.each(MEM_PLACES.map((p) => [p.name, p] as const))(
    '(iii) %s: the same two lines as their own paragraph are red too (a blank line does not hide them)',
    (_name, place) => {
      const [intro, list] = SPLIT[place.allowKey!];
      const mutated = place.read().replace(place.generated, `${place.generated}\n\n${intro}\n${list}`);
      expect(problems(mutated, place.generated, place.form, undefined, place.allowKey)).not.toEqual([]);
    }
  );

  it.each(MEM_PLACES.map((p) => [p.name, p] as const))(
    '(iii) %s: an allowed list stays green as it is, and is red once required kinds are added (the table allows no required list)',
    (_name, place) => {
      const allowed = ALLOWED_OTHER_LISTS[place.allowKey!][0];
      const asIs = place.read().replace(place.generated, `${place.generated}\n\n${allowed}`);
      expect(problems(asIs, place.generated, place.form, undefined, place.allowKey)).toEqual([]);
      for (const changed of [`${allowed} waiting / next / external`, `${allowed.replace('`note`', '`note` / `later`')}`, allowed.replace('`now` / ', '')]) {
        const mutated = place.read().replace(place.generated, `${place.generated}\n${changed}`);
        expect(problems(mutated, place.generated, place.form, undefined, place.allowKey)).not.toEqual([]);
      }
    }
  );
});

describe('[#4227 G9i] the allow table does not apply inside a paragraph that talks about the rule', () => {
  const MEM_PLACES = PLACES.filter((p) => p.form === 'paragraph');
  const INTRO: Record<string, string> = {
    [JA_MEM_KEY]: '--close-when は次の kind で必須:',
    [EN_MEM_KEY]: '--close-when is required for:',
  };

  it.each(MEM_PLACES.map((p) => [p.name, p] as const))(
    '(iii) %s: an allowed line right under a "required for:" line (same paragraph) is red; the same line alone in its paragraph is green',
    (_name, place) => {
      for (const allowed of ALLOWED_OTHER_LISTS[place.allowKey!]) {
        const text = place.read();
        const same = text.replace(place.generated, `${place.generated}\n${INTRO[place.allowKey!]}\n${allowed}`);
        const apart = text.replace(place.generated, `${place.generated}\n\n${allowed}`);
        expect(problems(same, place.generated, place.form, undefined, place.allowKey).join()).toContain('a list not from the generator');
        expect(problems(apart, place.generated, place.form, undefined, place.allowKey)).toEqual([]);
      }
    }
  );

  it.each(MEM_PLACES.map((p) => [p.name, p] as const))(
    '(iii) %s: the allowed line placed just before the rule paragraph text is red (moved next to the rule)',
    (_name, place) => {
      const allowed = ALLOWED_OTHER_LISTS[place.allowKey!][0];
      const mutated = place.read().replace(place.generated, `${allowed}\n${place.generated}`);
      expect(problems(mutated, place.generated, place.form, undefined, place.allowKey)).not.toEqual([]);
    }
  );

  it('"required" in an exit-code name (target_required) does not make a paragraph a rule paragraph', () => {
    expect(TALKS_ABOUT_RULE.test('`target_required`')).toBe(false);
    expect(TALKS_ABOUT_RULE.test('--close-when is required for:')).toBe(true);
  });
});
