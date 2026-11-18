/**
 * What a screen needs to show a tool-policy refusal (Issue #4436).
 *
 * The API answers a refused Antigravity request with 409
 * `{ code: 'TOOL_POLICY_DENIED', error, reason, links: { terms, faq } }`. The
 * screens only repeat what the response says: the sentence and the two links,
 * as given (no URL is written here). Pure; imports nothing but `policy.ts`.
 */

import { TOOL_POLICY_DENIED, TOOL_POLICY_DENIED_MESSAGE } from './policy';

/** The sentence and links a refusal notice shows. */
export interface ToolPolicyRefusalView {
  message: string;
  links: { terms: string; faq: string };
}

/** Thrown by a toggle handler so the toggle can show the refusal beside its switch. */
export class ToolPolicyRefusalError extends Error {
  readonly view: ToolPolicyRefusalView;
  constructor(view: ToolPolicyRefusalView) {
    super(view.message);
    this.name = 'ToolPolicyRefusalError';
    this.view = view;
  }
}

function isWebUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * The refusal view of a response, or null when the response is anything else
 * (another status, another `code`, or links that are not both web URLs).
 */
export function parseToolPolicyRefusal(status: number, body: unknown): ToolPolicyRefusalView | null {
  if (status !== 409 || typeof body !== 'object' || body === null) return null;
  const { code, error, links } = body as { code?: unknown; error?: unknown; links?: unknown };
  if (code !== TOOL_POLICY_DENIED) return null;
  if (typeof links !== 'object' || links === null) return null;
  const { terms, faq } = links as { terms?: unknown; faq?: unknown };
  if (!isWebUrl(terms) || !isWebUrl(faq)) return null;
  return {
    message: typeof error === 'string' && error.trim() !== '' ? error : TOOL_POLICY_DENIED_MESSAGE,
    links: { terms, faq },
  };
}
