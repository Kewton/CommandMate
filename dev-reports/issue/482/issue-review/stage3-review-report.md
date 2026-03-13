# Issue #482 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

## 総合評価

4つの変更対象はいずれもローカルスコープの変更であり、破壊的変更のリスクは極めて低い。特に以下の点が確認された:

1. **api-client.tsのSlashCommandsResponse型**を直接importしているモジュールは存在しない
2. **opencode-config.tsのTODO削除**はコメント変更のみで実行時影響ゼロ
3. **cli-patterns.tsのIssue #XXX修正**はJSDocコメント変更のみで実行時影響ゼロ
4. **既存テストへの影響はいずれの変更でもなし**

---

## Should Fix（推奨対応）

### S3-001: 型統合方針(A)選択時の配置場所未定義

**カテゴリ**: 影響範囲
**場所**: Issue本文 - 型統合の方針セクション

**問題**:
方針(A)で共通ベース型を導入する場合、型の配置先ファイルがIssueに明記されていない。

**調査結果**:
コードベース調査の結果、`api-client.ts`の`SlashCommandsResponse`を型名で直接importしているモジュールは存在しない。`useSlashCommands.ts`は`handleApiError`のみをimportし、APIレスポンスは`data.groups`として直接アクセスしている。route.tsのローカル`SlashCommandsResponse`は完全にファイル内で閉じている。

**推奨対応**:
方針**(B) 統合不要と判断しTODOを削除**が最もリスクが低く推奨。2つの型は:
- 異なるAPIエンドポイント（`/api/slash-commands` vs `/api/worktrees/[id]/slash-commands`）に紐づく
- 構造が大きく異なる（`{ groups }` vs `{ groups, sources, cliTool }`）
- 型名を直接参照する外部消費者がいない

既存のNOTEコメント（route.ts L29-31）で2つの型の関係が説明済みであり、TODO削除とNOTEコメントの維持で十分。

---

### S3-003: cli-patterns.ts Issue #XXX 特定不能時の修正文言未定義

**カテゴリ**: 影響範囲
**場所**: src/lib/cli-patterns.ts:27

**問題**:
Issueの方針は「git logで該当コミット（5ebd2ba）の関連PRを辿り正しいIssue番号を特定する。特定できない場合はIssue番号参照を除去する」とされている。

実際にコミット5ebd2baを調査した結果:
- コミットメッセージ: `fix(status-detector): detect running status during Task execution`
- コミットメッセージにIssue番号の記載なし
- 関連PRの特定も困難

「特定できない場合はIssue番号参照を除去する」の具体的な修正文言が未定義。

**推奨対応**:
以下のいずれかを修正案としてIssueに明記する:
1. `Issue #XXX`をコミットハッシュ参照に置換: `(commit 5ebd2ba)` -- トレーサビリティ維持
2. Issue参照を完全除去し `Alternative 2: "esc to interrupt" status bar text` のみ残す -- 最もシンプル

実装者が迷わないよう、推奨する修正後のJSDocテキストを具体的に記載することを推奨。

---

## Nice to Have（あれば良い）

### S3-002: opencode-config.ts TODO削除時の情報カバレッジ

**場所**: src/lib/cli-tools/opencode-config.ts:217, 284

TODOコメントの内容（`fetchWithTimeout`の共通化ヒント）は、`ensureOpencodeConfig`関数のJSDoc（L340-342）の「data-driven design」方針と重複しているが、粒度が異なる。TODO削除で情報損失は最小限だが、`fetchWithTimeout`という具体的な実装ヒントも保持したい場合はJSDocへの1行追記を検討。

### S3-004: テスト影響（slash-commands API）

テスト影響なし。型変更を伴わない方針(B)ではもちろん、方針(A)でも既存テストは型をimportしていないため破壊なし。

### S3-005: テスト影響（cli-patterns.ts）

テスト影響なし。JSDocコメント変更のみであり、CLAUDE_THINKING_PATTERNの定義（L33-36）は変更されない。

---

## 影響ファイル一覧

| ファイル | 影響内容 | リスク |
|---------|---------|--------|
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | TODOコメント削除（L33）。方針(A)の場合はinterface変更 | 低 |
| `src/lib/api-client.ts` | 方針(A)の場合のみinterface変更の可能性。方針(B)では変更なし | 低 |
| `src/lib/cli-tools/opencode-config.ts` | TODOコメント2行削除（L217, L284） | なし |
| `src/lib/cli-patterns.ts` | JSDoc内Issue #XXX参照の修正（L27） | なし |
| `src/hooks/useSlashCommands.ts` | 影響なし（型をimportしていない） | なし |
| `tests/integration/api-worktree-slash-commands.test.ts` | 影響なし | なし |
| `src/lib/__tests__/cli-patterns.test.ts` | 影響なし | なし |
| `tests/unit/cli-tools/opencode-config.test.ts` | 影響なし | なし |

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/slash-commands/route.ts`: ローカルSlashCommandsResponse型（L34-43）
- `src/lib/api-client.ts`: exportされたSlashCommandsResponse型（L437-439）
- `src/hooks/useSlashCommands.ts`: API消費側（handleApiErrorのみimport）
- `src/app/api/slash-commands/route.ts`: MCBDエンドポイント（{ groups }のみ返却）
- `src/lib/cli-tools/opencode-config.ts`: TODO 2箇所とensureOpencodeConfig JSDoc
- `src/lib/cli-patterns.ts`: Issue #XXX参照とCLAUDE_THINKING_PATTERN定義

### テスト
- `tests/integration/api-worktree-slash-commands.test.ts`: slash-commands API統合テスト
- `src/lib/__tests__/cli-patterns.test.ts`: CLAUDE_THINKING_PATTERNユニットテスト
- `tests/unit/cli-tools/opencode-config.test.ts`: opencode-config.tsユニットテスト
