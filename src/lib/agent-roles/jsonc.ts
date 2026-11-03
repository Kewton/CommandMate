/**
 * Reading the JSONC an OpenCode config is written in (§7.1): JSON with comments and
 * trailing commas. For reading only. A failure says where, never what: the text can
 * hold an API key.
 *
 * @module lib/agent-roles/jsonc
 */

/** Remove comments and trailing commas, leaving strings as they are. */
function stripJsonc(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === '\\' ? 2 : 1;
      }
      index += 1;
      out += text.slice(start, index);
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close === -1) throw new Error('Unterminated comment');
      index = close + 2;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      for (;;) {
        while (next < text.length && /\s/.test(text[next])) next += 1;
        if (text[next] === '/' && text[next + 1] === '/') {
          while (next < text.length && text[next] !== '\n') next += 1;
          continue;
        }
        if (text[next] === '/' && text[next + 1] === '*') {
          const close = text.indexOf('*/', next + 2);
          if (close === -1) throw new Error('Unterminated comment');
          next = close + 2;
          continue;
        }
        break;
      }
      if (text[next] === '}' || text[next] === ']') {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Parse a JSONC document that must be an object.
 *
 * @throws Error when it is not, with a message that quotes nothing from the text
 */
export function parseJsoncObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    throw new Error('not valid JSONC');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  return parsed as Record<string, unknown>;
}
