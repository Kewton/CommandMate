/**
 * Unit tests for CLIToolManager
 *
 * Issue #1752: このファイルは以前 child_process をモックしておらず、`getToolInfo` /
 * `getAllToolsInfo` / `getInstalledTools` を呼ぶたびに 7 ツール分の実プロセスが起動していた。
 * `BaseCLITool.isInstalled()` は `which <cmd>`（timeout 5000ms）、`CopilotTool.isInstalled()` は
 * `gh --version` → `gh copilot --help` の 2 段直列（最悪 5000 + 5000 = 10,000ms）で、
 * vitest 側は `testTimeout` 未設定＝既定 5000ms。つまり内側の予算が外側を構造的に超えており、
 * 負荷の高い CI ランナーではアサーション不一致ではなく **タイムアウト** で落ちていた。
 * exec / execFile をモックして実プロセスを排除し、あわせて `installed` を true / false の
 * 両方で固定する（以前は `typeof info.installed === 'boolean'` しか見ておらず、
 * どちらに転んでも緑になる assertion だった）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as childProcess from 'child_process';

// 実プロセス起動の唯一の入口である exec / execFile を差し替える。
// `BaseCLITool` と `claude-session.isClaudeInstalled()` は exec、`CopilotTool` は execFile を使う。
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    exec: vi.fn(),
    execFile: vi.fn(),
  };
});

// `stopPollers()` の委譲先。このファイルは stopPollers を検証しない
// （それは manager-stop-pollers.test.ts の担当）のに、response-poller の依存グラフだけで
// import に 500ms 以上かかるため切り離す。実行時間の短縮が目的で、被検証範囲は変わらない。
vi.mock('@/lib/polling/response-poller', () => ({ stopPolling: vi.fn() }));

import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** Map への登録順 = `getAllTools()` / `getAllToolsInfo()` の並び順 */
const TOOL_ORDER: CLIToolType[] = [
  'claude',
  'codex',
  'gemini',
  'vibe-local',
  'opencode',
  'copilot',
  'antigravity',
];

/** 偽の `which` が見つけるコマンド集合 */
let installedCommands: Set<string>;
/** `gh --version`（stage 1）の成否 */
let ghVersionOk: boolean;
/** `gh copilot --help`（stage 2）の成否 */
let ghCopilotOk: boolean;
/** true の間コールバックを発火せず parked に積む（並列性を観測するため） */
let holdCallbacks: boolean;

/** 記録された `exec` のコマンド文字列 */
let execCommands: string[];
/** 記録された `execFile` の [file, ...args] */
let execFileCalls: string[][];
/** holdCallbacks 中に保留されたコールバック */
let parked: Array<() => void>;

function respond(ok: boolean, callback: ExecCallback | undefined): void {
  if (!callback) return;
  const fire = (): void => {
    if (ok) {
      callback(null, 'ok', '');
    } else {
      callback(new Error('Command failed'), '', 'not found');
    }
  };
  if (holdCallbacks) {
    parked.push(fire);
  } else {
    queueMicrotask(fire);
  }
}

/** 保留中のコールバックを、連鎖して増えた分がなくなるまで発火する */
async function releaseParked(): Promise<void> {
  holdCallbacks = false;
  while (parked.length > 0) {
    const batch = parked.splice(0, parked.length);
    for (const fire of batch) fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('CLIToolManager', () => {
  let manager: CLIToolManager;

  beforeEach(() => {
    manager = CLIToolManager.getInstance();

    installedCommands = new Set<string>();
    ghVersionOk = false;
    ghCopilotOk = false;
    holdCallbacks = false;
    execCommands = [];
    execFileCalls = [];
    parked = [];

    vi.mocked(childProcess.exec).mockImplementation(((
      command: string,
      _options: unknown,
      callback?: unknown
    ) => {
      execCommands.push(command);
      const target = command.replace(/^which\s+/, '');
      respond(installedCommands.has(target), callback as ExecCallback | undefined);
      return {} as childProcess.ChildProcess;
    }) as unknown as typeof childProcess.exec);

    vi.mocked(childProcess.execFile).mockImplementation(((
      file: string,
      args: string[],
      _options: unknown,
      callback?: unknown
    ) => {
      execFileCalls.push([file, ...args]);
      const ok = args[0] === '--version' ? ghVersionOk : ghCopilotOk;
      respond(ok, callback as ExecCallback | undefined);
      return {} as childProcess.ChildProcess;
    }) as unknown as typeof childProcess.execFile);
  });

  describe('Singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = CLIToolManager.getInstance();
      const instance2 = CLIToolManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getTool', () => {
    it('should return ClaudeTool for claude', () => {
      const tool = manager.getTool('claude');
      expect(tool.id).toBe('claude');
      expect(tool.name).toBe('Claude Code');
      expect(tool.command).toBe('claude');
    });

    it('should return CodexTool for codex', () => {
      const tool = manager.getTool('codex');
      expect(tool.id).toBe('codex');
      expect(tool.name).toBe('Codex CLI');
      expect(tool.command).toBe('codex');
    });

    it('should return GeminiTool for gemini', () => {
      const tool = manager.getTool('gemini');
      expect(tool.id).toBe('gemini');
      expect(tool.name).toBe('Gemini CLI');
      expect(tool.command).toBe('gemini');
    });

    it('should return VibeLocalTool for vibe-local', () => {
      const tool = manager.getTool('vibe-local');
      expect(tool.id).toBe('vibe-local');
      expect(tool.name).toBe('Vibe Local');
      expect(tool.command).toBe('vibe-local');
    });

    it('should return OpenCodeTool for opencode', () => {
      const tool = manager.getTool('opencode');
      expect(tool.id).toBe('opencode');
      expect(tool.name).toBe('OpenCode');
      expect(tool.command).toBe('opencode');
    });

    it('should return CopilotTool for copilot', () => {
      const tool = manager.getTool('copilot');
      expect(tool.id).toBe('copilot');
      expect(tool.name).toBe('Copilot');
      expect(tool.command).toBe('gh');
    });

    it('should return AntigravityTool for antigravity (Issue #988)', () => {
      const tool = manager.getTool('antigravity');
      expect(tool.id).toBe('antigravity');
      expect(tool.name).toBe('Antigravity CLI');
      expect(tool.command).toBe('agy');
    });

    it('should return the same instance for the same tool type', () => {
      const tool1 = manager.getTool('claude');
      const tool2 = manager.getTool('claude');
      expect(tool1).toBe(tool2);
    });

    it('should throw for an unknown tool type', () => {
      expect(() => manager.getTool('nope' as CLIToolType)).toThrow(
        "CLI tool 'nope' not found"
      );
    });
  });

  describe('getAllTools', () => {
    it('should return all seven tools', () => {
      const tools = manager.getAllTools();
      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.id)).toEqual(TOOL_ORDER);
    });

    it('should return tools in consistent order', () => {
      const tools1 = manager.getAllTools();
      const tools2 = manager.getAllTools();

      expect(tools1.map((t) => t.id)).toEqual(tools2.map((t) => t.id));
    });
  });

  describe('getToolInfo', () => {
    it('should report installed = true when the command is on PATH', async () => {
      installedCommands = new Set(['claude']);

      const info = await manager.getToolInfo('claude');

      expect(info).toEqual({
        id: 'claude',
        name: 'Claude Code',
        command: 'claude',
        installed: true,
      });
      expect(execCommands).toEqual(['which claude']);
    });

    it('should report installed = false when the command is missing from PATH', async () => {
      installedCommands = new Set<string>();

      const info = await manager.getToolInfo('claude');

      expect(info).toEqual({
        id: 'claude',
        name: 'Claude Code',
        command: 'claude',
        installed: false,
      });
      expect(execCommands).toEqual(['which claude']);
    });

    it('should probe each tool with its own command', async () => {
      installedCommands = new Set(['codex']);

      const codexInfo = await manager.getToolInfo('codex');
      const geminiInfo = await manager.getToolInfo('gemini');
      const antigravityInfo = await manager.getToolInfo('antigravity');

      expect(codexInfo.installed).toBe(true);
      expect(geminiInfo.installed).toBe(false);
      expect(antigravityInfo.installed).toBe(false);
      expect(execCommands).toEqual(['which codex', 'which gemini', 'which agy']);
    });
  });

  /**
   * Issue #545 の 2 段チェックを manager 越しに固定する。
   * stage 2 を落とすと「gh さえ入っていれば copilot 扱い」に退行するため、
   * stage 1 単独成功で false になること／stage 1 失敗時に stage 2 を呼ばないことを個別に押さえる。
   */
  describe('getToolInfo (copilot の 2 段チェック)', () => {
    it('should report installed = true only when both gh and the copilot extension answer', async () => {
      ghVersionOk = true;
      ghCopilotOk = true;

      const info = await manager.getToolInfo('copilot');

      expect(info.installed).toBe(true);
      expect(execFileCalls).toEqual([
        ['gh', '--version'],
        ['gh', 'copilot', '--help'],
      ]);
    });

    it('should report installed = false when gh answers but the copilot extension does not', async () => {
      ghVersionOk = true;
      ghCopilotOk = false;

      const info = await manager.getToolInfo('copilot');

      expect(info.installed).toBe(false);
      expect(execFileCalls).toEqual([
        ['gh', '--version'],
        ['gh', 'copilot', '--help'],
      ]);
    });

    it('should skip the copilot extension check entirely when gh itself is missing', async () => {
      ghVersionOk = false;
      ghCopilotOk = true; // stage 2 に到達したら true になってしまう設定

      const info = await manager.getToolInfo('copilot');

      expect(info.installed).toBe(false);
      expect(execFileCalls).toEqual([['gh', '--version']]);
    });
  });

  describe('getAllToolsInfo', () => {
    it('should return per-tool installation status for all seven tools', async () => {
      installedCommands = new Set(['claude', 'gemini', 'agy']);
      ghVersionOk = true;
      ghCopilotOk = true;

      const allInfo = await manager.getAllToolsInfo();

      expect(allInfo).toEqual([
        { id: 'claude', name: 'Claude Code', command: 'claude', installed: true },
        { id: 'codex', name: 'Codex CLI', command: 'codex', installed: false },
        { id: 'gemini', name: 'Gemini CLI', command: 'gemini', installed: true },
        { id: 'vibe-local', name: 'Vibe Local', command: 'vibe-local', installed: false },
        { id: 'opencode', name: 'OpenCode', command: 'opencode', installed: false },
        { id: 'copilot', name: 'Copilot', command: 'gh', installed: true },
        { id: 'antigravity', name: 'Antigravity CLI', command: 'agy', installed: true },
      ]);
    });

    it('should report every tool as not installed when nothing is on PATH', async () => {
      const allInfo = await manager.getAllToolsInfo();

      expect(allInfo.map((info) => info.id)).toEqual(TOOL_ORDER);
      expect(allInfo.map((info) => info.installed)).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
    });

    it('should issue every probe before any of them resolves (checks run concurrently)', async () => {
      installedCommands = new Set([
        'claude',
        'codex',
        'gemini',
        'vibe-local',
        'opencode',
        'agy',
      ]);
      ghVersionOk = true;
      ghCopilotOk = true;
      holdCallbacks = true;

      const pending = manager.getAllToolsInfo();

      // 直列化されていればこの時点で発行済みの probe は先頭 1 本だけになる。
      // 7 ツール分がすべて in-flight であることが、Promise.all を使っている証拠。
      expect(execCommands).toEqual([
        'which claude',
        'which codex',
        'which gemini',
        'which vibe-local',
        'which opencode',
        'which agy',
      ]);
      expect(execFileCalls).toEqual([['gh', '--version']]);

      await releaseParked();

      const allInfo = await pending;
      expect(allInfo.map((info) => info.installed)).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
    });
  });

  describe('getInstalledTools', () => {
    it('should return only the tools whose probe succeeded', async () => {
      installedCommands = new Set(['claude', 'gemini', 'agy']);
      ghVersionOk = true;
      ghCopilotOk = false; // copilot は gh があっても拡張が無いので除外される

      const installed = await manager.getInstalledTools();

      expect(installed.map((info) => info.id)).toEqual(['claude', 'gemini', 'antigravity']);
      for (const info of installed) {
        expect(info.installed).toBe(true);
      }
    });

    it('should return an empty array when no tool is installed', async () => {
      const installed = await manager.getInstalledTools();

      expect(installed).toEqual([]);
    });
  });
});
