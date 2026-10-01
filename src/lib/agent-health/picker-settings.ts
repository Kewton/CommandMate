/**
 * The user's model / effort settings around `screen-picker` (Issue #3053).
 *
 * The probe only ever sends Esc to a picker, but a picker confirmed by mistake
 * writes the user's default model or effort. So the values are read before and
 * after the tool's run and compared; a change is a script failure (exit 2).
 * Nothing is written back — the change might be the user's own.
 *
 * Pure: the caller reads the files, these functions read the text.
 */

export type PickerSettingsFormat = 'json' | 'toml';

/** Key → value as text; null when the key (or the file) is absent or unreadable. */
export type PickerSettingsValues = Record<string, string | null>;

function emptyValues(keys: readonly string[]): PickerSettingsValues {
  return Object.fromEntries(keys.map((key) => [key, null]));
}

function readJson(text: string, keys: readonly string[]): PickerSettingsValues {
  const values = emptyValues(keys);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return values;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return values;
  for (const key of keys) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value === undefined) continue;
    values[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return values;
}

/** The top-level keys only (before the first `[table]`), which is where codex keeps `model`. */
function readTomlTopLevel(text: string, keys: readonly string[]): PickerSettingsValues {
  const values = emptyValues(keys);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const match = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1].replace(/^"(.*)"$/, '$1');
    if (!keys.includes(key)) continue;
    const raw = match[2].replace(/\s+#.*$/, '').trim();
    values[key] = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return values;
}

/**
 * The watched keys of a settings file.
 *
 * @param text - the file's content, or null when it does not exist
 */
export function readPickerSettings(
  text: string | null,
  format: PickerSettingsFormat,
  keys: readonly string[]
): PickerSettingsValues {
  if (text === null) return emptyValues(keys);
  return format === 'json' ? readJson(text, keys) : readTomlTopLevel(text, keys);
}

/** One line per key whose value differs (`model: "a" → "b"`); empty when nothing changed. */
export function describePickerSettingsChanges(
  before: PickerSettingsValues,
  after: PickerSettingsValues
): string[] {
  const show = (value: string | null | undefined) => (value === null || value === undefined ? '（無し）' : JSON.stringify(value));
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((key) => (before[key] ?? null) !== (after[key] ?? null))
    .map((key) => `${key}: ${show(before[key])} → ${show(after[key])}`);
}
