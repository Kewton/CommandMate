/**
 * The generated files that carry a role to each CLI (§5, §6 of
 * `docs/design/agent-roles-adapters.md`): what they contain, where they live, and
 * the only code that writes them.
 *
 * Free of the database on purpose: the launcher side of the tree stays outside
 * `better-sqlite3`'s import graph (`hooks/sources/opencode/launch-settings.ts`).
 *
 * ## The rules
 *
 * - **Immutable.** A name is fixed by the injection fingerprint, so one name means
 *   one content. An existing file is reused only if every byte matches, and a
 *   difference is an error rather than an overwrite.
 * - **Inspected.** Many CLIs run on with no role when a file is missing or broken
 *   (§8), so the writer reads back what it wrote, and {@link inspectRoleArtifact}
 *   is the same check for the moment before a launch.
 * - **Never deleted.** A running process or a resumable conversation may still
 *   read one. Copilot's `/agent` and `agy agent` therefore list them; `infer:
 *   false` and `subagent: false` narrow the candidates, not the list.
 *
 * Errors carry paths, never file content: the content is the role's body.
 *
 * @module lib/agent-roles/artifacts
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  statSync,
  type Stats,
  lstatSync,
  mkdirSync,
  chmodSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { homedir, userInfo } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import vm from 'vm';
import { parse as parseYaml } from 'yaml';
import { resolveSafeDirectory } from '@/config/safe-directory';
import {
  sharedHookWritePolicy,
  UAT_SAME_BUILD_FIX,
  UatIsolationLaunchRefusedError,
} from '@/config/uat-isolation';
import { getAntigravityHooksConfigPath } from '@/lib/hooks/sources/antigravity/hooks-config';
import { getCodexHome } from '@/lib/hooks/sources/codex/hooks-config';
import { getCopilotHomeDirectory } from '@/lib/hooks/sources/copilot/hook-settings';
import type { AgentRoleCliTool } from '@/types/agent-roles';
import { computeFingerprint } from './fingerprint';
import { parseTomlBasicDocument, renderTomlBasicDocument } from './toml-basic';

type Env = Readonly<Record<string, string | undefined>>;

/** Moves the data root (Claude, Command Code, OpenCode V1 and V2). Honoured in production. */
export const AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR = 'CM_AGENT_ROLE_ARTIFACTS_DIR';

/**
 * Moves Antigravity's agents directory, for tests and isolated runs. `agy` itself
 * reads only `~/.gemini/config/agents`, so a file put elsewhere is one it never finds.
 */
export const AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR_ENV_VAR = 'CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR';

/** Longest generated name. Becomes Codex's `-p`, Copilot's `--agent`, Antigravity's `name`. */
export const MAX_ARTIFACT_NAME_LENGTH = 64;

/** How much of the injection fingerprint goes into a name. */
const NAME_FINGERPRINT_LENGTH = 12;

const NAME_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FULL_FINGERPRINT = /^[0-9a-f]{64}$/;

export type RoleArtifactErrorCode =
  | 'invalid-name'
  | 'unexpected-location'
  | 'empty-instructions'
  | 'missing'
  | 'symlink'
  | 'not-regular-file'
  | 'foreign-owner'
  | 'insecure-permissions'
  | 'content-mismatch'
  | 'format-invalid'
  | 'write-failed';

export class RoleArtifactError extends Error {
  constructor(
    public readonly code: RoleArtifactErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RoleArtifactError';
  }
}

/** Where things go. Roots and homes move independently of one another. */
export interface ArtifactOptions {
  /** Data root override. Unset: {@link AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR}, then `~/.commandmate/agent-roles`. */
  dataRoot?: string;
  codexHome?: string;
  copilotHome?: string;
  antigravityAgentsDir?: string;
  /** Environment for the UAT policy and the overrides above. Defaults to `process.env`. */
  env?: Env;
}

export interface ArtifactLocation {
  path: string;
  /**
   * The CLI's home, when the file is under one. Created if absent. May be reached
   * through a symlink (dotfile setups); only its write permission is checked.
   */
  homeDir: string | null;
  /** Directories shared with the CLI: created 0700 if absent, otherwise left to their owner. */
  sharedDirs: string[];
  /** Directories this feature alone uses: created 0700, and repaired to 0700. */
  ownedDirs: string[];
  /** Whether this file is in a place a shared-read-only run may not write. */
  inSharedHome: boolean;
}

/** A label for this server inside a shared home, derived from something stable such as its database path. */
export function deriveServerNamespace(seed: string): string {
  return computeFingerprint(Buffer.from(seed, 'utf8')).slice(0, 8);
}

/**
 * `cm-role-<namespace>-<role id>-<head of the injection fingerprint>`. The
 * injection fingerprint and not the artifact fingerprint: the name is inside the
 * Copilot and Antigravity frontmatter, so naming a file after its own bytes would
 * be circular (§5).
 */
export function buildArtifactName(input: {
  namespace: string;
  roleId: string;
  injectionFingerprint: string;
}): string {
  const { namespace, roleId, injectionFingerprint } = input;
  if (!NAME_SEGMENT.test(namespace)) throw new RoleArtifactError('invalid-name', 'Invalid server namespace');
  if (!NAME_SEGMENT.test(roleId)) throw new RoleArtifactError('invalid-name', 'Invalid role id');
  if (!FULL_FINGERPRINT.test(injectionFingerprint)) {
    throw new RoleArtifactError('invalid-name', 'The injection fingerprint must be a full SHA-256 hex');
  }
  const name = `cm-role-${namespace}-${roleId}-${injectionFingerprint.slice(0, NAME_FINGERPRINT_LENGTH)}`;
  assertArtifactName(name);
  return name;
}

function assertArtifactName(name: string): void {
  if (!name.startsWith('cm-role-') || !NAME_SEGMENT.test(name)) {
    throw new RoleArtifactError('invalid-name', 'An artifact name is cm-role- plus alphanumerics and hyphens');
  }
  if (name.length > MAX_ARTIFACT_NAME_LENGTH) {
    throw new RoleArtifactError('invalid-name', `An artifact name is at most ${MAX_ARTIFACT_NAME_LENGTH} characters`);
  }
}

function defaultDataRoot(): string {
  return join(homedir(), '.commandmate', 'agent-roles');
}

function dataRootFor(options: ArtifactOptions): string {
  const fallback = defaultDataRoot();
  if (options.dataRoot) return resolveSafeDirectory(options.dataRoot, fallback, 'ArtifactOptions.dataRoot');
  const configured = (options.env ?? process.env)[AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR];
  return resolveSafeDirectory(configured, fallback, AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR);
}

/** The path with every symlink that exists on the way followed. What is not there yet is kept as spelled. */
function physicalPath(target: string): string {
  const rest: string[] = [];
  let existing = resolve(target);
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return join(existing, ...rest);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

function accountHomes(): string[] {
  const homes = [homedir()];
  try {
    homes.push(userInfo().homedir);
  } catch {
    // No account entry for this uid: HOME is all there is to go on.
  }
  return homes;
}

/** State directories of this product and the CLIs it drives, as they sit in a home. */
const KNOWN_HOME_STATE = ['.commandmate', '.codex', '.copilot', '.gemini', '.claude'] as const;

/**
 * Known shared state, wherever it physically is. Any of these may be a symlink out
 * of the home (a synced or shared directory), and the state is just as shared there.
 */
function knownSharedStatePaths(): string[] {
  const inHomes = accountHomes().flatMap((home) => KNOWN_HOME_STATE.map((entry) => join(home, entry)));
  return [
    defaultDataRoot(),
    ...inHomes,
    getCodexHome(),
    getCopilotHomeDirectory(),
    dirname(getAntigravityHooksConfigPath()),
  ];
}

function isSameOrInside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

/**
 * Whether a data root is a place the user's other servers and CLIs share, judged
 * by where it physically is and not by whether someone named it: the home itself,
 * anything inside one of its dot-directories, or anything inside known shared
 * state wherever a symlink has put it.
 *
 * Not "anywhere under the home". A UAT's run directory normally is, because the
 * checkout is, and it belongs to that run alone (`.commandmate/uat.yaml` puts its
 * database and hook directory there).
 */
function isSharedHomeState(root: string): boolean {
  const real = physicalPath(root);
  const inHomeState = accountHomes().some((home) => {
    const realHome = physicalPath(home);
    if (real === realHome) return true;
    return real.startsWith(`${realHome}${sep}`) && real.slice(realHome.length + 1).startsWith('.');
  });
  return inHomeState || knownSharedStatePaths().some((known) => isSameOrInside(real, physicalPath(known)));
}

/**
 * Antigravity has no resolver for this directory, so it is derived from the one
 * that names `hooks.json` beside it rather than spelling `~/.gemini` a second time.
 */
function antigravityAgentsDir(options: ArtifactOptions): string {
  const fallback = join(dirname(getAntigravityHooksConfigPath()), 'agents');
  if (options.antigravityAgentsDir) return options.antigravityAgentsDir;
  return resolveSafeDirectory(
    (options.env ?? process.env)[AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR_ENV_VAR],
    fallback,
    AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR_ENV_VAR
  );
}

/**
 * Where an adapter's file goes. Codex, Copilot and Antigravity discover theirs in
 * their own homes (D4); the others are handed a path, so theirs stay out of the
 * home altogether.
 */
export function resolveArtifactLocation(
  adapter: AgentRoleCliTool,
  name: string,
  options: ArtifactOptions = {}
): ArtifactLocation {
  assertArtifactName(name);
  switch (adapter) {
    case 'codex': {
      const home = getCodexHome(options.codexHome ? { codexHome: options.codexHome } : {});
      return { path: join(home, `${name}.config.toml`), homeDir: home, sharedDirs: [], ownedDirs: [], inSharedHome: true };
    }
    case 'copilot': {
      const home = options.copilotHome ?? getCopilotHomeDirectory();
      const agents = join(home, 'agents');
      return { path: join(agents, `${name}.agent.md`), homeDir: home, sharedDirs: [agents], ownedDirs: [], inSharedHome: true };
    }
    case 'antigravity': {
      const agents = antigravityAgentsDir(options);
      const own = join(agents, name);
      return { path: join(own, 'agent.md'), homeDir: null, sharedDirs: [agents], ownedDirs: [own], inSharedHome: true };
    }
    case 'claude':
    case 'command-code':
    case 'opencode':
    case 'opencode-v2': {
      const root = dataRootFor(options);
      const dir = join(root, adapter);
      const extension = adapter === 'command-code' ? 'ts' : 'md';
      // Only the default root is ours to tighten. A root someone named may be any
      // directory, up to the home itself, and is left to its owner.
      const rootIsOurs = physicalPath(root) === physicalPath(defaultDataRoot());
      return {
        path: join(dir, `${name}.${extension}`),
        homeDir: null,
        sharedDirs: rootIsOurs ? [] : [root],
        ownedDirs: rootIsOurs ? [root, dir] : [dir],
        inSharedHome: isSharedHomeState(root),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * A constant, not the role's name. A rename leaves the injection fingerprint, and
 * so the file name, unchanged; carrying the role name here would make the second
 * launch find different bytes under the same name and refuse.
 */
const DEFINITION_DESCRIPTION = 'CommandMate role';

const COMMAND_CODE_PREFIX = 'export default function (cmd) {\n  cmd.hooks({ appendSystemPrompt: () => ';
const COMMAND_CODE_SUFFIX = ' });\n}\n';

/**
 * Every byte of an adapter's file. `instructions` is the text the model should
 * get, already wrapped and composed by #4115: for Codex that includes the user's
 * own `developer_instructions`, which the profile would otherwise replace.
 */
export function renderRoleArtifact(adapter: AgentRoleCliTool, name: string, instructions: string): Buffer {
  switch (adapter) {
    case 'codex':
      return Buffer.from(renderTomlBasicDocument({ developer_instructions: instructions }), 'utf8');
    case 'copilot':
      return Buffer.from(
        `---\nname: ${name}\ndescription: ${DEFINITION_DESCRIPTION}\ninfer: false\n---\n${instructions}`,
        'utf8'
      );
    case 'antigravity':
      return Buffer.from(
        `---\nname: ${name}\ndescription: ${DEFINITION_DESCRIPTION}\nsubagent: false\n---\n${instructions}`,
        'utf8'
      );
    case 'command-code': {
      // Executed by the CLI, so the text goes in only as a JSON string literal.
      const literal = JSON.stringify(instructions).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      return Buffer.from(`${COMMAND_CODE_PREFIX}${literal}${COMMAND_CODE_SUFFIX}`, 'utf8');
    }
    case 'claude':
    case 'opencode':
    case 'opencode-v2':
      return Buffer.from(instructions, 'utf8');
  }
}

function parseDefinition(text: string): { data: unknown; body: string } | null {
  if (!text.startsWith('---\n')) return null;
  const close = text.indexOf('\n---\n', 3);
  if (close === -1) return null;
  try {
    return { data: parseYaml(text.slice(4, close)), body: text.slice(close + 5) };
  } catch {
    return null;
  }
}

/** Why these bytes would not carry a role through this adapter, or null when they would. */
function formatProblem(adapter: AgentRoleCliTool, name: string, bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  switch (adapter) {
    case 'codex': {
      let entries: Record<string, string>;
      try {
        entries = parseTomlBasicDocument(text);
      } catch (error) {
        return `not the expected TOML (${error instanceof Error ? error.message : 'unreadable'})`;
      }
      const value = entries.developer_instructions;
      return value === undefined || value.trim() === '' ? 'developer_instructions is missing or empty' : null;
    }
    case 'copilot':
    case 'antigravity': {
      const definition = parseDefinition(text);
      if (!definition || typeof definition.data !== 'object' || definition.data === null) {
        return 'no readable frontmatter';
      }
      const data = definition.data as Record<string, unknown>;
      if (data.name !== name) return 'the frontmatter name is not this artifact';
      if (adapter === 'copilot' && data.infer !== false) return 'infer: false is missing';
      if (adapter === 'antigravity' && data.subagent !== false) return 'subagent: false is missing';
      return definition.body.trim() === '' ? 'the definition has no body' : null;
    }
    case 'command-code': {
      // The CLI swallows a broken mod (§6.3), so this is the only check there is.
      // Compiled, never run; `export default` would not compile as a script.
      if (!text.startsWith(COMMAND_CODE_PREFIX) || !text.endsWith(COMMAND_CODE_SUFFIX)) {
        return 'not the generated mod';
      }
      const literal = text.slice(COMMAND_CODE_PREFIX.length, text.length - COMMAND_CODE_SUFFIX.length);
      try {
        const value: unknown = JSON.parse(literal);
        new vm.Script(`(function (cmd) { cmd.hooks({ appendSystemPrompt: () => ${literal} }); })`);
        return typeof value === 'string' && value.trim() !== '' ? null : 'the mod carries no text';
      } catch {
        return 'the mod does not parse';
      }
    }
    case 'claude':
    case 'opencode':
    case 'opencode-v2':
      return text.trim() === '' ? 'the file is empty' : null;
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // ENOTDIR: something on the way is a file, so this path does not exist either.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Read an existing artifact, refusing anything we could not have written. Null when absent. */
function readExistingArtifact(path: string): Buffer | null {
  const stat = lstatOrNull(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new RoleArtifactError('symlink', `${path} is a symlink`);
  if (!stat.isFile()) throw new RoleArtifactError('not-regular-file', `${path} is not a regular file`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new RoleArtifactError('foreign-owner', `${path} belongs to another user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new RoleArtifactError('insecure-permissions', `${path} is accessible to other users`);
  }
  // O_NOFOLLOW: the check above and this read are two steps.
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Check a directory that exists; one that does not has nothing to check.
 *
 * @param repair - Whether a directory of our own may be tightened. False when the
 *   run only reads: a read-only caller refuses instead, and changes nothing.
 */
function checkDirectory(dir: string, owned: boolean, repair: boolean): void {
  const stat = lstatOrNull(dir);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new RoleArtifactError('symlink', `${dir} is a symlink`);
  if (!stat.isDirectory()) throw new RoleArtifactError('not-regular-file', `${dir} is not a directory`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new RoleArtifactError('foreign-owner', `${dir} belongs to another user`);
  }
  if (owned) {
    if ((stat.mode & 0o077) === 0) return;
    if (!repair) throw new RoleArtifactError('insecure-permissions', `${dir} is accessible to other users`);
    chmodSync(dir, 0o700);
  } else if ((stat.mode & 0o022) !== 0) {
    // Readable is the CLI's business. Writable by others is someone else being able
    // to swap the file between this check and the launch.
    throw new RoleArtifactError('insecure-permissions', `${dir} is writable by other users`);
  }
}

/** A home may be reached through a symlink, so it is followed; what is below it is not. */
function checkDirectories(location: ArtifactLocation, repair: boolean): void {
  if (location.homeDir !== null) {
    let mode: number | null = null;
    try {
      mode = Number(statSync(location.homeDir).mode);
    } catch {
      // Absent, or a link to nothing: nothing readable is behind it, and creating it will say so.
    }
    if (mode !== null && (mode & 0o022) !== 0) {
      throw new RoleArtifactError('insecure-permissions', `${location.homeDir} is writable by other users`);
    }
  }
  for (const dir of location.sharedDirs) checkDirectory(dir, false, repair);
  for (const dir of location.ownedDirs) checkDirectory(dir, true, repair);
}

function createMissingDirectories(location: ArtifactLocation): void {
  const dirs = [...(location.homeDir === null ? [] : [location.homeDir]), ...location.sharedDirs, ...location.ownedDirs];
  for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Create `path` with exactly these bytes, or fail if anything is already there.
 * `link` and not `rename`: rename replaces a file that appeared meanwhile, and two
 * servers can generate the same name at once.
 *
 * @returns false when another writer got there first
 */
function publishExclusively(path: string, bytes: Buffer): boolean {
  const temporary = join(dirname(path), `.cm-role-${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written);
      fsyncSync(fd);
      if ((fstatSync(fd).mode & 0o077) !== 0) {
        throw new RoleArtifactError('insecure-permissions', `${temporary} was not created private`);
      }
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
}

// ---------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------

export interface WriteRoleArtifactInput {
  adapter: AgentRoleCliTool;
  /** From {@link buildArtifactName}. */
  name: string;
  /** The full text for the model. See {@link renderRoleArtifact}. */
  instructions: string;
}

export interface WrittenRoleArtifact {
  adapter: AgentRoleCliTool;
  name: string;
  path: string;
  /** Hash of every byte of the file, computed before writing. */
  artifactFingerprint: string;
  reused: boolean;
}

/**
 * Checks 1 and 2 of §5, for the moment before a launch: the file is where this
 * adapter keeps it, behind directories that could not have been swapped, is what
 * the writer said, and reads as this adapter's format. Changes nothing.
 *
 * @param options - The same options the file was written with
 * @throws {RoleArtifactError}
 */
export function inspectRoleArtifact(
  input: { adapter: AgentRoleCliTool; name: string; path: string; expectedFingerprint: string },
  options: ArtifactOptions = {}
): void {
  const { adapter, name, path, expectedFingerprint } = input;
  const location = resolveArtifactLocation(adapter, name, options);
  if (location.path !== path) {
    throw new RoleArtifactError('unexpected-location', `${path} is not where this adapter keeps ${name}`);
  }
  checkDirectories(location, false);
  inspectFile(adapter, name, path, expectedFingerprint);
}

function inspectFile(adapter: AgentRoleCliTool, name: string, path: string, expectedFingerprint: string): void {
  const bytes = readExistingArtifact(path);
  if (bytes === null) throw new RoleArtifactError('missing', `${path} does not exist`);
  if (computeFingerprint(bytes) !== expectedFingerprint) {
    throw new RoleArtifactError('content-mismatch', `${path} is not the expected content`);
  }
  const problem = formatProblem(adapter, name, bytes);
  if (problem) throw new RoleArtifactError('format-invalid', `${path}: ${problem}`);
}

/**
 * Make sure the artifact exists with exactly this content, writing it only if it
 * is absent and the run may write there.
 *
 * In `CM_UAT_ISOLATION=1` nothing is changed in the user's shared state
 * (`config/uat-isolation.ts`): an identical file behind sound directories is
 * reused, and anything else refuses the launch. A data root that really is
 * elsewhere (see {@link isSharedHomeState}) belongs to the run and may be written.
 *
 * @throws {RoleArtifactError} The file cannot be used
 * @throws {UatIsolationLaunchRefusedError} The run may not write it
 */
export function writeRoleArtifact(input: WriteRoleArtifactInput, options: ArtifactOptions = {}): WrittenRoleArtifact {
  const { adapter, name, instructions } = input;
  assertArtifactName(name);
  // §5 check 3: an empty role does not become "no role".
  if (instructions.trim() === '') {
    throw new RoleArtifactError('empty-instructions', 'A role artifact needs instructions');
  }
  const location = resolveArtifactLocation(adapter, name, options);
  const bytes = renderRoleArtifact(adapter, name, instructions);
  const artifactFingerprint = computeFingerprint(bytes);
  const written = (reused: boolean): WrittenRoleArtifact => ({
    adapter,
    name,
    path: location.path,
    artifactFingerprint,
    reused,
  });
  const inspect = (): void => inspectFile(adapter, name, location.path, artifactFingerprint);

  const policy = sharedHookWritePolicy(adapter, [location.path], options.env ?? process.env);
  const readOnly = policy === 'read-only' && location.inSharedHome;

  // Before the file is read: a good file behind a swapped directory is not ours.
  checkDirectories(location, !readOnly);

  if (readExistingArtifact(location.path) !== null) {
    inspect();
    return written(true);
  }

  if (readOnly) {
    throw new UatIsolationLaunchRefusedError(
      adapter,
      `the role artifact ${location.path} does not exist and this run may not write it`,
      UAT_SAME_BUILD_FIX
    );
  }

  let published: boolean;
  try {
    createMissingDirectories(location);
    published = publishExclusively(location.path, bytes);
  } catch (error) {
    if (error instanceof RoleArtifactError) throw error;
    throw new RoleArtifactError(
      'write-failed',
      `Could not write ${location.path}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`
    );
  }
  // Read back either way. If another writer won the race this is also what proves
  // its bytes are ours.
  inspect();
  return written(!published);
}
