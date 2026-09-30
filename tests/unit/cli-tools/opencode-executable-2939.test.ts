/**
 * Telling OpenCode 1.x and OpenCode V2 apart by what they print (Issue #2939).
 *
 * npm `@opencode/cli` registers `opencode` as well as `opencode2`, so on a
 * machine with V2 the name `opencode` may be either. These tests put fake
 * `opencode` / `opencode2` scripts on a temporary `PATH` — real files, real
 * `execFile` — and assert what each tool then considers installed and what its
 * launch line runs.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  clearOpencodeExecutableCache,
  describeOpencodeV1Unavailable,
  parseOpencodeVersionOutput,
  resolveOpencodeV1Executable,
  resolveOpencodeV2Executable,
} from '@/lib/cli-tools/opencode-executable';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { OpenCodeV2Tool, parseOpencodeV2Version } from '@/lib/cli-tools/opencode-v2';
import { buildMissingToolMessage } from '@/lib/cli-tools/install-hints';
import { prepareOpencodeLaunch } from '@/lib/hooks/sources/opencode/source';
import {
  prepareOpencodeV2Launch,
  resolveOpencodeV2LaunchScriptPath,
} from '@/lib/hooks/sources/opencode-v2/source';
import {
  rememberOpencodeV2Port,
  resetOpencodeV2PortAssignments,
} from '@/lib/hooks/sources/opencode-v2/ports';
import { writeOpencodeV2Password } from '@/lib/hooks/sources/opencode-v2/secrets';
import { resetOpencodePortAssignments } from '@/lib/hooks/sources/opencode/ports';

let sandbox: string;

/** Write an executable `name` into `dir` that prints `output` for `--version`. */
function fakeBinary(dir: string, name: string, output: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  sandbox = makeTempDir('opencode-executable-2939-');
  clearOpencodeExecutableCache();
  resetOpencodePortAssignments();
  vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
  vi.stubEnv('CM_OPENCODE_V2_DIR', join(sandbox, 'opencode-v2'));
});

afterEach(() => {
  resetOpencodeV2PortAssignments();
  vi.unstubAllEnvs();
  clearOpencodeExecutableCache();
  removeTempDir(sandbox);
});

describe('parseOpencodeVersionOutput', () => {
  it('reads a bare 1.x as OpenCode 1.x', () => {
    expect(parseOpencodeVersionOutput('1.18.33\n')).toEqual({ generation: 'v1', version: '1.18.33' });
  });

  it('reads `opencode v2.x` as OpenCode V2', () => {
    expect(parseOpencodeVersionOutput('opencode v2.0.18\n')).toEqual({
      generation: 'v2',
      version: '2.0.18',
    });
  });

  it('answers null for empty output', () => {
    expect(parseOpencodeVersionOutput('')).toBeNull();
    expect(parseOpencodeVersionOutput('\n  \n')).toBeNull();
  });

  it('answers null for output that is not a version of OpenCode', () => {
    expect(parseOpencodeVersionOutput('command not found')).toBeNull();
    expect(parseOpencodeVersionOutput('something v2.0.18')).toBeNull();
    expect(parseOpencodeVersionOutput('version 1.18.33 of something')).toBeNull();
    expect(parseOpencodeVersionOutput('0.9.1')).toBeNull();
    expect(parseOpencodeVersionOutput('1.18')).toBeNull();
  });

  it('is the rule OpenCode V2 reads its own version by', () => {
    expect(parseOpencodeV2Version('opencode v2.0.18\n')).toBe('2.0.18');
    expect(parseOpencodeV2Version('1.18.33\n')).toBeNull();
  });
});

describe('only an `opencode` that is OpenCode V2 on PATH', () => {
  let v2Path: string;

  beforeEach(() => {
    const bin = join(sandbox, 'bin');
    v2Path = fakeBinary(bin, 'opencode', 'opencode v2.0.18');
    vi.stubEnv('PATH', bin);
  });

  it('OpenCode 1.x is not installed, and says why', async () => {
    expect(await new OpenCodeTool().isInstalled()).toBe(false);

    const resolution = await resolveOpencodeV1Executable();
    expect(resolution.executable).toBeNull();
    const reason = describeOpencodeV1Unavailable(resolution);
    expect(reason).toContain(v2Path);
    expect(reason).toContain('OpenCode V2 2.0.18');
    expect(buildMissingToolMessage(new OpenCodeTool(), reason)).toMatch(
      /^OpenCode \(opencode\) is not installed or not in PATH\. .*OpenCode V2 2\.0\.18/
    );
  });

  it('OpenCode V2 is installed, and launches that `opencode` by its absolute path', async () => {
    expect(await new OpenCodeV2Tool().isInstalled()).toBe(true);

    const resolved = (await resolveOpencodeV2Executable()).executable;
    expect(resolved).toEqual({ path: v2Path, version: '2.0.18', generation: 'v2' });

    // With no server reserved it takes the standalone line — with the path
    // that answered.
    const plan = prepareOpencodeV2Launch({
      target: { worktreeId: 'wt-2939', cliToolId: 'opencode-v2' },
      executablePath: resolved!.path,
      worktreePath: sandbox,
    });
    expect(plan.command).toBe(`'${v2Path}' --standalone '${sandbox}'`);
  });

  it('Issue #2952: with a server reserved, the wrapper runs that `opencode` by --executable', async () => {
    const resolved = (await resolveOpencodeV2Executable()).executable;
    expect(resolved?.path).toBe(v2Path);

    const target = { worktreeId: 'wt-2952', cliToolId: 'opencode-v2' as const, instanceId: 'opencode-v2' };
    rememberOpencodeV2Port(target, 4352, sandbox);
    const passwordFile = writeOpencodeV2Password(target);

    const plan = prepareOpencodeV2Launch({
      target,
      executablePath: resolved!.path,
      worktreePath: sandbox,
    });
    expect(plan.command).toBe(
      `bash '${resolveOpencodeV2LaunchScriptPath()}' --port 4352 ` +
        `--password-file '${passwordFile}' --directory '${sandbox}' --executable '${v2Path}'`
    );
    expect(plan.command).not.toContain('--standalone');
    expect(plan.env).toEqual({});
  });
});

describe('`opencode` = 1.18.33 and `opencode2` = v2.0.18', () => {
  let v1Path: string;
  let v2Path: string;

  beforeEach(() => {
    const bin = join(sandbox, 'bin');
    v1Path = fakeBinary(bin, 'opencode', '1.18.33');
    v2Path = fakeBinary(bin, 'opencode2', 'opencode v2.0.18');
    vi.stubEnv('PATH', bin);
  });

  it('both are installed', async () => {
    expect(await new OpenCodeTool().isInstalled()).toBe(true);
    expect(await new OpenCodeV2Tool().isInstalled()).toBe(true);
  });

  it('each launch line runs its own absolute path', async () => {
    const v1 = (await resolveOpencodeV1Executable()).executable;
    const v2 = (await resolveOpencodeV2Executable()).executable;
    expect(v1).toEqual({ path: v1Path, version: '1.18.33', generation: 'v1' });
    expect(v2).toEqual({ path: v2Path, version: '2.0.18', generation: 'v2' });

    const v1Plan = prepareOpencodeLaunch({
      target: { worktreeId: 'wt-2939', cliToolId: 'opencode' },
      executablePath: v1!.path,
      worktreePath: sandbox,
    });
    expect(v1Plan.command.startsWith(v1Path) || v1Plan.command.startsWith(`'${v1Path}'`)).toBe(
      true
    );

    const v2Plan = prepareOpencodeV2Launch({
      target: { worktreeId: 'wt-2939', cliToolId: 'opencode-v2' },
      executablePath: v2!.path,
      worktreePath: sandbox,
    });
    expect(v2Plan.command).toBe(`'${v2Path}' --standalone '${sandbox}'`);
  });
});

describe('two `opencode`s on PATH, V2 first', () => {
  it('OpenCode 1.x is the later one, not the first one', async () => {
    const v2Path = fakeBinary(join(sandbox, 'homebrew'), 'opencode', 'opencode v2.0.18');
    const v1Path = fakeBinary(join(sandbox, 'dot-opencode'), 'opencode', '1.18.33');
    vi.stubEnv('PATH', [join(sandbox, 'homebrew'), join(sandbox, 'dot-opencode')].join(':'));

    expect((await resolveOpencodeV1Executable()).executable?.path).toBe(v1Path);
    expect((await resolveOpencodeV2Executable()).executable?.path).toBe(v2Path);
  });
});

describe('an `opencode` that answers something else', () => {
  it('is neither, and OpenCode 1.x says it did not report a 1.x version', async () => {
    const bin = join(sandbox, 'bin');
    const path = fakeBinary(bin, 'opencode', 'not opencode');
    vi.stubEnv('PATH', bin);

    const v1 = await resolveOpencodeV1Executable();
    expect(v1.executable).toBeNull();
    expect(describeOpencodeV1Unavailable(v1)).toContain(path);
    expect((await resolveOpencodeV2Executable()).executable).toBeNull();
  });

  it('nothing on PATH has no extra reason', async () => {
    vi.stubEnv('PATH', join(sandbox, 'empty'));
    expect(describeOpencodeV1Unavailable(await resolveOpencodeV1Executable())).toBeNull();
  });
});
