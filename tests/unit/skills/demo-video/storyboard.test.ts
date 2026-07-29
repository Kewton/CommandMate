/**
 * storyboard.ts — YAML subset, validation and scheduling (Issue #1554).
 *
 * The validator is the only thing standing between a typo in the storyboard and
 * a two-locale recording session that ends in an unusable file, so every rule it
 * enforces is tested in both directions: a storyboard that violates it fails,
 * and the committed storyboard passes.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STORYBOARD_PATH,
  TELOP_LIMITS,
  buildPlan,
  countEnglishWords,
  formatPlan,
  parseStoryboard,
  parseStoryboardArgs,
  parseYamlSubset,
  runStoryboardCli,
  stripComment,
  type Storyboard,
} from '../../../../.claude/skills/demo-video/scripts/storyboard';
import { SCENES } from '../../../../.claude/skills/demo-video/scripts/record-scenes';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const IMPLEMENTED = SCENES.map((scene) => scene.id);

/**
 * A minimal storyboard whose *record* ids track whatever record-scenes.ts
 * implements, so the fixtures below exercise one rule at a time instead of all
 * failing on the 1:1 check the moment a scene is added.
 */
function baseYaml(overrides: { scenes?: string; duration?: number } = {}): string {
  const recorded = IMPLEMENTED.map(
    (id) => `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "説明", en: "Explanation" }`,
  ).join('\n');
  const scenes = overrides.scenes ?? `  - id: title\n    type: card\n    duration: 3\n    telop: { ja: "題", en: "Title" }\n${recorded}`;
  const duration = overrides.duration ?? 3 + IMPLEMENTED.length * 2;
  return `version: 1\nduration: ${duration}\noutput: demo\nscenes:\n${scenes}\n`;
}

describe('stripComment', () => {
  it('removes a trailing comment', () => {
    expect(stripComment('duration: 30 # target')).toBe('duration: 30 ');
    expect(stripComment('# whole line')).toBe('');
  });

  it('leaves a # that is inside a quoted telop alone', () => {
    // A telop may legitimately contain a hash. Truncating it would silently
    // ship a half sentence.
    expect(stripComment('ja: "タグ #dev を付ける"')).toBe('ja: "タグ #dev を付ける"');
  });

  it('leaves a # that is not preceded by whitespace alone', () => {
    expect(stripComment('output: demo#1')).toBe('output: demo#1');
  });
});

describe('parseYamlSubset', () => {
  it('reads block mappings, block sequences and inline flow mappings', () => {
    expect(
      parseYamlSubset(
        ['version: 1', 'scenes:', '  - id: a', '    telop: { ja: "あ", en: "A" }', '  - id: b', '    telop:', '      ja: "い"', '      en: "B"'].join('\n'),
      ),
    ).toEqual({
      version: 1,
      scenes: [
        { id: 'a', telop: { ja: 'あ', en: 'A' } },
        { id: 'b', telop: { ja: 'い', en: 'B' } },
      ],
    });
  });

  it('keeps a comma inside a quoted flow value', () => {
    expect(parseYamlSubset('telop: { ja: "完了、検知", en: "Completion, detected" }')).toEqual({
      telop: { ja: '完了、検知', en: 'Completion, detected' },
    });
  });

  it.each([
    ['a: 1\n\tb: 2', /tabs are not valid/],
    ['a: 1\nb: [1, 2]', /flow sequences are not supported/],
    ["a: 'single'", /single-quoted/],
    ['a: { b 1 }', /is not 'key: value'/],
    ['a: 1\na: 2', /duplicate key/],
    ['a:', /has no value/],
    ['a: 1\n  b: 2', /has both an inline value and a nested block/],
    ['', /storyboard is empty/],
    ['  a: 1', /must start at column 0/],
    ['a: "unterminated', /unterminated string/],
  ])('rejects %j', (source, message) => {
    expect(() => parseYamlSubset(source)).toThrow(message);
  });

  it('names the offending line', () => {
    // Without a line number the operator has to bisect a 50-line storyboard.
    expect(() =>
      parseYamlSubset('version: 1\nduration: 30\nscenes:\n  - id: a\n  bad: 1'),
    ).toThrow(/line 5: expected a '- ' sequence entry/);
  });
});

describe('countEnglishWords', () => {
  it.each([
    ['', 0],
    ['CommandMate', 1],
    ['Send a task and agents get to work', 8],
    ['  spaced   out  ', 2],
  ])('counts %j as %i', (text, expected) => {
    expect(countEnglishWords(text)).toBe(expected);
  });
});

describe('validation', () => {
  const errorsFor = (yaml: string): string[] => parseStoryboard(yaml, IMPLEMENTED).errors;

  it('accepts the base fixture', () => {
    const { storyboard, errors } = parseStoryboard(baseYaml(), IMPLEMENTED);
    expect(errors).toEqual([]);
    expect(storyboard).not.toBeNull();
  });

  it('rejects a scene list whose durations do not sum to the declared total', () => {
    const errors = errorsFor(baseYaml({ duration: 99 }));
    expect(errors.join('\n')).toMatch(/sum to \d+s but the storyboard declares 99s/);
  });

  it('reports which scene contributed what when the sum is wrong', () => {
    // The message has to be actionable: "the total is wrong" alone means
    // re-adding six numbers by hand.
    expect(errorsFor(baseYaml({ duration: 99 })).join('\n')).toContain(`${IMPLEMENTED[0]}=2`);
  });

  it.each([
    ['ja', '  - id: title\n    type: card\n    duration: 3\n    telop: { en: "Title" }'],
    ['en', '  - id: title\n    type: card\n    duration: 3\n    telop: { ja: "題" }'],
  ])('rejects a telop missing %s', (_locale, scene) => {
    const recorded = IMPLEMENTED.map(
      (id) => `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "説明", en: "Explanation" }`,
    ).join('\n');
    const errors = errorsFor(baseYaml({ scenes: `${scene}\n${recorded}` }));
    expect(errors.join('\n')).toMatch(/telop\.(ja|en) is required/);
  });

  it('rejects a telop language the renderer would never draw', () => {
    const recorded = IMPLEMENTED.map(
      (id) => `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "説明", en: "Explanation" }`,
    ).join('\n');
    const errors = errorsFor(
      baseYaml({ scenes: `  - id: title\n    type: card\n    duration: 3\n    telop: { ja: "題", en: "Title", fr: "Titre" }\n${recorded}` }),
    );
    expect(errors.join('\n')).toMatch(/unknown telop language 'fr'/);
  });

  it('enforces the record-scene telop budget', () => {
    const overLong = 'あ'.repeat(TELOP_LIMITS.record.jaChars + 1);
    const scenes = IMPLEMENTED.map((id, index) =>
      index === 0
        ? `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "${overLong}", en: "ok" }`
        : `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "説明", en: "Explanation" }`,
    ).join('\n');
    const errors = errorsFor(
      baseYaml({ scenes: `  - id: title\n    type: card\n    duration: 3\n    telop: { ja: "題", en: "Title" }\n${scenes}` }),
    );
    expect(errors.join('\n')).toMatch(/telop\.ja is 21 characters, limit for a record scene is 20/);
  });

  it('counts a Japanese telop in code points, not UTF-16 units', () => {
    // 'あ'.repeat(21) and an emoji-bearing string of the same visual length must
    // be judged the same way; `.length` would count surrogate pairs twice and
    // reject a legal telop.
    const twentyCodePoints = `${'あ'.repeat(19)}🎬`;
    const scenes = IMPLEMENTED.map((id, index) =>
      index === 0
        ? `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "${twentyCodePoints}", en: "ok" }`
        : `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "説明", en: "Explanation" }`,
    ).join('\n');
    const errors = errorsFor(
      baseYaml({ scenes: `  - id: title\n    type: card\n    duration: 3\n    telop: { ja: "題", en: "Title" }\n${scenes}` }),
    );
    expect(errors.join('\n')).not.toMatch(/telop\.ja is \d+ characters/);
  });

  it('gives a card a longer budget than a record scene', () => {
    // The Issue's own outro card is 29 characters, which the 20-character band
    // budget it also specifies would reject. Cards are full-screen stills, not
    // a strip laid over moving footage.
    expect(TELOP_LIMITS.card.jaChars).toBeGreaterThan(TELOP_LIMITS.record.jaChars);
    const long = 'あ'.repeat(TELOP_LIMITS.card.jaChars + 1);
    const recorded = IMPLEMENTED.map(
      (id) => `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "説明", en: "Explanation" }`,
    ).join('\n');
    expect(
      errorsFor(baseYaml({ scenes: `  - id: title\n    type: card\n    duration: 3\n    telop: { ja: "${long}", en: "Title" }\n${recorded}` })).join('\n'),
    ).toMatch(/limit for a card scene is 40/);
  });

  it('rejects a record scene with no implementation', () => {
    const errors = errorsFor(
      'version: 1\nduration: 5\noutput: demo\nscenes:\n  - id: does-not-exist\n    type: record\n    duration: 5\n    telop: { ja: "あ", en: "a" }\n',
    );
    expect(errors.join('\n')).toMatch(/no implementation in record-scenes\.ts: does-not-exist/);
  });

  it('rejects an implemented scene the storyboard never places', () => {
    // The other half of "1:1". Without it, dropping a scene from the storyboard
    // would silently shorten the video and waste the footage.
    const errors = parseStoryboard(baseYaml(), [...IMPLEMENTED, 'orphan-scene']).errors;
    expect(errors.join('\n')).toMatch(/absent from the storyboard: orphan-scene/);
  });

  it('rejects a card that declares a viewport it is never recorded at', () => {
    const recorded = IMPLEMENTED.map(
      (id) => `  - id: ${id}\n    type: record\n    duration: 2\n    telop: { ja: "説明", en: "Explanation" }`,
    ).join('\n');
    expect(
      errorsFor(baseYaml({ scenes: `  - id: title\n    type: card\n    duration: 3\n    viewport: pc\n    telop: { ja: "題", en: "Title" }\n${recorded}` })).join('\n'),
    ).toMatch(/must not declare a viewport/);
  });

  it.each([
    ['version: 2\nduration: 1\noutput: demo\nscenes:\n  - id: a\n    type: card\n    duration: 1\n    telop: { ja: "あ", en: "a" }', /version must be 1/],
    ['version: 1\nduration: 1\noutput: ../escape\nscenes:\n  - id: a\n    type: card\n    duration: 1\n    telop: { ja: "あ", en: "a" }', /output must be a plain file stem/],
    ['version: 1\nduration: 1\noutput: demo\nscenes:\n  - id: A_Scene\n    type: card\n    duration: 1\n    telop: { ja: "あ", en: "a" }', /kebab-case/],
    ['version: 1\nduration: 1\noutput: demo\nscenes:\n  - id: a\n    type: still\n    duration: 1\n    telop: { ja: "あ", en: "a" }', /type must be 'card' or 'record'/],
    ['version: 1\nduration: 0\noutput: demo\nscenes:\n  - id: a\n    type: card\n    duration: 0\n    telop: { ja: "あ", en: "a" }', /duration must be a positive number/],
    ['version: 1\nduration: 1\noutput: demo\nscenes: []', /flow sequences are not supported/],
  ])('rejects %j', (yaml, message) => {
    expect(errorsFor(yaml).join('\n')).toMatch(message);
  });

  it('rejects a duplicate scene id', () => {
    const errors = errorsFor(
      'version: 1\nduration: 2\noutput: demo\nscenes:\n  - id: a\n    type: card\n    duration: 1\n    telop: { ja: "あ", en: "a" }\n  - id: a\n    type: card\n    duration: 1\n    telop: { ja: "あ", en: "a" }\n',
    );
    expect(errors.join('\n')).toMatch(/duplicate scene id 'a'/);
  });
});

describe('the committed storyboard', () => {
  const source = fs.readFileSync(DEFAULT_STORYBOARD_PATH, 'utf8');
  const { storyboard, errors } = parseStoryboard(source);

  it('validates against the scenes record-scenes.ts actually implements', () => {
    expect(errors).toEqual([]);
    expect(storyboard).not.toBeNull();
  });

  it('is the 30 second cut the Issue asks for', () => {
    expect(storyboard!.duration).toBe(30);
    expect(storyboard!.output).toBe('demo-30s');
  });

  it('covers every implemented scene exactly once', () => {
    const recorded = storyboard!.scenes.filter((scene) => scene.type === 'record').map((s) => s.id);
    expect([...recorded].sort()).toEqual([...IMPLEMENTED].sort());
  });

  it('films the approval beat at a phone viewport', () => {
    const mobile = storyboard!.scenes.filter((scene) => scene.viewport === 'mobile');
    expect(mobile.map((scene) => scene.id)).toEqual(['respond-from-mobile']);
  });

  it('agrees with record-scenes.ts about which scenes are mobile', () => {
    // Two files declare the viewport and they must not drift: the storyboard
    // decides the letterbox, record-scenes decides the browser.
    for (const scene of storyboard!.scenes) {
      if (scene.type !== 'record') continue;
      expect(SCENES.find((s) => s.id === scene.id)!.viewport).toBe(scene.viewport);
    }
  });
});

describe('buildPlan', () => {
  const storyboard = parseStoryboard(baseYaml(), IMPLEMENTED).storyboard as Storyboard;

  it('accumulates start times from the cut instead of restating them', () => {
    const plan = buildPlan(storyboard, 'ja');
    expect(plan[0].startSec).toBe(0);
    let cursor = 0;
    for (const entry of plan) {
      expect(entry.startSec).toBe(cursor);
      expect(entry.endSec).toBe(cursor + entry.durationSec);
      cursor = entry.endSec;
    }
    expect(cursor).toBe(storyboard.duration);
  });

  it('selects the telop for the requested locale', () => {
    expect(buildPlan(storyboard, 'ja')[0].telop).toBe('題');
    expect(buildPlan(storyboard, 'en')[0].telop).toBe('Title');
  });

  it('re-times downstream scenes when an earlier one changes length', () => {
    // The property the Issue asks for: editing the YAML must be enough, with no
    // hand-written timecode anywhere else.
    const stretched = {
      ...storyboard,
      duration: storyboard.duration + 5,
      scenes: storyboard.scenes.map((scene, index) =>
        index === 0 ? { ...scene, duration: scene.duration + 5 } : scene,
      ),
    };
    const before = buildPlan(storyboard, 'ja');
    const after = buildPlan(stretched, 'ja');
    expect(after[1].startSec).toBe(before[1].startSec + 5);
    expect(after.at(-1)!.endSec).toBe(before.at(-1)!.endSec + 5);
  });
});

describe('formatPlan', () => {
  const storyboard = parseStoryboard(fs.readFileSync(DEFAULT_STORYBOARD_PATH, 'utf8')).storyboard!;

  it('emits a tab-separated plan compose.sh can read without jq', () => {
    const rows = formatPlan(storyboard, 'ja').trim().split('\n');
    expect(rows[0]).toBe('#id\ttype\tviewport\tstart\tduration\ttelop');
    expect(rows).toContain('#total\t30.000');
    expect(rows).toContain('#output\tdemo-30s.ja');
    const first = rows.find((row) => row.startsWith('title\t'))!;
    expect(first.split('\t')).toEqual(['title', 'card', 'pc', '0.000', '3.000', 'CommandMate']);
  });

  it('never emits a telop containing a tab, which would shift every column', () => {
    for (const locale of ['ja', 'en'] as const) {
      for (const row of formatPlan(storyboard, locale).trim().split('\n')) {
        expect(row.split('\t').length).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('CLI', () => {
  it.each([
    [['--locale', 'fr'], /--locale must be one of ja\|en/],
    [['--format', 'yaml'], /--format must be plan or json/],
    [['--file'], /--file needs a value/],
    [['--nope'], /unknown argument/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseStoryboardArgs(argv)).toThrow(message);
  });

  it('defaults to the committed storyboard in Japanese', () => {
    const options = parseStoryboardArgs([]);
    expect(options.file).toBe(DEFAULT_STORYBOARD_PATH);
    expect(options.locale).toBe('ja');
    expect(options.format).toBe('plan');
  });

  it('exits 0 and prints a plan for the committed storyboard', () => {
    let written = '';
    expect(runStoryboardCli([], (text) => { written += text; })).toBe(0);
    expect(written).toContain('#total\t30.000');
  });

  it('exits 1 without printing a plan when the storyboard is invalid', () => {
    // A validator that reported failure on stderr but still exited 0 would let
    // demo-video.sh record 30 seconds of footage against a broken cut.
    const broken = path.join(REPO_ROOT, 'tests/unit/skills/demo-video/__does-not-validate.yaml');
    fs.writeFileSync(broken, 'version: 1\nduration: 99\noutput: demo\nscenes:\n  - id: title\n    type: card\n    duration: 3\n    telop: { ja: "題", en: "Title" }\n');
    try {
      let written = '';
      expect(runStoryboardCli(['--file', broken], (text) => { written += text; })).toBe(1);
      expect(written).toBe('');
    } finally {
      fs.rmSync(broken, { force: true });
    }
  });

  it('exits 2 on a bad argument, distinguishing usage from content', () => {
    expect(runStoryboardCli(['--locale', 'fr'], () => {})).toBe(2);
  });
});
