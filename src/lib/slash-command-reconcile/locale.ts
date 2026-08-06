/**
 * Slash Command Catalog reconcile — locale dictionary I/O helpers (Issue #1704)
 *
 * The runner used to own these inline. They moved here so the write side and the
 * read side can be exercised together: a `descriptionKey` is only useful if the
 * key the engine mints is the key the renderer can resolve, and once keys stopped
 * being derivable from the command name (tool-scoped overrides) that round trip
 * is worth pinning in a test rather than assuming.
 *
 * Pure data manipulation — no filesystem access; the runner still owns read/write.
 */

import type { LocaleAddition } from './types';

/** A locale namespace as shipped in locales/{en,ja}/worktree.json. */
export type LocaleDictionary = Record<string, unknown>;

/**
 * Set a dotted key (e.g. slashCommands.descriptions.loop) inside a dictionary.
 *
 * A node in the path that is not an object is replaced by one. That is what
 * turns a flat `descriptions.btw` string into the `descriptions.btw.<tool>`
 * object a contested command needs, and it is only ever reached when the engine
 * decided to split that key.
 */
export function setNestedValue(dict: LocaleDictionary, dottedKey: string, value: string): void {
  const parts = dottedKey.split('.');
  let node: Record<string, unknown> = dict;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = node[key];
    if (!next || typeof next !== 'object') {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Resolve a dotted key against a dictionary, the way a namespace-scoped
 * next-intl translator does. Returns undefined when the path is missing or
 * lands on a non-string node.
 */
export function lookupNestedValue(dict: unknown, dottedKey: string): string | undefined {
  let node: unknown = dict;
  for (const part of dottedKey.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Flatten a dictionary to dotted key → string pairs.
 *
 * Feeds the engine the text a key already ships, so it can tell "this tool wants
 * the key another tool already owns" from "this key is free".
 */
export function flattenDictionary(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return prefix ? { [prefix]: value } : {};
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flattenDictionary(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/** Merge locale additions into `dict` in place, picking the language to write. */
export function applyLocaleAdditions(
  dict: LocaleDictionary,
  additions: LocaleAddition[],
  pick: (addition: LocaleAddition) => string
): LocaleDictionary {
  for (const addition of additions) {
    setNestedValue(dict, addition.key, pick(addition));
  }
  return dict;
}
