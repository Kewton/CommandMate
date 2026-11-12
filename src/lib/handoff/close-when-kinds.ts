/**
 * The one source of the sentences that say which kinds of a hand-off proposal need `--close-when`
 * (Issue #4227 G-PR4, G9). Built from `CLOSE_WHEN_DEFAULTS` (null = required) and `MEM_KINDS`, so no
 * place writes the list by hand: the request text (`lib/handoff/template`), the help body of
 * `commandmate handoff` and the help of `propose add --close-when` use the return value as it is; the
 * ja / en guides carry the generated line verbatim, which
 * `tests/unit/cli/commands/handoff-close-when-places-4227.test.ts` checks.
 *
 * Read by the CLI: this file imports with relative paths only (no `@/` alias, which the CLI build
 * `tsconfig.cli.json` cannot resolve), and only `types/mem`, which imports nothing.
 *
 * @module lib/handoff/close-when-kinds
 */

import { CLOSE_WHEN_DEFAULTS, MEM_EXIT_BY_CODE, MEM_KINDS, type MemKind } from '../../types/mem';

/** The kinds a hand-off can propose (`now` is the agent's own, not proposed). */
export type ProposeKind = Exclude<MemKind, 'now'>;

export interface CloseWhenKindsText {
  /** The kinds whose `--close-when` is required (no default), in `MEM_KINDS` order. */
  required: readonly ProposeKind[];
  /** The kinds that may omit it (a default exists), in `MEM_KINDS` order. */
  optional: readonly ProposeKind[];
  /** `waiting / next / external` */
  requiredList: string;
  /** `decision / note` */
  optionalList: string;
  /** One line, Japanese: the request text, and `docs/user-guide/cli-operations-guide.md` verbatim. */
  ja: string;
  /** One line, English: the help body of `commandmate handoff`, and the en guide verbatim. */
  en: string;
  /** The description of `propose add --close-when` and of `mem add --close-when`. */
  option: string;
  /** The line that heads the `--close-when` part of the help body of `commandmate mem`. */
  memHelp: string;
  /** One line, Japanese: the `commandmate mem` chapter of the ja guide, verbatim. */
  memJa: string;
  /** One line, English: the `commandmate mem` chapter of the en guide, verbatim. */
  memEn: string;
}

export function closeWhenKindsText(): CloseWhenKindsText {
  const kinds = MEM_KINDS.filter((kind): kind is ProposeKind => kind !== 'now');
  const required = kinds.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] === null);
  const optional = kinds.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] !== null);
  const requiredList = required.join(' / ');
  const optionalList = optional.join(' / ');
  const exit = MEM_EXIT_BY_CODE.invalid_close_when;
  return {
    required,
    optional,
    requiredList,
    optionalList,
    ja: `propose add の --close-when は kind が ${requiredList} のとき必須（無いと終了コード ${exit} で、何も保存しない）。${optionalList} は省略できる。`,
    en: `--close-when of "propose add": required for kind ${requiredList} (without it: exit ${exit}, nothing stored); optional for ${optionalList}.`,
    option: `When it closes (required for ${requiredList})`,
    memHelp: `--close-when (required for ${requiredList}):`,
    memJa: `mem add の --close-when は kind が ${requiredList} のとき必須（無いと終了コード ${exit} で、何も保存しない）。${optionalList} は省略できる。`,
    memEn: `--close-when of "mem add": required for kind ${requiredList} (without it: exit ${exit}, nothing stored); optional for ${optionalList}.`,
  };
}
