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

export type SceneType = 'card' | 'record';
export type Viewport = 'pc' | 'mobile';
export const LOCALES = ['ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export interface StoryboardScene {
  id: string;
  type: SceneType;
  duration: number;
  viewport: Viewport;
  telop: Record<Locale, string>;
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
};

/** Sub-frame slop: durations are authored in whole seconds but summed as floats. */
const DURATION_EPSILON = 1e-6;

export function countEnglishWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function readScene(raw: YamlValue, index: number, errors: string[]): StoryboardScene | null {
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
  if (type !== 'card' && type !== 'record') {
    errors.push(`${where} (${id}): type must be 'card' or 'record', got ${JSON.stringify(type)}`);
    return null;
  }
  const duration = map.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    errors.push(`${where} (${id}): duration must be a positive number, got ${JSON.stringify(duration)}`);
    return null;
  }

  let viewport: Viewport = 'pc';
  if (map.viewport !== undefined) {
    if (type === 'card') {
      errors.push(`${where} (${id}): a card scene is not recorded, so it must not declare a viewport`);
      return null;
    }
    if (map.viewport !== 'pc' && map.viewport !== 'mobile') {
      errors.push(`${where} (${id}): viewport must be 'pc' or 'mobile', got ${JSON.stringify(map.viewport)}`);
      return null;
    }
    viewport = map.viewport;
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

  return { id, type, duration, viewport, telop };
}

export interface ValidationResult {
  storyboard: Storyboard | null;
  errors: string[];
}

/**
 * @param implementedSceneIds ids `record-scenes.ts` can actually film. The
 * correspondence is checked in both directions: an unimplemented id would fail
 * at record time, and an implemented-but-unused id would silently drop footage
 * the storyboard never places.
 */
export function validateStoryboard(
  raw: YamlValue,
  implementedSceneIds: string[] = SCENES.map((scene) => scene.id),
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
    const scene = readScene(rawScene, index, errors);
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
  const unused = implemented.filter((id) => !recorded.includes(id));
  if (missing.length > 0) {
    errors.push(
      `record scene(s) with no implementation in record-scenes.ts: ${missing.join(', ')}` +
        ` (implemented: ${implemented.join(', ') || '<none>'})`,
    );
  }
  if (unused.length > 0) {
    errors.push(`scene(s) implemented in record-scenes.ts but absent from the storyboard: ${unused.join(', ')}`);
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

export function parseStoryboard(text: string, implementedSceneIds?: string[]): ValidationResult {
  let raw: YamlValue;
  try {
    raw = parseYamlSubset(text);
  } catch (error) {
    return { storyboard: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
  return validateStoryboard(raw, implementedSceneIds);
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
  const { storyboard, errors } = parseStoryboard(fs.readFileSync(options.file, 'utf8'));
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
