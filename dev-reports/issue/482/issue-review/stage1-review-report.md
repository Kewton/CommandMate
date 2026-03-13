# Issue #482 Stage 1 レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 通常レビュー（整合性・正確性・明確性・完全性・受け入れ条件・技術的妥当性）
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |
| **合計** | **6** |

---

## Must Fix（必須対応）

### S1-001: 概要文の件数と対象一覧の不整合

**カテゴリ**: 整合性
**場所**: 概要文

**問題**:
概要文に「コードベースに残存する**6箇所**のTODO/FIXMEマーカー」と記載されているが、対象一覧の表には**4件**しか記載されていない。

**証拠**:
- `grep -rn "TODO\|FIXME" src/` の結果: TODOコメント3件（opencode-config.ts x2、slash-commands/route.ts x1）
- `grep -rn "Issue #XXX" src/` の結果: 1件（cli-patterns.ts:27）
- 合計4件であり、表の記載と一致するが概要文の「6箇所」とは不一致

**推奨対応**:
概要文を「コードベースに残存する**4箇所**のTODO/FIXMEマーカーを対応または削除する。」に修正する。

---

## Should Fix（推奨対応）

### S1-002: cli-patterns.ts の正しいIssue番号の特定方法が不明

**カテゴリ**: 明確性
**場所**: 対象一覧 - `src/lib/cli-patterns.ts:27`

**問題**:
方針が「正しいIssue番号に修正 or コメント削除」とされているが、正しいIssue番号の特定方法が明記されていない。

git logの調査結果:
- 該当コメントはcommit `5ebd2ba`（"fix(status-detector): detect running status during Task execution"）で導入
- コミットメッセージにIssue番号の記載なし
- コミット内容はClaude Code v2.xの「esc to interrupt」ステータスバー形式変更への対応

**推奨対応**:
Issue本文に調査方針を追記する。「commit 5ebd2baの関連PRを特定し、PR経由で正しいIssue番号を確認する。特定できない場合はIssue番号参照を除去する。」

---

### S1-003: 型統合の具体的方針が不明確

**カテゴリ**: 技術的妥当性
**場所**: 対象一覧 - `src/app/api/worktrees/[id]/slash-commands/route.ts:33`

**問題**:
方針が「型統合を実施」とされているが、2つの`SlashCommandsResponse`は構造が大きく異なる。

| 型の場所 | フィールド | 対応API |
|---------|-----------|---------|
| `route.ts` (ローカル) | `groups`, `sources`, `cliTool` | `/api/worktrees/[id]/slash-commands` |
| `api-client.ts` (export) | `groups` のみ | `/api/slash-commands` |

単純な統合は困難であり、route.tsのコメント自体にも「The two types share the same name but have different structures (this one includes sources).」と明記されている。

**推奨対応**:
以下のいずれかの方針を明記する:
- **(A) 共通ベース型の導入**: `BaseSlashCommandsResponse { groups }` を定義し、route.tsの型が拡張する
- **(B) 統合不要と判断しTODO削除**: 用途が異なるため統合せず、TODOコメントを除去
- **(C) 完全統合**: api-client.tsにもsourcesフィールドを追加

現実的には **(A)** または **(B)** が妥当。

---

### S1-004: opencode-config.ts のTODO対応方針が曖昧

**カテゴリ**: 明確性
**場所**: 対象一覧 - `opencode-config.ts:217, 284`

**問題**:
方針が「コメント維持 or 共通化」の2択だが判断基準が不明確。さらに、`ensureOpencodeConfig`関数のJSDoc（行341-342付近）に既に同内容のコメントが存在し、TODOコメントと内容が重複している。

```
// ensureOpencodeConfig() JSDoc内:
// If a 3rd provider is added, consider refactoring to a data-driven design
// (providerDefinitions array + loop) instead of inline if-branches. [KISS]
```

**推奨対応**:
TODOコメント2箇所を削除し、既存のJSDocコメントに集約する。これによりTODOマーカーの解消と重複排除が同時に達成できる。

---

## Nice to Have（あれば良い）

### S1-005: 型変更に対するテスト方針の明記

**カテゴリ**: 完全性
**場所**: 受け入れ基準

**問題**:
受け入れ基準に「既存テストが全パス」はあるが、型統合実施時の型チェック確認について言及がない。

**推奨対応**:
受け入れ基準に「型統合を実施した場合、`npx tsc --noEmit` でコンパイルエラーがないことを確認」を追加する。

---

### S1-006: 対象の種別区分の明確化

**カテゴリ**: 正確性
**場所**: 対象一覧

**問題**:
4件中3件はTODOコメントだが、cli-patterns.ts:27はJSDocコメント内の未解決参照であり、種別が異なる。対象一覧ではこの違いが明確でない。

**推奨対応**:
対象一覧に「種別」列を追加する（例: TODOマーカー / JSDoc内未解決参照）。

---

## 参照ファイル

### コード
| ファイル | 行 | 関連内容 |
|---------|-----|---------|
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | 33 | TODOコメント: 型統合検討 |
| `src/lib/api-client.ts` | 437 | SlashCommandsResponse型（route.tsと構造が異なる） |
| `src/lib/cli-tools/opencode-config.ts` | 217, 284 | TODOコメント: HTTP fetch共通化 |
| `src/lib/cli-tools/opencode-config.ts` | 341-342 | ensureOpencodeConfig JSDoc（TODOと重複するKISS原則コメント） |
| `src/lib/cli-patterns.ts` | 27 | JSDoc内 Issue #XXX 未解決参照 |

### ドキュメント
| ファイル | 関連内容 |
|---------|---------|
| `CLAUDE.md` | モジュール一覧・プロジェクト規約の整合性確認 |
