/**
 * CLI Tool Manager
 * Singleton class to manage multiple CLI tools (Claude, Codex, Gemini, Vibe Local, OpenCode)
 */

import type { CLIToolType, ICLITool, CLIToolInfo } from './types';
import { ClaudeTool } from './claude';
import { CodexTool } from './codex';
import { GeminiTool } from './gemini';
import { VibeLocalTool } from './vibe-local';
import { OpenCodeTool } from './opencode';
import { CopilotTool } from './copilot';
import { AntigravityTool } from './antigravity';

/**
 * CLI Tool Manager (Singleton)
 * Provides centralized access to all CLI tools (Issue #368: includes Vibe Local, Issue #379: includes OpenCode)
 */
export class CLIToolManager {
  private static instance: CLIToolManager;
  private tools: Map<CLIToolType, ICLITool>;

  /**
   * Private constructor for Singleton pattern
   */
  private constructor() {
    this.tools = new Map();

    // Initialize all tools
    this.tools.set('claude', new ClaudeTool());
    this.tools.set('codex', new CodexTool());
    this.tools.set('gemini', new GeminiTool());
    this.tools.set('vibe-local', new VibeLocalTool());
    this.tools.set('opencode', new OpenCodeTool());
    this.tools.set('copilot', new CopilotTool());
    this.tools.set('antigravity', new AntigravityTool());
  }

  /**
   * Get singleton instance
   *
   * @returns CLIToolManager instance
   */
  static getInstance(): CLIToolManager {
    if (!CLIToolManager.instance) {
      CLIToolManager.instance = new CLIToolManager();
    }
    return CLIToolManager.instance;
  }

  /**
   * Get a specific CLI tool by type
   *
   * @param type - CLI tool type
   * @returns CLI tool instance
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const claude = manager.getTool('claude');
   * await claude.startSession('my-worktree', '/path/to/worktree');
   * ```
   */
  getTool(type: CLIToolType): ICLITool {
    const tool = this.tools.get(type);
    if (!tool) {
      throw new Error(`CLI tool '${type}' not found`);
    }
    return tool;
  }

  /**
   * Get all CLI tools
   *
   * @returns Array of all CLI tool instances
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const allTools = manager.getAllTools();
   * console.log(allTools.map(t => t.name)); // ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Vibe Local', 'OpenCode']
   * ```
   */
  getAllTools(): ICLITool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get information about a specific tool including installation status
   *
   * @param type - CLI tool type
   * @returns Tool information with installation status
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const info = await manager.getToolInfo('claude');
   * if (info.installed) {
   *   console.log(`${info.name} is installed`);
   * }
   * ```
   */
  async getToolInfo(type: CLIToolType): Promise<CLIToolInfo> {
    const tool = this.getTool(type);
    const installed = await tool.isInstalled();

    return {
      id: tool.id,
      name: tool.name,
      command: tool.command,
      installed,
    };
  }

  /**
   * Get information about all tools including installation status
   *
   * @returns Array of tool information for all tools
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const allInfo = await manager.getAllToolsInfo();
   * allInfo.forEach(info => {
   *   console.log(`${info.name}: ${info.installed ? 'installed' : 'not installed'}`);
   * });
   * ```
   */
  async getAllToolsInfo(): Promise<CLIToolInfo[]> {
    const tools = this.getAllTools();
    const infoPromises = tools.map(async (tool) => {
      const installed = await tool.isInstalled();
      return {
        id: tool.id,
        name: tool.name,
        command: tool.command,
        installed,
      };
    });

    return Promise.all(infoPromises);
  }

  /**
   * Get only installed tools
   *
   * @returns Array of tool information for installed tools only
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const installed = await manager.getInstalledTools();
   * console.log(`${installed.length} tools installed`);
   * ```
   */
  async getInstalledTools(): Promise<CLIToolInfo[]> {
    const allInfo = await this.getAllToolsInfo();
    return allInfo.filter(info => info.installed);
  }

  /**
   * Stop pollers for a specific worktree and CLI tool
   * T2.4: Abstraction for poller stopping (MF1-001 DIP compliance)
   *
   * This method abstracts the poller stopping logic so API layer
   * doesn't need to know about specific poller implementations.
   *
   * ## Issue #1984: なぜ `await import()` なのか
   *
   * この 1 行のためだけに `manager.ts` が `../polling/response-poller` を静的 import して
   * いたことが、モジュールスコープの循環の起点だった:
   *
   *     ws-server -> cli-tools/manager -> polling/response-poller
   *       -> polling/response-poller-core -> polling/response-checker -> ws-server
   *       -> polling/response-poller-core -> realtime/terminal-broadcast -> ws-server
   *
   * `manager` を通る循環は実測 8 本あり、その **8 本すべて**が
   * `manager -> response-poller` を通る。つまりここ 1 辺で全部落ちる
   * （検査は tests/unit/guards/no-manager-poller-cycle-1984.test.ts）。
   *
   * 代償は API の非同期化。呼び出し元は `api/worktrees/[id]/kill-session/route.ts` の
   * 1 箇所だけで、そこは `await` を付けてある。**付け忘れると poller 停止が
   * 直後の `deleteSessionState()` より後ろにずれる**（型も lint も検出しない静かな
   * 挙動変化）ので、順序を
   * tests/unit/api/kill-session-stop-pollers-order-1984.test.ts で固定している。
   *
   * @param worktreeId - Worktree ID
   * @param cliToolId - CLI tool ID
   * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance.
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * await manager.stopPollers('my-worktree', 'claude');
   * ```
   */
  async stopPollers(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): Promise<void> {
    // Stop response-poller for all tools
    const { stopPolling: stopResponsePolling } = await import('../polling/response-poller');
    stopResponsePolling(worktreeId, cliToolId, instanceId);
  }
}
