# Epic #2055 子 Issue の変異注入スイープ（#2103）

- **Issue**: [#2103](https://github.com/Kewton/CommandMate/issues/2103)（親 Epic [#2055](https://github.com/Kewton/CommandMate/issues/2055)）
- **実施日**: 2026-08-27
- **対象**: Epic #2055 の子 Issue 24 件のうち、close-out 時点で変異注入未実施だった **17 件**
- **基準 commit**: `786e4765`（`develop`）
- **成果物**: 本書 ＋ [`tests/unit/lib/skills/opencode-matrix-measurement-2037.test.ts`](../../tests/unit/lib/skills/opencode-matrix-measurement-2037.test.ts)（空振り 1 件への追加テスト）

> Epic #2055 の受入条件「各子 Issue の受入条件が**機械可読なテスト（変異注入で赤になることを確認済み）**で固定されている」を、残り 17 件について埋めたもの。
> **本書に書いてあるのは推測ではなく、実際に production へ変異を当てて `vitest` を回した結果である。**
> Issue 本文の前提と実測が食い違った箇所は [§5](#5-issue-本文の前提と実測の食い違い) にまとめた。**食い違いは 2 件あり、うち 1 件は #2103 本文の指示を覆す。**

---

## 1. 結論サマリ

| # | 判定 | 件数 |
|---|---|---|
| 1 | 変異が赤を出した（テストは非空振り） | **15 件** |
| 2 | 変異は赤を出したが、**別の主張が空振り**だったのでテストを追加した | **1 件**（#2037） |
| 3 | 変異注入が意味を持たない（production の変更ゼロ） | **1 件**（#2052） |

- **17 件すべてに verdict がある。**
- #2053 は「不採用の裁定 pin」だが production に値として存在し、**変異注入は意味を持った**（#2103 本文の想定と異なる。[§5.1](#51-2053-は裁定-pin-だが変異注入は意味を持つ)）。
- 空振りは **1 件**見つかった: #2037 の第 1 受入条件「matrix の opencode 行が実測値になる」を守るテストが存在せず、**リポジトリ全体を回しても緑**だった。追加テストで塞ぎ、同じ変異で赤になることを確認した（[§4](#4-空振り-2037-の-matrix-行と追加テスト)）。
- **production の変更は残っていない。** 全変異は `git checkout --` で戻し、**md5 が事前ベースラインと一致すること**を毎回確認している（[§2.3](#23-復元の検証)）。

---

## 2. 手法

### 2.1 隔離 worktree

変異は本作業ブランチではなく、`git worktree add --detach` で切った使い捨ての worktree で当てた。

```bash
git worktree add --detach ../cm-mut-2103-2103 HEAD
cp -al node_modules ../cm-mut-2103-2103/node_modules   # ハードリンク
```

- ブランチは作らない（`--detach`）。稼働中の他 worktree（`MyCodeBranchDesk` / `commandmate-main` / `commandmate-issue-*`）には一切触れていない。
- 終了後に `git worktree remove` 済み。`git worktree list` に `cm-mut-2103-*` は残っていない。
- 17 件すべてを 1 個の worktree で直列に処理した（1 件 1 worktree にすると `node_modules` のハードリンクを 17 回張ることになり、得られる隔離は同じ）。

### 2.2 陽性・陰性の対照

**赤が変異のせいであることは、変異を戻して同じコマンドが緑になるまで言えない。** このマシンでは負荷起因の赤が実際に出ている（2026-08-27 実測: `develop` のフル `test:unit` で `db-migration-path.test.ts` の 2 件が `Test timed out in 5000ms`、`orchestrate-monitor/monitor-exit-codes.test.ts` の 1 件が stderr 空で赤。いずれも単独では緑）。

そこで 1 件ごとに次を機械的に回した。**対照は変異後の復元済みツリーで、変異時と同一のコマンド・同一のファイル集合**である。

```
baseline md5 → 変異を当てる → md5 が変わったことを確認（no-op 変異の検出）
  → CI=true NODE_ENV=test npx vitest run <対象テスト>   ... MUTANT
  → git checkout -- <file> → md5 がベースラインと一致することを確認
  → CI=true NODE_ENV=test npx vitest run <対象テスト>   ... CONTROL
  → git status --short が空であることを確認
```

本書の表の「赤になったか」欄は、**MUTANT が exit 1 かつ CONTROL が exit 0** だった組のみを「赤」と書いている。**下表の 20 本の変異すべてで CONTROL は exit 0**（緑）で、うち 19 本が MUTANT exit 1（赤）、1 本（#2037 の補強）が MUTANT exit 0（緑＝空振り）だった。赤はすべて assertion の不一致であり、タイムアウトや stderr 空で落ちたものは 1 件も無い。

### 2.3 復元の検証

`md5 -q <file>` を変異前後で比較し、復元後の値がベースラインと一致することを毎回確認した。不一致なら runner が exit 93 で止まる設計にしてある。**この runner を回したのは（表に載らない試行を含めて）22 回で、22 回とも `RESTORED_OK` を出し、`git status --short` は毎回空だった。**

加えて、本 Issue の scope は `src/**` / `server.ts` を **deny** にしてあるので、復元漏れがあれば scope ゲートが exit code で落とす。人の申告ではなく検算で担保されている。

### 2.4 変異の作り方（構造を壊さない）

- 使ったのは **値の入れ替え** / **境界のずらし** / **条件の無効化・反転**のみ。
- **行やブロックの削除はしていない。** 先行 Issue で gutter を削除する変異を当てたところ、後から gutter を境界に使う別のコードが別の理由で赤になり、変異の意味が読めなくなった事例があるため。
- 1 Issue につき「主張の中核」1 箇所。中核が複数ある Issue では 2 本目を当てて補強した（表の «補強» 行）。

### 2.5 空振り判定の手順

Issue のテストファイルだけを回して緑でも、**それだけでは空振りと言えない**（close-out で #2040 に対して実際に踏んだ落とし穴: 不変条件は守られていて、守っていたのが #1898 のテストだった）。

そこで緑が出た場合は、(1) 変異がその Issue の主張と噛み合っているかを確かめ、(2) 噛み合っていなければ狙いを付け直し、(3) それでも緑なら **`tests/unit` 全体**を回してから空振りと判定した。実際に全体を回したのは 1 件（#2037、[§4](#4-空振り-2037-の-matrix-行と追加テスト)）。

---

## 3. 結果表（17 件）

「赤になったか」は**赤になったファイル名と件数**で書いている。行番号は基準 commit `786e4765` のもの。

| Issue | 当てた変異（ファイル:行 と内容） | 対象テスト | 赤になったか | 備考 |
|---|---|---|---|---|
| **#2032** | `src/lib/tmux/tmux.ts:515` — `ALLOWED_SPECIAL_KEYS` の `'BTab'` を `'BTabb'` に（値の入れ替え。要素数は不変） | `tests/unit/tmux/special-keys-allowlist-2032.test.ts`, `tests/unit/api/special-keys-btab-2032.test.ts` | **赤 — 2 files / 8 tests**（allowlist 5 件 ＋ btab route 3 件） | 差集合テスト・`send-keys BTab` 発行・route 200 の 3 系統すべてが反応した |
| **#2034** | `src/lib/cli-tools/opencode.ts:1014` — `interrupt()` の `if (await abortOpencodeTurn(…))` を否定に（条件の反転） | `tests/unit/cli-tools/opencode-interrupt-abort-2034.test.ts`, `tests/unit/hooks/sources/opencode-abort-2034.test.ts` | **赤 — 1 file / 9 tests**（`opencode-interrupt-abort-2034.test.ts`） | 「API 一次」1 件と「Esc×2 fallback」7 件の**両側**が落ちた＝ fallback 側も空振りしていない |
| **#2035** | `src/lib/cli-tools/opencode.ts:737` — `sendMessage()` の `if (await this.trySendViaServer(…))` を否定に（条件の反転） | `tests/unit/cli-tools/opencode-send-api-2035.test.ts` | **赤 — 1 file / 14 tests** | `/` 始まり・3 行・幅超えの本文、read-back 検証、キーストローク fallback、画像劣化のすべてが反応した |
| **#2036** | `src/lib/command-merger.ts:200` — `foldInMissingCommands()` の `if (served.has(key)) continue;` を `!served.has(key)` に（条件の反転） | `tests/unit/api/slash-commands-opencode-live-2036.test.ts`, `tests/unit/lib/opencode-live-commands-2036.test.ts`, `tests/unit/lib/opencode-skills-loader-2036.test.ts`, `tests/unit/lib/slash-command-catalog.test.ts`, `tests/unit/lib/standard-commands.test.ts` | **赤 — 2 files / 6 tests**（`slash-commands-opencode-live-2036.test.ts` 2 件、`opencode-live-commands-2036.test.ts` 4 件） | 受入条件「`.opencode/commands/test.md` がパレットに説明つきで出る」と「catalog の説明が live 行に上書きされない」の両方が反応した |
| **#2037** | `src/lib/slash-commands.ts:475` — `loadOpencodeSkills()` の `cliTools: ['opencode']` を `['claude']` に（値の入れ替え） | `tests/unit/lib/opencode-skills-loader-2036.test.ts`, `tests/unit/lib/skills/agent-discovery-regression.test.ts`, `tests/unit/lib/skills/compatibility-matrix.test.ts`, `tests/unit/api/slash-commands-opencode-live-2036.test.ts` | **赤 — 3 files / 3 tests**（`slash-commands-opencode-live-2036.test.ts` 1 件、`opencode-skills-loader-2036.test.ts` 1 件、`agent-discovery-regression.test.ts` 1 件） | 第 2 受入条件（パレットに Skill が出る）は固定されている。**第 1 受入条件（matrix の実測値）は空振りだった** → [§4](#4-空振り-2037-の-matrix-行と追加テスト) |
| «補強» #2037 | `src/lib/skills/compatibility-matrix.ts:267` — opencode 行の `discovery.outcome` を `'verified'` → `'unsupported'`（`labelKey` も対応させて整合を保つ） | `tests/unit` **全体** | **緑（空振り）** → 追加テストで塞いだ | [§4](#4-空振り-2037-の-matrix-行と追加テスト) |
| **#2038** | `src/lib/session/opencode-session-store.ts:281` — `recoverOpencodeSessionId()` の `if (memory.worktreePath !== worktreePath)` を `===` に（条件の反転） | `tests/unit/session/opencode-session-store-2038.test.ts`, `tests/unit/cli-tools/opencode-session-resume-2038.test.ts`, `tests/unit/session/opencode-session-recall-2038.test.ts`, `tests/unit/session/opencode-session-api-2038.test.ts`, `tests/unit/session/opencode-session-route-2038.test.ts`, `tests/unit/cli-tools/opencode-session-capture-2038.test.ts`, `tests/unit/cli/commands/instances-opencode-session-2038.test.ts`, `tests/unit/components/worktree/OpencodeSessionControls-2038.test.tsx` | **赤 — 2 files / 6 tests**（`opencode-session-resume-2038.test.ts` 4 件、`opencode-session-store-2038.test.ts` 2 件） | 受入条件「別 worktree に紐づく sessionID は復元に使われない」を名指しする `ACCEPTANCE:` 付きテストが両ファイルで落ちた |
| **#2042** | `src/lib/hooks/agent-session-telemetry.ts:349` — `agentSessionContextPercent()` の `Math.round` を `Math.ceil` に（境界のずらし） | `tests/unit/hooks/agent-session-context-2042.test.ts`, `tests/unit/hooks/sources/opencode-context-usage-2042.test.ts`, `tests/unit/components/worktree/agent-session-display-2042.test.tsx`, `tests/unit/hooks/useTerminalPanePolling-session-2042.test.ts`, `tests/unit/session/current-output-context-2042.test.ts` | **赤 — 1 file / 1 test**（`agent-session-context-2042.test.ts`「rounds rather than ceils, so a nearly-empty window reads 0%」） | opencode の footer 表示規則（`round`、`ceil` ではない）が名指しで固定されている |
| «補強» #2042 | `src/lib/hooks/sources/opencode/client.ts:1252` — `fetchOpencodeContextTokens()` の `info.role !== 'assistant'` を `!== 'user'` に（値の入れ替え） | 同上 | **赤 — 1 file / 3 tests**（`opencode-context-usage-2042.test.ts`） | 「最後の assistant ターンの footprint」という受入条件の中核も固定されている |
| **#2043** | `src/lib/hooks/sources/opencode/diff.ts:246` — `recordOpencodeDiffFrame()` の unrevert 時 `revert.messageId === null ? [] : …` を `!== null` に（条件の反転） | `tests/unit/lib/hooks/sources/opencode/session-diff-2043.test.ts`, `tests/unit/lib/hooks/sources/opencode/client-diff-2043.test.ts`, `tests/unit/components/worktree/opencode-turn-diff-panel-2043.test.tsx`, `tests/unit/verification/work-evidence-opencode-2043.test.ts` | **赤 — 1 file / 1 test**（`session-diff-2043.test.ts`「clears the held-back files when session.updated reports no revert」） | unrevert の取り消しは `session.diff` を伴わないので、ここだけが唯一の clear 経路 |
| «補強» #2043 | `src/lib/hooks/sources/opencode/diff.ts:395,401` — `opencodeWorkEvidenceFileCount()` の `[...record.files, ...record.revertedFiles]` を `[...record.files, ...record.files]` に（値の入れ替え） | 同上 | **赤 — 2 files / 4 tests**（`work-evidence-opencode-2043.test.ts` 2 件、`session-diff-2043.test.ts` 2 件） | 「revert が worktree を git 的にきれいに見せても証跡は残る」という #2043 の中核が固定されている |
| **#2045** | `src/lib/hooks/sources/opencode/push.ts:219` — `notifyOpencodeSessionErrorPush()` の `if (errorName === OPENCODE_INTERRUPT_ERROR_NAME)` を `!==` に（条件の反転） | `tests/unit/hooks/sources/opencode-push-2045.test.ts`, `tests/integration/opencode-push-parity-2045.test.ts`, `tests/unit/i18n/notifications-push-keys.test.ts` | **赤 — 1 file / 4 tests**（`opencode-push-2045.test.ts`） | 「provider エラーで 1 通」と「中断では黙る」の**両側**が落ちた |
| **#2046** | `src/lib/tmux/tmux.ts:965` — `isAllowedSpecialKey()` の `vocabulary.includes(key) && isSendableSpecialKey(key)` を `\|\|` に（演算子の入れ替え） | `tests/unit/api/special-keys-per-tool-vocabulary-2046.test.ts`, `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts`, `tests/unit/components/worktree/OpencodeQuickKeys-2046.test.tsx`, `tests/unit/detection-opencode-quick-key-frames-2046.test.ts`, `tests/unit/special-keys-route.test.ts`, `tests/unit/tmux-navigation.test.ts`, `tests/unit/api/special-keys-btab-2032.test.ts`, `tests/unit/tmux/special-keys-allowlist-2032.test.ts` | **赤 — 3 files / 13 tests**（`tmux-navigation.test.ts` 4 件、`special-keys-per-tool-vocabulary-2046.test.ts` 8 件、`special-keys-allowlist-2032.test.ts` 1 件） | 「claude に `a` を送れてはいけない」というツール別語彙の中核が 7 ツール分すべて固定されている |
| **#2047** | `src/config/tmux-pane-config.ts:175` — `resolveOpencodePaneWidth()` の範囲判定 `parsed < MIN \|\| parsed > MAX` を `<=` / `>=` に（境界のずらし） | `tests/unit/cli-tools/opencode-pane-width-2047.test.ts`, `tests/unit/detection-opencode-pane-width-fixtures-2047.test.ts`, `tests/unit/lib/polling/response-checker-opencode-pane-width-2047.test.ts`, `tests/unit/components/TerminalDisplay-wrap-mode-2047.test.tsx`, `tests/unit/canary-opencode-geometry-2047.test.ts` | **赤 — 1 file / 1 test**（`opencode-pane-width-2047.test.ts`「keeps the bounds inclusive」） | 境界が閉区間であることが名指しで固定されている |
| «補強» #2047 | `src/config/tmux-pane-config.ts:113` — `OPENCODE_PANE_WIDTH` を `80` → `120`（値の入れ替え） | 同上 | **赤 — 2 files / 3 tests**（`canary-opencode-geometry-2047.test.ts` 2 件、`opencode-pane-width-2047.test.ts` 1 件） | 「既定は測定値の 80」「canary と launcher が同じ geometry を共有する」が固定されている |
| **#2048** | `src/lib/hooks/sources/opencode/launch-settings.ts:224` — `opencodeLaunchArguments()` が `--agent` の代わりに `--variant` を出すように（値の入れ替え） | `tests/unit/hooks/sources/opencode-launch-settings-2048.test.ts`, `tests/unit/hooks/sources/opencode-variant-wiring-2048.test.ts`, `tests/unit/cli-tools/opencode-send-selection-2048.test.ts`, `tests/unit/types/opencode-instance-settings-2048.test.ts`, `tests/unit/hooks/sources/opencode-catalog-2048.test.ts`, `tests/unit/session/opencode-variant-effort-2048.test.ts`, `tests/unit/db/opencode-instance-settings-2048.test.ts` | **赤 — 2 files / 4 tests**（`opencode-launch-settings-2048.test.ts` 3 件、`opencode-variant-wiring-2048.test.ts` 1 件） | 「TUI に `--variant` は無い（渡すと usage を出して終了する）」という実測が `NEVER emits --variant` として名指しで固定されている |
| **#2049** | `src/lib/terminal-display-normalize.ts:168` — `compactBlankRuns()` の `isVisuallyBlank(line) && !(isStructuralRow?.(line) ?? false)` から `!` を外す（条件の反転） | `tests/unit/lib/terminal-display-normalize-2049.test.ts`, `tests/unit/lib/opencode-terminal-compaction-2049.test.ts`, `tests/unit/components/TerminalDisplay-2049.test.tsx`, `tests/unit/config/terminal-display-compaction-2049.test.ts` | **赤 — 3 files / 19 tests**（`terminal-display-normalize-2049.test.ts` 12 件、`opencode-terminal-compaction-2049.test.ts` 5 件、`TerminalDisplay-2049.test.tsx` 2 件） | 「空行が畳まれる」「gutter / パネル帯は残る」「claude / codex / copilot は byte 一致で不変」の 3 つすべてが反応した |
| **#2051** | `src/types/opencode-share.ts:82` — `isOpencodeSharingDisabled()` の `mode === 'disabled'` を `=== 'manual'` に（値の入れ替え） | `tests/unit/types/opencode-share-2051.test.ts`, `tests/unit/lib/hooks/sources/opencode/client-share-2051.test.ts`, `tests/unit/components/worktree/OpencodeSessionControls-share-2051.test.tsx`, `tests/integration/api-opencode-share-2051.test.ts`, `tests/unit/types/opencode-export-2051.test.ts`, `tests/unit/lib/daily-summary-opencode-export-2051.test.ts` | **赤 — 2 files / 7 tests**（`api-opencode-share-2051.test.ts` 5 件、`opencode-share-2051.test.ts` 2 件） | 受入条件「`share: disabled` でボタンが出ない」が API 層まで固定されている（`canShare: false` ＋「opencode の share route を呼ばない」） |
| **#2052** | **変異注入は意味を持たない — production の変更がゼロ** | （テスト消費者なし） | **N/A** | spike。PR [#2096](https://github.com/Kewton/CommandMate/pull/2096) の差分は `CHANGELOG.md` / `docs/**` / `tests/fixtures/opencode-web-2052/**` のみで `src/**` は 0 行。**当てる先が無い。** 実測の記録先は設計書であり、それは受入条件どおり。ただし [§5.2](#52-2052-の-fixture-はどのテストからも読まれていない) の観察あり |
| **#2053** | `src/lib/hooks/sources/opencode/source.ts:354` — opencode の `AgentSourceCapabilities.configScope` を `'none'` → `'per-instance'`（値の入れ替え） | `tests/unit/hooks/sources/opencode-config-scope-2053.test.ts`, `tests/unit/hooks/sources/capabilities.test.ts` | **赤 — 1 file / 1 test**（`opencode-config-scope-2053.test.ts`「still declares `none`, which is the whole ruling in one value」） | **#2103 本文の想定（「不採用の裁定 pin なので意味を持たないかもしれない」）と異なり、変異注入は意味を持った。** 裁定は 1 個の値として production に在り、テストがそれを名指しで守っている（[§5.1](#51-2053-は裁定-pin-だが変異注入は意味を持つ)） |
| **#2054** | `src/lib/hooks/sources/define-source.ts:462` — `describeAgentEventSource()` の heartbeat 判定 `now - lastHeartbeatAt >= AGENT_SOURCE_STALE_AFTER_MS` を `<` に（条件の反転） | `tests/unit/hooks/sources/opencode-liveness-2054.test.ts`, `tests/unit/lib/worktree-status-source-2054.test.ts`, `tests/unit/session/current-output-source-2054.test.ts`, `tests/unit/components/worktree/agent-source-display-2054.test.tsx`, `tests/integration/opencode-port-takeover-2054.test.ts` | **赤 — 4 files / 6 tests**（`opencode-port-takeover-2054.test.ts` 1 件、`current-output-source-2054.test.ts` 1 件、`worktree-status-source-2054.test.ts` 2 件、`opencode-liveness-2054.test.ts` 2 件） | 受入条件「port を奪われると `port_identity_changed` が出て scraper 由来に切り替わる」を含む 4 層（describe / status helper / payload / 実 port 奪取の integration）すべてが反応した |

---

## 4. 空振り: #2037 の matrix 行と追加テスト

### 4.1 何が空振りだったか

#2037 の受入条件は 2 つある。

1. **matrix の opencode 行が `CONFIRMED` / `RESTRICTED` いずれかの実測値になり、証跡へのリンクがある**
2. opencode のパレットに install 済み Skill が出る

条件 2 は固定されている（表の #2037 行、3 files / 3 tests が赤）。**条件 1 は固定されていなかった。**

`src/lib/skills/compatibility-matrix.ts:267` の opencode 行 `discovery.outcome` を `'verified'` → `'unsupported'` に入れ替え、**`labelKey` も `AGENT_AXIS_OUTCOME_LABEL_KEYS.unsupported` に合わせて既存の整合性不変条件を満たしたまま**回したところ:

| 回した範囲 | 結果 |
|---|---|
| #2036/#2037 のテスト 4 ファイル | 緑 |
| matrix に触れるテスト全 4 ファイル（`compatibility-matrix.test.ts` / `agent-discovery-regression.test.ts` / `skills-i18n-keys.test.ts` / `skills-agent-discovery-probe.test.ts`） | 緑 |
| **`tests/unit` 全体** | **緑 — 1163 files / 21173 tests すべて pass**（`CI=true NODE_ENV=test npx vitest run tests/unit`、847.68s、2026-08-27） |

`labelKey` を動かさずに `outcome` だけ入れ替えた場合は `compatibility-matrix.test.ts` の「uses only the declared axis outcomes and evidence kinds」が 1 件落ちる。だがそれが捕まえているのは**行の内部整合性**であって、**測定値そのもの**ではない。整合を保ったまま値を反転させると誰も気づかない。

### 4.2 なぜ気づかれなかったか

`compatibility-matrix.test.ts` には `describe('the 2026-07-26 measurements are recorded as taken')` があり、**claude と codex の測定値は 1 つずつ値で固定されている**（roots / testedVersion / 両軸の outcome / evidenceKind / limitationKey / 派生する support 値）。

#2037 が足した opencode 行に対して同じことをした assertion は無く、動いたのは `unmeasuredAgents()` のリストから `'opencode'` が消えたことだけだった。これは **`verified` でも `unsupported` でも等しく真**なので、測定値を守っていない。

`docs/reference/skill-agent-compatibility.md` との突合テストも同じ穴を持つ: 突き合わせているのは version / date / discoveryRoots / evidenceSource であって、**outcome は突き合わせていない**。

### 4.3 追加したテスト

[`tests/unit/lib/skills/opencode-matrix-measurement-2037.test.ts`](../../tests/unit/lib/skills/opencode-matrix-measurement-2037.test.ts) を追加した（9 件）。claude / codex の既存 pin と同じ書き方で、opencode 行を値で固定する:

- measured 行であること（`isAgentMeasured` / `skipReasonKey === null`）
- `discoveryRoots` が `.agents/skills` と `.claude/skills` の 2 本ちょうどであること
- `testedVersion === '1.18.22'` / `testedDate === '2026-08-25'`
- **両軸が `verified` / `mechanical`**（これが空振りだった箇所）
- **`labelKey` / `evidenceKindKey` が outcome と一致していること**（outcome と label を一緒に動かす変異も赤にするため）
- `invocation.limitationKey === NO_SLASH_COMMAND` / `discovery.limitationKey === null`
- `reloadKey === SESSION_RESTART`（boot 時 1 回スキャンという実測に対応）
- `deriveMatrixAgentSupport() === 'native'`
- `evidenceSource` が `https://` で始まり `opencode-server-live-verification.md` を含むこと（受入条件「証跡へのリンクがある」）

**既存のテストは 1 行も弱めていない**（assertion の削除・skip・期待値の実測合わせはしていない）。追加のみ。

### 4.4 追加テストが同じ変異で赤になること

追加テストを隔離 worktree に置き、**リポジトリ全体を緑にしたのと同一の変異**（`outcome` と `labelKey` を揃えて `unsupported` へ）を当て直した。

```
CI=true NODE_ENV=test npx vitest run \
  tests/unit/lib/skills/opencode-matrix-measurement-2037.test.ts \
  tests/unit/lib/skills/compatibility-matrix.test.ts \
  tests/unit/lib/skills/agent-discovery-regression.test.ts
```

| | 結果 |
|---|---|
| MUTANT | **赤 — 1 file / 3 tests**（`opencode-matrix-measurement-2037.test.ts`: 「records opencode as machine-checked on BOTH axes」「keeps the display keys agreeing with the outcomes they label」「derives native support, which is the badge the measurement earns」） |
| CONTROL（復元後、同一コマンド） | 緑 — 3 files / 47 tests |
| 復元 | `md5` がベースライン `3d4b384d087cefe80cc37c40950bf1f9` と一致 |

つまりこの追加テストは、**リポジトリの他のどのテストも捕まえられなかった変異を捕まえる**。

---

## 5. Issue 本文の前提と実測の食い違い

### 5.1 #2053 は裁定 pin だが、変異注入は意味を持つ

#2103 本文は「#2053 は不採用の裁定 pin なので、『変異注入が意味を持つか』から判断してよい」としている。**実測は「意味を持つ」だった。**

PR [#2099](https://github.com/Kewton/CommandMate/pull/2099) は docs だけでなく production も触っている:

- `src/lib/hooks/sources/opencode/source.ts` (+26/-1) — `configScope: 'none'` の宣言と、`env: {}` を空のままにする理由の記述
- `src/lib/cli-tools/opencode-config.ts` (+12) — precedence 表への `$OPENCODE_CONFIG_CONTENT` 行の追加（doc comment）

裁定そのものが `configScope: 'none'` という**1 個の値**として production に存在し、`opencode-config-scope-2053.test.ts` がそれを名指しで守っている。値を `'per-instance'` に入れ替えると赤になる。**「意味を持たない」のは #2052 だけである。**

### 5.2 #2052 の fixture はどのテストからも読まれていない

#2052 は production を変えていないので変異注入の対象が無く、これは受入条件（「実測結果が設計書に記録されている」）どおりで問題ではない。

ただし PR #2096 が置いた `tests/fixtures/opencode-web-2052/**`（10 ファイル）は、**リポジトリのどのテストからも参照されていない**（`grep -rn 'opencode-web-2052' tests src scripts` の一致は fixture 自身のみ、0 件）。証跡アーカイブとしては正しい置き場だが、**`tests/` 配下にあるので「テストが読んでいる」と誤読されうる**。#2052 の結論（proxy 越しでは動かない、理由は絶対パスのアセットと同一 origin 前提）は設計書 §22 が一次記録であり、fixture はその添付である — というのが実際の関係。

---

## 6. 使ったコマンド（再現手順）

```bash
# 1. 隔離 worktree
git worktree add --detach ../cm-mut-2103-2103 HEAD
cp -al node_modules ../cm-mut-2103-2103/node_modules
cd ../cm-mut-2103-2103

# 2. 1 件ぶんの手順（例: #2032）
md5 -q src/lib/tmux/tmux.ts                       # ベースライン
#   'BTab', -> 'BTabb',  （値の入れ替え。行は消さない）
md5 -q src/lib/tmux/tmux.ts                       # 変わったことを確認（no-op 変異の検出）
CI=true NODE_ENV=test npx vitest run \
  tests/unit/tmux/special-keys-allowlist-2032.test.ts \
  tests/unit/api/special-keys-btab-2032.test.ts   # MUTANT: exit 1 を期待
git checkout -- src/lib/tmux/tmux.ts
md5 -q src/lib/tmux/tmux.ts                       # ベースラインと一致すること
CI=true NODE_ENV=test npx vitest run \
  tests/unit/tmux/special-keys-allowlist-2032.test.ts \
  tests/unit/api/special-keys-btab-2032.test.ts   # CONTROL: exit 0 を期待
git status --short                                # 空であること

# 3. 片付け
cd -
git worktree remove ../cm-mut-2103-2103
git worktree list | grep cm-mut-2103 || echo "残っていない"
```

---

## 7. 参照

- Epic: [#2055](https://github.com/Kewton/CommandMate/issues/2055)（受入条件・close-out レポート）
- 本 Issue: [#2103](https://github.com/Kewton/CommandMate/issues/2103)
- 実測基盤: [`docs/design/opencode-server-live-verification.md`](./opencode-server-live-verification.md)
- 既実施 7 件の証跡: [Epic #2055 のコメント](https://github.com/Kewton/CommandMate/issues/2055#issuecomment-5424201419)
