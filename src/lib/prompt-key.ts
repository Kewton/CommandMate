/**
 * Shared prompt key generation utility for deduplication.
 * Used by both client-side (useAutoYes.ts) and server-side (auto-yes-manager.ts)
 * to ensure consistent prompt identification.
 *
 * @internal Used for in-memory comparison only. Do NOT use for logging,
 * persistence, or external output. If the return value is ever used in
 * log output, DB storage, or HTML rendering, apply appropriate sanitization
 * (CR/LF escaping, prepared statements, HTML escaping respectively).
 * See SEC: S4-F001.
 */
export function generatePromptKey(promptData: { type: string; question: string }): string {
  return `${promptData.type}:${promptData.question}`;
}
