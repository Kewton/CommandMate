/**
 * Codex writes into the profile it runs under (Issue #4136): the role must survive
 * that, and nothing else may pass.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  inspectRoleArtifact,
  writeRoleArtifact,
  type ArtifactOptions,
} from '@/lib/agent-roles/artifacts';
import { AGENT_ROLE_CLI_TOOLS } from '@/types/agent-roles';

const NAME = 'cm-role-ns-0011223344556677-abababababab';
const BODY = 'Start with ROLESTAMP.\n\n日本語 " \\ \t   😀\n';
/** What 0.166.0 appended when the folder-trust screen was answered (UAT of Epic #4112). */
const TRUST_TABLE = '\n[projects."/work/role-uat-sample"]\ntrust_level = "trusted"\n';

describe('a Codex profile the CLI has written into', () => {
  let base: string;
  let options: ArtifactOptions;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cm-role-4136-'));
    options = {
      dataRoot: join(base, 'data'),
      codexHome: join(base, 'codex'),
      copilotHome: join(base, 'copilot'),
      antigravityAgentsDir: join(base, 'gemini', 'config', 'agents'),
      env: {},
    };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const write = () => writeRoleArtifact({ adapter: 'codex', name: NAME, instructions: BODY }, options);
  const inspect = (path: string, expectedFingerprint: string) =>
    inspectRoleArtifact({ adapter: 'codex', name: NAME, path, expectedFingerprint }, options);

  it('reuses the file after the folder trust was saved in it, and leaves it alone', () => {
    const first = write();
    appendFileSync(first.path, TRUST_TABLE);
    const after = readFileSync(first.path);

    const second = write();

    expect(second).toMatchObject({ reused: true, artifactFingerprint: first.artifactFingerprint });
    expect(() => inspect(first.path, first.artifactFingerprint)).not.toThrow();
    expect(readFileSync(first.path).equals(after)).toBe(true);
  });

  it('accepts keys the CLI adds in front of the text too', () => {
    const first = write();
    writeFileSync(first.path, `model = "gpt"\n${readFileSync(first.path, 'utf8')}${TRUST_TABLE}`);
    expect(() => inspect(first.path, first.artifactFingerprint)).not.toThrow();
  });

  it.each([
    ['the text changed', 'developer_instructions = "something else"\n', 'content-mismatch'],
    ['the text is gone', TRUST_TABLE, 'content-mismatch'],
    ['the text is not a string', 'developer_instructions = 1\n', 'content-mismatch'],
    ['it is not TOML', 'developer_instructions = "unterminated\n', 'content-mismatch'],
  ])('refuses the file when %s', (_label, content, code) => {
    const first = write();
    writeFileSync(first.path, content);
    expect(() => inspect(first.path, first.artifactFingerprint)).toThrow(expect.objectContaining({ code }));
    expect(() => write()).toThrow(expect.objectContaining({ code }));
  });

  it('never quotes the body when the TOML does not parse', () => {
    const first = write();
    writeFileSync(first.path, 'developer_instructions = "SECRETBODY\n');
    expect(() => inspect(first.path, first.artifactFingerprint)).toThrow(/^(?!.*SECRETBODY)/s);
  });

  it.each(AGENT_ROLE_CLI_TOOLS.filter((tool) => tool !== 'codex'))('%s: one added byte is still refused', (adapter) => {
    const first = writeRoleArtifact({ adapter, name: NAME, instructions: BODY }, options);
    appendFileSync(first.path, '\n');
    expect(() =>
      inspectRoleArtifact({ adapter, name: NAME, path: first.path, expectedFingerprint: first.artifactFingerprint }, options)
    ).toThrow(expect.objectContaining({ code: 'content-mismatch' }));
  });
});
