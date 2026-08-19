/**
 * storyboard.ts — parse, validate and schedule the demo storyboard (#1554).
 *
 * The storyboard is the single place a human edits wording. Everything
 * downstream (which scenes to record, which PNGs to render, where each telop
 * fades in) is derived from it, so a hand-written timecode can never drift out
 * of sync with the cut.
 *
 * YAML is parsed by the strict subset reader below rather than by a library:
 * the only YAML parser in this tree is js-yaml, which is a *transitive* dep of
 * gray-matter/marp-core and is not declared in package.json — a skill that has
 * to keep working after an unrelated dependency bump cannot import it. The
 * subset rejects what it does not understand instead of guessing.
 *
 *   npx tsx .claude/skills/demo-video/scripts/storyboard.ts --locale ja
 */

import fs from 'fs';
import path from 'path';

import { SCENES } from './record-scenes';

// ------------------------------------------------------------- yaml ---------

interface RawLine {
  /** 1-based line number in the source file, for error messages. */
  n: number;
  indent: number;
  text: string;
}

export type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

/**
 * Drop a trailing `#` comment. Quote-aware, because telop text may legitimately
 * contain `#` (a hashtag, a colour). A `#` only starts a comment when it is at
 * the start of the line or preceded by whitespace, matching YAML.
 */
export function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) backslashes += 1;
      if (backslashes % 2 === 0) inQuote = !inQuote;
    } else if (ch === '#' && !inQuote && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function toRawLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  text.split('\n').forEach((original, index) => {
    const n = index + 1;
    const stripped = stripComment(original).replace(/\s+$/, '');
    if (stripped === '') return;
    if (/^\s*\t/.test(stripped)) {
      throw new Error(`line ${n}: tabs are not valid YAML indentation`);
    }
    const indent = stripped.length - stripped.replace(/^ +/, '').length;
    out.push({ n, indent, text: stripped.slice(indent) });
  });
  return out;
}

function unquote(raw: string, n: number): string {
  let out = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    if (raw[i] === '\\') {
      const next = raw[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
      throw new Error(`line ${n}: only \\" and \\\\ are supported inside a quoted string`);
    }
    out += raw[i];
  }
  return out;
}

export function parseScalar(raw: string, n: number): YamlValue {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error(`line ${n}: unterminated string`);
    return unquote(value, n);
  }
  if (value.startsWith("'")) {
    throw new Error(`line ${n}: single-quoted strings are not supported — use double quotes`);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

/** Split `a: 1, b: "x, y"` on commas that are not inside a quoted string. */
function splitFlowEntries(body: string, n: number): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && body[j] === '\\'; j -= 1) backslashes += 1;
      if (backslashes % 2 === 0) inQuote = !inQuote;
    }
    if (ch === ',' && !inQuote) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (inQuote) throw new Error(`line ${n}: unterminated string in flow mapping`);
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function parseValue(raw: string, n: number): YamlValue {
  const value = raw.trim();
  if (value.startsWith('[')) {
    throw new Error(`line ${n}: flow sequences are not supported — use a block sequence`);
  }
  if (!value.startsWith('{')) return parseScalar(value, n);
  if (!value.endsWith('}')) throw new Error(`line ${n}: unterminated flow mapping`);
  const map: Record<string, YamlValue> = {};
  for (const entry of splitFlowEntries(value.slice(1, -1), n)) {
    const colon = entry.indexOf(':');
    if (colon <= 0) throw new Error(`line ${n}: flow mapping entry is not 'key: value': '${entry}'`);
    const key = entry.slice(0, colon).trim();
    if (key in map) throw new Error(`line ${n}: duplicate key '${key}'`);
    map[key] = parseScalar(entry.slice(colon + 1), n);
  }
  return map;
}

function parseBlockLines(lines: RawLine[]): YamlValue {
  const head = lines[0];
  if (head.text === '-' || head.text.startsWith('- ')) return parseSequence(lines);
  return parseMapping(lines);
}

function parseSequence(lines: RawLine[]): YamlValue[] {
  const indent = lines[0].indent;
  const items: YamlValue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent) throw new Error(`line ${line.n}: unexpected indentation in sequence`);
    if (line.text !== '-' && !line.text.startsWith('- ')) {
      throw new Error(`line ${line.n}: expected a '- ' sequence entry`);
    }
    const afterDash = line.text.slice(1);
    const lead = afterDash.length - afterDash.replace(/^ +/, '').length;
    const rest = afterDash.slice(lead);
    const sub: RawLine[] = [];
    if (rest !== '') sub.push({ n: line.n, indent: indent + 1 + lead, text: rest });
    i += 1;
    while (i < lines.length && lines[i].indent > indent) {
      sub.push(lines[i]);
      i += 1;
    }
    if (sub.length === 0) throw new Error(`line ${line.n}: sequence entry has no value`);
    items.push(parseBlockLines(sub));
  }
  return items;
}

function parseMapping(lines: RawLine[]): Record<string, YamlValue> {
  const indent = lines[0].indent;
  const map: Record<string, YamlValue> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent) throw new Error(`line ${line.n}: unexpected indentation in mapping`);
    const match = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line.text);
    if (!match) throw new Error(`line ${line.n}: expected 'key: value', got '${line.text}'`);
    const key = match[1];
    if (key in map) throw new Error(`line ${line.n}: duplicate key '${key}'`);
    const inline = (match[2] ?? '').trim();
    const sub: RawLine[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].indent > indent) {
      sub.push(lines[j]);
      j += 1;
    }
    if (inline === '') {
      if (sub.length === 0) throw new Error(`line ${line.n}: key '${key}' has no value`);
      map[key] = parseBlockLines(sub);
    } else {
      if (sub.length > 0) {
        throw new Error(`line ${line.n}: key '${key}' has both an inline value and a nested block`);
      }
      map[key] = parseValue(inline, line.n);
    }
    i = j;
  }
  return map;
}

/** Parse the documented YAML subset: block mappings, block sequences, inline flow mappings. */
export function parseYamlSubset(text: string): YamlValue {
  const lines = toRawLines(text);
  if (lines.length === 0) throw new Error('storyboard is empty');
  if (lines[0].indent !== 0) throw new Error(`line ${lines[0].n}: document must start at column 0`);
  return parseBlockLines(lines);
}

// -------------------------------------------------------- storyboard --------

export type SceneType = 'card' | 'record' | 'code';
export type Viewport = 'pc' | 'mobile';
export const LOCALES = ['ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Line budget for a `code` card (#1810).
 *
 * A code card is a still frame held for its declared duration, so the reader
 * gets one pass over it at whatever size 30 lines can be set at. Beyond that
 * the type shrinks past reading distance and the card stops being a card.
 */
export const MAX_CODE_CARD_LINES = 30;

/**
 * Column budget for a `code` card.
 *
 * The template does not wrap — a wrapped YAML key would read as a different
 * document — so an over-wide line silently runs off the right edge of the frame
 * instead of failing. Checked here, where it is still a one-second failure.
 */
export const MAX_CODE_CARD_COLUMNS = 100;

/**
 * Scenes whose footage only exists once a message has been sent (#1810).
 *
 * fake-agent.sh's cassette blocks on `@input` until CommandMate delivers a
 * message, so every frame past the first is unreachable without a send: the
 * approval prompt, the amber attention badge that counts it, and the Review
 * screen's approval list are all the *same* frame seen from three surfaces.
 * A storyboard that places one of them alone does not fail fast — it waits out
 * the scene's whole timeout and then reports a take that never had a subject.
 */
export const SEND_SCENE_ID = 'send-and-generate';
export const SCENES_REQUIRING_A_PRIOR_SEND: readonly string[] = [
  'respond-from-mobile',
  'attention-badge',
  'review-screen',
];

/**
 * Scenes that *answer* the approval prompt, and so consume it (#1810).
 *
 * The cassette paints one approval per pass. A cut placing two of these makes
 * the second wait out its whole timeout against a session that is no longer
 * asking anything — a failed take, minutes in, whose message says only that
 * nothing became `isWaitingForResponse`.
 */
export const APPROVAL_CONSUMING_SCENES: readonly string[] = ['respond-from-mobile', 'review-screen'];

/**
 * Films the moment a session *starts* waiting, so it has to run before anything
 * answers: the cross-screen toast comes off a realtime event, and a page opened
 * after the edge never receives one.
 */
export const ATTENTION_SCENE_ID = 'attention-badge';

export interface StoryboardScene {
  id: string;
  type: SceneType;
  duration: number;
  viewport: Viewport;
  telop: Record<Locale, string>;
  /** `code` scenes only: the path as authored, relative to the storyboard. */
  source?: string;
  /** `code` scenes only: `source` resolved against the storyboard's directory. */
  sourcePath?: string;
  /** `code` scenes only: syntax label rendered on the card (`yaml`, `text`, ...). */
  lang?: string;
}

export interface Storyboard {
  version: number;
  duration: number;
  output: string;
  scenes: StoryboardScene[];
}

/**
 * Telop budgets, per scene type.
 *
 * `record` telops are a lower-third band laid over moving footage and have to
 * be read in one glance, so they get the tight budget from the Issue. `card`
 * telops are full-screen title text on a still frame — the Issue's own outro
 * card, "github.com/Kewton/CommandMate", is 29 characters and would fail the
 * band budget it also specifies. Separate budgets rather than an exemption, so
 * a card still cannot become a paragraph.
 */
export const TELOP_LIMITS: Record<SceneType, { jaChars: number; enWords: number }> = {
  record: { jaChars: 20, enWords: 8 },
  card: { jaChars: 40, enWords: 12 },
  // A code card is a still frame like a card, so it gets the card budget: the
  // telop is the caption above the listing, not a band over moving footage.
  code: { jaChars: 40, enWords: 12 },
};

/** Sub-frame slop: durations are authored in whole seconds but summed as floats. */
const DURATION_EPSILON = 1e-6;

export function countEnglishWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Resolve a `code` scene's `source` against the storyboard's own directory, and
 * refuse anything that leaves it.
 *
 * Same property `output` already defends, one level up: a storyboard is data
 * edited by whoever writes the wording, and `source: ../../../etc/passwd` would
 * otherwise put an arbitrary file on screen in a published video. The check is
 * on the *resolved* path rather than on the spelling, so a path that reaches
 * outside through a symlinked subdirectory is caught too.
 */
export function resolveCodeSource(
  baseDir: string,
  source: string,
): { path: string } | { error: string } {
  if (source.trim() === '') return { error: 'source must not be empty' };
  if (path.isAbsolute(source)) {
    return { error: `source must be relative to the storyboard, got '${source}'` };
  }
  const base = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir);
  const joined = path.resolve(base, source);
  const resolved = fs.existsSync(joined) ? fs.realpathSync(joined) : joined;
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return { error: `source must stay inside ${base}, got '${source}' -> ${resolved}` };
  }
  return { path: resolved };
}

function readCodeSource(
  map: Record<string, YamlValue>,
  where: string,
  id: string,
  baseDir: string,
  errors: string[],
): { source: string; sourcePath: string; lang: string } | null {
  const source = map.source;
  if (typeof source !== 'string') {
    errors.push(`${where} (${id}): a code scene needs 'source', the file it renders`);
    return null;
  }
  const lang = map.lang;
  if (typeof lang !== 'string' || !/^[a-z0-9][a-z0-9+#.-]{0,19}$/.test(lang)) {
    errors.push(
      `${where} (${id}): lang must be a short syntax label like 'yaml' or 'text', got ${JSON.stringify(lang)}`,
    );
    return null;
  }
  const resolved = resolveCodeSource(baseDir, source);
  if ('error' in resolved) {
    errors.push(`${where} (${id}): ${resolved.error}`);
    return null;
  }
  let body: string;
  try {
    body = fs.readFileSync(resolved.path, 'utf8');
  } catch {
    errors.push(`${where} (${id}): cannot read source '${source}' (looked at ${resolved.path})`);
    return null;
  }
  const lines = body.replace(/\n$/, '').split('\n');
  if (lines.length > MAX_CODE_CARD_LINES) {
    errors.push(
      `${where} (${id}): source '${source}' is ${lines.length} lines, limit is ${MAX_CODE_CARD_LINES}`,
    );
    return null;
  }
  const overlong = lines
    .map((line, index) => ({ n: index + 1, width: [...line].length }))
    .filter((line) => line.width > MAX_CODE_CARD_COLUMNS);
  if (overlong.length > 0) {
    errors.push(
      `${where} (${id}): source '${source}' line ${overlong[0].n} is ${overlong[0].width} columns, ` +
        `limit is ${MAX_CODE_CARD_COLUMNS} (the card does not wrap)`,
    );
    return null;
  }
  return { source, sourcePath: resolved.path, lang };
}

function readScene(
  raw: YamlValue,
  index: number,
  baseDir: string,
  errors: string[],
): StoryboardScene | null {
  const where = `scenes[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${where}: expected a mapping`);
    return null;
  }
  const map = raw as Record<string, YamlValue>;
  const id = map.id;
  if (typeof id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    errors.push(`${where}: id must be a lower-case kebab-case string, got ${JSON.stringify(id)}`);
    return null;
  }
  const type = map.type;
  if (type !== 'card' && type !== 'record' && type !== 'code') {
    errors.push(
      `${where} (${id}): type must be 'card', 'record' or 'code', got ${JSON.stringify(type)}`,
    );
    return null;
  }
  const duration = map.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    errors.push(`${where} (${id}): duration must be a positive number, got ${JSON.stringify(duration)}`);
    return null;
  }

  let viewport: Viewport = 'pc';
  if (map.viewport !== undefined) {
    if (type !== 'record') {
      errors.push(`${where} (${id}): a ${type} scene is not recorded, so it must not declare a viewport`);
      return null;
    }
    if (map.viewport !== 'pc' && map.viewport !== 'mobile') {
      errors.push(`${where} (${id}): viewport must be 'pc' or 'mobile', got ${JSON.stringify(map.viewport)}`);
      return null;
    }
    viewport = map.viewport;
  }

  let code: { source: string; sourcePath: string; lang: string } | null = null;
  if (type === 'code') {
    code = readCodeSource(map, where, id, baseDir, errors);
    if (!code) return null;
  } else if (map.source !== undefined || map.lang !== undefined) {
    errors.push(`${where} (${id}): only a code scene may declare 'source' / 'lang'`);
    return null;
  }

  const telopRaw = map.telop;
  if (typeof telopRaw !== 'object' || telopRaw === null || Array.isArray(telopRaw)) {
    errors.push(`${where} (${id}): telop must be a mapping with ja and en`);
    return null;
  }
  const telop = {} as Record<Locale, string>;
  let telopOk = true;
  for (const locale of LOCALES) {
    const value = (telopRaw as Record<string, YamlValue>)[locale];
    if (typeof value !== 'string' || value.trim() === '') {
      // Both languages are mandatory: a missing one would silently ship a
      // localized video with a foreign telop, which no reviewer would catch.
      errors.push(`${where} (${id}): telop.${locale} is required and must be a non-empty string`);
      telopOk = false;
      continue;
    }
    if (/[\t\n\r]/.test(value)) {
      errors.push(`${where} (${id}): telop.${locale} must be a single line without tabs`);
      telopOk = false;
      continue;
    }
    telop[locale] = value;
  }
  for (const key of Object.keys(telopRaw as Record<string, YamlValue>)) {
    if (!LOCALES.includes(key as Locale)) {
      errors.push(`${where} (${id}): unknown telop language '${key}'`);
      telopOk = false;
    }
  }
  if (!telopOk) return null;

  const limits = TELOP_LIMITS[type];
  if ([...telop.ja].length > limits.jaChars) {
    errors.push(
      `${where} (${id}): telop.ja is ${[...telop.ja].length} characters, limit for a ${type} scene is ${limits.jaChars}`,
    );
  }
  if (countEnglishWords(telop.en) > limits.enWords) {
    errors.push(
      `${where} (${id}): telop.en is ${countEnglishWords(telop.en)} words, limit for a ${type} scene is ${limits.enWords}`,
    );
  }

  return code
    ? { id, type, duration, viewport, telop, ...code }
    : { id, type, duration, viewport, telop };
}

export interface ValidationResult {
  storyboard: Storyboard | null;
  errors: string[];
}

/**
 * @param implementedSceneIds ids `record-scenes.ts` can actually film. A
 * storyboard must be a *subset* of them: an id with no implementation still
 * fails, because the recorder would have nothing to run.
 *
 * The reverse direction is deliberately not an error. It used to be, to stop a
 * scene being filmed and then silently dropped — but that made one storyboard
 * have to place every implemented scene, which caps the scene library at
 * whatever fits the shortest cut. `demo-video.sh` now derives its `--scene`
 * arguments from the storyboard, so footage the storyboard does not place is
 * never shot in the first place. The property is enforced by construction
 * instead of by assertion.
 */
export function validateStoryboard(
  raw: YamlValue,
  implementedSceneIds: string[] = SCENES.map((scene) => scene.id),
  baseDir: string = path.dirname(DEFAULT_STORYBOARD_PATH),
): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { storyboard: null, errors: ['storyboard must be a mapping'] };
  }
  const map = raw as Record<string, YamlValue>;

  if (map.version !== 1) errors.push(`version must be 1, got ${JSON.stringify(map.version)}`);
  const duration = map.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    errors.push(`duration must be a positive number, got ${JSON.stringify(duration)}`);
  }
  const output = map.output;
  if (typeof output !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(output)) {
    // `output` becomes a file name; anything with a slash or a leading dot
    // would write outside the directory the operator chose.
    errors.push(`output must be a plain file stem, got ${JSON.stringify(output)}`);
  }

  const rawScenes = map.scenes;
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    errors.push('scenes must be a non-empty sequence');
    return { storyboard: null, errors };
  }

  const scenes: StoryboardScene[] = [];
  const seen = new Set<string>();
  rawScenes.forEach((rawScene, index) => {
    const scene = readScene(rawScene, index, baseDir, errors);
    if (!scene) return;
    if (seen.has(scene.id)) {
      errors.push(`scenes[${index}]: duplicate scene id '${scene.id}'`);
      return;
    }
    seen.add(scene.id);
    scenes.push(scene);
  });

  if (typeof duration === 'number' && scenes.length === rawScenes.length) {
    const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
    if (Math.abs(total - duration) > DURATION_EPSILON) {
      errors.push(
        `scene durations sum to ${total}s but the storyboard declares ${duration}s` +
          ` (${scenes.map((scene) => `${scene.id}=${scene.duration}`).join(' + ')})`,
      );
    }
  }

  const recorded = scenes.filter((scene) => scene.type === 'record').map((scene) => scene.id);
  const implemented = [...implementedSceneIds];
  const missing = recorded.filter((id) => !implemented.includes(id));
  if (missing.length > 0) {
    errors.push(
      `record scene(s) with no implementation in record-scenes.ts: ${missing.join(', ')}` +
        ` (implemented: ${implemented.join(', ') || '<none>'})`,
    );
  }

  // The dependency #1575 exposed and #1810 widened: the cassette parks on
  // `@input` until CommandMate sends a message, so nothing downstream of the
  // send is on screen without it. Enforced here rather than only in a test, so
  // `demo-video.sh --check` catches it in a second instead of the recorder
  // catching it after a scene's whole timeout has run out.
  const orderOf = (id: string): number => scenes.findIndex((scene) => scene.id === id);
  const sendAt = orderOf(SEND_SCENE_ID);
  for (const dependent of SCENES_REQUIRING_A_PRIOR_SEND) {
    const at = orderOf(dependent);
    if (at === -1) continue;
    if (sendAt === -1 || sendAt > at) {
      errors.push(
        `scene '${dependent}' needs '${SEND_SCENE_ID}' earlier in the cut: the cassette blocks ` +
          'on @input until a message is sent, so the frame it films is never painted',
      );
    }
  }

  const consumers = APPROVAL_CONSUMING_SCENES.filter((id) => orderOf(id) !== -1);
  if (consumers.length > 1) {
    errors.push(
      `scenes ${consumers.map((id) => `'${id}'`).join(' and ')} both answer the approval prompt, ` +
        'and the cassette paints one per pass: the second would wait out its timeout',
    );
  }
  const attentionAt = orderOf(ATTENTION_SCENE_ID);
  if (attentionAt !== -1) {
    for (const consumer of consumers) {
      if (orderOf(consumer) < attentionAt) {
        errors.push(
          `scene '${ATTENTION_SCENE_ID}' films the moment a session starts waiting, so it must ` +
            `come before '${consumer}', which answers the prompt`,
        );
      }
    }
  }

  if (errors.length > 0) return { storyboard: null, errors };
  return {
    storyboard: {
      version: 1,
      duration: duration as number,
      output: output as string,
      scenes,
    },
    errors: [],
  };
}

/**
 * @param baseDir directory `code` scenes resolve their `source` against —
 * always the directory holding the storyboard itself, so a cut can only ship
 * code it sits next to. Callers that read a file pass `path.dirname(file)`.
 */
export function parseStoryboard(
  text: string,
  implementedSceneIds?: string[],
  baseDir?: string,
): ValidationResult {
  let raw: YamlValue;
  try {
    raw = parseYamlSubset(text);
  } catch (error) {
    return { storyboard: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
  return validateStoryboard(raw, implementedSceneIds, baseDir);
}

// ------------------------------------------------------------- plan ---------

export interface PlanEntry {
  id: string;
  type: SceneType;
  viewport: Viewport;
  startSec: number;
  durationSec: number;
  endSec: number;
  telop: string;
  /** `code` scenes only: absolute path of the listing the card renders. */
  sourcePath?: string;
  /** `code` scenes only: syntax label rendered on the card. */
  lang?: string;
}

/** Absolute timeline positions, accumulated from the storyboard's own cut. */
export function buildPlan(storyboard: Storyboard, locale: Locale): PlanEntry[] {
  let cursor = 0;
  return storyboard.scenes.map((scene) => {
    const entry: PlanEntry = {
      id: scene.id,
      type: scene.type,
      viewport: scene.viewport,
      startSec: cursor,
      durationSec: scene.duration,
      endSec: cursor + scene.duration,
      telop: scene.telop[locale],
      // Deliberately not a TSV column: compose.sh only needs to know that the
      // row is a still, and every extra column is one more thing its `read`
      // has to keep in step with. The path is for render-overlays.ts, which
      // reads the plan as JSON.
      ...(scene.sourcePath ? { sourcePath: scene.sourcePath, lang: scene.lang } : {}),
    };
    cursor += scene.duration;
    return entry;
  });
}

const TSV_HEADER = '#id\ttype\tviewport\tstart\tduration\ttelop';

/**
 * Tab-separated so `compose.sh` can read it with `while IFS=$'\t' read` on bash
 * 3.2 without needing jq, which is not a documented dependency of this skill.
 */
export function formatPlan(storyboard: Storyboard, locale: Locale): string {
  const rows = buildPlan(storyboard, locale).map((entry) =>
    [
      entry.id,
      entry.type,
      entry.viewport,
      entry.startSec.toFixed(3),
      entry.durationSec.toFixed(3),
      entry.telop,
    ].join('\t'),
  );
  return [
    TSV_HEADER,
    `#total\t${storyboard.duration.toFixed(3)}`,
    `#output\t${storyboard.output}.${locale}`,
    ...rows,
    '',
  ].join('\n');
}

export const DEFAULT_STORYBOARD_PATH = path.resolve(__dirname, '../storyboard/default.yaml');

export interface StoryboardCliOptions {
  file: string;
  locale: Locale;
  format: 'plan' | 'json';
}

export function parseStoryboardArgs(argv: string[]): StoryboardCliOptions {
  const options: StoryboardCliOptions = {
    file: DEFAULT_STORYBOARD_PATH,
    locale: 'ja',
    format: 'plan',
  };
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--file': options.file = next(i, arg); i += 1; break;
      case '--locale': {
        const value = next(i, arg);
        if (!LOCALES.includes(value as Locale)) {
          throw new Error(`--locale must be one of ${LOCALES.join('|')}, got '${value}'`);
        }
        options.locale = value as Locale;
        i += 1;
        break;
      }
      case '--format': {
        const value = next(i, arg);
        if (value !== 'plan' && value !== 'json') {
          throw new Error(`--format must be plan or json, got '${value}'`);
        }
        options.format = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function runStoryboardCli(argv: string[], write: (text: string) => void): number {
  let options: StoryboardCliOptions;
  try {
    options = parseStoryboardArgs(argv);
  } catch (error) {
    process.stderr.write(`storyboard: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const { storyboard, errors } = parseStoryboard(
    fs.readFileSync(options.file, 'utf8'),
    undefined,
    path.dirname(path.resolve(options.file)),
  );
  if (!storyboard) {
    process.stderr.write(`storyboard: ${options.file} is invalid\n`);
    for (const error of errors) process.stderr.write(`  - ${error}\n`);
    return 1;
  }
  write(
    options.format === 'json'
      ? `${JSON.stringify({ ...storyboard, plan: buildPlan(storyboard, options.locale) }, null, 2)}\n`
      : formatPlan(storyboard, options.locale),
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith(path.join('scripts', 'storyboard.ts'));

if (invokedDirectly) {
  process.exitCode = runStoryboardCli(process.argv.slice(2), (text) => process.stdout.write(text));
}
