/**
 * CLI Tool response polling - barrel file (Issue #575).
 * Re-exports all public API from sub-modules.
 *
 * Issue #479: Split into sub-modules for single-responsibility separation.
 * Issue #575: Further split into response-poller-core.ts and response-checker.ts.
 *
 * Note: export * is intentionally avoided (D4-001) to prevent
 * @internal functions from being unintentionally exposed.
 */

// ============================================================================
// Named re-exports from sub-modules (barrel pattern, D4-001: no export *)
// ============================================================================

// response-poller-core public API (polling lifecycle)
export { startPolling, stopPolling, stopAllPolling, getActivePollers } from './response-poller-core';

// response-extractor public API
export { resolveExtractionStartIndex, isOpenCodeComplete } from '../response-extractor';

// response-cleaner public API
export { cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse, cleanCopilotResponse, truncateMessage } from '../response-cleaner';

// tui-accumulator public API (@internal functions, exported for test access)
export {
  extractTuiContentLines,
  extractCopilotContentLines,
  normalizeCopilotLine,
  findOverlapIndex,
  initTuiAccumulator,
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
} from '../tui-accumulator';

// prompt-dedup public API
export { isDuplicatePrompt, clearPromptHashCache, normalizePromptForDedup } from './prompt-dedup';
