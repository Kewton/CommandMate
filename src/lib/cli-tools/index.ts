/**
 * CLI Tools Module
 * Provides abstraction layer for multiple SWE CLI tools (Claude, Codex, Gemini)
 *
 * @module cli-tools
 */

// Export types and interfaces
export type { CLIToolType, ICLITool, CLIToolInfo, IImageCapableCLITool } from './types';
export { isImageCapableCLITool } from './types';

// Export the per-tool contracts (Issue #1933)
export type {
  CaptureSpec,
  ComposerSpec,
  ComposerReader,
  GracefulExitSpec,
  GracefulExitFailureReason,
  GracefulExitVerdict,
  KeySequence,
  KeySequenceKeyName,
} from '../../types/cli-tool-contracts';
export { resolveComposerSpec, DEFAULT_COMPOSER_SPEC } from './composer-spec';
export { resolveCaptureSpec, GEMINI_PANE_HEIGHT } from './capture-spec';
export {
  resolveGracefulExitSpec,
  verifyGracefulExit,
  DEFAULT_GRACEFUL_EXIT_SPEC,
} from './graceful-exit';

// Export base class
export { BaseCLITool } from './base';

// Export CLI tool implementations
export { ClaudeTool } from './claude';
export { CodexTool } from './codex';
export { GeminiTool } from './gemini';
export { AntigravityTool } from './antigravity';

// Export CLI tool manager
export { CLIToolManager } from './manager';
