# Issue #482 仮説検証レポート

## 検証日時
- 2026-03-13

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | コードベースに「6箇所」のTODO/FIXMEマーカーが残存する | Rejected | 実際には4件（TODOコメント3件 + Issue #XXX参照1件）。表も4行のみ |
| 2 | `src/app/api/worktrees/[id]/slash-commands/route.ts:33` にTODO | Confirmed | 行33に該当TODOコメント確認済み |
| 3 | `src/lib/cli-tools/opencode-config.ts:217` にTODO | Confirmed | 行217に該当TODOコメント確認済み |
| 4 | `src/lib/cli-tools/opencode-config.ts:284` にTODO | Confirmed | 行284に該当TODOコメント確認済み |
| 5 | `src/lib/cli-patterns.ts:27` に「Issue #XXX 未解決の参照」 | Confirmed | 行27のJSDocコメント内に `Issue #XXX` の参照あり（TODO/FIXMEではなくコメント内の参照） |

## 詳細検証

### 仮説 1: 「6箇所」のTODO/FIXME

**Issue内の記述**: 「コードベースに残存する6箇所のTODO/FIXMEマーカーを対応または削除する。」

**検証手順**:
1. `grep -rn "TODO\|FIXME" src/` を実行
2. 結果: 実際のTODOは3件（opencode-config.ts×2、slash-commands/route.ts×1）
3. `src/lib/cli-patterns.ts:27` は TODO/FIXME マーカーではなくJSDocコメント内の `Issue #XXX` 参照

**判定**: Rejected

**根拠**: grep結果で実際のTODO/FIXMEは3件のみ。`src/lib/standard-commands.ts:161` の `Show TODO list` はコマンドのdescription文字列であり対象外。合計4件（3 TODO + 1 Issue参照）が正確。

**Issueへの影響**: 概要文の「6箇所」は「4箇所」に修正が必要。

### 仮説 2-4: 各ファイルのTODO位置

**検証**: すべて実際にコードベースで確認済み。位置・内容ともに正確。

### 仮説 5: cli-patterns.ts の Issue #XXX 参照

**Issue内の記述**: 「`Issue #XXX` 未解決の参照」

**検証手順**:
1. `grep -n "Issue #XXX" src/lib/cli-patterns.ts` を実行
2. 行27のJSDocコメント内に存在確認
3. コンテキスト確認: CLAUDE_THINKING_PATTERN の説明コメント内の参照

**判定**: Confirmed（ただしTODO/FIXMEではなくJSDocコメント内の参照）

**根拠**: `src/lib/cli-patterns.ts:27` の `Alternative 2: "esc to interrupt" status bar text (Issue #XXX)` は適切なIssue番号（例: #47）に差し替えるべき参照。

---

## Stage 1レビューへの申し送り事項

- **「6箇所」→「4箇所」の修正**: 概要文の件数が誤っているため、Stage 1で指摘すること
- 表には4件しか記載されていないが、概要文との整合性を確認させること
- `src/lib/cli-patterns.ts:27` の `Issue #XXX` は正しいIssue番号（おそらく #47: ターミナル検索機能）に修正する方針が適切かレビューで確認
