/**
 * Restricted YAML reader for Skill manifests (Issue #1230)
 *
 * `SKILL_YAML_SAFE_PROFILE` (#1228) fixed the limits a manifest parser must
 * enforce but deliberately left the implementation open. This module closes it
 * with a parser for a *subset* of YAML rather than a configured general-purpose
 * one, for two reasons:
 *
 * - No dependency in the tree can enforce the profile. `js-yaml` (reachable
 *   only transitively, through `gray-matter`) has no depth, node-count or
 *   scalar-size bound and resolves anchors and merge keys by default, which is
 *   exactly the parser-bomb surface the profile exists to remove.
 * - A manifest is a closed document: schema_version 1 has no field that needs
 *   anchors, tags, flow collections or multiple documents. Everything outside
 *   the subset is therefore a rejection, not a parse.
 *
 * The subset is: one document, block mappings, block sequences, plain and
 * quoted scalars, literal/folded block scalars, empty flow collections and
 * comments. Anchors, aliases, merge keys, tags, non-empty flow collections,
 * complex keys and additional documents are refused with their own code so a
 * caller can tell "malicious" from "malformed".
 *
 * Parsed mappings have a null prototype: `__proto__` is rejected by the profile
 * *and* is inert if that check is ever weakened.
 *
 * @module lib/skills/safe-yaml
 */

import { SKILL_YAML_SAFE_PROFILE } from '@/lib/skills';

// =============================================================================
// Error vocabulary
// =============================================================================

/** Stable, client-safe reason codes for a rejected YAML document. */
export const SkillYamlErrorCode = {
  /** Document is larger than the profile's byte budget. */
  BYTES_LIMIT: 'SKILL_YAML_BYTES_LIMIT',
  /** Nesting is deeper than the profile allows. */
  DEPTH_LIMIT: 'SKILL_YAML_DEPTH_LIMIT',
  /** Document has more nodes than the profile allows. */
  NODE_LIMIT: 'SKILL_YAML_NODE_LIMIT',
  /** A single scalar is longer than the profile allows. */
  SCALAR_LIMIT: 'SKILL_YAML_SCALAR_LIMIT',
  /** An anchor (`&`) or alias (`*`) was used. */
  ALIAS_FORBIDDEN: 'SKILL_YAML_ALIAS_FORBIDDEN',
  /** A merge key (`<<`) was used. */
  MERGE_KEY_FORBIDDEN: 'SKILL_YAML_MERGE_KEY_FORBIDDEN',
  /** An explicit tag (`!`/`!!`) was used. */
  TAG_FORBIDDEN: 'SKILL_YAML_TAG_FORBIDDEN',
  /** The same key appears twice in one mapping. */
  DUPLICATE_KEY: 'SKILL_YAML_DUPLICATE_KEY',
  /** A key on the profile's forbidden list (prototype pollution) was used. */
  FORBIDDEN_KEY: 'SKILL_YAML_FORBIDDEN_KEY',
  /** The stream carries more than one document. */
  MULTIPLE_DOCUMENTS: 'SKILL_YAML_MULTIPLE_DOCUMENTS',
  /** Bytes are not valid UTF-8, or carry a BOM or a control character. */
  ENCODING: 'SKILL_YAML_ENCODING',
  /** A construct outside the supported subset was used. */
  UNSUPPORTED: 'SKILL_YAML_UNSUPPORTED',
  /** The document does not parse as the supported subset. */
  SYNTAX: 'SKILL_YAML_SYNTAX',
} as const;

export type SkillYamlErrorCodeType = (typeof SkillYamlErrorCode)[keyof typeof SkillYamlErrorCode];

const MESSAGES: Record<SkillYamlErrorCodeType, string> = {
  [SkillYamlErrorCode.BYTES_LIMIT]: 'YAML document exceeds the size limit',
  [SkillYamlErrorCode.DEPTH_LIMIT]: 'YAML document is nested too deeply',
  [SkillYamlErrorCode.NODE_LIMIT]: 'YAML document has too many nodes',
  [SkillYamlErrorCode.SCALAR_LIMIT]: 'YAML scalar exceeds the length limit',
  [SkillYamlErrorCode.ALIAS_FORBIDDEN]: 'YAML anchors and aliases are not accepted',
  [SkillYamlErrorCode.MERGE_KEY_FORBIDDEN]: 'YAML merge keys are not accepted',
  [SkillYamlErrorCode.TAG_FORBIDDEN]: 'YAML tags are not accepted',
  [SkillYamlErrorCode.DUPLICATE_KEY]: 'YAML mapping declares the same key twice',
  [SkillYamlErrorCode.FORBIDDEN_KEY]: 'YAML mapping uses a forbidden key',
  [SkillYamlErrorCode.MULTIPLE_DOCUMENTS]: 'YAML stream carries more than one document',
  [SkillYamlErrorCode.ENCODING]: 'YAML document is not valid UTF-8 text',
  [SkillYamlErrorCode.UNSUPPORTED]: 'YAML document uses an unsupported construct',
  [SkillYamlErrorCode.SYNTAX]: 'YAML document could not be parsed',
};

/**
 * A rejected YAML document.
 *
 * Carries a line number but never the offending text: a manifest can embed
 * anything, and echoing it back would turn the parser into a reflection gadget.
 */
export class SkillYamlError extends Error {
  readonly code: SkillYamlErrorCodeType;
  /** 1-based line the rejection was raised at, when known. */
  readonly line?: number;

  constructor(code: SkillYamlErrorCodeType, line?: number) {
    super(MESSAGES[code]);
    this.name = 'SkillYamlError';
    this.code = code;
    if (line !== undefined) this.line = line;
  }
}

/** Narrow an unknown thrown value to a {@link SkillYamlError}. */
export function isSkillYamlError(value: unknown): value is SkillYamlError {
  return value instanceof SkillYamlError;
}

// =============================================================================
// Profile
// =============================================================================

/** The bounds and refusals a parse run enforces. */
export interface SkillYamlProfile {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxScalarLength: number;
  readonly allowAliases: boolean;
  readonly allowCustomTags: boolean;
  readonly allowDuplicateKeys: boolean;
  readonly forbiddenKeys: readonly string[];
}

// =============================================================================
// Lexing
// =============================================================================

interface Line {
  /** 1-based source line number. */
  readonly number: number;
  /** Raw text without the line terminator. */
  readonly raw: string;
  /** Leading space count. */
  indent: number;
  /** Text after the indent, comments still attached. */
  content: string;
  readonly significant: boolean;
}

const KEY_HEAD =
  /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]|$)/;

function decodeUtf8(input: string | Uint8Array, maxBytes: number): string {
  const byteLength =
    typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (byteLength > maxBytes) throw new SkillYamlError(SkillYamlErrorCode.BYTES_LIMIT);
  if (typeof input === 'string') return input;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(input);
  } catch {
    throw new SkillYamlError(SkillYamlErrorCode.ENCODING);
  }
}

/** Split into lines, rejecting anything that is not plain UTF-8 text. */
function toLines(text: string): Line[] {
  if (text.includes('\uFEFF')) throw new SkillYamlError(SkillYamlErrorCode.ENCODING);
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) throw new SkillYamlError(SkillYamlErrorCode.ENCODING);

  const lines: Line[] = [];
  const rawLines = normalized.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const number = i + 1;
    for (let j = 0; j < raw.length; j++) {
      const code = raw.charCodeAt(j);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
        throw new SkillYamlError(SkillYamlErrorCode.ENCODING, number);
      }
    }
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    if (raw[indent] === '\t') throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, number);
    const content = raw.slice(indent);
    lines.push({
      number,
      raw,
      indent,
      content,
      significant: content.length > 0 && !content.startsWith('#'),
    });
  }
  return lines;
}

/**
 * Drop a trailing comment, honouring quotes.
 *
 * `summary: "a # b"` keeps its hash; `summary: a # b` does not.
 */
function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i);
    }
  }
  return text;
}

// =============================================================================
// Parser
// =============================================================================

class Parser {
  private readonly lines: Line[];
  private readonly profile: SkillYamlProfile;
  private cursor = 0;
  private nodes = 0;
  private documentEnded = false;
  private documentStarted = false;

  constructor(lines: Line[], profile: SkillYamlProfile) {
    this.lines = lines;
    this.profile = profile;
  }

  parseDocument(): unknown {
    const first = this.peek();
    if (!first) return null;
    if (first.indent !== 0) throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, first.number);
    const value = this.parseNode(0, 1);
    this.skipToSignificant();
    const trailing = this.peek();
    if (trailing) throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, trailing.number);
    return value;
  }

  // ---------------------------------------------------------------------------
  // Cursor
  // ---------------------------------------------------------------------------

  private skipToSignificant(): void {
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (!line.significant) {
        this.cursor++;
        continue;
      }
      const trimmed = line.content.trim();
      if (trimmed === '...') {
        this.documentEnded = true;
        this.cursor++;
        continue;
      }
      if (trimmed === '---') {
        // Only the marker that opens the stream is a document start; a later one
        // begins a second document, which this parser never accepts.
        if (this.documentStarted) {
          throw new SkillYamlError(SkillYamlErrorCode.MULTIPLE_DOCUMENTS, line.number);
        }
        this.documentStarted = true;
        this.cursor++;
        continue;
      }
      if (this.documentEnded) {
        throw new SkillYamlError(SkillYamlErrorCode.MULTIPLE_DOCUMENTS, line.number);
      }
      this.documentStarted = true;
      return;
    }
  }

  private peek(): Line | null {
    this.skipToSignificant();
    return this.cursor < this.lines.length ? this.lines[this.cursor] : null;
  }

  private countNode(line: Line): void {
    this.nodes++;
    if (this.nodes > this.profile.maxNodes) {
      throw new SkillYamlError(SkillYamlErrorCode.NODE_LIMIT, line.number);
    }
  }

  private checkDepth(depth: number, line: Line): void {
    if (depth > this.profile.maxDepth) {
      throw new SkillYamlError(SkillYamlErrorCode.DEPTH_LIMIT, line.number);
    }
  }

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------

  private parseNode(indent: number, depth: number): unknown {
    const line = this.peek();
    if (!line) return null;
    this.checkDepth(depth, line);
    return this.isSequenceEntry(line.content)
      ? this.parseSequence(indent, depth)
      : this.parseMapping(indent, depth);
  }

  private isSequenceEntry(content: string): boolean {
    return content === '-' || content.startsWith('- ');
  }

  private parseMapping(indent: number, depth: number): Record<string, unknown> {
    const result = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();

    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
      if (this.isSequenceEntry(line.content)) {
        throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
      }
      this.countNode(line);

      const key = this.readKey(line);
      if (seen.has(key) && !this.profile.allowDuplicateKeys) {
        throw new SkillYamlError(SkillYamlErrorCode.DUPLICATE_KEY, line.number);
      }
      seen.add(key);

      const colon = line.content.indexOf(':', this.keyTokenLength(line.content));
      const rest = stripComment(line.content.slice(colon + 1)).trim();
      this.cursor++;
      result[key] = this.parseValue(rest, indent, depth, line);
    }
    return result;
  }

  private parseSequence(indent: number, depth: number): unknown[] {
    const result: unknown[] = [];

    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
      if (!this.isSequenceEntry(line.content)) break;
      this.countNode(line);

      const rest = line.content === '-' ? '' : line.content.slice(2);
      const offset = line.content.length - rest.length;
      const trimmedRest = stripComment(rest).trim();

      if (trimmedRest === '') {
        this.cursor++;
        result.push(this.parseIndentedValue(indent, depth + 1, line));
        continue;
      }
      if (this.isSequenceEntry(trimmedRest)) {
        throw new SkillYamlError(SkillYamlErrorCode.UNSUPPORTED, line.number);
      }
      if (KEY_HEAD.test(rest.trimStart())) {
        // Re-anchor `- key: value` as a mapping line at the item's own indent so
        // its sibling keys on following lines line up with it.
        const itemIndent = indent + offset + (rest.length - rest.trimStart().length);
        line.indent = itemIndent;
        line.content = rest.trimStart();
        this.checkDepth(depth + 1, line);
        result.push(this.parseMapping(itemIndent, depth + 1));
        continue;
      }
      this.cursor++;
      this.countNode(line);
      result.push(this.parseScalar(trimmedRest, line));
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Keys and values
  // ---------------------------------------------------------------------------

  private keyTokenLength(content: string): number {
    if (content.startsWith('"') || content.startsWith("'")) {
      const quote = content[0];
      for (let i = 1; i < content.length; i++) {
        if (quote === '"' && content[i] === '\\') {
          i++;
          continue;
        }
        if (content[i] === quote) return i + 1;
      }
    }
    return 0;
  }

  private readKey(line: Line): string {
    const content = line.content;
    if (content.startsWith('<<')) {
      throw new SkillYamlError(SkillYamlErrorCode.MERGE_KEY_FORBIDDEN, line.number);
    }
    if (content.startsWith('&') || content.startsWith('*')) {
      throw new SkillYamlError(SkillYamlErrorCode.ALIAS_FORBIDDEN, line.number);
    }
    if (content.startsWith('!')) {
      throw new SkillYamlError(SkillYamlErrorCode.TAG_FORBIDDEN, line.number);
    }
    if (content.startsWith('?') || content.startsWith('[') || content.startsWith('{')) {
      throw new SkillYamlError(SkillYamlErrorCode.UNSUPPORTED, line.number);
    }
    if (!KEY_HEAD.test(content)) {
      throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
    }

    const tokenLength = this.keyTokenLength(content);
    const colon = content.indexOf(':', tokenLength);
    const rawKey = content.slice(0, colon).trim();
    const key =
      rawKey.startsWith('"') || rawKey.startsWith("'")
        ? this.parseQuoted(rawKey, line)
        : rawKey;

    if (key.length > this.profile.maxScalarLength) {
      throw new SkillYamlError(SkillYamlErrorCode.SCALAR_LIMIT, line.number);
    }
    if (this.profile.forbiddenKeys.includes(key)) {
      throw new SkillYamlError(SkillYamlErrorCode.FORBIDDEN_KEY, line.number);
    }
    return key;
  }

  private parseValue(rest: string, indent: number, depth: number, line: Line): unknown {
    if (rest === '') {
      const next = this.peek();
      if (next && next.indent === indent && this.isSequenceEntry(next.content)) {
        this.checkDepth(depth + 1, next);
        return this.parseSequence(indent, depth + 1);
      }
      return this.parseIndentedValue(indent, depth + 1, line);
    }
    if (rest[0] === '|' || rest[0] === '>') {
      return this.parseBlockScalar(rest, indent, line);
    }
    this.countNode(line);
    return this.parseScalar(rest, line);
  }

  /** Read the nested block owned by a line, or null when there is none. */
  private parseIndentedValue(indent: number, depth: number, owner: Line): unknown {
    const next = this.peek();
    if (!next || next.indent <= indent) {
      this.countNode(owner);
      return null;
    }
    this.checkDepth(depth, next);
    return this.parseNode(next.indent, depth);
  }

  // ---------------------------------------------------------------------------
  // Scalars
  // ---------------------------------------------------------------------------

  private parseScalar(raw: string, line: Line): unknown {
    if (raw.startsWith('&') || raw.startsWith('*')) {
      throw new SkillYamlError(SkillYamlErrorCode.ALIAS_FORBIDDEN, line.number);
    }
    if (raw.startsWith('!')) {
      throw new SkillYamlError(SkillYamlErrorCode.TAG_FORBIDDEN, line.number);
    }
    if (raw === '[]') {
      this.countNode(line);
      return [];
    }
    if (raw === '{}') {
      this.countNode(line);
      return Object.create(null) as Record<string, unknown>;
    }
    if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('%') || raw.startsWith('`')) {
      throw new SkillYamlError(SkillYamlErrorCode.UNSUPPORTED, line.number);
    }
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const value = this.parseQuoted(raw, line);
      this.checkScalarLength(value, line);
      return value;
    }
    this.checkScalarLength(raw, line);
    return this.resolvePlain(raw);
  }

  private checkScalarLength(value: string, line: Line): void {
    if (value.length > this.profile.maxScalarLength) {
      throw new SkillYamlError(SkillYamlErrorCode.SCALAR_LIMIT, line.number);
    }
  }

  private resolvePlain(raw: string): unknown {
    if (raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
    if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
    if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;
    if (/^-?(?:0|[1-9][0-9]*)$/.test(raw)) {
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) ? parsed : raw;
    }
    if (/^-?(?:0|[1-9][0-9]*)\.[0-9]+$/.test(raw)) return Number(raw);
    return raw;
  }

  private parseQuoted(raw: string, line: Line): string {
    const quote = raw[0];
    if (raw.length < 2 || !raw.endsWith(quote)) {
      throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
    }
    const body = raw.slice(1, -1);

    if (quote === "'") {
      let out = '';
      for (let i = 0; i < body.length; i++) {
        if (body[i] === "'") {
          if (body[i + 1] !== "'") throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
          i++;
        }
        out += body[i];
      }
      return out;
    }

    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch !== '\\') {
        if (ch === '"') throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
        out += ch;
        continue;
      }
      const escape = body[++i];
      switch (escape) {
        case '"':
        case '\\':
        case '/':
          out += escape;
          break;
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'u': {
          const hex = body.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new SkillYamlError(SkillYamlErrorCode.SYNTAX, line.number);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          throw new SkillYamlError(SkillYamlErrorCode.UNSUPPORTED, line.number);
      }
    }
    return out;
  }

  /** Literal (`|`) and folded (`>`) block scalars with `-`/`+` chomping. */
  private parseBlockScalar(header: string, indent: number, owner: Line): string {
    const match = /^([|>])([-+]?)$/.exec(header.trim());
    if (!match) throw new SkillYamlError(SkillYamlErrorCode.UNSUPPORTED, owner.number);
    const [, style, chomp] = match;

    const collected: string[] = [];
    let blockIndent = -1;
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      const isBlank = line.raw.trim() === '';
      if (!isBlank && line.indent <= indent) break;
      if (!isBlank && blockIndent === -1) blockIndent = line.indent;
      collected.push(isBlank ? '' : line.raw.slice(blockIndent));
      this.cursor++;
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();

    this.countNode(owner);
    let body: string;
    if (style === '|') {
      body = collected.join('\n');
    } else {
      body = collected.reduce((acc, current, index) => {
        if (index === 0) return current;
        const previous = collected[index - 1];
        if (current === '' || previous === '') return `${acc}\n${current}`;
        return `${acc} ${current}`;
      }, '');
    }
    if (chomp !== '-' && collected.length > 0) body += '\n';
    this.checkScalarLength(body, owner);
    return body;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Parse a YAML document under the safe profile.
 *
 * @param input Document bytes or text
 * @param profile Bounds to enforce; defaults to {@link SKILL_YAML_SAFE_PROFILE}
 * @returns The parsed value; mappings have a null prototype
 * @throws SkillYamlError for every rejection, including plain syntax errors
 */
export function parseSkillYaml(
  input: string | Uint8Array,
  profile: SkillYamlProfile = SKILL_YAML_SAFE_PROFILE
): unknown {
  if (profile.allowAliases || profile.allowCustomTags) {
    // The subset has no way to honour aliases or tags, so a profile that asks
    // for them would silently under-enforce rather than parse them.
    throw new SkillYamlError(SkillYamlErrorCode.UNSUPPORTED);
  }
  const text = decodeUtf8(input, profile.maxBytes);
  return new Parser(toLines(text), profile).parseDocument();
}

/**
 * Extract and parse the YAML frontmatter of a Markdown document.
 *
 * Used for `SKILL.md`, whose frontmatter must agree with the manifest. The
 * frontmatter is parsed under the same profile as the manifest: it is authored
 * by the same untrusted publisher.
 *
 * @returns The parsed frontmatter, or null when the document has none
 * @throws SkillYamlError when frontmatter is present but violates the profile
 */
export function parseSkillFrontmatter(
  markdown: string,
  profile: SkillYamlProfile = SKILL_YAML_SAFE_PROFILE
): unknown {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return null;
  return parseSkillYaml(normalized.slice(4, end + 1), profile);
}
