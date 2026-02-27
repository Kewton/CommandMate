# Issue #374 レビューレポート（Stage 5）

**レビュー日**: 2026-02-28
**フォーカス**: 通常レビュー（2回目）
**ステージ**: 5（通常レビュー 2回目 -- 前回指摘反映確認 + 新規問題洗い出し）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 3 |

**総合評価**: 前回指摘（Stage 1: SF-001~SF-004, NTH-001~NTH-003 / Stage 3: IR-001~IR-005, IR-009）は全て適切に反映済み。Issue全体として実装に必要な情報が十分に網羅されており、実装開始可能な状態と判断する。

---

## 前回指摘の反映状況

### Stage 1 通常レビュー（1回目）指摘

| ID | 指摘内容 | 反映状況 |
|----|---------|---------|
| SF-001 | テスト戦略が記載されていない | 対応済み -- テスト戦略セクション追加、受け入れ基準にもテスト要件追加 |
| SF-002 | バリデーション範囲の根拠不明 | 対応済み -- 「128以上の正の整数、上限はCLI側に委ねる」に変更 |
| SF-003 | DB更新関数の設計パターン未指定 | 対応済み -- 「updateVibeLocalModelと同様の単独関数」と明記 |
| SF-004 | セッション再起動時の反映タイミング未記載 | 対応済み -- 受け入れ基準に「セッション再起動後に反映」追加 |
| NTH-001 | UIの入力欄仕様が粗い | 対応済み -- type/step/min属性、i18nキー名・テキスト値を記載 |
| NTH-002 | 関連Issue #368へのリンクがない | 対応済み -- 背景セクションに追記 |
| NTH-003 | CLAUDE.mdへの追記が変更対象に含まれていない | 対応済み -- 変更対象に追加 |

### Stage 3 影響範囲レビュー（1回目）主要指摘

| ID | 指摘内容 | 反映状況 |
|----|---------|---------|
| IR-001 | getWorktrees/getWorktreeById のSELECT文修正箇所の明示 | 対応済み -- 「計6箇所の同期修正」と明記 |
| IR-002/IR-009 | 変更対象にWorktreeDetailRefactored.tsx/NotesAndLogsPane.tsxが漏れ | 対応済み -- 変更対象に追加 |
| IR-003 | vibe-local.tsのdefense-in-depthバリデーション具体例 | 対応済み -- 具体的条件を記載 |
| IR-004 | CURRENT_SCHEMA_VERSION更新とテストへの影響 | 対応済み -- テスト戦略に明記 |
| IR-005 | i18nキーの具体的テキスト値 | 対応済み -- en/jaの具体値を記載 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### SF-005: db-migrations.test.ts のテスト記述修正の詳細化

**カテゴリ**: 整合性
**場所**: テスト戦略セクション / `tests/unit/lib/db-migrations.test.ts` L36, L430, L443

**問題**:
`tests/unit/lib/db-migrations.test.ts` の L36 に `it('should be 18 after Migration #18', ...)` というテスト記述があるが、アサーションは `expect(CURRENT_SCHEMA_VERSION).toBe(19)` であり、既に記述とアサーションが不一致である。Issue #374 で version 20 を追加しアサーションを `toBe(20)` に変更する際に、テスト記述も合わせて修正すべきである。

Issue 本文では「db-migrations.test.ts: CURRENT_SCHEMA_VERSION期待値を20に更新」とあるが、更新が必要なアサーションが3箇所（L37, L430, L443）あることが明示されていない。

**証拠**:
```typescript
// tests/unit/lib/db-migrations.test.ts L36-37
it('should be 18 after Migration #18', () => {
  expect(CURRENT_SCHEMA_VERSION).toBe(19);  // 記述「18」とアサーション「19」が不一致
});

// L430
expect(getCurrentVersion(db)).toBe(19);

// L443
expect(getCurrentVersion(db)).toBe(19);
```

**推奨対応**:
テスト戦略セクションを「db-migrations.test.ts: CURRENT_SCHEMA_VERSION期待値を20に更新（L37, L430, L443の3箇所）、テスト記述も合わせて修正」に詳細化する。

---

### Nice to Have（あれば良い）

#### NTH-004: APIバリデーションの境界値テストケースの列挙

**カテゴリ**: 完全性
**場所**: テスト戦略セクション

**問題**:
テスト戦略に「PATCH API（正常値、null、境界値、不正値）」と記載されているが、具体的なテストケースが列挙されていない。バリデーション条件「128以上の正の整数」に対する境界値テストとして、どの値を検証すべきかが明示されていない。

**推奨対応**:
代表的なテストケースを列挙する。例:
- 正常値: 8192 (許可)
- null: リセット (許可)
- 境界値: 128 (許可), 127 (拒否)
- 非整数: 128.5 (拒否)
- 負数: -1 (拒否)
- 文字列: "abc" (拒否)

---

#### NTH-005: UIにおけるnullリセットの操作方法

**カテゴリ**: 明確性
**場所**: 対応方針セクション 3. UI

**問題**:
APIバリデーションで null（リセット）が許可されているが、UI上でユーザーがコンテキストウィンドウ値をデフォルトに戻す操作方法が未記載である。number input で値をクリアした場合の動作（空文字列を null として API に送信するか）を実装者が判断する必要がある。

**推奨対応**:
「入力欄をクリア（空欄にして）保存した場合、null として API に送信しデフォルト値に戻す」等の操作フローを記載する。

---

#### NTH-006: upsertWorktree()が修正不要である根拠

**カテゴリ**: 技術的妥当性
**場所**: 対応方針セクション 1. データベース

**問題**:
Issue本文に「upsertWorktree()は修正不要」と記載されているが、根拠が明記されていない。vibeLocalModel も upsertWorktree() に含まれていない既存パターンの踏襲であるが、Issue だけを読んだ場合に設計判断の根拠が不明確。

**推奨対応**:
「upsertWorktree()は修正不要（vibeLocalModelと同様、個別のupdate関数で管理するため）」のように根拠を一文追記する。

---

## CURRENT_SCHEMA_VERSION 整合性確認

Issue本文の「CURRENT_SCHEMA_VERSION を 20 に更新」という記載について、以下の整合性を確認した。

| 項目 | 現在の値 | Issue記載 | 整合性 |
|------|---------|----------|--------|
| `src/lib/db-migrations.ts` CURRENT_SCHEMA_VERSION | 19 | 20に更新 | 整合（version 20 のマイグレーション追加に対応） |
| 最新マイグレーション | version 19 (add-vibe-local-model-column) | version 20 (add-vibe-local-context-window-column) | 整合 |
| `tests/unit/lib/db-migrations.test.ts` アサーション | `toBe(19)` x 3箇所 | `toBe(20)` に更新 | 整合 |

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `tests/unit/lib/db-migrations.test.ts` L36-37, L430, L443 | CURRENT_SCHEMA_VERSION期待値の更新が必要な3箇所 |
| `src/lib/db-migrations.ts` L14 | CURRENT_SCHEMA_VERSION = 19（version 20への更新対象） |
| `src/lib/db.ts` L199, L215-234, L240-264, L312, L319-338, L344-363 | getWorktrees/getWorktreeByIdの計6箇所の同期修正対象 |
| `src/lib/db.ts` L1004-1016 | updateVibeLocalModel() -- updateVibeLocalContextWindow()の参照パターン |
| `src/lib/cli-tools/vibe-local.ts` L88-97 | startSession()のコマンド構築 -- --context-windowの追加先 |
| `src/app/api/worktrees/[id]/route.ts` L232-251 | vibeLocalModelバリデーション -- vibeLocalContextWindowの参照パターン |
| `src/components/worktree/AgentSettingsPane.tsx` L232-264 | Ollama model selector UI -- context-window入力欄の追加先 |
| `src/types/models.ts` L80-81 | Worktree interface -- vibeLocalContextWindowフィールド追加先 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `locales/ja/schedule.json` | vibeLocalContextWindow / vibeLocalContextWindowDefault キー追加先 |
| `locales/en/schedule.json` | vibeLocalContextWindow / vibeLocalContextWindowDefault キー追加先 |
| `CLAUDE.md` | vibe-local.tsモジュール説明の更新対象 |

---

## 結論

Issue #374 は Stage 1~4 のレビューサイクルを経て、実装に必要な情報が十分に整備された。前回指摘事項は全て適切に反映されており、残存する指摘（SF-005, NTH-004~NTH-006）はいずれも軽微なものである。CURRENT_SCHEMA_VERSION の 20 への更新記載も db-migrations.ts の現状（version 19）と正しく整合している。実装開始可能な状態と判断する。
