# Issue #393 Stage 5 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（整合性・正確性）（2回目）
**ステージ**: 5/6（通常レビュー 2回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 4 |

**総合品質**: 高

---

## 前回指摘事項の反映状況

### Stage 1 指摘事項

| ID | 重要度 | タイトル | 状態 |
|----|--------|---------|------|
| F008 | must_fix | worktreeId の DB 存在確認欠如 | **Resolved** -- Root Cause item 6 に追加済み。Recommended Direction にも `getWorktreeById()` 確認を追記済み |
| F001 | should_fix | capture/route.ts が Affected Code に未記載 | **Resolved** -- Affected Code に追加。「Additional Affected Endpoint」サブセクションで詳細記載 |
| F002 | should_fix | 行番号のずれ | **Resolved** -- tmux.ts:68, tmux.ts:175-176, tmux.ts:220 に更新済み |
| F006 | should_fix | workingDirectory のインジェクションリスク未記載 | **Resolved** -- Recommended Direction に workingDirectory の exec() 補間についてNote追記済み |
| F010 | should_fix | Severity 'Critical' の根拠不足 | **Resolved** -- 認証状態別リスクレベルテーブル、攻撃前提条件、Case 区分を追加済み |
| F003 | nice_to_have | PoC Case 2 の但し書き曖昧さ | Partially addressed -- 但し書き文言は残存（S5F003 で継続指摘） |
| F004 | nice_to_have | sendSpecialKeys/sendSpecialKey の言及 | **Resolved** -- 全 8 関数リストに含まれている |
| F005 | nice_to_have | 安全パターンルートの具体例 | **Resolved** -- 「Routes using the safe pattern」セクション追加済み |
| F007 | nice_to_have | historyLimit の補間リスク | Not addressed -- 低優先度のため合理的なスキップ |
| F009 | nice_to_have | CSRF 対策の具体策不足 | Not addressed -- Issue スコープ外として合理的 |

### Stage 3 指摘事項

| ID | 重要度 | タイトル | 状態 |
|----|--------|---------|------|
| IF001 | must_fix | codex.ts/claude-session.ts の直接 exec() 呼び出し未記載 | **Resolved** -- 「Direct exec() Call Sites Bypassing tmux.ts」サブセクション追加。具体的な行番号と移行先関数を明記 |
| IF002 | must_fix | terminal/capture ルートのテスト不存在 | **Resolved** -- Recommended Direction にテストケース仕様を追加（4テストケース明記） |
| IF003 | should_fix | tmux.test.ts のモック変更必要性 | **Resolved** -- Recommended Direction に mock 対象移行の注記追加 |
| IF004 | should_fix | codex.ts の直接 exec() を tmux.ts 関数に統一 | **Resolved** -- 具体的な置換マッピング（codex.ts:102->sendSpecialKey 等）を Recommended Direction に追加 |
| IF005 | should_fix | インジェクション防止テスト不足 | **Resolved** -- Recommended Direction にセッション名インジェクション防止テスト要件追加 |
| IF006 | should_fix | getSessionName() パターン不統一 | **Resolved** -- 「getSessionName() Pattern Inconsistency」サブセクション追加。4実装の比較テーブルと統一推奨を記載 |
| IF007 | should_fix | セッション自動作成削除の後方互換性 | **Resolved** -- Recommended Direction に明確なエラーメッセージと後方互換性考慮の注記追加 |
| IF008 | nice_to_have | opencode.ts リファレンス実装 | **Resolved** -- Recommended Direction 最終項目に追加 |
| IF009 | nice_to_have | isValidWorktreeId() 共有化 | Not addressed -- Issue スコープ外として合理的 |

**総括**: Stage 1 の Must Fix 1件 + Should Fix 4件、Stage 3 の Must Fix 2件 + Should Fix 5件が全て適切に反映されている。

---

## 新規発見事項

### Should Fix（推奨対応）

#### S5F001: tmux.ts の対象関数数「8」は不正確

**カテゴリ**: 正確性
**場所**: Recommended Direction セクション

**問題**:
Recommended Direction に「The migration affects all 8 functions in tmux.ts: hasSession, createSession, sendKeys, sendSpecialKeys, sendSpecialKey, capturePane, killSession, ensureSession」と記載されているが、`tmux.ts` には実際に 10 個のエクスポート関数が存在する。

以下の 2 関数が列挙から漏れている:

| 関数 | 行 | exec() 使用 | リスク |
|------|-----|------------|--------|
| `isTmuxAvailable()` | line 45 | `tmux -V` 固定コマンド | 低（ユーザー入力なし） |
| `listSessions()` | line 89 | 固定フォーマット文字列 | 低（ユーザー入力なし） |

これらの関数はユーザー入力を補間しないため直接的なインジェクションリスクは低いが、包括的な exec() -> execFile() 移行を推奨するなら対象に含めるべき。

**推奨対応**:
「all 8 functions」を「all 10 exported functions」に修正し、リストに `isTmuxAvailable` と `listSessions` を追加する。あるいは「8 functions that accept user-controlled parameters」と限定し、残り 2 関数は低リスクだが同時移行が望ましい旨を注記する。

---

#### S5F002: capture/route.ts の lines パラメータが未検証のまま capturePane() に渡されている

**カテゴリ**: 完全性
**場所**: Additional Affected Endpoint セクション / Root Cause セクション

**問題**:
`capture/route.ts:20` で JSON ボディから `lines` パラメータを取得している:

```typescript
const { cliToolId, lines = 1000 } = await req.json();
```

この `lines` は `capture/route.ts:41` で直接 `tmux.capturePane(sessionName, lines)` に渡される。`capturePane()` 内部（`tmux.ts:325`）では `startLine = -linesOrOptions` として exec() の文字列補間に使用される:

```typescript
`tmux capture-pane -t "${sessionName}" -p -e -S ${startLine} -E ${endLine}`
```

攻撃者が `lines` に文字列や特殊文字を含む値を送信した場合、`-${linesOrOptions}` の結果がシェルコマンドの一部として解釈される可能性がある。

Issue の cliToolId / worktreeId / sessionName のインジェクションについては詳細に記載されているが、`lines` パラメータの未検証問題は言及されていない。

**推奨対応**:
Additional Affected Endpoint セクションまたは Root Cause セクションに、`lines` パラメータの数値バリデーション欠如を追記する。Recommended Direction に「Validate the `lines` parameter as a positive integer within a reasonable range (e.g., 1-100000) before passing to `capturePane()`」を追加する。

---

### Nice to Have（あれば良い）

#### S5F003: Case 2 PoC の但し書きが依然として曖昧

**カテゴリ**: 正確性
**場所**: Proof of Concept > Case 2 セクション

**問題**:
「Exact exploitability depends on routing constraints and how `params.id` is parsed, but the injection primitive is present in code.」の記載が残っている。`cliToolId` は JSON ボディから取得されるためルーティング制約は無関係。`params.id` についてはURL パスパラメータとして Next.js のルーティングで処理されるが、デコード後にはシェルメタ文字が含まれうる。

**推奨対応**:
但し書きを修正し、cliToolId と params.id の入力経路の違いを明確にする。

---

#### S5F004: getSessionName() テーブルの Validation 列が呼び出しチェーンを省略

**カテゴリ**: 整合性
**場所**: getSessionName() Pattern Inconsistency セクション

**問題**:
`cli-session.ts:81-85` の Validation 列が「CLIToolManager via `validateSessionName()`」となっているが、実際の呼び出しチェーンは `CLIToolManager.getInstance().getTool(cliToolId).getSessionName(worktreeId)` -> `BaseCLITool.getSessionName()` -> `validateSessionName()` である。直接 `validateSessionName()` を呼んでいるわけではない。

**推奨対応**:
現状でも実用上の問題はないが、呼び出しチェーンを明示すると正確性が向上する。

---

#### S5F005: Review History で nice_to_have 項目の扱いが不明

**カテゴリ**: 完全性
**場所**: Review History セクション

**問題**:
Stage 1 の F003, F004, F005, F007, F009 と Stage 3 の IF008, IF009 について、反映されたか意図的にスキップされたかの記録がない。F004（sendSpecialKeys の列挙）と F005（安全パターンルート具体例）は Issue 本文に反映されているが、Review History に記録されていない。

**推奨対応**:
Review History の各ステージセクションに、反映した nice_to_have 項目を追記するか、「Nice to have items were selectively addressed」のような注記を追加する。

---

#### S5F006: IF008, IF009 の Review History 記録不足

**カテゴリ**: 完全性
**場所**: Review History > Stage 3 セクション

**問題**:
IF008（opencode.ts リファレンス実装）は Issue 本文に反映されている（Recommended Direction 最終項目）が、Review History に記載がない。IF009（isValidWorktreeId 共有化）は Issue に反映されていない。

**推奨対応**:
Review History に IF008 の反映記録を追加する。IF009 はスコープ外としてスキップした旨を注記する。

---

## 総評

Issue #393 は Stage 1 および Stage 3 のレビュー指摘を包括的かつ正確に反映しており、全体の品質は **高い** 水準にある。

### 強み
1. **Root Cause 分析が充実**: 6 項目の Root Cause が体系的に記述されており、特に item 6（worktreeId DB 存在確認欠如）の追加により網羅性が向上した
2. **Severity の根拠が明確化**: 認証状態別リスクレベルテーブル、攻撃前提条件、Case 区分が追加され、Critical 評価の妥当性が読者に判断可能になった
3. **影響範囲が包括的**: capture/route.ts の追加、直接 exec() 呼び出し箇所の列挙、getSessionName() パターン不統一の文書化により、修正漏れのリスクが大幅に低減
4. **Recommended Direction が実装可能**: テストケース仕様、具体的な関数置換マッピング、リファレンス実装（opencode.ts）、後方互換性考慮が含まれ、実装者が作業を開始するのに十分な情報量
5. **Review History によるトレーサビリティ**: レビュー指摘と反映内容の対応が明確に記録されている

### 残課題（Should Fix 2件）
1. tmux.ts の関数数「8」は「10」に修正すべき（S5F001）
2. capture/route.ts の lines パラメータ未検証問題を記載すべき（S5F002）

これらは Issue の品質を更に向上させるものだが、現状でも実装者が安全な修正を行うために必要な情報は十分に揃っている。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/tmux.ts` | 関数数の検証（10 エクスポート関数） |
| `src/app/api/worktrees/[id]/capture/route.ts` | lines パラメータ未検証問題（line 20, 41） |
| `src/lib/cli-session.ts` | getSessionName() 呼び出しチェーン確認（line 81-84） |
| `src/lib/cli-tools/base.ts` | BaseCLITool.getSessionName() の validateSessionName() 確認（line 46-49） |
| `src/lib/cli-tools/opencode.ts` | execFileAsync リファレンス実装確認（line 113-117） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成・モジュール定義の整合性確認 |
