/**
 * Input for prompt key generation.
 * Uses a minimal interface (ISP) requiring only the fields needed
 * for key construction, rather than depending on the full PromptData type.
 */
export interface PromptKeyInput {
  /** Prompt type identifier (e.g., 'yes_no', 'multiple_choice') */
  type: string;
  /** The question text displayed to the user */
  question: string;
}

/**
 * Generate a composite key for prompt deduplication.
 *
 * Used by both client-side (useAutoYes.ts) and server-side (auto-yes-manager.ts)
 * to ensure consistent prompt identification across the duplicate prevention system.
 *
 * The key format is `{type}:{question}`, which uniquely identifies a prompt
 * by combining its type and question text.
 *
 * @param promptData - Prompt data containing type and question fields
 * @returns Composite key string in the format "type:question"
 *
 * @internal Used for in-memory comparison only. Do NOT use for logging,
 * persistence, or external output. If the return value is ever used in
 * log output, DB storage, or HTML rendering, apply appropriate sanitization
 * (CR/LF escaping, prepared statements, HTML escaping respectively).
 * See SEC: S4-F001.
 *
 * @example
 * ```typescript
 * const key = generatePromptKey({ type: 'yes_no', question: 'Continue?' });
 * // Returns 'yes_no:Continue?'
 * ```
 */
export function generatePromptKey(promptData: PromptKeyInput): string {
  return `${promptData.type}:${promptData.question}`;
}
