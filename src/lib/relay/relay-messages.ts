/**
 * Every sentence a relay puts in front of an agent or a reader (Issue #2377).
 *
 * ## Why the text is here and not in `locales/`
 *
 * Two of the four go into an AGENT's composer, which makes them prompts rather
 * than labels: the `[from …]` header is what tells session A that the paragraph
 * underneath it was written by somebody else, and a key that resolved to its own
 * name — a renamed namespace, a dictionary that failed to load — would hand A an
 * unattributed wall of text from another session and no way to tell. The same
 * argument `buildDelegationBrief` makes in `lib/cli/command-reference`, and the
 * same shape `buildModelChangedSentence` uses for the model-change history row
 * (#2357): both languages written out side by side so a change to one is
 * visibly a change to the other.
 *
 * The UI's own labels — the badges, the chat strip — ARE in `locales/`, because
 * those are labels.
 *
 * ## The header is machine-readable on purpose
 *
 * {@link RELAY_HEADER_PREFIX} opens every delivered body in both languages, so
 * a reader (a human, an agent, a later `capture`) can recognise a relayed
 * message without knowing which language the server was speaking. The body
 * after it is B's own text, untouched — summarising or translating it is out of
 * scope by the Issue's own words.
 *
 * @module lib/relay/relay-messages
 */

import type { SupportedLocale } from '@/config/i18n-config';

/**
 * The literal every relayed body starts with.
 *
 * `[from ` and not a localized word: it is the one token a consumer may match
 * on, and it has to mean the same thing in both dictionaries.
 */
export const RELAY_HEADER_PREFIX = '[from ';

/** How long a quoted prompt question may be before it is elided. */
const PROMPT_SUMMARY_MAX_CHARS = 200;

/** How many options of a confirmation are listed before the rest are counted. */
const PROMPT_OPTIONS_MAX = 9;

/** Who a relayed message is from, as the header names them. */
export interface RelaySenderLabel {
  /** The roster alias, e.g. `Codex 2`. Falls back to the instance id. */
  alias: string;
  /** The worktree the sender lives in. */
  worktreeId: string;
}

/**
 * `[from <alias> / <worktree>]` — the attribution line.
 *
 * Both fields, always: an alias alone is ambiguous across worktrees (every
 * repository's roster tends to contain a `Codex 2`) and a worktree alone does
 * not say which of its sessions answered.
 */
export function buildRelayHeader(sender: RelaySenderLabel): string {
  return `${RELAY_HEADER_PREFIX}${sender.alias} / ${sender.worktreeId}]`;
}

/**
 * B's reply, attributed.
 *
 * The body is passed through verbatim — no summary, no translation, no
 * re-wrapping. A blank body still gets a header: "they finished and said
 * nothing" is information, and swallowing the delivery would leave A waiting on
 * a relay that has already closed.
 */
export function buildRelayReplyMessage(
  sender: RelaySenderLabel,
  reply: string
): string {
  const body = reply.trim();
  return body === ''
    ? `${buildRelayHeader(sender)} (no reply body)`
    : `${buildRelayHeader(sender)} ${body}`;
}

/** One choice of a confirmation, as the notice lists it. */
export interface RelayPromptOption {
  /** What the operator would type; usually a digit. */
  key: string;
  label: string;
}

/** What {@link buildRelayPromptMessage} describes. */
export interface RelayPromptNotice {
  /** The dialog's question, as the agent asked it. */
  question: string;
  options: RelayPromptOption[];
}

/** Collapse whitespace and clip, so a 40-line dialog is one readable line. */
function squeeze(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const PROMPT_TEMPLATES: Record<SupportedLocale, { waiting: string; options: string; more: string }> = {
  en: {
    waiting: 'is waiting for a confirmation:',
    options: 'Options:',
    more: '(+{n} more)',
  },
  ja: {
    waiting: '確認待ちです:',
    options: '選択肢:',
    more: '(他 {n} 件)',
  },
};

/**
 * "They are blocked on a dialog, and here is what it asks."
 *
 * Deliberately NOT an instruction to answer it. `respond` on somebody else's
 * dialog picks whatever option happens to be highlighted (#1681), and the
 * delegation brief already forbids it; this notice exists so A can decide what
 * to do, which is usually to tell a human.
 */
export function buildRelayPromptMessage(
  locale: SupportedLocale,
  sender: RelaySenderLabel,
  notice: RelayPromptNotice
): string {
  const t = PROMPT_TEMPLATES[locale];
  const head = `${buildRelayHeader(sender)} ${t.waiting} ${squeeze(notice.question, PROMPT_SUMMARY_MAX_CHARS)}`;
  if (notice.options.length === 0) return head;

  const shown = notice.options.slice(0, PROMPT_OPTIONS_MAX);
  const rest = notice.options.length - shown.length;
  const listed = shown.map((o) => `${o.key}) ${squeeze(o.label, 60)}`).join('  ');
  const more = rest > 0 ? ` ${t.more.replace('{n}', String(rest))}` : '';
  return `${head}\n${t.options} ${listed}${more}`;
}

const EXPIRED_TEMPLATES: Record<SupportedLocale, string> = {
  en: 'The reply you were waiting for did not arrive within {hours}h; the relay has expired.',
  ja: '待っていた返信が {hours} 時間以内に届かなかったため、委任は期限切れになりました。',
};

/**
 * The single line an expired relay leaves in A's composer.
 *
 * One line and one only — the Issue's "1行だけ通知". The once-ness is enforced
 * by the ledger (`markRelayExpired` is a guarded update), not by this string.
 */
export function buildRelayExpiredMessage(
  locale: SupportedLocale,
  sender: RelaySenderLabel,
  ttlMs: number
): string {
  const hours = Math.max(1, Math.round(ttlMs / 3_600_000));
  return `${buildRelayHeader(sender)} ${EXPIRED_TEMPLATES[locale].replace('{hours}', String(hours))}`;
}

const SYSTEM_TEMPLATES: Record<
  SupportedLocale,
  { requested: string; replied: string; waiting: string; expired: string }
> = {
  en: {
    requested: 'Delegated to {alias}; waiting for the reply.',
    replied: 'Reply from {alias}.',
    waiting: '{alias} is waiting for a confirmation.',
    expired: 'The delegation to {alias} expired without a reply.',
  },
  ja: {
    requested: '{alias} へ委任、返信待ち',
    replied: '{alias} から返信',
    waiting: '{alias} が確認待ち',
    expired: '{alias} への委任が返信のないまま期限切れ',
  },
};

/** Which system line to write into the requester's transcript. */
export type RelaySystemLineKind = 'requested' | 'replied' | 'waiting' | 'expired';

/**
 * The one-line system row the chat surface and History both show.
 *
 * Written into `chat_messages` exactly as the model-change row is (#2357), in
 * the readers' language, because a stored row cannot be re-rendered per viewer.
 */
export function buildRelaySystemLine(
  locale: SupportedLocale,
  kind: RelaySystemLineKind,
  alias: string
): string {
  return SYSTEM_TEMPLATES[locale][kind].replace('{alias}', alias);
}
