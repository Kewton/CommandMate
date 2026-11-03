/**
 * The TOML this feature writes: `key = "basic string"` lines, and a reader for
 * exactly that (#4114 decided against a new dependency).
 *
 * The reader's job is the read-back check of a generated profile (§5), so it is
 * strict: anything outside this subset throws rather than being guessed at. It
 * is NOT a reader for a user's `config.toml`, which may use tables, literal and
 * multi-line strings.
 *
 * @module lib/agent-roles/toml-basic
 */

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** A TOML basic string. `JSON.stringify` is not one: it leaves U+007F raw. */
export function toTomlBasicString(value: string): string {
  if (!value.isWellFormed()) throw new Error('A lone surrogate has no TOML spelling');
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/** One `key = "value"` line per entry. */
export function renderTomlBasicDocument(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => {
      if (!BARE_KEY.test(key)) throw new Error('Not a bare TOML key');
      return `${key} = ${toTomlBasicString(value)}\n`;
    })
    .join('');
}

const SIMPLE_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/** Read the basic string opening at `start`. Answers the value and the index after the close. */
function readBasicString(line: string, start: number): { value: string; end: number } {
  let value = '';
  let index = start + 1;
  while (index < line.length) {
    const char = line[index];
    if (char === '"') return { value, end: index + 1 };
    if (char === '\\') {
      const escape = line[index + 1];
      if (escape === 'u' || escape === 'U') {
        const width = escape === 'u' ? 4 : 8;
        const hex = line.slice(index + 2, index + 2 + width);
        if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) throw new Error('Invalid unicode escape');
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Not a Unicode scalar value');
        value += String.fromCodePoint(code);
        index += 2 + width;
        continue;
      }
      const simple = SIMPLE_ESCAPES[escape];
      if (simple === undefined) throw new Error('Invalid escape');
      value += simple;
      index += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if ((code < 0x20 && char !== '\t') || code === 0x7f) throw new Error('Raw control character');
    value += char;
    index += 1;
  }
  throw new Error('Unterminated string');
}

/**
 * Read a document of `key = "basic string"` lines, comments and blank lines.
 *
 * @throws Error on anything else. The message names the line, never its content,
 *   since a line of a generated file holds the role's body.
 */
export function parseTomlBasicDocument(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  text.split('\n').forEach((rawLine, lineIndex) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const fail = (why: string): never => {
      throw new Error(`Line ${lineIndex + 1}: ${why}`);
    };
    const equals = line.indexOf('=');
    if (equals === -1) fail('expected key = "value"');
    const key = line.slice(0, equals).trim();
    if (!BARE_KEY.test(key)) fail('invalid key');
    const open = equals + 1 + (line.slice(equals + 1).length - line.slice(equals + 1).trimStart().length);
    if (line[open] !== '"' || line.startsWith('"""', open)) fail('expected a basic string');
    let parsed: { value: string; end: number } | undefined;
    try {
      parsed = readBasicString(line, open);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'invalid string');
    }
    const { value, end } = parsed as { value: string; end: number };
    const rest = line.slice(end).trim();
    if (rest !== '' && !rest.startsWith('#')) fail('unexpected text after the value');
    if (Object.prototype.hasOwnProperty.call(entries, key)) fail('duplicate key');
    Object.defineProperty(entries, key, { value, enumerable: true, writable: true, configurable: true });
  });
  return entries;
}
