/**
 * Writing the generated files (Issue #4114, design §5).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  buildArtifactName,
  deriveServerNamespace,
  inspectRoleArtifact,
  MAX_ARTIFACT_NAME_LENGTH,
  renderRoleArtifact,
  resolveArtifactLocation,
  RoleArtifactError,
  writeRoleArtifact,
  type ArtifactOptions,
} from '@/lib/agent-roles/artifacts';
import { computeFingerprint } from '@/lib/agent-roles/fingerprint';
import { parseTomlBasicDocument, renderTomlBasicDocument, toTomlBasicString } from '@/lib/agent-roles/toml-basic';
import { UatIsolationLaunchRefusedError } from '@/config/uat-isolation';
import { AGENT_ROLE_CLI_TOOLS, type AgentRoleCliTool } from '@/types/agent-roles';

const FP = 'ab'.repeat(32);
const NAME = 'cm-role-ns-0011223344556677-abababababab';
/** Every character the design's format check (§8) exercised. */
const TRICKY = [
  'line one',
  'dq " sq \' bt ` tdq """ tsq \'\'\'',
  '---',
  '$HOME $(whoami) {file:/x} {env:Y} <tag>',
  '日本語 \t tab \\ backslash',
  'del \u007f ctrl \u0001 ls \u2028 emoji 😀',
  '',
].join('\n');

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

describe('role artifacts', () => {
  let base: string;
  let options: ArtifactOptions;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cm-role-artifacts-'));
    options = {
      dataRoot: join(base, 'data'),
      codexHome: join(base, 'codex'),
      copilotHome: join(base, 'copilot'),
      antigravityAgentsDir: join(base, 'gemini', 'config', 'agents'),
      env: {},
    };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function write(adapter: AgentRoleCliTool, instructions = 'be a marketer', name = NAME) {
    return writeRoleArtifact({ adapter, name, instructions }, options);
  }

  describe('names', () => {
    it('is namespace, role id and the head of the injection fingerprint', () => {
      expect(buildArtifactName({ namespace: 'ns', roleId: '0011223344556677', injectionFingerprint: FP })).toBe(NAME);
    });

    it('takes only lower-case alphanumerics and hyphens', () => {
      const args = { namespace: 'ns', roleId: 'r1', injectionFingerprint: FP };
      for (const namespace of ['', 'NS', 'n_s', 'n.s', 'n/s', '-ns', 'ns-', 'n s', 'ネーム']) {
        expect(() => buildArtifactName({ ...args, namespace }), namespace).toThrow(RoleArtifactError);
      }
      for (const roleId of ['', 'R1', '../x', 'a b']) {
        expect(() => buildArtifactName({ ...args, roleId }), roleId).toThrow(RoleArtifactError);
      }
    });

    it('takes only a full sha-256 hex as the fingerprint', () => {
      for (const injectionFingerprint of ['', 'ab', 'Z'.repeat(64), FP.toUpperCase()]) {
        expect(() => buildArtifactName({ namespace: 'ns', roleId: 'r1', injectionFingerprint })).toThrow(
          RoleArtifactError
        );
      }
    });

    it('enforces the length limit, exactly', () => {
      const prefixed = (roleId: string): string =>
        buildArtifactName({ namespace: 'ns', roleId, injectionFingerprint: FP });
      const fixed = 'cm-role-ns--abababababab'.length;
      expect(prefixed('r'.repeat(MAX_ARTIFACT_NAME_LENGTH - fixed))).toHaveLength(MAX_ARTIFACT_NAME_LENGTH);
      expect(() => prefixed('r'.repeat(MAX_ARTIFACT_NAME_LENGTH - fixed + 1))).toThrow(RoleArtifactError);
    });

    it('the server namespace is a stable hex label', () => {
      expect(deriveServerNamespace('/data/cm.db')).toMatch(/^[0-9a-f]{8}$/);
      expect(deriveServerNamespace('/data/cm.db')).toBe(deriveServerNamespace('/data/cm.db'));
      expect(deriveServerNamespace('/other.db')).not.toBe(deriveServerNamespace('/data/cm.db'));
    });

    it('the writer refuses a hand-built name that would escape the directory', () => {
      expect(() => write('claude', 'x', '../evil')).toThrow(RoleArtifactError);
      expect(() => write('codex', 'x', 'Evil')).toThrow(RoleArtifactError);
    });
  });

  describe('locations', () => {
    it.each([
      ['claude', 'data/claude', '.md'],
      ['command-code', 'data/command-code', '.ts'],
      ['opencode', 'data/opencode', '.md'],
      ['opencode-v2', 'data/opencode-v2', '.md'],
    ] as const)('%s lives under the data root', (adapter, dir, extension) => {
      expect(resolveArtifactLocation(adapter, NAME, options).path).toBe(join(base, dir, `${NAME}${extension}`));
    });

    it('codex, copilot and antigravity live where the CLI discovers them', () => {
      expect(resolveArtifactLocation('codex', NAME, options).path).toBe(join(base, 'codex', `${NAME}.config.toml`));
      expect(resolveArtifactLocation('copilot', NAME, options).path).toBe(
        join(base, 'copilot', 'agents', `${NAME}.agent.md`)
      );
      expect(resolveArtifactLocation('antigravity', NAME, options).path).toBe(
        join(base, 'gemini', 'config', 'agents', NAME, 'agent.md')
      );
    });

    it('moving the data root does not move a home, and moving a home does not move the root', () => {
      const moved = { ...options, dataRoot: join(base, 'elsewhere') };
      expect(resolveArtifactLocation('codex', NAME, moved).path).toBe(resolveArtifactLocation('codex', NAME, options).path);
      const movedHome = { ...options, codexHome: join(base, 'elsewhere') };
      expect(resolveArtifactLocation('claude', NAME, movedHome).path).toBe(
        resolveArtifactLocation('claude', NAME, options).path
      );
    });

    it('reuses the existing home resolvers and the setup-pinned defaults (never the real home)', () => {
      expect(resolveArtifactLocation('codex', NAME).path).toBe(join(process.env.CODEX_HOME!, `${NAME}.config.toml`));
      expect(resolveArtifactLocation('copilot', NAME).path).toBe(
        join(process.env.COPILOT_HOME!, 'agents', `${NAME}.agent.md`)
      );
      expect(resolveArtifactLocation('claude', NAME).path.startsWith(process.env.CM_AGENT_ROLE_ARTIFACTS_DIR!)).toBe(true);
      expect(
        resolveArtifactLocation('antigravity', NAME).path.startsWith(process.env.CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR!)
      ).toBe(true);
    });

    it('the antigravity default sits beside the hooks file the existing resolver names', () => {
      vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', '');
      const fakeHome = join(base, 'home');
      vi.stubEnv('HOME', fakeHome);
      try {
        expect(resolveArtifactLocation('antigravity', NAME).path).toBe(
          join(fakeHome, '.gemini', 'config', 'agents', NAME, 'agent.md')
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe.each(AGENT_ROLE_CLI_TOOLS)('%s', (adapter) => {
    it('writes 0600 under 0700 directories and answers the fingerprint of the bytes it wrote', () => {
      const result = write(adapter, TRICKY);
      expect(result.reused).toBe(false);
      const bytes = readFileSync(result.path);
      expect(result.artifactFingerprint).toBe(computeFingerprint(bytes));
      expect(mode(result.path)).toBe(0o600);
      expect(mode(dirname(result.path))).toBe(0o700);
      // Nothing beside it: the temporary file is gone.
      expect(readdirSync(dirname(result.path)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    });

    it('reuses the same content, and leaves the file untouched', () => {
      const first = write(adapter, TRICKY);
      const stamp = lstatSync(first.path).mtimeMs;
      const second = write(adapter, TRICKY);
      expect(second.reused).toBe(true);
      expect(second.artifactFingerprint).toBe(first.artifactFingerprint);
      expect(lstatSync(first.path).mtimeMs).toBe(stamp);
    });

    it('refuses different content under the same name and keeps the existing bytes', () => {
      const first = write(adapter, 'one');
      const before = readFileSync(first.path);
      expect(() => write(adapter, 'two')).toThrow(expect.objectContaining({ code: 'content-mismatch' }));
      expect(readFileSync(first.path)).toEqual(before);
    });

    it('refuses a symlink at the artifact path and does not touch its target', () => {
      const { path } = resolveArtifactLocation(adapter, NAME, options);
      const decoy = join(base, 'decoy');
      writeFileSync(decoy, 'precious');
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(decoy, path);
      expect(() => write(adapter)).toThrow(expect.objectContaining({ code: 'symlink' }));
      expect(readFileSync(decoy, 'utf8')).toBe('precious');
    });

    it('refuses an existing file readable by others', () => {
      const first = write(adapter);
      chmodSync(first.path, 0o644);
      expect(() => write(adapter)).toThrow(expect.objectContaining({ code: 'insecure-permissions' }));
    });

    it('refuses something that is not a regular file', () => {
      const { path } = resolveArtifactLocation(adapter, NAME, options);
      mkdirSync(path, { recursive: true });
      expect(() => write(adapter)).toThrow(expect.objectContaining({ code: 'not-regular-file' }));
    });

    it.each(['', '   \n'])('refuses the empty instructions %j rather than writing a file that means nothing', (text) => {
      expect(() => write(adapter, text)).toThrow(expect.objectContaining({ code: 'empty-instructions' }));
      expect(existsSync(resolveArtifactLocation(adapter, NAME, options).path)).toBe(false);
    });

    it('the pre-launch inspection passes on the file, then fails after it changes', () => {
      const result = write(adapter, TRICKY);
      inspectRoleArtifact({ adapter, name: NAME, path: result.path, expectedFingerprint: result.artifactFingerprint }, options);
      chmodSync(result.path, 0o600);
      writeFileSync(result.path, Buffer.concat([readFileSync(result.path), Buffer.from('tampered')]));
      expect(() =>
        inspectRoleArtifact({ adapter, name: NAME, path: result.path, expectedFingerprint: result.artifactFingerprint }, options)
      ).toThrow(expect.objectContaining({ code: 'content-mismatch' }));
    });

    it('the inspection refuses a missing file', () => {
      const { path } = resolveArtifactLocation(adapter, NAME, options);
      expect(() => inspectRoleArtifact({ adapter, name: NAME, path, expectedFingerprint: FP }, options)).toThrow(
        expect.objectContaining({ code: 'missing' })
      );
    });
  });

  it('refuses a symlinked directory of its own instead of writing through it', () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(options.dataRoot!, { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, join(options.dataRoot!, 'claude'));
    expect(() => write('claude')).toThrow(expect.objectContaining({ code: 'symlink' }));

    mkdirSync(options.copilotHome!, { recursive: true });
    symlinkSync(elsewhere, join(options.copilotHome!, 'agents'));
    expect(() => write('copilot')).toThrow(expect.objectContaining({ code: 'symlink' }));

    mkdirSync(dirname(options.antigravityAgentsDir!), { recursive: true });
    symlinkSync(elsewhere, options.antigravityAgentsDir!);
    expect(() => write('antigravity')).toThrow(expect.objectContaining({ code: 'symlink' }));

    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('repairs the mode of a directory it owns but leaves a shared one to its owner', () => {
    mkdirSync(join(options.dataRoot!, 'claude'), { recursive: true, mode: 0o755 });
    chmodSync(join(options.dataRoot!, 'claude'), 0o755);
    write('claude');
    expect(mode(join(options.dataRoot!, 'claude'))).toBe(0o700);

    mkdirSync(join(options.copilotHome!, 'agents'), { recursive: true });
    chmodSync(join(options.copilotHome!, 'agents'), 0o755);
    write('copilot');
    expect(mode(join(options.copilotHome!, 'agents'))).toBe(0o755);
  });

  it('accepts a home reached through a symlink, and refuses a home others can write', () => {
    const real = join(base, 'real-codex');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, options.codexHome!);
    expect(write('codex').reused).toBe(false);
    chmodSync(real, 0o777);
    expect(() => write('codex', 'x', 'cm-role-other')).toThrow(
      expect.objectContaining({ code: 'insecure-permissions' })
    );
  });

  it('a home that is a file is a write failure, not a raw error', () => {
    writeFileSync(options.codexHome!, 'not a directory');
    expect(() => write('codex')).toThrow(expect.objectContaining({ code: 'write-failed' }));
  });

  describe('reusing a file checks the directories as writing does', () => {
    it('refuses identical content behind a symlinked directory of its own', () => {
      const first = write('claude');
      const moved = join(base, 'moved-claude');
      renameSync(dirname(first.path), moved);
      symlinkSync(moved, dirname(first.path));
      expect(() => write('claude')).toThrow(expect.objectContaining({ code: 'symlink' }));
      expect(() =>
        inspectRoleArtifact(
          { adapter: 'claude', name: NAME, path: first.path, expectedFingerprint: first.artifactFingerprint },
          options
        )
      ).toThrow(expect.objectContaining({ code: 'symlink' }));
    });

    it('refuses identical content behind a symlinked data root, agents directory or antigravity directory', () => {
      const claude = write('claude');
      const movedRoot = join(base, 'moved-root');
      renameSync(options.dataRoot!, movedRoot);
      symlinkSync(movedRoot, options.dataRoot!);
      expect(() => write('claude')).toThrow(expect.objectContaining({ code: 'symlink' }));
      expect(claude.path.startsWith(options.dataRoot!)).toBe(true);

      write('copilot');
      const movedAgents = join(base, 'moved-agents');
      renameSync(join(options.copilotHome!, 'agents'), movedAgents);
      symlinkSync(movedAgents, join(options.copilotHome!, 'agents'));
      expect(() => write('copilot')).toThrow(expect.objectContaining({ code: 'symlink' }));

      const antigravity = write('antigravity');
      const movedOwn = join(base, 'moved-own');
      renameSync(dirname(antigravity.path), movedOwn);
      symlinkSync(movedOwn, dirname(antigravity.path));
      expect(() => write('antigravity')).toThrow(expect.objectContaining({ code: 'symlink' }));
    });

    it('refuses identical content under a shared directory or home others can write', () => {
      const copilot = write('copilot');
      chmodSync(dirname(copilot.path), 0o777);
      expect(() => write('copilot')).toThrow(expect.objectContaining({ code: 'insecure-permissions' }));

      write('codex');
      chmodSync(options.codexHome!, 0o777);
      expect(() => write('codex')).toThrow(expect.objectContaining({ code: 'insecure-permissions' }));
    });

    it('repairs its own directory when it may write', () => {
      const first = write('claude');
      chmodSync(dirname(first.path), 0o755);
      expect(write('claude').reused).toBe(true);
      expect(mode(dirname(first.path))).toBe(0o700);
    });

    it('read-only: refuses instead of repairing, and changes no mode', () => {
      const first = write('antigravity');
      chmodSync(dirname(first.path), 0o755);
      expect(() =>
        writeRoleArtifact(
          { adapter: 'antigravity', name: NAME, instructions: 'be a marketer' },
          { ...options, env: { CM_UAT_ISOLATION: '1' } }
        )
      ).toThrow(expect.objectContaining({ code: 'insecure-permissions' }));
      expect(mode(dirname(first.path))).toBe(0o755);
    });

    it('read-only: an intact file behind intact directories is still reused', () => {
      write('antigravity');
      const again = writeRoleArtifact(
        { adapter: 'antigravity', name: NAME, instructions: 'be a marketer' },
        { ...options, env: { CM_UAT_ISOLATION: '1' } }
      );
      expect(again.reused).toBe(true);
    });

    it('the pre-launch inspection never repairs either', () => {
      const first = write('claude');
      chmodSync(dirname(first.path), 0o755);
      expect(() =>
        inspectRoleArtifact(
          { adapter: 'claude', name: NAME, path: first.path, expectedFingerprint: first.artifactFingerprint },
          options
        )
      ).toThrow(expect.objectContaining({ code: 'insecure-permissions' }));
      expect(mode(dirname(first.path))).toBe(0o755);
    });

    it('the pre-launch inspection refuses a path this adapter would not use', () => {
      const first = write('claude');
      const copy = join(base, 'copy.md');
      writeFileSync(copy, readFileSync(first.path), { mode: 0o600 });
      expect(() =>
        inspectRoleArtifact(
          { adapter: 'claude', name: NAME, path: copy, expectedFingerprint: first.artifactFingerprint },
          options
        )
      ).toThrow(expect.objectContaining({ code: 'unexpected-location' }));
    });
  });

  it('refuses a shared directory other users can write', () => {
    mkdirSync(join(options.copilotHome!, 'agents'), { recursive: true });
    chmodSync(join(options.copilotHome!, 'agents'), 0o777);
    expect(() => write('copilot')).toThrow(expect.objectContaining({ code: 'insecure-permissions' }));
  });

  it('a failed publish leaves no temporary file behind', () => {
    const first = write('claude', 'one');
    expect(() => write('claude', 'two')).toThrow(RoleArtifactError);
    expect(readdirSync(dirname(first.path))).toEqual([`${NAME}.md`]);
  });

  describe('format check after writing', () => {
    it('codex: the TOML reads back to exactly the instructions', () => {
      const result = write('codex', TRICKY);
      expect(parseTomlBasicDocument(readFileSync(result.path, 'utf8'))).toEqual({ developer_instructions: TRICKY });
    });

    it('codex: refuses a file that is not this TOML', () => {
      const { path } = resolveArtifactLocation('codex', NAME, options);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from('developer_instructions = "unterminated\n');
      writeFileSync(path, bytes, { mode: 0o600 });
      expect(() =>
        inspectRoleArtifact({ adapter: 'codex', name: NAME, path, expectedFingerprint: computeFingerprint(bytes) }, options)
      ).toThrow(expect.objectContaining({ code: 'format-invalid' }));
    });

    it('copilot: infer false, the name, and the body byte for byte', () => {
      const result = write('copilot', TRICKY);
      const text = readFileSync(result.path, 'utf8');
      expect(text.startsWith(`---\nname: ${NAME}\n`)).toBe(true);
      expect(text).toContain('\ninfer: false\n');
      expect(text.endsWith(`---\n${TRICKY}`)).toBe(true);
    });

    it('antigravity: subagent false', () => {
      const result = write('antigravity');
      const text = readFileSync(result.path, 'utf8');
      expect(text).toContain('\nsubagent: false\n');
      expect(text.startsWith(`---\nname: ${NAME}\n`)).toBe(true);
    });

    it.each([
      ['copilot', '---\nname: other\ndescription: x\ninfer: false\n---\nbody'],
      ['copilot', `---\nname: ${NAME}\ndescription: x\n---\nbody`],
      ['copilot', `---\nname: ${NAME}\ndescription: x\ninfer: true\n---\nbody`],
      ['copilot', `---\nname: ${NAME}\ndescription: x\ninfer: false\n---\n   `],
      ['copilot', 'no frontmatter at all'],
      ['copilot', '---\n: : [unclosed\n---\nbody'],
      ['antigravity', `---\nname: ${NAME}\ndescription: x\n---\nbody`],
    ] as const)('%s: refuses a definition that would lose the role (%j)', (adapter, text) => {
      const { path } = resolveArtifactLocation(adapter, NAME, options);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(text);
      writeFileSync(path, bytes, { mode: 0o600 });
      expect(() =>
        inspectRoleArtifact({ adapter, name: NAME, path, expectedFingerprint: computeFingerprint(bytes) }, options)
      ).toThrow(expect.objectContaining({ code: 'format-invalid' }));
    });

    it('command code: the mod has the contract shape and carries the text as JSON', () => {
      const result = write('command-code', TRICKY);
      const text = readFileSync(result.path, 'utf8');
      expect(text).toMatch(/^export default function \(cmd\) \{/);
      expect(text).toContain('appendSystemPrompt: () => "');
      // The body may contain anything; it must not reach the file as code.
      expect(text).not.toContain('$(whoami)\n');
    });

    it('command code: a syntax error is caught, since the CLI would swallow it', () => {
      const { path } = resolveArtifactLocation('command-code', NAME, options);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from('export default function (cmd) { cmd.hooks({ appendSystemPrompt: () => "x" );\n');
      writeFileSync(path, bytes, { mode: 0o600 });
      expect(() =>
        inspectRoleArtifact({ adapter: 'command-code', name: NAME, path, expectedFingerprint: computeFingerprint(bytes) }, options)
      ).toThrow(expect.objectContaining({ code: 'format-invalid' }));
    });

    it('command code: the check parses and does not run the file', () => {
      const { path } = resolveArtifactLocation('command-code', NAME, options);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const marker = join(base, 'ran');
      const bytes = Buffer.from(
        `export default function (cmd) { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); }\n` +
          `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`
      );
      writeFileSync(path, bytes, { mode: 0o600 });
      expect(() =>
        inspectRoleArtifact({ adapter: 'command-code', name: NAME, path, expectedFingerprint: computeFingerprint(bytes) }, options)
      ).toThrow(expect.objectContaining({ code: 'format-invalid' }));
      expect(existsSync(marker)).toBe(false);
    });

    it('a plain file: the bytes are the instructions, with no trim', () => {
      const result = write('claude', TRICKY);
      expect(readFileSync(result.path, 'utf8')).toBe(TRICKY);
    });

    it('renders identically every time, so the same input is the same fingerprint', () => {
      for (const adapter of AGENT_ROLE_CLI_TOOLS) {
        expect(renderRoleArtifact(adapter, NAME, TRICKY)).toEqual(renderRoleArtifact(adapter, NAME, TRICKY));
      }
    });
  });

  describe('UAT shared-read-only', () => {
    const uat = { CM_UAT_ISOLATION: '1' };

    it.each(['codex', 'copilot', 'antigravity'] as const)('%s: refuses to write a home', (adapter) => {
      expect(() => writeRoleArtifact({ adapter, name: NAME, instructions: 'x' }, { ...options, env: uat })).toThrow(
        UatIsolationLaunchRefusedError
      );
      expect(existsSync(resolveArtifactLocation(adapter, NAME, options).path)).toBe(false);
    });

    it('reuses an identical file already there', () => {
      write('codex', 'x');
      const again = writeRoleArtifact({ adapter: 'codex', name: NAME, instructions: 'x' }, { ...options, env: uat });
      expect(again.reused).toBe(true);
    });

    it('refuses when the file there differs, without writing', () => {
      const first = write('codex', 'one');
      const before = readFileSync(first.path);
      expect(() => writeRoleArtifact({ adapter: 'codex', name: NAME, instructions: 'two' }, { ...options, env: uat })).toThrow(
        expect.objectContaining({ code: 'content-mismatch' })
      );
      expect(readFileSync(first.path)).toEqual(before);
    });

    it('the data root may be written only when the run moved it away from the home', () => {
      const moved = writeRoleArtifact({ adapter: 'claude', name: NAME, instructions: 'x' }, { ...options, env: uat });
      expect(moved.reused).toBe(false);

      const notMoved = { ...options, dataRoot: undefined };
      expect(() =>
        writeRoleArtifact(
          { adapter: 'claude', name: NAME, instructions: 'y' },
          { ...notMoved, env: { ...uat, HOME: base } }
        )
      ).toThrow(UatIsolationLaunchRefusedError);
    });
  });

  describe('UAT shared-read-only decides by where the data root really is', () => {
    const uat = { CM_UAT_ISOLATION: '1' };
    let fakeHome: string;

    beforeEach(() => {
      // os.homedir() follows HOME, so "the home" here is a directory of this test.
      fakeHome = join(base, 'home');
      mkdirSync(fakeHome);
      vi.stubEnv('HOME', fakeHome);
    });
    afterEach(() => vi.unstubAllEnvs());

    const attempt = (dataRoot: string): ReturnType<typeof writeRoleArtifact> =>
      writeRoleArtifact({ adapter: 'claude', name: NAME, instructions: 'x' }, { ...options, dataRoot, env: uat });

    it.each([
      ['the default, named explicitly', () => join(fakeHome, '.commandmate', 'agent-roles')],
      ['the default, with a trailing slash', () => `${join(fakeHome, '.commandmate', 'agent-roles')}/`],
      ['the default, spelled with ..', () => join(fakeHome, 'x') + '/../.commandmate/agent-roles'],
      ['the state directory itself', () => join(fakeHome, '.commandmate')],
      ['another CLI state directory', () => join(fakeHome, '.codex', 'roles')],
      ['the home itself', () => fakeHome],
    ])('refuses %s, and writes nothing', (_label, root) => {
      expect(() => attempt(root())).toThrow(UatIsolationLaunchRefusedError);
      expect(readdirSync(fakeHome)).toEqual([]);
    });

    it('refuses a symlink that leads into the home', () => {
      mkdirSync(join(fakeHome, '.commandmate'));
      const link = join(base, 'looks-elsewhere');
      symlinkSync(join(fakeHome, '.commandmate'), link);
      expect(() => attempt(join(link, 'agent-roles'))).toThrow(UatIsolationLaunchRefusedError);
      expect(readdirSync(join(fakeHome, '.commandmate'))).toEqual([]);
    });

    it('the same applies to the environment variable', () => {
      expect(() =>
        writeRoleArtifact(
          { adapter: 'claude', name: NAME, instructions: 'x' },
          {
            ...options,
            dataRoot: undefined,
            env: { ...uat, CM_AGENT_ROLE_ARTIFACTS_DIR: `${join(fakeHome, '.commandmate', 'agent-roles')}/` },
          }
        )
      ).toThrow(UatIsolationLaunchRefusedError);
      expect(readdirSync(fakeHome)).toEqual([]);
    });

    describe('known shared state that lives outside the home through a symlink', () => {
      let outside: string;

      beforeEach(() => {
        outside = join(base, 'shared-state');
        mkdirSync(outside);
      });

      const named = (dataRoot: string | undefined) => () =>
        writeRoleArtifact(
          { adapter: 'claude', name: NAME, instructions: 'x' },
          { ...options, dataRoot, env: uat }
        );

      it('~/.commandmate outside the home: the default root is still refused', () => {
        symlinkSync(outside, join(fakeHome, '.commandmate'));
        expect(named(undefined)).toThrow(UatIsolationLaunchRefusedError);
        expect(readdirSync(outside)).toEqual([]);
      });

      it('~/.commandmate outside the home: so is its physical path, named directly', () => {
        symlinkSync(outside, join(fakeHome, '.commandmate'));
        expect(named(join(outside, 'agent-roles'))).toThrow(UatIsolationLaunchRefusedError);
        expect(named(outside)).toThrow(UatIsolationLaunchRefusedError);
        expect(readdirSync(outside)).toEqual([]);
      });

      it('the default root itself outside the home', () => {
        mkdirSync(join(fakeHome, '.commandmate'));
        symlinkSync(outside, join(fakeHome, '.commandmate', 'agent-roles'));
        chmodSync(outside, 0o700); // As the writer leaves it; a loose one is refused for that reason first.
        expect(named(outside)).toThrow(UatIsolationLaunchRefusedError);
        expect(readdirSync(outside)).toEqual([]);
      });

      it.each(['.codex', '.copilot', '.gemini', '.claude'])('%s outside the home', (entry) => {
        symlinkSync(outside, join(fakeHome, entry));
        expect(named(join(outside, 'roles'))).toThrow(UatIsolationLaunchRefusedError);
        expect(readdirSync(outside)).toEqual([]);
      });

      it('the homes the CLIs are really configured with', () => {
        vi.stubEnv('CODEX_HOME', outside);
        expect(named(join(outside, 'roles'))).toThrow(UatIsolationLaunchRefusedError);
        expect(readdirSync(outside)).toEqual([]);
      });

      it('an identical file there is still reused: reading shares nothing', () => {
        symlinkSync(outside, join(fakeHome, '.commandmate'));
        const first = writeRoleArtifact(
          { adapter: 'claude', name: NAME, instructions: 'x' },
          { ...options, dataRoot: undefined, env: {} }
        );
        expect(first.path.startsWith(fakeHome)).toBe(true);
        expect(named(undefined)().reused).toBe(true);
      });

      it('a directory beside that state, unrelated to it, may be written (negative control)', () => {
        symlinkSync(outside, join(fakeHome, '.commandmate'));
        expect(named(join(base, 'run', 'roles'))().reused).toBe(false);
      });
    });

    it('a run directory under the home, like a checkout, may be written', () => {
      expect(attempt(join(fakeHome, 'work', 'wt', 'run', 'roles')).reused).toBe(false);
    });

    it('a root outside the home may be written', () => {
      expect(attempt(join(base, 'run', 'roles')).reused).toBe(false);
    });

    it('a named root is not tightened, even when it is the home; the default root is', () => {
      chmodSync(fakeHome, 0o755);
      const inHome = writeRoleArtifact(
        { adapter: 'claude', name: NAME, instructions: 'x' },
        { ...options, dataRoot: fakeHome, env: {} }
      );
      expect(mode(fakeHome)).toBe(0o755);
      expect(mode(dirname(inHome.path))).toBe(0o700);

      const defaultRoot = join(fakeHome, '.commandmate', 'agent-roles');
      mkdirSync(defaultRoot, { recursive: true });
      chmodSync(defaultRoot, 0o755);
      writeRoleArtifact(
        { adapter: 'claude', name: NAME, instructions: 'x' },
        { ...options, dataRoot: undefined, env: {} }
      );
      expect(mode(defaultRoot)).toBe(0o700);
    });

    it('a named root others can write is refused', () => {
      const shared = join(base, 'shared-root');
      mkdirSync(shared);
      chmodSync(shared, 0o777);
      expect(() =>
        writeRoleArtifact({ adapter: 'claude', name: NAME, instructions: 'x' }, { ...options, dataRoot: shared, env: {} })
      ).toThrow(expect.objectContaining({ code: 'insecure-permissions' }));
    });

    it('with no isolation the explicit root is simply used', () => {
      const result = writeRoleArtifact(
        { adapter: 'claude', name: NAME, instructions: 'x' },
        { ...options, dataRoot: join(fakeHome, '.commandmate', 'agent-roles'), env: {} }
      );
      expect(result.reused).toBe(false);
    });
  });

  it('own-home: refuses unless the dedicated-user checks pass, and writes nothing', () => {
    const env = { CM_UAT_ISOLATION: 'own-home' };
    expect(() => writeRoleArtifact({ adapter: 'codex', name: NAME, instructions: 'x' }, { ...options, env })).toThrow(
      UatIsolationLaunchRefusedError
    );
    expect(existsSync(resolveArtifactLocation('codex', NAME, options).path)).toBe(false);
  });

  it('the error for a refused file never carries the instructions', () => {
    write('claude', 'SECRET-ONE');
    try {
      write('claude', 'SECRET-TWO');
      throw new Error('should have refused');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('SECRET');
    }
  });
});

describe('TOML basic strings', () => {
  it.each([
    ['plain', 'hello'],
    ['quotes', 'dq " sq \' tdq """'],
    ['backslash', 'C:\\path\\n'],
    ['newlines', 'a\nb\r\nc\t'],
    ['controls', '\u0000\u0001\u001f\u007f\u0008\u000c'],
    ['unicode', '日本語 😀 \u2028'],
  ])('round-trips %s', (_label, value) => {
    const document = renderTomlBasicDocument({ developer_instructions: value });
    expect(parseTomlBasicDocument(document)).toEqual({ developer_instructions: value });
  });

  it('escapes what TOML forbids raw', () => {
    expect(toTomlBasicString('\u007f')).toBe('"\\u007F"');
    expect(toTomlBasicString('\u0001')).toBe('"\\u0001"');
    expect(toTomlBasicString('a\nb')).toBe('"a\\nb"');
  });

  it('refuses a lone surrogate, which has no TOML spelling', () => {
    expect(() => toTomlBasicString('\ud83d')).toThrow(/surrogate/);
  });

  it('reads comments and blank lines', () => {
    expect(parseTomlBasicDocument('# c\n\nkey = "v" # trailing\n')).toEqual({ key: 'v' });
  });

  it.each([
    ['unterminated', 'k = "v'],
    ['raw control', 'k = "a\u0001b"'],
    ['raw newline', 'k = "a\nb"'],
    ['bad escape', 'k = "\\q"'],
    ['bad unicode', 'k = "\\uZZZZ"'],
    ['surrogate escape', 'k = "\\uD83D"'],
    ['duplicate', 'k = "a"\nk = "b"'],
    ['table', '[t]\nk = "a"'],
    ['multi-line', 'k = """a"""'],
    ['literal', "k = 'a'"],
    ['number', 'k = 1'],
    ['trailing garbage', 'k = "a" b'],
    ['no key', '= "a"'],
  ])('refuses %s rather than guess', (_label, text) => {
    expect(() => parseTomlBasicDocument(text)).toThrow();
  });
});
