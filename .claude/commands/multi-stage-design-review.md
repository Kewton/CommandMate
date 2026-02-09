---
model: sonnet
description: "設計書の4段階レビュー（通常→整合性→影響分析→セキュリティ）と指摘対応を自動実行"
---

# マルチステージ設計レビューコマンド

## 概要
4段階のアーキテクチャレビューとその指摘事項対応を自動で実行するコマンドです。各段階でレビュー→対応のサイクルを回し、**設計方針書の品質**を段階的に向上させます。

> **重要**: このコマンドは**設計方針書のレビューと改善**を目的としています。
> ソースコードの実装は行いません。レビュー結果は設計方針書に反映されます。

## 使用方法
```bash
/multi-stage-design-review [Issue番号]
/multi-stage-design-review [Issue番号] --skip-stage=3,4
```

**例**:
```bash
/multi-stage-design-review 76              # 全4段階を実行
/multi-stage-design-review 76 --skip-stage=4  # セキュリティレビューをスキップ
```

## 実行内容

あなたはマルチステージレビューの統括者です。4段階のレビューサイクルを順次実行し、各段階で指摘事項を対応してから次の段階に進みます。

### パラメータ

- **issue_number**: 対象Issue番号（必須）
- **skip_stage**: スキップするステージ番号（カンマ区切り）

### サブエージェントモデル指定

| エージェント | モデル | 理由 |
|-------------|--------|------|
| architecture-review-agent | **opus** | 品質判断にOpus必要 |
| apply-review-agent | sonnet（継承） | 設計方針書更新のみ |

---

## レビューステージ

| Stage | レビュー種別 | フォーカス | 目的 |
|-------|------------|----------|------|
| 1 | 通常レビュー | 設計原則 | SOLID/KISS/YAGNI/DRY準拠確認 |
| 2 | 整合性レビュー | 整合性 | 設計書と実装の整合性確認 |
| 3 | 影響分析レビュー | 影響範囲 | 変更の波及効果分析 |
| 4 | セキュリティレビュー | セキュリティ | OWASP Top 10準拠確認 |

---

## 実行フェーズ

### Phase 0: 初期設定

#### 0-1. TodoWriteで作業計画作成

```
- [ ] Stage 1: 通常レビュー
- [ ] Stage 1: 指摘事項対応
- [ ] Stage 2: 整合性レビュー
- [ ] Stage 2: 指摘事項対応
- [ ] Stage 3: 影響分析レビュー
- [ ] Stage 3: 指摘事項対応
- [ ] Stage 4: セキュリティレビュー
- [ ] Stage 4: 指摘事項対応
- [ ] 最終確認
```

#### 0-2. ディレクトリ構造作成

```bash
mkdir -p dev-reports/issue/{issue_number}/multi-stage-design-review
```

---

### Stage 1: 通常レビュー（設計原則）

#### 1-1. レビュー実行

```
Use architecture-review-agent (model: opus) to review Issue #{issue_number} with focus on 設計原則.

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage1-review-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage1-review-result.json
```

**コンテキスト内容**:
```json
{
  "issue_number": {issue_number},
  "focus_area": "設計原則",
  "stage": 1,
  "stage_name": "通常レビュー"
}
```

#### 1-2. 指摘事項対応（設計方針のみ）

> **重要**: このステップでは**設計方針書のみ**を更新します。ソースコードは変更しません。

レビュー結果にMust Fix/Should Fix項目がある場合：

```
Use apply-review-agent to update design policy for Issue #{issue_number} Stage 1.
Target: dev-reports/design/issue-{issue_number}-*-design-policy.md

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage1-apply-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage1-apply-result.json

IMPORTANT: Only update design policy documents. Do NOT modify source code.
```

#### 1-3. Stage 1完了確認

- テスト全パス
- 静的解析エラー0件
- Must Fix項目すべて対応済み

---

### Stage 2: 整合性レビュー

#### 2-1. レビュー実行

```
Use architecture-review-agent (model: opus) to review Issue #{issue_number} with focus on 整合性.

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage2-review-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage2-review-result.json
```

**コンテキスト内容**:
```json
{
  "issue_number": {issue_number},
  "focus_area": "整合性",
  "stage": 2,
  "stage_name": "整合性レビュー",
  "design_doc_path": "dev-reports/design/issue-{issue_number}-*-design-policy.md"
}
```

#### 2-2. 指摘事項対応（設計方針のみ）

> **重要**: このステップでは**設計方針書のみ**を更新します。ソースコードは変更しません。

設計書と実装の差異がある場合：
- 差異を設計方針書に記録
- 実装変更の指針を設計方針書に追記

```
Use apply-review-agent to update design policy for Issue #{issue_number} Stage 2.
Target: dev-reports/design/issue-{issue_number}-*-design-policy.md

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage2-apply-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage2-apply-result.json

IMPORTANT: Only update design policy documents. Do NOT modify source code.
```

#### 2-3. Stage 2完了確認

- 設計書と実装の整合性100%
- テスト全パス

---

### Stage 3: 影響分析レビュー

#### 3-1. レビュー実行

```
Use architecture-review-agent (model: opus) to review Issue #{issue_number} with focus on 影響範囲.

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage3-review-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage3-review-result.json
```

**コンテキスト内容**:
```json
{
  "issue_number": {issue_number},
  "focus_area": "影響範囲",
  "stage": 3,
  "stage_name": "影響分析レビュー"
}
```

#### 3-2. 指摘事項対応（設計方針のみ）

> **重要**: このステップでは**設計方針書のみ**を更新します。ソースコードは変更しません。

影響範囲に関する問題がある場合：
- 影響分析結果を設計方針書に記録
- 必要な対応策を設計方針書に追記

```
Use apply-review-agent to update design policy for Issue #{issue_number} Stage 3.
Target: dev-reports/design/issue-{issue_number}-*-design-policy.md

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage3-apply-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage3-apply-result.json

IMPORTANT: Only update design policy documents. Do NOT modify source code.
```

#### 3-3. Stage 3完了確認

- 影響範囲が適切に管理されている
- 必要なテストが追加されている

---

### Stage 4: セキュリティレビュー

#### 4-1. レビュー実行

```
Use architecture-review-agent (model: opus) to review Issue #{issue_number} with focus on セキュリティ.

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage4-review-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage4-review-result.json
```

**コンテキスト内容**:
```json
{
  "issue_number": {issue_number},
  "focus_area": "セキュリティ",
  "stage": 4,
  "stage_name": "セキュリティレビュー"
}
```

#### 4-2. 指摘事項対応（設計方針のみ）

> **重要**: このステップでは**設計方針書のみ**を更新します。ソースコードは変更しません。

セキュリティ上の問題がある場合：
- セキュリティ対策を設計方針書に記録
- 実装指針を設計方針書に追記

```
Use apply-review-agent to update design policy for Issue #{issue_number} Stage 4.
Target: dev-reports/design/issue-{issue_number}-*-design-policy.md

Context file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage4-apply-context.json
Output file: dev-reports/issue/{issue_number}/multi-stage-design-review/stage4-apply-result.json

IMPORTANT: Only update design policy documents. Do NOT modify source code.
```

#### 4-3. Stage 4完了確認

- セキュリティ上の問題がすべて解消
- OWASP Top 10準拠

---

### Phase Final: 最終確認と報告

#### 最終検証

```bash
npx tsc --noEmit
npm run lint
npm run test:unit
```

#### サマリーレポート作成

**ファイルパス**: `dev-reports/issue/{issue_number}/multi-stage-design-review/summary-report.md`

```markdown
# マルチステージレビュー完了報告

## Issue #{issue_number}

### ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー | X | X | ✅ |
| 2 | 整合性レビュー | X | X | ✅ |
| 3 | 影響分析レビュー | X | X | ✅ |
| 4 | セキュリティレビュー | X | X | ✅ |

### 最終検証結果

- TypeScript: ✅ Pass
- ESLint: ✅ Pass
- Unit Tests: ✅ X/X Pass

### 変更ファイル一覧

- src/lib/xxx.ts
- ...

### 次のアクション

- [ ] コミット作成
- [ ] PR作成
```

---

## ファイル構造

```
dev-reports/issue/{issue_number}/
└── multi-stage-review/
    ├── stage1-review-context.json
    ├── stage1-review-result.json
    ├── stage1-apply-context.json
    ├── stage1-apply-result.json
    ├── stage2-review-context.json
    ├── stage2-review-result.json
    ├── stage2-apply-context.json
    ├── stage2-apply-result.json
    ├── stage3-review-context.json
    ├── stage3-review-result.json
    ├── stage3-apply-context.json
    ├── stage3-apply-result.json
    ├── stage4-review-context.json
    ├── stage4-review-result.json
    ├── stage4-apply-context.json
    ├── stage4-apply-result.json
    └── summary-report.md
```

---

## 完了条件

以下をすべて満たすこと：

- 全4ステージのレビュー完了
- 各ステージの指摘事項が**設計方針書に反映**完了
- **設計方針書が最新の状態に更新**されている
- サマリーレポート作成完了

> **Note**: このコマンドではソースコードの変更・テスト実行は行いません。
> 設計方針書のレビューと改善のみを実施します。

---

## 使用例

```
User: /multi-stage-design-review 76

Multi-Stage Review:

📋 Stage 1/4: 通常レビュー
  レビュー実行中...
  - 指摘: Must Fix 1件, Should Fix 2件
  設計方針書更新中...
  - 設計方針書に反映: 3/3件
  ✅ Stage 1 完了

📋 Stage 2/4: 整合性レビュー
  レビュー実行中...
  - 指摘: Must Fix 0件, Should Fix 1件
  設計方針書更新中...
  - 設計方針書に反映: 1/1件
  ✅ Stage 2 完了

📋 Stage 3/4: 影響分析レビュー
  レビュー実行中...
  - 指摘: Must Fix 0件, Should Fix 0件
  設計方針書更新不要
  ✅ Stage 3 完了

📋 Stage 4/4: セキュリティレビュー
  レビュー実行中...
  - 指摘: Must Fix 0件, Should Fix 1件
  設計方針書更新中...
  - 設計方針書に反映: 1/1件
  ✅ Stage 4 完了

🎉 マルチステージレビュー完了！

| Stage | 指摘数 | 設計方針書反映 |
|-------|-------|--------------|
| 通常 | 3 | 3 |
| 整合性 | 1 | 1 |
| 影響分析 | 0 | 0 |
| セキュリティ | 1 | 1 |

総指摘数: 5件
設計方針書反映: 5件

更新ファイル: dev-reports/design/issue-76-xxx-design-policy.md
レポート: dev-reports/issue/76/multi-stage-design-review/summary-report.md

次のアクション:
- 設計方針書をレビュー
- /tdd-impl または /pm-auto-dev で実装を開始
```

---

## 関連コマンド

- `/architecture-review`: 単体アーキテクチャレビュー
- `/apply-review`: レビュー指摘事項の反映
- `/pm-auto-dev`: 自動開発フロー
- `/create-pr`: PR作成
