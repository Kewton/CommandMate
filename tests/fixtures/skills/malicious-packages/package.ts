/**
 * Benign baseline package and the knobs the corpus turns (Issue #1230)
 *
 * Every malicious case is the baseline package with exactly one thing changed,
 * so a test that fails tells you which property was load-bearing.
 */

import { createHash } from 'crypto';
import type { SkillFileEntry, SkillFileKind, SkillManifest } from '@/types/skills';
import { TarType, buildTarGz, type BuildTarOptions, type TarEntryInput } from './tar';

export const SKILL_ID = 'demo-skill';
export const SKILL_VERSION = '1.2.3';
export const SKILL_NAME = 'Demo Skill';

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: A demo Skill used by the CommandMate package tests.
---

# ${SKILL_NAME}

Steps go here.
`;

function sha256(content: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    .digest('hex');
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
}

// =============================================================================
// Specs
// =============================================================================

/** One payload file, plus how the manifest should (mis)describe it. */
export interface PackageFileSpec {
  path: string;
  content: string | Uint8Array;
  /** Header mode written into the archive. */
  mode?: number;
  kind?: SkillFileKind;
  script?: boolean;
  /** Declared executable bit; defaults to whatever `mode` carries. */
  executable?: boolean;
  /** Leave the file out of `manifest.files`. */
  undeclared?: boolean;
  declaredSha256?: string;
  declaredSize?: number;
  /** Emit the tar entry with a different name than the declared path. */
  archivePath?: string;
  /** tar typeflag, for special-file cases. */
  type?: TarEntryInput['type'];
  linkname?: string;
}

export interface PackageOptions {
  skillId?: string;
  version?: string;
  /** Top-level directory every entry is placed under. */
  rootDir?: string | null;
  files?: PackageFileSpec[];
  skillMd?: string | null;
  /** Replace the rendered manifest with raw bytes. */
  manifestYaml?: string;
  /** Mutate the manifest object after it is derived from the files. */
  manifestPatch?: (manifest: SkillManifest) => void;
  /** Declared entries with no file behind them. */
  extraDeclarations?: SkillFileEntry[];
  /** Raw tar entries appended after the generated ones. */
  extraEntries?: TarEntryInput[];
  omitManifest?: boolean;
  directories?: string[];
  tarOptions?: BuildTarOptions;
}

export const DEFAULT_FILES: readonly PackageFileSpec[] = [
  { path: 'reference/notes.md', content: '# Notes\n\nBackground reading.\n' },
  { path: 'assets/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>\n' },
];

// =============================================================================
// Manifest rendering
// =============================================================================

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function renderList(name: string, values: readonly string[], indent: string): string[] {
  if (values.length === 0) return [`${indent}${name}: []`];
  return [`${indent}${name}:`, ...values.map((value) => `${indent}  - ${quote(value)}`)];
}

/** Serialize a manifest in the subset `safe-yaml` accepts. */
export function renderManifestYaml(manifest: SkillManifest): string {
  const lines: string[] = [
    `schema_version: ${manifest.schema_version}`,
    `id: ${quote(manifest.id)}`,
    `name: ${quote(manifest.name)}`,
    `version: ${quote(manifest.version)}`,
    `summary: ${quote(manifest.summary)}`,
    `description: ${quote(manifest.description)}`,
    ...renderList('capabilities', manifest.capabilities, ''),
    ...renderList('expected_outcomes', manifest.expected_outcomes, ''),
    'provider:',
    `  name: ${quote(manifest.provider.name)}`,
    `license: ${quote(manifest.license)}`,
    'compatibility:',
    `  commandmate: ${quote(manifest.compatibility.commandmate)}`,
  ];

  if (manifest.compatibility.agents.length === 0) {
    lines.push('  agents: []');
  } else {
    lines.push('  agents:');
    for (const agent of manifest.compatibility.agents) {
      lines.push(
        `    - agent: ${quote(agent.agent)}`,
        `      support: ${quote(agent.support)}`,
        `      evidence: ${quote(agent.evidence)}`
      );
    }
  }

  lines.push('requirements:');
  if (manifest.requirements.commands.length === 0) {
    lines.push('  commands: []');
  } else {
    lines.push('  commands:');
    for (const command of manifest.requirements.commands) {
      lines.push(`    - name: ${quote(command.name)}`);
      if (command.version_range !== undefined) {
        lines.push(`      version_range: ${quote(command.version_range)}`);
      }
    }
  }
  lines.push(...renderList('network_hosts', manifest.requirements.network_hosts, '  '));
  lines.push(...renderList('declared_permissions', manifest.declared_permissions, ''));
  lines.push(`declared_risk: ${quote(manifest.declared_risk)}`);
  lines.push(`risk_rationale: ${quote(manifest.risk_rationale)}`);

  if (manifest.files.length === 0) {
    lines.push('files: []');
  } else {
    lines.push('files:');
    for (const file of manifest.files) {
      lines.push(
        `  - path: ${quote(file.path)}`,
        `    sha256: ${quote(file.sha256)}`,
        `    size: ${file.size}`,
        `    kind: ${quote(file.kind)}`,
        `    executable: ${file.executable}`,
        `    script: ${file.script}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

const SCRIPT_EXTENSIONS = ['.sh', '.py', '.js', '.rb', '.ps1'];

function deriveKind(spec: PackageFileSpec): SkillFileKind {
  if (spec.kind) return spec.kind;
  if (spec.path === 'SKILL.md') return 'skill_md';
  if (SCRIPT_EXTENSIONS.some((extension) => spec.path.endsWith(extension))) return 'script';
  return spec.path.endsWith('.md') ? 'instruction' : 'asset';
}

function declarationFor(spec: PackageFileSpec): SkillFileEntry {
  const kind = deriveKind(spec);
  return {
    path: spec.path,
    sha256: spec.declaredSha256 ?? sha256(spec.content),
    size: spec.declaredSize ?? byteLength(spec.content),
    kind,
    executable: spec.executable ?? ((spec.mode ?? 0o644) & 0o111) !== 0,
    script: spec.script ?? kind === 'script',
  };
}

// =============================================================================
// Package assembly
// =============================================================================

export interface BuiltPackage {
  bytes: Buffer;
  manifest: SkillManifest;
  manifestYaml: string;
  skillId: string;
  version: string;
}

/** Build a package: benign by default, malicious via one option. */
export function buildPackage(options: PackageOptions = {}): BuiltPackage {
  const skillId = options.skillId ?? SKILL_ID;
  const version = options.version ?? SKILL_VERSION;
  const rootDir = options.rootDir === undefined ? skillId : options.rootDir;
  const skillMd = options.skillMd === undefined ? SKILL_MD : options.skillMd;

  const payload: PackageFileSpec[] = [
    ...(skillMd === null ? [] : [{ path: 'SKILL.md', content: skillMd } as PackageFileSpec]),
    ...(options.files ?? DEFAULT_FILES).map((file) => ({ ...file })),
  ];

  const manifest: SkillManifest = {
    schema_version: 1,
    id: skillId,
    name: SKILL_NAME,
    version,
    summary: 'A demo Skill used by the CommandMate package tests.',
    description: 'Longer description of the demo Skill used by the package tests.',
    capabilities: ['Read the reference notes'],
    expected_outcomes: ['You know what the demo Skill does'],
    provider: { name: 'CommandMate' },
    license: 'MIT',
    compatibility: {
      commandmate: '>=0.11.0',
      agents: [{ agent: 'claude', support: 'native', evidence: 'verified by the package tests' }],
    },
    requirements: { commands: [], network_hosts: [] },
    declared_permissions: ['filesystem_read'],
    declared_risk: 'low',
    risk_rationale: 'Reads bundled reference material only.',
    files: [
      ...payload.filter((spec) => !spec.undeclared).map(declarationFor),
      ...(options.extraDeclarations ?? []),
    ],
  };
  options.manifestPatch?.(manifest);

  const manifestYaml = options.manifestYaml ?? renderManifestYaml(manifest);
  const withRoot = (entryPath: string): string =>
    rootDir === null ? entryPath : `${rootDir}/${entryPath}`;

  const entries: TarEntryInput[] = [];
  if (rootDir !== null) entries.push({ name: `${rootDir}/`, type: TarType.DIRECTORY });
  for (const directory of options.directories ?? []) {
    entries.push({ name: `${withRoot(directory)}/`, type: TarType.DIRECTORY });
  }
  if (!options.omitManifest) {
    entries.push({ name: withRoot('commandmate.skill.yaml'), content: manifestYaml, mode: 0o644 });
  }
  for (const spec of payload) {
    entries.push({
      name: withRoot(spec.archivePath ?? spec.path),
      content: spec.content,
      mode: spec.mode ?? 0o644,
      ...(spec.type ? { type: spec.type } : {}),
      ...(spec.linkname ? { linkname: spec.linkname } : {}),
    });
  }
  entries.push(...(options.extraEntries ?? []));

  return {
    bytes: buildTarGz(entries, options.tarOptions),
    manifest,
    manifestYaml,
    skillId,
    version,
  };
}
