/**
 * Issue #4548: the role canon in docs/orchestrate/roles is what the database can hold.
 *
 * That the database holds the same bytes is not checked here (CI cannot reach a
 * database): `node scripts/orchestrate/roles-sync.mjs check` does that. Private values
 * in these files are checked by orchestrate-memory-move-4403, whose publicDocs()
 * takes in docs/orchestrate/roles.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANON_ROLES } from '../../../scripts/orchestrate/roles-sync.mjs';
import { MAX_ROLE_BODY_BYTES } from '../../../src/types/agent-roles';

const ROLES_DIR = path.resolve(__dirname, '../../../docs/orchestrate/roles');

describe('docs/orchestrate/roles canon (#4548)', () => {
  it('C1: holds the four canon roles and no other .md', () => {
    const md = fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md')).sort();
    expect(md).toEqual(CANON_ROLES.map((n: string) => `${n}.md`).sort());
  });

  it.each(CANON_ROLES as readonly string[])('C2: %s.md fits MAX_ROLE_BODY_BYTES', (name) => {
    const bytes = fs.readFileSync(path.join(ROLES_DIR, `${name}.md`)).length;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(MAX_ROLE_BODY_BYTES);
  });

  it.each(CANON_ROLES as readonly string[])('C3: %s.md is valid UTF-8 with no CR', (name) => {
    const buf = fs.readFileSync(path.join(ROLES_DIR, `${name}.md`));
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(buf)).not.toThrow();
    expect(buf.includes(0x0d)).toBe(false);
  });
});
