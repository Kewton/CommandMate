/**
 * Issue #3031: codex's `$CODEX_HOME/config.toml` is TOML, but the trust-state
 * restore read it with `JSON.parse`, so it always failed with
 * `… is not valid JSON` and left whatever the run changed in place.
 *
 * The codex entry now compares the file with the run's own
 * `[projects."<temp dir>"]` tables taken out line by line. A throwaway dir
 * stands in for `CODEX_HOME` — never the real `~/.codex/`. The before/after
 * shapes are the ones measured on codex 0.159.1, in
 * `tests/fixtures/codex-config-toml-3031/`.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  restoreTrustState,
  sameJsonWithoutMarker,
  sameTomlWithoutMarker,
  snapshotFile,
  tomlLinesWithoutMarker,
} from '@/lib/agent-health/config-guard';
import { TOOL_PROBE_SPECS } from '../../../../scripts/agent-health/tool-table';

const MARKER = 'cm-agent-health-';
const FIXTURES = path.resolve(__dirname, '../../../fixtures/codex-config-toml-3031');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

let codexHome: string;
let savedCodexHome: string | undefined;

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-codex-home-'));
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(codexHome, { recursive: true, force: true });
});

/** The codex spec's own `config.toml` entry, resolved against the throwaway CODEX_HOME. */
function codexConfigEntry(): { path: string; compare: typeof sameTomlWithoutMarker } {
  const entry = TOOL_PROBE_SPECS.codex.guardedFiles().trustState.find(
    (file) => typeof file !== 'string' && path.basename(file.path) === 'config.toml'
  );
  if (entry === undefined || typeof entry === 'string') throw new Error('codex config.toml entry missing');
  return entry;
}

describe('codex config.toml trust-state restore (Issue #3031)', () => {
  it('the codex entry points at $CODEX_HOME/config.toml and compares as TOML', () => {
    const entry = codexConfigEntry();
    expect(entry.path).toBe(path.join(codexHome, 'config.toml'));
    expect(entry.compare).toBe(sameTomlWithoutMarker);
  });

  it('puts the bytes back when the run’s own [projects."<temp dir>"] table is the only change', () => {
    const { path: file, compare } = codexConfigEntry();
    const before = read('before.toml');
    fs.writeFileSync(file, before, { mode: 0o600 });
    const snapshot = snapshotFile(file);
    fs.writeFileSync(file, read('after-trust-dialog.toml'));

    const entry = restoreTrustState(snapshot, MARKER, compare);
    expect(entry).toEqual({ path: file, restored: true, kind: 'trust-state' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('leaves the file alone and says so when anything else changed too', () => {
    const { path: file, compare } = codexConfigEntry();
    fs.writeFileSync(file, read('before.toml'));
    const snapshot = snapshotFile(file);
    const after = read('after-nux-launch.toml');
    fs.writeFileSync(file, after);

    const entry = restoreTrustState(snapshot, MARKER, compare);
    expect(entry).toEqual({
      path: file,
      restored: false,
      kind: 'trust-state',
      detail: '実行中に別の変更が入ったため触っていない',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
  });

  it('no longer fails with "is not valid JSON" — the JSON comparison is what did', () => {
    const { path: file, compare } = codexConfigEntry();
    fs.writeFileSync(file, read('before.toml'));
    const snapshot = snapshotFile(file);
    fs.writeFileSync(file, read('after-trust-dialog.toml'));

    expect(restoreTrustState(snapshot, MARKER, sameJsonWithoutMarker).detail).toMatch(/not valid JSON/);
    expect(restoreTrustState(snapshot, MARKER, compare).restored).toBe(true);
  });

  it('a config.toml codex created holding only the run’s table is removed', () => {
    const { path: file, compare } = codexConfigEntry();
    const snapshot = snapshotFile(file);
    fs.writeFileSync(file, '[projects."/private/var/T/cm-agent-health-ab12/codex"]\ntrust_level = "trusted"\n');

    expect(restoreTrustState(snapshot, MARKER, compare).restored).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('an untouched file is not rewritten (sha256 path, mtime kept)', () => {
    const { path: file, compare } = codexConfigEntry();
    fs.writeFileSync(file, read('before.toml'));
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);

    expect(restoreTrustState(snapshotFile(file), MARKER, compare).restored).toBe(true);
    expect(fs.statSync(file).mtime.getTime()).toBe(past.getTime());
  });
});

describe('tomlLinesWithoutMarker', () => {
  it('drops a marked table from its header to the next header, and blank lines', () => {
    const toml = [
      'a = 1',
      '',
      '[projects."/private/var/T/cm-agent-health-x/codex"]',
      'trust_level = "trusted"',
      '',
      '[tui]',
      'b = 2',
    ].join('\n');
    expect(tomlLinesWithoutMarker(toml, MARKER)).toEqual(['a = 1', '[tui]', 'b = 2']);
  });

  it('drops a marked table that runs to EOF, and keeps unmarked tables and keys', () => {
    const toml = ['[x]', 'k = "cm"', '[projects."/T/cm-agent-health-y/codex"]', 'trust_level = "trusted"'].join('\r\n');
    expect(tomlLinesWithoutMarker(toml, MARKER)).toEqual(['[x]', 'k = "cm"']);
  });
});
